import { randomBytes } from 'node:crypto';
import { access } from 'node:fs/promises';
import * as path from 'node:path';

import { assessDuplicateConsolidation } from '../core/cleanup/consolidation.js';
import { collectDuplicateConstraintEvidence } from '../core/cleanup/consolidationEvidence.js';
import { cleanupGraphSignature } from '../core/cleanup/graphSignature.js';
import { buildDependencyGraph } from '../core/lockfile/build.js';
import { parseManifest } from '../core/manifest/parse.js';
import type { DependencyGraph } from '../core/types.js';
import type { DashboardController, MessageSink } from './dashboardController.js';
import { createNodeNpmResolverDeps, resolveNpmInvocation } from './npmResolver.js';
import { resolveInstalledPnpmInvocation } from './pnpmResolver.js';
import { IsolatedResolverVerifier } from './resolverVerifier.js';
import { smartCleanupProjectCapability } from './smartCleanupProjectCapability.js';
import type {
  SmartCleanupDedupeActionPresentation,
  SmartCleanupDuplicateAssessmentPresentation,
} from './webviewProtocol.js';

export const SMART_CLEANUP_DEDUPE_TIMEOUT_MS = 60_000;
const CUSTOM_RESOLUTION_FILES = ['.npmrc', '.pnpmfile.cjs', 'pnpm-workspace.yaml'] as const;

export interface SmartCleanupDedupeSelection {
  affectedPackages: readonly string[];
  expectedRemovedVersions: number;
  expectedTargets: Readonly<Record<string, string>>;
  expectedDirectVersions: Readonly<Record<string, string | null>>;
  /** Full normalized resolved-version inventory produced by the exact final simulation. */
  expectedInventory: Readonly<Record<string, readonly string[]>>;
  /** Canonical resolved nodes and edges produced by the exact final simulation. */
  expectedGraphSignature: string;
}

export interface SmartCleanupDedupeEvidence {
  requestId: string;
  actionId: string;
  affectedPackages: readonly string[];
  expectedRemovedVersions: number;
  expectedTargets: Readonly<Record<string, string>>;
  isCurrent(): boolean;
  /** Re-run the exact isolated dedupe against the final staged manifest before mutation. */
  verifySelection(manifestText: string, signal?: AbortSignal): Promise<
    ({ ok: true } & SmartCleanupDedupeSelection) | { ok: false; reason: string }
  >;
}

export interface SmartCleanupDuplicateCoordinatorOptions {
  sink: MessageSink;
  ensureController(): Promise<DashboardController | undefined>;
  isDisposed(): boolean;
  sourceGeneration(): number;
}

function versionsByName(graph: DependencyGraph): Map<string, string[]> {
  const grouped = new Map<string, Set<string>>();
  for (const node of graph.nodes.values()) {
    if (node.version === null) continue;
    const versions = grouped.get(node.name) ?? new Set<string>();
    versions.add(node.version);
    grouped.set(node.name, versions);
  }
  return new Map([...grouped].map(([name, versions]) => [name, [...versions].sort((a, b) => a.localeCompare(b))]));
}

