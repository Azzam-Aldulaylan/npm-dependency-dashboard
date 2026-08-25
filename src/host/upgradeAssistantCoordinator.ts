/**
 * Host-side coordinator for one dependency-upgrade lifecycle.
 *
 * DashboardPanel owns the webview, project selection, watchers, and reload
 * machinery. This class owns everything from validating an untrusted upgrade
 * message through preflight, the Upgrade Analysis modal, transaction
 * execution, final-state reload, and user-visible completion.
 *
 * The flow is now two phases, not one:
 *
 *   handleAnalyzeUpgrade  — eligibility, the panel-wide lock, preflight,
 *                           smart-plan search, security-outcome evaluation.
 *                           Stores the result (never trusted contents,
 *                           always a fresh re-derivation) under a random
 *                           `analysisId` and posts it to the webview. The
 *                           lock stays held — reserved across preflight
 *                           *and* however long the modal stays open, exactly
 *                           as it was reserved across preflight and the old
 *                           native confirmation dialog.
 *   handleConfirmUpgrade  — looks up the stored analysis by id, re-runs the
 *   handleUseSmartPlan      exact same disk-reread + eligibility recheck the
 *                           old single-method flow ran right after its native
 *                           dialog resolved, then executes the transaction.
 *   handleCancelUpgrade   — releases the lock without executing anything.
 *
 * The stored analysis is never execution authority by itself — see the
 * STALE_SOURCE recheck in handleConfirmUpgrade/handleUseSmartPlan, which is
 * the same recheck this file has always run, just relocated from "after a
 * resolved dialog Promise" to "after a confirm-upgrade message arrives".
 */

import { randomBytes } from 'node:crypto';
import * as path from 'node:path';

import * as vscode from 'vscode';

import { buildDependencyGraph } from '../core/lockfile/build.js';
import { runSequentialBatch } from '../core/async/sequentialBatch.js';
import { SharedPromise } from '../core/async/sharedPromise.js';
import { directNodes } from '../core/lockfile/parse.js';
import { parseManifest } from '../core/manifest/parse.js';
import { analyzeCompatibility, CompatibilityCancelledError } from '../core/compatibility/preflight.js';
import type { CompatibilityStatus, UpgradeProposal } from '../core/compatibility/types.js';
import { RegistryPackageMetadataProvider, registryForPackage } from '../core/compatibility/registryMetadataProvider.js';
import type { HttpClient } from '../core/registry/http.js';
import { fetchPackument } from '../core/registry/versions.js';
import type { EtagStore } from '../core/registry/versions.js';
import type { PerformanceRecorder } from '../core/performance/measurement.js';
import { createPerformanceSession } from '../core/performance/measurement.js';
import { planSmartUpgrade } from '../core/upgrade/smartPlan.js';
import { buildStagedManifest, buildStagedManifestForRemoval } from '../core/upgrade/stagedManifest.js';
import { requiresManifestReconciliation } from '../core/upgrade/plan.js';
import { stillRequiredBy } from '../core/upgrade/removeImpact.js';
import { describeBulkRejection, describeBulkRemoveRejection } from '../core/upgrade/validate.js';
import type { EligibleRemoval, EligibleUpgrade } from '../core/upgrade/validate.js';
import { advisoriesByNameFromRows } from '../core/advisories/attribution.js';
import { resolveRemediationRequest } from '../core/advisories/remediationRequest.js';
import type { RemediationRequestRejection } from '../core/advisories/remediationRequest.js';
import { evaluateSecurityOutcome } from '../core/advisories/securityOutcome.js';
import type { SecurityOutcomeStatus } from '../core/advisories/securityOutcome.js';
import type { DashboardController, MessageSink } from './dashboardController.js';
import { createNodeNpmResolverDeps, resolveNpmInvocation } from './npmResolver.js';
import { createNodeUpgradeTransactionFileAdapter } from './nodeUpgradeTransactionFiles.js';
import { resolveInstalledPnpmInvocation } from './pnpmResolver.js';
import { combineSecurityOutcomes } from './securityOutcomeBatch.js';
import type { DiscoveredProject, ResolvedProject } from './projectResolution.js';
import { loadProject } from './projectResolution.js';
import { IsolatedResolverVerifier } from './resolverVerifier.js';
import { resolveAnalysisForExecution } from './upgradeAnalysisLookup.js';
import type { AnalysisLookupRejection } from './upgradeAnalysisLookup.js';
import { buildUpgradeAnalysisPresentation } from './upgradeAnalysisPresentation.js';
import { buildRemoveAnalysisPresentation } from './removeAnalysisPresentation.js';
import { describeRemoveTransactionOutcome, describeUpgradeTransactionOutcome } from './upgradeAssistantOutcome.js';
import { UpgradeExecutionSession } from './upgradeRunner.js';
import { runUpgradeTransaction } from './upgradeTransaction.js';
import { selectVerificationScripts } from './verificationPolicy.js';
import type { VerificationScript } from './verificationPolicy.js';
import type {
  ProtocolError,
  RemediationOutcomeStatus,
  SecurityOutcome,
  UpgradeAnalysisSmartPlan,
} from './webviewProtocol.js';

export interface UpgradeMessage {
  package: string;
  target: string;
}

export interface BulkUpgradeMessage {
  changes: UpgradeMessage[];
}

export interface RemoveMessage {
  package: string;
}

export interface BulkRemoveMessage {
  changes: RemoveMessage[];
}

export interface RemediationMessage {
  package: string;
}

export interface RemediationBatchMessage {
  packages: string[];
}

export interface AnalysisMessage {
  analysisId: string;
}

export interface CancelUpgradeMessage {
  analysisId: string | null;
}

export interface UpgradeAssistantCoordinatorOptions {
  sink: MessageSink;
  httpClient: HttpClient;
  etagStore: EtagStore;
  ensureController(): Promise<DashboardController | undefined>;
  getSelectedProject(): DiscoveredProject | undefined;
  isDisposed(): boolean;
  reloadFinalState(): Promise<void>;
  flushDeferredChanges(): Promise<void>;
  /**
   * Fires once the mutation lock is actually released after a transaction
   * that called `reloadFinalState()` — the moment a background usage
   * refresh queued during that reload (see UsageAnalysisCoordinator's
   * `requestBackgroundUsageRefresh`) is allowed to actually start. Called
   * before `flushDeferredChanges()` awaits, so the background scan starts
   * without waiting on deferred watcher-event handling.
   */
  onMutationLockReleased?(): void;
  performanceEnabled?(): boolean;
  /** Test seam; production always uses the host-owned project loader. */
  loadProject?: (candidate: DiscoveredProject) => Promise<ResolvedProject>;
}

/** How long an opened-but-abandoned analysis holds the panel's upgrade lock before a later analyze request reclaims it. The real invalidation is always the disk-snapshot recheck below, not this — see handleConfirmUpgrade/handleUseSmartPlan. */
const ANALYSIS_TTL_MS = 10 * 60_000;

function toProtocolError(cause: unknown): ProtocolError {
  if (cause instanceof Error) return { code: cause.name, message: cause.message };
  return { code: 'UNKNOWN', message: String(cause) };
}