function directVersions(graph: DependencyGraph): Map<string, string | null> {
  return new Map(
    [...graph.nodes.values()]
      .filter((node) => node.direct)
      .map((node) => [node.name, node.version])
  );
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function firstExisting(root: string): Promise<string | null> {
  for (const name of CUSTOM_RESOLUTION_FILES) {
    try {
      await access(path.join(root, name));
      return name;
    } catch {
      // Missing is the expected case.
    }
  }
  return null;
}

export class SmartCleanupDuplicateCoordinator {
  private active: { requestId: string; abort: AbortController } | undefined;
  private completed: {
    requestId: string;
    sourceGeneration: number;
    controller: DashboardController;
    action: SmartCleanupDedupeActionPresentation;
    expectedTargets: Readonly<Record<string, string>>;
    verifier: IsolatedResolverVerifier;
    source: DashboardController['upgradeSource'];
  } | undefined;

  constructor(private readonly options: SmartCleanupDuplicateCoordinatorOptions) {}

  cancel(requestId?: string): void {
    if (requestId !== undefined && this.active?.requestId !== requestId) return;
    this.active?.abort.abort();
    this.active = undefined;
    if (requestId === undefined || this.completed?.requestId === requestId) this.completed = undefined;
  }

  dispose(): void {
    this.cancel();
  }

  evidence(requestId: string, actionId: string): SmartCleanupDedupeEvidence | null {
    const completed = this.completed;
    if (
      completed === undefined ||
      completed.requestId !== requestId ||
      completed.action.actionId !== actionId
    ) return null;
    return {
      requestId,
      actionId,
      affectedPackages: completed.action.affectedPackages,
      expectedRemovedVersions: completed.action.expectedRemovedVersions,
      expectedTargets: completed.expectedTargets,
      isCurrent: () =>
        this.completed === completed &&
        completed.sourceGeneration === this.options.sourceGeneration(),
      verifySelection: async (manifestText, signal) => {
        if (this.completed !== completed || completed.sourceGeneration !== this.options.sourceGeneration()) {
          return { ok: false, reason: 'Project dependencies changed after duplicate analysis.' };
        }
        const simulated = await completed.verifier.materializeCleanupGraph(
          manifestText,
          manifestText !== completed.source.manifestText,
          signal
        );
        if (!simulated.ok) return simulated;
        const stagedDirect = directVersions(simulated.beforeGraph);
        const simulatedDirect = directVersions(simulated.graph);
        const directChanged = [...new Set([...stagedDirect.keys(), ...simulatedDirect.keys()])]
          .some((name) => stagedDirect.get(name) !== simulatedDirect.get(name));
        if (directChanged) {
          return { ok: false, reason: 'The final dedupe preview changed a remaining direct dependency resolution.' };
        }
        const beforeInventory = versionsByName(simulated.beforeGraph);
        const inventory = versionsByName(simulated.graph);
        const expectedTargets: Record<string, string> = {};
        let expectedRemovedVersions = 0;
        for (const [packageName, beforeVersions] of beforeInventory) {
          const afterVersions = inventory.get(packageName) ?? [];
          if (beforeVersions.length <= 1 || afterVersions.length !== 1) continue;
          const beforeEvidence = collectDuplicateConstraintEvidence(simulated.beforeGraph, packageName);
          const afterEvidence = collectDuplicateConstraintEvidence(simulated.graph, packageName);
          const assessment = assessDuplicateConsolidation({
            packageName,
            resolvedVersions: beforeEvidence.versions,
            constraints: beforeEvidence.constraints,
            constraintsComplete: beforeEvidence.constraintsComplete,
            simulation: {
              status: 'complete',
              resolvedVersions: afterEvidence.versions,
              constraints: afterEvidence.constraints,
              constraintsComplete: afterEvidence.constraintsComplete,
              parentUpgrades: [],
            },
          });
          if (assessment.outcome !== 'safe-convergence') continue;
          expectedTargets[packageName] = assessment.targetVersion;
          expectedRemovedVersions += beforeVersions.length - 1;
        }
        const affectedPackages = Object.keys(expectedTargets).sort((left, right) => left.localeCompare(right));
        const changedVersionSets = [...new Set([...beforeInventory.keys(), ...inventory.keys()])]
          .filter((name) => !sameStrings(beforeInventory.get(name) ?? [], inventory.get(name) ?? []));
        const unexplainedChange = changedVersionSets.find((name) => expectedTargets[name] === undefined);
        if (unexplainedChange !== undefined) {
          return {
            ok: false,
            reason: `The final dedupe preview changed ${unexplainedChange} without a fully verified convergence result.`,
          };
        }
        if (affectedPackages.length === 0) {
          return { ok: false, reason: 'The selected removals leave no verified duplicate groups for the dedupe action.' };
        }
        return {
          ok: true,
          affectedPackages,
          expectedRemovedVersions,
          expectedTargets,
          expectedDirectVersions: Object.fromEntries([...simulatedDirect].sort(([left], [right]) => left.localeCompare(right))),
          expectedInventory: Object.fromEntries([...inventory].sort(([left], [right]) => left.localeCompare(right))),
          expectedGraphSignature: cleanupGraphSignature(simulated.graph),
        };
      },
    };
  }

  async analyze(requestId: string): Promise<void> {
    if (this.active !== undefined) return;
    const abort = new AbortController();
    const active = { requestId, abort };
    this.active = active;
    this.completed = undefined;
    const sourceGeneration = this.options.sourceGeneration();
    this.options.sink.postMessage({ status: 'smart-cleanup-duplicates-analyzing', requestId });

    try {
      const controller = await this.options.ensureController();
      if (controller === undefined || abort.signal.aborted || this.options.isDisposed()) return;
      const source = controller.upgradeSource;
      const manifest = parseManifest(source.manifestText);
      const currentGraph = buildDependencyGraph({
        root: controller.root,
        manifest,
        lockfileText: source.lockfileText,
        packageManager: source.packageManager,
        importerId: source.importerId,
      });
      const currentInventory = versionsByName(currentGraph);
      const duplicateNames = [...currentInventory]
        .filter(([, versions]) => versions.length > 1)
        .map(([name]) => name)
        .sort((left, right) => left.localeCompare(right));
      if (duplicateNames.length === 0) {
        this.options.sink.postMessage({
          status: 'smart-cleanup-duplicates-result',
          requestId,
          assessments: [],
        });
        return;
      }

      const basicCapability = smartCleanupProjectCapability(source);
      const customResolutionFile = await firstExisting(controller.root);
      const unsupportedReason = !basicCapability.executionSupported
        ? basicCapability.reason
        : manifest.workspaces.length > 0
          ? 'Automatic deduplication is disabled for workspace roots because the isolated preview cannot reproduce every workspace package safely.'
          : customResolutionFile !== null
            ? `Automatic deduplication is disabled because ${customResolutionFile} may change resolver behavior outside the isolated preview.`
            : source.packageManager === 'npm' && source.lockfileName !== 'package-lock.json'
              ? 'Automatic deduplication requires package-lock.json.'
              : source.packageManager === 'npm' && currentGraph.lockfileVersion !== 2 && currentGraph.lockfileVersion !== 3
                ? 'Automatic deduplication requires npm lockfile version 2 or 3.'
                : Object.keys(source.resolvedRegistry.scoped).length > 0
                  ? 'Automatic deduplication is disabled for scoped registry routing until the isolated preview can reproduce it exactly.'
                  : null;
      if (unsupportedReason !== null) {
        const assessments: SmartCleanupDuplicateAssessmentPresentation[] = duplicateNames.map((packageName) => ({
          packageName,
          outcome: 'unknown',
          currentVersions: currentInventory.get(packageName) ?? [],
          reason: unsupportedReason,
        }));
        this.options.sink.postMessage({
          status: 'smart-cleanup-duplicates-result',
          requestId,
          assessments,
          unavailableReason: unsupportedReason,
        });
        return;
      }

      const npm = resolveNpmInvocation(createNodeNpmResolverDeps(controller.root));
      const invocation = !npm.ok
        ? null
        : source.packageManager === 'npm'
          ? { executable: npm.invocation.node, prefixArgs: [npm.invocation.npmCliJs], version: npm.invocation.version }
          : resolveInstalledPnpmInvocation(npm.invocation, controller.root);
      if (invocation === null || source.lockfileText === null || source.lockfileName === null) {
        const reason = `A working ${source.packageManager} installation and active lockfile are required for dedupe preview.`;
        this.options.sink.postMessage({
          status: 'smart-cleanup-duplicates-result',
          requestId,
          assessments: duplicateNames.map((packageName) => ({
            packageName,
            outcome: 'unknown',
            currentVersions: currentInventory.get(packageName) ?? [],
            reason,
          })),
          unavailableReason: reason,
        });
        return;
      }

      const verifier = new IsolatedResolverVerifier({
        packageManager: source.packageManager,
        packageManagerVersion: invocation.version ?? null,
        invocation,
        manifestText: source.manifestText,
        lockfile: { name: source.lockfileName, text: source.lockfileText },
        registry: source.registry,
        policy: source.peerPolicy,
      });
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        abort.abort();
      }, SMART_CLEANUP_DEDUPE_TIMEOUT_MS);
      let simulated: Awaited<ReturnType<IsolatedResolverVerifier['materializeDedupedGraph']>>;
      try {
        simulated = await verifier.materializeDedupedGraph(abort.signal);
      } finally {
        clearTimeout(timeout);
      }
      if (this.active !== active || this.options.isDisposed()) return;
      if (timedOut) {
        const reason = 'Duplicate analysis timed out after one minute. Retry when the package registry or package manager is responsive.';
        this.options.sink.postMessage({
          status: 'smart-cleanup-duplicates-result',
          requestId,
          assessments: duplicateNames.map((packageName) => ({
            packageName,
            outcome: 'unknown',
            currentVersions: currentInventory.get(packageName) ?? [],
            reason,
          })),
          unavailableReason: reason,
        });
        return;
      }
      if (abort.signal.aborted) return;
      if (!simulated.ok) {
        this.options.sink.postMessage({
          status: 'smart-cleanup-duplicates-result',
          requestId,
          assessments: duplicateNames.map((packageName) => ({
            packageName,
            outcome: 'unknown',
            currentVersions: currentInventory.get(packageName) ?? [],
            reason: simulated.reason,
          })),
          unavailableReason: simulated.reason,
        });
        return;
      }

      const currentDirect = directVersions(currentGraph);
      const simulatedDirect = directVersions(simulated.graph);
      const directChanged = [...new Set([...currentDirect.keys(), ...simulatedDirect.keys()])]
        .some((name) => currentDirect.get(name) !== simulatedDirect.get(name));
      const simulatedInventory = versionsByName(simulated.graph);
      const assessments: SmartCleanupDuplicateAssessmentPresentation[] = [];
      const safeTargets = new Map<string, string>();
      for (const packageName of duplicateNames) {
        const currentEvidence = collectDuplicateConstraintEvidence(currentGraph, packageName);
        const simulatedEvidence = collectDuplicateConstraintEvidence(simulated.graph, packageName);
        const assessment = assessDuplicateConsolidation({
          packageName,
          resolvedVersions: currentEvidence.versions,
          constraints: currentEvidence.constraints,
          constraintsComplete: currentEvidence.constraintsComplete,
          simulation: {
            status: 'complete',
            resolvedVersions: simulatedEvidence.versions,
            constraints: simulatedEvidence.constraints,
            constraintsComplete: simulatedEvidence.constraintsComplete,
            parentUpgrades: [],
          },
        });
        if (assessment.outcome === 'safe-convergence') {
          safeTargets.set(packageName, assessment.targetVersion);
          assessments.push({
            packageName,
            outcome: 'safe-convergence',
            currentVersions: [...assessment.currentVersions],
            targetVersion: assessment.targetVersion,
            reason: assessment.reason,
          });
        } else if (assessment.outcome === 'keep-both') {
          assessments.push({
            packageName,
            outcome: 'keep-both',
            currentVersions: [...assessment.currentVersions],
            reason: assessment.reason,
          });
        } else {
          assessments.push({
            packageName,
            outcome: 'unknown',
            currentVersions: [...assessment.currentVersions],
            reason: assessment.reason,
          });
        }
      }

      const changedVersionSets = [...new Set([...currentInventory.keys(), ...simulatedInventory.keys()])]
        .filter((name) => !sameStrings(currentInventory.get(name) ?? [], simulatedInventory.get(name) ?? []));
      const unexplainedChange = changedVersionSets.find((name) => !safeTargets.has(name));
      const sourceStillCurrent =
        sourceGeneration === this.options.sourceGeneration() &&
        (await this.options.ensureController()) === controller;
      if (!sourceStillCurrent) {
        this.options.sink.postMessage({
          status: 'smart-cleanup-duplicates-error',
          requestId,
          error: { code: 'STALE_SOURCE', message: 'Project dependencies changed during duplicate analysis. Analyze again.' },
        });
        return;
      }

      let action: SmartCleanupDedupeActionPresentation | undefined;
      if (!directChanged && unexplainedChange === undefined && safeTargets.size > 0) {
        const affectedPackages = [...safeTargets.keys()].sort((left, right) => left.localeCompare(right));
        action = {
          actionId: `dedupe:${randomBytes(16).toString('hex')}`,
          affectedPackages,
          expectedRemovedVersions: affectedPackages.reduce(
            (count, name) => count + Math.max(0, (currentInventory.get(name)?.length ?? 1) - 1),
            0
          ),
        };
        this.completed = {
          requestId,
          sourceGeneration,
          controller,
          action,
          expectedTargets: Object.fromEntries(safeTargets),
          verifier,
          source,
        };
      }
      const unavailableReason = directChanged
        ? 'The isolated dedupe changed a direct dependency resolution, so automatic execution was disabled.'
        : unexplainedChange === undefined
          ? undefined
          : `The isolated dedupe changed ${unexplainedChange} without a fully verified convergence result.`;
      this.options.sink.postMessage({
        status: 'smart-cleanup-duplicates-result',
        requestId,
        assessments,
        ...(action === undefined ? {} : { action }),
        ...(unavailableReason === undefined ? {} : { unavailableReason }),
      });
    } catch (cause) {
      if (!abort.signal.aborted && this.active === active && !this.options.isDisposed()) {
        this.options.sink.postMessage({
          status: 'smart-cleanup-duplicates-error',
          requestId,
          error: { code: 'DUPLICATE_ANALYSIS_FAILED', message: cause instanceof Error ? cause.message : String(cause) },
        });
      }
    } finally {
      if (this.active === active) this.active = undefined;
    }
  }
}