const ANALYSIS_LOOKUP_ERRORS: Record<AnalysisLookupRejection, ProtocolError> = {
  STALE_ANALYSIS: { code: 'STALE_ANALYSIS', message: 'This upgrade analysis is no longer current. Analyze again.' },
  NO_SMART_PLAN: { code: 'NO_SMART_PLAN', message: 'No coordinated upgrade plan was offered for this analysis.' },
  PREFLIGHT_CONFLICT: { code: 'PREFLIGHT_CONFLICT', message: 'Compatibility preflight found blocking peer conflicts.' },
};

const REMEDIATION_REQUEST_ERRORS: Record<RemediationRequestRejection, ProtocolError> = {
  UNKNOWN_PACKAGE: { code: 'UNKNOWN_PACKAGE', message: 'This package is not part of the current scan.' },
  NOT_TRANSITIVE_VULNERABILITY: {
    code: 'NOT_ELIGIBLE',
    message: 'This dependency has no transitive vulnerability that remediation analysis applies to.',
  },
};

/** `not-applicable` never reaches here — resolveRemediationRequest only ever accepts a row with real advisories. */
function toRemediationOutcomeStatus(status: SecurityOutcomeStatus): RemediationOutcomeStatus {
  if (status === 'resolved' || status === 'not-applicable') return 'resolved';
  if (status === 'unknown') return 'unknown';
  return 'remains';
}

export function compatibilitySummary(analysis: Awaited<ReturnType<typeof analyzeCompatibility>>): string[] {
  const important = analysis.findings.filter((finding) => finding.status !== 'compatible').slice(0, 4);
  return [
    `Result: ${analysis.status}${analysis.completeness === 'partial' ? ' (partial evidence)' : ''}.`,
    ...important.map((finding) => `• ${finding.explanation}`),
    ...(analysis.findings.length > important.length
      ? [`• ${analysis.findings.length - important.length} additional finding(s).`]
      : []),
    ...(analysis.resolverVerification === undefined
      ? []
      : [`Resolver: ${analysis.resolverVerification.explanation}`]),
  ];
}

interface StoredAnalysis {
  id: string;
  /** Original lookup keys — every item is re-validated fresh at confirm time. */
  requests: UpgradeMessage[];
  eligibility: EligibleUpgrade;
  /** The disk snapshot preflight ran against — the baseline the post-confirm recheck below compares fresh disk reads to. */
  snapshot: ResolvedProject;
  proposal: UpgradeProposal;
  compatibilityStatus: CompatibilityStatus;
  /** Set only when planSmartUpgrade found a validated coordinated plan — the only proposal `handleUseSmartPlan` is ever allowed to execute. */
  smartPlanProposal: UpgradeProposal | null;
  ignoreScripts: boolean;
  verificationScripts: VerificationScript[];
  expiresAt: number;
}

/** Same shape/lifecycle discipline as StoredAnalysis, minus everything specific to compatibility preflight/smart-plan — a removal has neither. */
interface StoredRemoval {
  id: string;
  requests: RemoveMessage[];
  /** The first, host-validated removal — the session's reserve/release key, same convention as StoredAnalysis.eligibility. */
  eligibility: EligibleRemoval;
  eligibilities: EligibleRemoval[];
  snapshot: ResolvedProject;
  ignoreScripts: boolean;
  verificationScripts: VerificationScript[];
  expiresAt: number;
}

interface SharedRemediationWork {
  performance?: PerformanceRecorder;
  prepared: SharedPromise<{
    materialized: Awaited<ReturnType<IsolatedResolverVerifier['materializeResolvedGraph']>>;
    advisoriesByName: ReturnType<typeof advisoriesByNameFromRows>;
  }>;
}

export class UpgradeAssistantCoordinator {
  private readonly session = new UpgradeExecutionSession();
  private readonly projectLoader: (candidate: DiscoveredProject) => Promise<ResolvedProject>;
  private analysis: StoredAnalysis | undefined;
  private removal: StoredRemoval | undefined;
  /** The package a handleAnalyzeUpgrade call is currently in flight for, or null — the target `cancel-upgrade { analysisId: null }` refers to, since no analysisId exists yet at that point. */
  private pendingAnalyzePackage: string | null = null;
  /** Set by a cancel-upgrade with `analysisId: null` that arrived mid-analysis — handleAnalyzeUpgrade checks this right before storing/posting its result and drops it instead. */
  private cancelRequestedFor: string | null = null;
  private activeRemediationAbort: AbortController | undefined;

  constructor(private readonly options: UpgradeAssistantCoordinatorOptions) {
    this.projectLoader = options.loadProject ?? loadProject;
  }

  isBusy(): boolean {
    return this.session.isBusy();
  }

  isRemediationBusy(): boolean {
    return this.activeRemediationAbort !== undefined;
  }

  /** Dispose immediately only when no mutation is in flight. */
  disposeWhenIdle(): void {
    this.activeRemediationAbort?.abort();
    if (!this.session.isBusy()) this.session.dispose();
  }

  /** An abandoned analysis (modal left open, never confirmed or cancelled) reclaims its lock once its TTL passes, so a later analyze request is never permanently blocked by it. */
  private reclaimExpiredAnalysis(): void {
    if (this.analysis !== undefined && Date.now() >= this.analysis.expiresAt) {
      this.session.release(this.analysis.eligibility.packageName);
      this.analysis = undefined;
    }
  }

  /** Same reclaim as reclaimExpiredAnalysis, for an abandoned removal review. */
  private reclaimExpiredRemoval(): void {
    if (this.removal !== undefined && Date.now() >= this.removal.expiresAt) {
      this.session.release(this.removal.eligibility.packageName);
      this.removal = undefined;
    }
  }

  /**
   * Phase 1: eligibility, lock, preflight, smart-plan search, security
   * outcome. Ends by storing the analysis and posting it — never by
   * executing anything.
   */
  async handleAnalyzeUpgrade(message: UpgradeMessage): Promise<void> {
    await this.handleAnalyzeUpgradeRequests([message]);
  }

  async handleAnalyzeBulkUpgrade(message: BulkUpgradeMessage): Promise<void> {
    await this.handleAnalyzeUpgradeRequests(message.changes);
  }

  private async handleAnalyzeUpgradeRequests(messages: readonly UpgradeMessage[]): Promise<void> {
    this.reclaimExpiredAnalysis();
    this.reclaimExpiredRemoval();

    if (this.activeRemediationAbort !== undefined) {
      this.options.sink.postMessage({
        status: 'upgrade-error',
        package: messages[0]?.package ?? 'unknown',
        error: { code: 'ANALYSIS_IN_PROGRESS', message: 'Wait for remediation analysis to finish before upgrading.' },
      });
      return;
    }

    const controller = await this.options.ensureController();
    if (controller === undefined) return;

    const batch = controller.validateBulkUpgradeRequest(messages);
    if (!batch.ok) {
      this.options.sink.postMessage({
        status: 'upgrade-error',
        package: batch.packageName ?? messages[0]?.package ?? 'unknown',
        error: describeBulkRejection(batch),
      });
      return;
    }
    const eligibility = batch.upgrades[0];
    if (eligibility === undefined) return;
    const eligibilities = batch.upgrades;

    // Reserve across preflight and however long the analysis modal stays
    // open, not merely process execution: forged requests cannot stack
    // analyses or race package managers, and only one package can be under
    // analysis for the whole panel at a time.
    if (!this.session.reserve(eligibility.packageName)) {
      this.options.sink.postMessage({
        status: 'upgrade-error',
        package: eligibility.packageName,
        error: { code: 'UPGRADE_IN_PROGRESS', message: 'Another upgrade is already in progress for this project.' },
      });
      return;
    }
    this.pendingAnalyzePackage = eligibility.packageName;

    // Set true only on the success path, right before the final return —
    // `finally` below releases the lock on every other exit (an early
    // return, a thrown error) since only a stored, still-open analysis is
    // allowed to keep holding it.
    let succeeded = false;
    const performance = createPerformanceSession(
      'Dependency Dashboard upgrade analysis',
      this.options.performanceEnabled?.() ?? false
    );
    performance.setMetadata('changes', eligibilities.length);
    try {
      const selected = this.options.getSelectedProject();
      if (selected === undefined) return;
      const source = controller.upgradeSource;
      const endProjectLoad = performance.start('action project reload');
      const preflightProject = await this.projectLoader(selected);
      endProjectLoad();
      if (
        preflightProject.root !== controller.root ||
        preflightProject.manifestText !== source.manifestText ||
        preflightProject.lockfileText !== source.lockfileText ||
        preflightProject.lockfilePath !== source.lockfilePath ||
        preflightProject.registry !== source.registry ||
        preflightProject.packageManager !== source.packageManager ||
        preflightProject.importerId !== source.importerId
      ) {
        this.options.sink.postMessage({
          status: 'upgrade-error',
          package: eligibility.packageName,
          error: { code: 'STALE_SOURCE', message: 'Project dependency files changed. Refresh and try again.' },
        });
        return;
      }

      const proposal: UpgradeProposal = {
        requested: {
          packageName: eligibility.packageName,
          currentVersion: eligibility.currentVersion,
          targetVersion: eligibility.target,
          classification: eligibility.classification,
        },
        changes: eligibilities.map((item) => ({
          packageName: item.packageName,
          currentVersion: item.currentVersion,
          targetVersion: item.target,
          classification: item.classification,
        })),
      };
      const endGraph = performance.start('action graph rebuild');
      const manifest = parseManifest(preflightProject.manifestText);
      const graph = buildDependencyGraph({
        root: preflightProject.root,
        manifest,
        lockfileText: preflightProject.lockfileText,
        packageManager: preflightProject.packageManager,
        importerId: preflightProject.importerId,
      });
      endGraph({ nodes: graph.nodes.size });
      const endToolchain = performance.start('package-manager resolution');
      const npmResolution = resolveNpmInvocation(createNodeNpmResolverDeps(controller.root));
      const packageManagerInvocation =
        !npmResolution.ok
          ? null
          : preflightProject.packageManager === 'npm'
            ? {
                executable: npmResolution.invocation.node,
                prefixArgs: [npmResolution.invocation.npmCliJs],
                version: npmResolution.invocation.version,
              }
            : resolveInstalledPnpmInvocation(npmResolution.invocation, controller.root);
      endToolchain({ available: packageManagerInvocation !== null });
      const resolverVerifier = packageManagerInvocation !== null
        ? new IsolatedResolverVerifier({
            packageManager: preflightProject.packageManager,
            packageManagerVersion: packageManagerInvocation.version ?? null,
            invocation: packageManagerInvocation,
            manifestText: preflightProject.manifestText,
            ...(preflightProject.lockfileText === null || preflightProject.lockfileName === null
              ? {}
              : {
                  lockfile: {
                    name: preflightProject.lockfileName,
                    text: preflightProject.lockfileText,
                  },
                }),
            registry: preflightProject.registry,
            policy: preflightProject.peerPolicy,
          })
        : undefined;
      const metadataProvider = new RegistryPackageMetadataProvider(
        this.options.httpClient,
        this.options.etagStore,
        preflightProject.resolvedRegistry
      );

      this.options.sink.postMessage({ status: 'upgrade-analyzing', package: eligibility.packageName, phase: 'compatibility' });
      const endCompatibility = performance.start('compatibility preflight');
      const analysis = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title:
            eligibilities.length === 1
              ? `Checking compatibility for ${eligibility.packageName}@${eligibility.target}`
              : `Checking compatibility for ${eligibilities.length} dependency upgrades`,
          cancellable: true,
        },
        async (_progress, token) => {
          const abort = new AbortController();
          const cancellation = token.onCancellationRequested(() => abort.abort());
          try {
            return await analyzeCompatibility({
              graph,
              proposal,
              metadataProvider,
              policy: preflightProject.peerPolicy,
              ...(resolverVerifier === undefined ? {} : { resolverVerifier }),
              signal: abort.signal,
            });
          } finally {
            cancellation.dispose();
          }
        }
      );
      endCompatibility({ status: analysis.status });

      let smartPlan: UpgradeAnalysisSmartPlan | null = null;
      let smartPlanProposal: UpgradeProposal | null = null;
      if (analysis.status === 'conflict') {
        const declaredByName = new Map(manifest.dependencies.map((dependency) => [dependency.name, dependency]));
        const upgradeableDirectDependencies = directNodes(graph).flatMap((node) => {
          const declared = declaredByName.get(node.name);
          if (declared === undefined || node.version === null) return [];
          return [{
            packageName: node.name,
            currentVersion: node.version,
            classification: declared.optional ? ('optional' as const) : declared.dev ? ('dev' as const) : ('prod' as const),
          }];
        });
        this.options.sink.postMessage({ status: 'upgrade-analyzing', package: eligibility.packageName, phase: 'smart-plan' });
        const endSmartPlan = performance.start('smart-plan search');
        const planned = await planSmartUpgrade({
          graph,
          initialAnalysis: analysis,
          upgradeableDirectDependencies,
          candidateProvider: {
            getStableVersionCandidates: async (packageName, signal) => {
              const packument = await fetchPackument(
                this.options.httpClient,
                this.options.etagStore,
                registryForPackage(preflightProject.resolvedRegistry, packageName),
                packageName,
                signal
              );
              return { versions: packument.versions, complete: true };
            },
          },
          metadataProvider,
          policy: preflightProject.peerPolicy,
          ...(resolverVerifier === undefined ? {} : { resolverVerifier }),
        });
        endSmartPlan({ outcome: planned.outcome, checks: planned.statistics.compatibilityChecks });
        // A conflict with no coordinated plan is not an error here — the
        // analysis is still shown, honestly, as a conflict with no smart-plan
        // option; the modal offers only Close (see spec's conflict-action
        // rules). Only genuinely offer the option when one was actually found
        // and validated.
        if (planned.outcome === 'found') {
          smartPlanProposal = planned.plan.proposal;
          smartPlan = {
            changes: planned.plan.proposal.changes.map((change) => ({
              packageName: change.packageName,
              currentVersion: change.currentVersion,
              targetVersion: change.targetVersion,
            })),
            reasonFindingIds: [...new Set(planned.plan.groups.flatMap((group) => group.reasonFindingIds))],
          };
        }
      }

      const ignoreScripts = vscode.workspace
        .getConfiguration('dependencyDashboard')
        .get<boolean>('upgrade.ignoreScripts', true);
      const configuredVerification = vscode.workspace
        .getConfiguration('dependencyDashboard')
        .get<unknown[]>('upgrade.verificationScripts', []);
      const verificationScripts = selectVerificationScripts(source.manifestText, configuredVerification);

      // --- security outcome (best-effort; never blocks the rest of the analysis) ---
      const rows = controller.lastResultRows();
      let security: SecurityOutcome | null = null;
      const securityInputs = eligibilities.flatMap((item) => {
        const before = rows.find((row) => row.name === item.packageName)?.advisories ?? [];
        return before.length === 0 ? [] : [{ item, before }];
      });
      if (securityInputs.length > 0) {
        let after: Parameters<typeof evaluateSecurityOutcome>[0]['after'] = 'no-resolver-evidence';
        if (analysis.status !== 'conflict' && resolverVerifier !== undefined) {
          try {
            const endSecurityResolver = performance.start('security graph materialization');
            const materialized = await resolverVerifier.materializeResolvedGraph(proposal);
            endSecurityResolver({ resolved: materialized.ok });
            if (materialized.ok) {
              after = { graph: materialized.graph, advisoriesByName: advisoriesByNameFromRows(rows) };
            }
          } catch {
            // Left as 'no-resolver-evidence' — never a hard failure of the analysis.
          }
        }
        security = combineSecurityOutcomes(
          securityInputs.map(({ item, before }) =>
            evaluateSecurityOutcome({
              before,
              targetVersion: item.target,
              rootPackageName: item.packageName,
              after,
            })
          )
        );
      }

      // A cancel-upgrade with `analysisId: null` arrived while the above was
      // in flight — drop the result rather than storing/posting it, and let
      // `finally` release the lock like any other unsuccessful exit.
      if (this.cancelRequestedFor === eligibility.packageName) {
        this.cancelRequestedFor = null;
        return;
      }

      const manifestPath = path.join(controller.root, 'package.json');
      const expectedLockfilePath =
        source.lockfilePath ??
        path.join(controller.root, source.packageManager === 'pnpm' ? 'pnpm-lock.yaml' : 'package-lock.json');

      const analysisId = randomBytes(16).toString('hex');
      this.analysis = {
        id: analysisId,
        requests: [...messages],
        eligibility,
        snapshot: preflightProject,
        proposal,
        compatibilityStatus: analysis.status,
        smartPlanProposal,
        ignoreScripts,
        verificationScripts,
        expiresAt: Date.now() + ANALYSIS_TTL_MS,
      };

      this.options.sink.postMessage({
        status: 'upgrade-analysis',
        analysis: buildUpgradeAnalysisPresentation({
          analysisId,
          packageName: eligibility.packageName,
          currentVersion: eligibility.currentVersion,
          targetVersion: eligibility.target,
          classification: eligibility.classification,
          changes: eligibilities.map((item) => ({
            packageName: item.packageName,
            currentVersion: item.currentVersion,
            targetVersion: item.target,
            classification: item.classification,
          })),
          compatibility: {
            status: analysis.status,
            completeness: analysis.completeness,
            findings: analysis.findings,
            ...(analysis.resolverVerification === undefined ? {} : { resolverVerification: analysis.resolverVerification }),
          },
          security,
          smartPlan,
          verificationScriptNames: verificationScripts.map((script) => script.scriptName),
          manifestPath,
          lockfilePath: expectedLockfilePath,
        }),
      });
      // Lock intentionally NOT released here — held until confirm, cancel, or
      // TTL reclaim. See handleConfirmUpgrade/handleUseSmartPlan/handleCancelUpgrade.
      succeeded = true;
      return;
    } catch (cause) {
      if (!this.options.isDisposed()) {
        this.options.sink.postMessage({
          status: 'upgrade-error',
          package: eligibility.packageName,
          error:
            cause instanceof CompatibilityCancelledError
              ? { code: 'CANCELLED', message: 'Compatibility preflight was cancelled.' }
              : toProtocolError(cause),
        });
      }
      return;
    } finally {
      if (!succeeded) this.session.release(eligibility.packageName);
      if (this.pendingAnalyzePackage === eligibility.packageName) this.pendingAnalyzePackage = null;
      if (this.cancelRequestedFor === eligibility.packageName) this.cancelRequestedFor = null;
      performance.finish({ completed: succeeded });
    }
  }

  async handleConfirmUpgrade(message: AnalysisMessage): Promise<void> {
    await this.executeStoredAnalysis(message.analysisId, false);
  }

  async handleUseSmartPlan(message: AnalysisMessage): Promise<void> {
    await this.executeStoredAnalysis(message.analysisId, true);
  }

  handleCancelUpgrade(message: CancelUpgradeMessage): void {
    if (message.analysisId === null) {
      // No analysis exists yet — mark the in-flight one (if any) so
      // handleAnalyzeUpgrade drops its own result instead of storing/posting
      // it. The lock itself is released by that method's own `finally`, not
      // here — nothing to release yet if it's still running.
      if (this.pendingAnalyzePackage !== null) this.cancelRequestedFor = this.pendingAnalyzePackage;
      return;
    }
    if (this.analysis === undefined || this.analysis.id !== message.analysisId) return;
    this.session.release(this.analysis.eligibility.packageName);
    this.analysis = undefined;
  }

  handleConfigureVerification(): void {
    void vscode.commands.executeCommand(
      'workbench.action.openSettings',
      'dependencyDashboard.upgrade.verificationScripts'
    );
  }

  /**
   * Analyze phase for a coordinated removal — eligibility, the same
   * panel-wide lock an upgrade reserves, and a non-blocking dependency-graph
   * impact check (does anything else still resolve through what's being
   * removed). No compatibility preflight, no smart-plan search, no security
   * outcome — none apply to removing a declared dependency outright. Ends by
   * storing the analysis and posting it, exactly like handleAnalyzeUpgrade —
   * never by executing anything.
   */
  async handleAnalyzeBulkRemove(message: BulkRemoveMessage): Promise<void> {
    this.reclaimExpiredAnalysis();
    this.reclaimExpiredRemoval();

    if (this.activeRemediationAbort !== undefined) {
      this.options.sink.postMessage({
        status: 'remove-error',
        package: message.changes[0]?.package ?? 'unknown',
        error: { code: 'ANALYSIS_IN_PROGRESS', message: 'Wait for remediation analysis to finish before removing dependencies.' },
      });
      return;
    }

    const controller = await this.options.ensureController();
    if (controller === undefined) return;

    const batch = controller.validateBulkRemoveRequest(message.changes);
    if (!batch.ok) {
      this.options.sink.postMessage({
        status: 'remove-error',
        package: batch.packageName ?? message.changes[0]?.package ?? 'unknown',
        error: describeBulkRemoveRejection(batch),
      });
      return;
    }
    const eligibility = batch.removals[0];
    if (eligibility === undefined) return;
    const eligibilities = batch.removals;

    // Same reservation discipline as an upgrade — held across analysis and
    // however long the review modal stays open, not merely execution.
    if (!this.session.reserve(eligibility.packageName)) {
      this.options.sink.postMessage({
        status: 'remove-error',
        package: eligibility.packageName,
        // Reuses the upgrade flow's own code: it is the same panel-wide
        // lock, so the webview's existing upgradeErrorClearsActiveState/
        // upgradeErrorIsUserVisible already treat this race the right way
        // (quiet, doesn't clear whatever this webview is itself tracking).
        error: { code: 'UPGRADE_IN_PROGRESS', message: 'Another dependency operation is already in progress for this project.' },
      });
      return;
    }

    let succeeded = false;
    try {
      const selected = this.options.getSelectedProject();
      if (selected === undefined) return;
      const source = controller.upgradeSource;
      const preflightProject = await this.projectLoader(selected);
      if (
        preflightProject.root !== controller.root ||
        preflightProject.manifestText !== source.manifestText ||
        preflightProject.lockfileText !== source.lockfileText ||
        preflightProject.lockfilePath !== source.lockfilePath ||
        preflightProject.registry !== source.registry ||
        preflightProject.packageManager !== source.packageManager ||
        preflightProject.importerId !== source.importerId
      ) {
        this.options.sink.postMessage({
          status: 'remove-error',
          package: eligibility.packageName,
          error: { code: 'STALE_SOURCE', message: 'Project dependency files changed. Refresh and try again.' },
        });
        return;
      }

      this.options.sink.postMessage({ status: 'remove-analyzing', package: eligibility.packageName });

      const manifest = parseManifest(preflightProject.manifestText);
      const graph = buildDependencyGraph({
        root: preflightProject.root,
        manifest,
        lockfileText: preflightProject.lockfileText,
        packageManager: preflightProject.packageManager,
        importerId: preflightProject.importerId,
      });
      const removingNames = new Set(eligibilities.map((item) => item.packageName));
      const changes = eligibilities.map((item) => ({
        packageName: item.packageName,
        classification: item.classification,
        stillRequiredBy: stillRequiredBy(graph, manifest.dependencies, item.packageName, removingNames),
      }));

      const manifestPath = path.join(controller.root, 'package.json');
      const expectedLockfilePath =
        source.lockfilePath ??
        path.join(controller.root, source.packageManager === 'pnpm' ? 'pnpm-lock.yaml' : 'package-lock.json');

      const ignoreScripts = vscode.workspace
        .getConfiguration('dependencyDashboard')
        .get<boolean>('upgrade.ignoreScripts', true);
      const configuredVerification = vscode.workspace
        .getConfiguration('dependencyDashboard')
        .get<unknown[]>('upgrade.verificationScripts', []);
      const verificationScripts = selectVerificationScripts(source.manifestText, configuredVerification);

      const analysisId = randomBytes(16).toString('hex');
      this.removal = {
        id: analysisId,
        requests: [...message.changes],
        eligibility,
        eligibilities,
        snapshot: preflightProject,
        ignoreScripts,
        verificationScripts,
        expiresAt: Date.now() + ANALYSIS_TTL_MS,
      };

      this.options.sink.postMessage({
        status: 'remove-analysis',
        analysis: buildRemoveAnalysisPresentation({
          analysisId,
          packageName: eligibility.packageName,
          changes,
          verificationScriptNames: verificationScripts.map((script) => script.scriptName),
          manifestPath,
          lockfilePath: expectedLockfilePath,
        }),
      });
      // Lock intentionally NOT released here — held until confirm, cancel, or TTL reclaim.
      succeeded = true;
      return;
    } catch (cause) {
      if (!this.options.isDisposed()) {
        this.options.sink.postMessage({ status: 'remove-error', package: eligibility.packageName, error: toProtocolError(cause) });
      }
      return;
    } finally {
      if (!succeeded) this.session.release(eligibility.packageName);
    }
  }

  async handleConfirmRemove(message: AnalysisMessage): Promise<void> {
    await this.executeStoredRemoval(message.analysisId);
  }

  handleCancelRemove(message: CancelUpgradeMessage): void {
    // Removal's analyze phase has nothing long-running to drop mid-flight
    // (no network preflight, unlike an upgrade) — only a real, already-
    // delivered analysis is ever cancellable.
    if (message.analysisId === null) return;
    if (this.removal === undefined || this.removal.id !== message.analysisId) return;
    this.session.release(this.removal.eligibility.packageName);
    this.removal = undefined;
  }

  /**
   * "Analyze remediation" for a transitive vulnerability with no direct
   * upgrade target — see resolveRemediationRequest
   * (src/core/advisories/remediationRequest.ts) for the eligibility check
   * and upgradeAction.ts's `transitive-remediation` state for where this is
   * triggered from.
   *
   * Read-only start to finish: no manifest/lockfile write, no package-manager
   * lock reserved (`dashboardPanel.ts` still refuses this while an upgrade
   * holds the panel-wide lock, the same way it already refuses refresh/
   * change-project, since a concurrent disk read could otherwise race an
   * in-flight upgrade's file writes). The one real question this can answer
   * is: does the isolated resolver, run *without* the existing lockfile,
   * settle on a tree where the row's known advisories no longer appear? A
   * `changes: []` proposal is IsolatedResolverVerifier's dedicated no-op
   * shape for exactly this (see its own doc) — the manifest is staged
   * unchanged, and omitting `lockfile` below is what forces a fully fresh
   * resolution from declared ranges rather than reusing pinned transitive
   * versions. This never searches for a coordinated direct-dependency
   * upgrade (that would need a second, vulnerability-aware planner distinct
   * from planSmartUpgrade's peer-conflict-driven search) — a vulnerability
   * that a fresh resolve does not clear is honestly reported as
   * `no-direct-fix`, never guessed at further.
   */
  async handleAnalyzeRemediation(message: RemediationMessage): Promise<void> {
    if (this.activeRemediationAbort !== undefined) {
      this.options.sink.postMessage({
        status: 'remediation-error',
        package: message.package,
        error: { code: 'ANALYSIS_IN_PROGRESS', message: 'Another remediation analysis is already in progress.' },
      });
      return;
    }
    const abort = new AbortController();
    this.activeRemediationAbort = abort;
    const performance = createPerformanceSession(
      'Dependency Dashboard remediation analysis',
      this.options.performanceEnabled?.() ?? false
    );
    try {
      await this.analyzeRemediation(message, abort.signal, { performance, prepared: new SharedPromise() });
    } finally {
      if (this.activeRemediationAbort === abort) this.activeRemediationAbort = undefined;
      performance.finish({ packages: 1 });
    }
  }

  async handleAnalyzeRemediations(message: RemediationBatchMessage): Promise<void> {
    if (this.activeRemediationAbort !== undefined) {
      this.options.sink.postMessage({
        status: 'remediation-batch-error',
        error: { code: 'ANALYSIS_IN_PROGRESS', message: 'Another remediation analysis is already in progress.' },
      });
      return;
    }
    const abort = new AbortController();
    this.activeRemediationAbort = abort;
    const total = message.packages.length;
    const performance = createPerformanceSession(
      'Dependency Dashboard bulk remediation analysis',
      this.options.performanceEnabled?.() ?? false
    );
    // A lockfile-free remediation resolve depends on the project's declared
    // ranges, not on which vulnerable row will later be evaluated against the
    // resulting graph. Share that immutable fresh resolve across this one
    // logical batch instead of reloading the project, probing npm/pnpm, and
    // running an identical package-manager subprocess once per row.
    const sharedWork: SharedRemediationWork = { performance, prepared: new SharedPromise() };
    try {
      const result = await runSequentialBatch({
        items: message.packages,
        signal: abort.signal,
        onStart: (packageName, completed) => {
          this.options.sink.postMessage({ status: 'remediation-batch-progress', completed, total, current: packageName });
        },
        run: async (packageName, signal) => this.analyzeRemediation({ package: packageName }, signal, sharedWork),
        onError: (packageName, cause) => {
          if (!this.options.isDisposed()) {
            this.options.sink.postMessage({
              status: 'remediation-error',
              package: packageName,
              error: toProtocolError(cause),
            });
          }
        },
      });
      this.options.sink.postMessage({
        status: 'remediation-batch-complete',
        completed: result.completed,
        total,
        cancelled: result.cancelled,
      });
    } finally {
      if (this.activeRemediationAbort === abort) this.activeRemediationAbort = undefined;
      performance.finish({ packages: total });
    }
  }

  handleCancelRemediation(): void {
    this.activeRemediationAbort?.abort();
  }

  private async analyzeRemediation(
    message: RemediationMessage,
    signal: AbortSignal,
    sharedWork: SharedRemediationWork
  ): Promise<void> {
    const controller = await this.options.ensureController();
    if (controller === undefined) return;

    const eligibility = resolveRemediationRequest(controller.lastResultRows(), message.package);
    if (!eligibility.ok) {
      this.options.sink.postMessage({
        status: 'remediation-error',
        package: message.package,
        error: REMEDIATION_REQUEST_ERRORS[eligibility.reason],
      });
      return;
    }
    const { row } = eligibility;
    // resolveRemediationRequest already guarantees this; re-asserted for the
    // type checker without weakening the check itself.
    if (row.current === null) return;
    const currentVersion = row.current;

    this.options.sink.postMessage({ status: 'remediation-analyzing', package: row.name });

    try {
      const noOpProposal: UpgradeProposal = {
        requested: {
          packageName: row.name,
          currentVersion,
          targetVersion: currentVersion,
          classification: row.dev ? 'dev' : 'prod',
        },
        changes: [],
      };
      const prepared = await sharedWork.prepared.get(() =>
        this.prepareRemediationWork(controller, noOpProposal, row.name, signal, sharedWork.performance)
      );
      if (signal.aborted) return;
      const { materialized } = prepared;

      if (this.options.isDisposed()) return;

      if (!materialized.ok) {
        this.options.sink.postMessage({
          status: 'remediation-result',
          package: row.name,
          result: {
            status: 'unknown',
            security: {
              status: 'unknown',
              resolvedAdvisories: [],
              remaining: row.advisories.map((entry) => ({
                advisory: entry.advisory,
                flaggedPackage: entry.flaggedPackage,
                path: entry.path,
                status: 'unknown',
                resolvedVersion: null,
                patchedVersion: entry.patchedVersion,
              })),
            },
          },
        });
        return;
      }

      const security = evaluateSecurityOutcome({
        before: row.advisories,
        targetVersion: currentVersion,
        rootPackageName: row.name,
        after: { graph: materialized.graph, advisoriesByName: prepared.advisoriesByName },
      });

      this.options.sink.postMessage({
        status: 'remediation-result',
        package: row.name,
        result: { status: toRemediationOutcomeStatus(security.status), security },
      });
    } catch (cause) {
      if (!this.options.isDisposed() && !signal.aborted) {
        this.options.sink.postMessage({ status: 'remediation-error', package: row.name, error: toProtocolError(cause) });
      }
    }
  }

  private async prepareRemediationWork(
    controller: DashboardController,
    noOpProposal: UpgradeProposal,
    packageName: string,
    signal: AbortSignal,
    performance?: PerformanceRecorder
  ): Promise<{
    materialized: Awaited<ReturnType<IsolatedResolverVerifier['materializeResolvedGraph']>>;
    advisoriesByName: ReturnType<typeof advisoriesByNameFromRows>;
  }> {
    const selected = this.options.getSelectedProject();
    if (selected === undefined) throw Object.assign(new Error('No project is selected.'), { name: 'NO_PROJECT' });
    const endProjectLoad = performance?.start('remediation project reload') ?? (() => 0);
    const preflightProject = await this.projectLoader(selected);
    endProjectLoad();
    const source = controller.upgradeSource;
    if (
      preflightProject.root !== controller.root ||
      preflightProject.manifestText !== source.manifestText ||
      preflightProject.lockfileText !== source.lockfileText ||
      preflightProject.lockfilePath !== source.lockfilePath ||
      preflightProject.registry !== source.registry ||
      preflightProject.packageManager !== source.packageManager ||
      preflightProject.importerId !== source.importerId
    ) {
      throw Object.assign(new Error('Project dependency files changed. Refresh and try again.'), {
        name: 'STALE_SOURCE',
      });
    }

    const endToolchain = performance?.start('remediation package-manager resolution') ?? (() => 0);
    const npmResolution = resolveNpmInvocation(createNodeNpmResolverDeps(controller.root));
    const packageManagerInvocation =
      !npmResolution.ok
        ? null
        : preflightProject.packageManager === 'npm'
          ? {
              executable: npmResolution.invocation.node,
              prefixArgs: [npmResolution.invocation.npmCliJs],
              version: npmResolution.invocation.version,
            }
          : resolveInstalledPnpmInvocation(npmResolution.invocation, controller.root);
    endToolchain({ available: packageManagerInvocation !== null });
    if (packageManagerInvocation === null) {
      throw Object.assign(new Error('The package manager could not be located to run this check.'), {
        name: 'RESOLVER_UNAVAILABLE',
      });
    }

    const resolverVerifier = new IsolatedResolverVerifier({
      packageManager: preflightProject.packageManager,
      packageManagerVersion: packageManagerInvocation.version ?? null,
      invocation: packageManagerInvocation,
      manifestText: preflightProject.manifestText,
      // No lockfile: this intentionally computes one fresh graph from the
      // unchanged declared ranges for every row in this logical batch.
      registry: preflightProject.registry,
      policy: preflightProject.peerPolicy,
    });
    const endMaterialization = performance?.start('remediation graph materialization') ?? (() => 0);
    const materialized = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Checking remediation for ${packageName}`,
        cancellable: true,
      },
      async (_progress, token) => {
        const abort = new AbortController();
        const cancellation = token.onCancellationRequested(() => abort.abort());
        const externalCancellation = (): void => abort.abort();
        signal.addEventListener('abort', externalCancellation, { once: true });
        if (signal.aborted) abort.abort();
        try {
          return await resolverVerifier.materializeResolvedGraph(noOpProposal, abort.signal);
        } finally {
          cancellation.dispose();
          signal.removeEventListener('abort', externalCancellation);
        }
      }
    );
    endMaterialization({ resolved: materialized.ok });
    return {
      materialized,
      advisoriesByName: advisoriesByNameFromRows(controller.lastResultRows()),
    };
  }

  /**
   * Phase 2, shared by confirm-upgrade and use-smart-plan: look up the
   * stored analysis (via the pure, unit-tested resolveAnalysisForExecution —
   * see upgradeAnalysisLookup.ts for why that check lives there rather than
   * inline here), re-run the exact same disk-reread + eligibility recheck
   * the old single-method flow ran right after its native dialog resolved,
   * then execute.
   */
  private async executeStoredAnalysis(analysisId: string, wantsSmartPlan: boolean): Promise<void> {
    const stored = this.analysis;
    const lookup = resolveAnalysisForExecution({
      stored:
        stored === undefined
          ? undefined
          : {
              id: stored.id,
              compatibilityStatus: stored.compatibilityStatus,
              hasSmartPlan: stored.smartPlanProposal !== null,
              expiresAt: stored.expiresAt,
            },
      requestedAnalysisId: analysisId,
      now: Date.now(),
      wantsSmartPlan,
    });
    if (!lookup.ok || stored === undefined) {
      this.options.sink.postMessage({
        status: 'upgrade-error',
        package: stored?.eligibility.packageName ?? 'unknown',
        error: ANALYSIS_LOOKUP_ERRORS[lookup.ok ? 'STALE_ANALYSIS' : lookup.reason],
      });
      return;
    }
    // `wantsSmartPlan` guarantees `hasSmartPlan` was true for `lookup.ok` to
    // be true, so `smartPlanProposal` is never null here — the `??`
    // fallback below only exists to satisfy the type checker, not because
    // this path is reachable.
    const proposal = wantsSmartPlan ? (stored.smartPlanProposal ?? stored.proposal) : stored.proposal;

    // Single-use: cleared now, regardless of outcome, so a retry always goes
    // through a fresh handleAnalyzeUpgrade.
    this.analysis = undefined;

    const controller = await this.options.ensureController();
    if (controller === undefined) {
      this.session.release(stored.eligibility.packageName);
      return;
    }

    try {
      const selected = this.options.getSelectedProject();
      if (selected === undefined) return;

      // A modal can remain open while project/config files change. Re-read
      // and repeat the host-owned eligibility check immediately before the
      // snapshot; the stored analysis is never execution authority.
      const disk = await this.projectLoader(selected);
      const sourceStillMatches =
        disk.root === controller.root &&
        disk.manifestText === stored.snapshot.manifestText &&
        disk.lockfileText === stored.snapshot.lockfileText &&
        disk.lockfilePath === stored.snapshot.lockfilePath &&
        disk.registry === stored.snapshot.registry &&
        disk.packageManager === stored.snapshot.packageManager &&
        disk.importerId === stored.snapshot.importerId &&
        JSON.stringify(disk.peerPolicy) === JSON.stringify(stored.snapshot.peerPolicy) &&
        JSON.stringify(disk.resolvedRegistry) === JSON.stringify(stored.snapshot.resolvedRegistry);
      const rechecked = controller.validateBulkUpgradeRequest(stored.requests);
      if (!sourceStillMatches || !rechecked.ok) {
        this.options.sink.postMessage({
          status: 'upgrade-error',
          package: stored.eligibility.packageName,
          error: {
            code: 'STALE_SOURCE',
            message: 'Project dependency files changed while the analysis was open. Refresh and try again.',
          },
        });
        return;
      }

      const source = controller.upgradeSource;
      const manifestPath = path.join(controller.root, 'package.json');
      const expectedLockfilePath =
        source.lockfilePath ??
        path.join(controller.root, source.packageManager === 'pnpm' ? 'pnpm-lock.yaml' : 'package-lock.json');
      const allowlistedPaths = [manifestPath, expectedLockfilePath];
      const usesStagedManifest = requiresManifestReconciliation(proposal.changes);
      const stagedManifest = usesStagedManifest
        ? buildStagedManifest(
            disk.manifestText,
            proposal.changes.map((change) => ({
              packageName: change.packageName,
              target: change.targetVersion,
              classification: change.classification,
            }))
          )
        : null;

      const files = await createNodeUpgradeTransactionFileAdapter({
        workspaceRoot: selected.folder.uri.fsPath,
        allowlistedPaths,
      });

      const runParams = {
        packageName: stored.eligibility.packageName,
        currentVersion: stored.eligibility.currentVersion,
        target: stored.eligibility.target,
        classification: stored.eligibility.classification,
        cwd: controller.root,
        ignoreScripts: stored.ignoreScripts,
        packageManager: source.packageManager,
        coordinatedChanges: proposal.changes.map((change) => ({
          packageName: change.packageName,
          target: change.targetVersion,
          classification: change.classification,
        })),
      };

      let executeInstall: () => Promise<Awaited<ReturnType<UpgradeExecutionSession['run']>>>;
      if (usesStagedManifest) {
        const prepared = this.session.prepareManifestReconciliation({
          cwd: controller.root,
          ignoreScripts: stored.ignoreScripts,
          packageManager: source.packageManager,
        });
        if (!prepared.ok) {
          this.options.sink.postMessage({
            status: 'upgrade-error',
            package: stored.eligibility.packageName,
            error: { code: prepared.code, message: prepared.message },
          });
          return;
        }
        executeInstall = prepared.execute;
      } else {
        executeInstall = () => this.session.run(runParams);
      }

      const transaction = await runUpgradeTransaction({
        allowlistedPaths,
        files,
        ...(stagedManifest === null
          ? {}
          : {
              manifestStage: {
                path: manifestPath,
                expectedContents: Buffer.from(disk.manifestText, 'utf8'),
                contents: Buffer.from(stagedManifest, 'utf8'),
              },
            }),
        install: {
          execute: async () => {
            const outcome = await executeInstall();
            return outcome.ok
              ? { status: 'succeeded' as const }
              : { status: 'failed' as const, code: outcome.code, message: outcome.message };
          },
        },
        ...(stored.verificationScripts.length === 0
          ? {}
          : {
              verifier: {
                verify: () =>
                  this.session.verify({
                    packageName: stored.eligibility.packageName,
                    cwd: controller.root,
                    packageManager: source.packageManager,
                    scripts: stored.verificationScripts,
                  }),
              },
              verificationFailureDecider: {
                decide: async () => {
                  if (this.options.isDisposed()) return 'rollback' as const;
                  const choice = await vscode.window.showWarningMessage(
                    'The dependency installed, but post-upgrade verification failed.',
                    {
                      modal: true,
                      detail:
                        'Rollback restores only package.json and the active lockfile captured by this upgrade transaction; ' +
                        'it does not restore node_modules or files changed by lifecycle/verification scripts.',
                    },
                    'Rollback',
                    'Keep Changes'
                  );
                  return choice === 'Keep Changes' ? ('keep' as const) : ('rollback' as const);
                },
              },
            }),
      });

      // Reload the kept/restored/partial state while the coordinator still
      // owns the project-wide mutation lock.
      if (!this.options.isDisposed()) await this.options.reloadFinalState();
      if (this.options.isDisposed()) return;

      const presentation = describeUpgradeTransactionOutcome(
        stored.eligibility.packageName,
        source.packageManager,
        transaction
      );
      if (presentation.kind === 'verified') {
        void vscode.window.showInformationMessage(presentation.message);
      } else if (presentation.kind === 'error') {
        this.options.sink.postMessage({
          status: 'upgrade-error',
          package: stored.eligibility.packageName,
          error: presentation.error,
        });
      } else {
        void vscode.window.showWarningMessage(presentation.message);
      }
    } catch (cause) {
      if (!this.options.isDisposed()) {
        this.options.sink.postMessage({
          status: 'upgrade-error',
          package: stored.eligibility.packageName,
          error: toProtocolError(cause),
        });
      }
    } finally {
      this.session.release(stored.eligibility.packageName);
      this.options.onMutationLockReleased?.();
      // Watcher events received during the lock are deferred, never dropped.
      await this.options.flushDeferredChanges();
      if (this.options.isDisposed()) this.session.dispose();
    }
  }

  /**
   * Phase 2 for a removal: look up the stored analysis, re-run the same
   * disk-reread + eligibility recheck executeStoredAnalysis runs for an
   * upgrade, then stage package.json with the removed keys deleted and
   * reconcile via the same manifest-reconciliation path a mixed-
   * classification coordinated upgrade already uses — see
   * UpgradeExecutionSession.prepareManifestReconciliation, which accepts no
   * package/version input at all and simply reconciles whatever the host
   * already staged.
   */
  private async executeStoredRemoval(analysisId: string): Promise<void> {
    const stored = this.removal;
    if (stored === undefined || stored.id !== analysisId || Date.now() >= stored.expiresAt) {
      this.options.sink.postMessage({
        status: 'remove-error',
        package: stored?.eligibility.packageName ?? 'unknown',
        error: { code: 'STALE_ANALYSIS', message: 'This removal analysis is no longer current. Analyze again.' },
      });
      return;
    }

    // Single-use: cleared now, regardless of outcome, so a retry always goes through a fresh handleAnalyzeBulkRemove.
    this.removal = undefined;

    const controller = await this.options.ensureController();
    if (controller === undefined) {
      this.session.release(stored.eligibility.packageName);
      return;
    }

    try {
      const selected = this.options.getSelectedProject();
      if (selected === undefined) return;

      const disk = await this.projectLoader(selected);
      const sourceStillMatches =
        disk.root === controller.root &&
        disk.manifestText === stored.snapshot.manifestText &&
        disk.lockfileText === stored.snapshot.lockfileText &&
        disk.lockfilePath === stored.snapshot.lockfilePath &&
        disk.registry === stored.snapshot.registry &&
        disk.packageManager === stored.snapshot.packageManager &&
        disk.importerId === stored.snapshot.importerId;
      const rechecked = controller.validateBulkRemoveRequest(stored.requests);
      if (!sourceStillMatches || !rechecked.ok) {
        this.options.sink.postMessage({
          status: 'remove-error',
          package: stored.eligibility.packageName,
          error: {
            code: 'STALE_SOURCE',
            message: 'Project dependency files changed while the analysis was open. Refresh and try again.',
          },
        });
        return;
      }

      const source = controller.upgradeSource;
      const manifestPath = path.join(controller.root, 'package.json');
      const expectedLockfilePath =
        source.lockfilePath ??
        path.join(controller.root, source.packageManager === 'pnpm' ? 'pnpm-lock.yaml' : 'package-lock.json');
      const allowlistedPaths = [manifestPath, expectedLockfilePath];

      const stagedManifest = buildStagedManifestForRemoval(
        disk.manifestText,
        stored.eligibilities.map((item) => ({ packageName: item.packageName, classification: item.classification }))
      );

      const files = await createNodeUpgradeTransactionFileAdapter({
        workspaceRoot: selected.folder.uri.fsPath,
        allowlistedPaths,
      });

      const prepared = this.session.prepareManifestReconciliation({
        cwd: controller.root,
        ignoreScripts: stored.ignoreScripts,
        packageManager: source.packageManager,
      });
      if (!prepared.ok) {
        this.options.sink.postMessage({
          status: 'remove-error',
          package: stored.eligibility.packageName,
          error: { code: prepared.code, message: prepared.message },
        });
        return;
      }

      const transaction = await runUpgradeTransaction({
        allowlistedPaths,
        files,
        manifestStage: {
          path: manifestPath,
          expectedContents: Buffer.from(disk.manifestText, 'utf8'),
          contents: Buffer.from(stagedManifest, 'utf8'),
        },
        install: {
          execute: async () => {
            const outcome = await prepared.execute();
            return outcome.ok
              ? { status: 'succeeded' as const }
              : { status: 'failed' as const, code: outcome.code, message: outcome.message };
          },
        },
        ...(stored.verificationScripts.length === 0
          ? {}
          : {
              verifier: {
                verify: () =>
                  this.session.verify({
                    packageName: stored.eligibility.packageName,
                    cwd: controller.root,
                    packageManager: source.packageManager,
                    scripts: stored.verificationScripts,
                  }),
              },
              verificationFailureDecider: {
                decide: async () => {
                  if (this.options.isDisposed()) return 'rollback' as const;
                  const choice = await vscode.window.showWarningMessage(
                    'The dependencies were removed, but post-removal verification failed.',
                    {
                      modal: true,
                      detail:
                        'Rollback restores only package.json and the active lockfile captured by this removal transaction; ' +
                        'it does not restore node_modules or files changed by lifecycle/verification scripts.',
                    },
                    'Rollback',
                    'Keep Changes'
                  );
                  return choice === 'Keep Changes' ? ('keep' as const) : ('rollback' as const);
                },
              },
            }),
      });

      // Reload the kept/restored/partial state while the coordinator still owns the project-wide mutation lock.
      if (!this.options.isDisposed()) await this.options.reloadFinalState();
      if (this.options.isDisposed()) return;

      const presentation = describeRemoveTransactionOutcome(
        stored.eligibilities.map((item) => item.packageName),
        source.packageManager,
        transaction
      );
      if (presentation.kind === 'verified') {
        void vscode.window.showInformationMessage(presentation.message);
      } else if (presentation.kind === 'error') {
        this.options.sink.postMessage({
          status: 'remove-error',
          package: stored.eligibility.packageName,
          error: presentation.error,
        });
      } else {
        void vscode.window.showWarningMessage(presentation.message);
      }
    } catch (cause) {
      if (!this.options.isDisposed()) {
        this.options.sink.postMessage({
          status: 'remove-error',
          package: stored.eligibility.packageName,
          error: toProtocolError(cause),
        });
      }
    } finally {
      this.session.release(stored.eligibility.packageName);
      this.options.onMutationLockReleased?.();
      await this.options.flushDeferredChanges();
      if (this.options.isDisposed()) this.session.dispose();
    }
  }
}
