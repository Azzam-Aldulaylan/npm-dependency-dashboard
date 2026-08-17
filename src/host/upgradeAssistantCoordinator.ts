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
import { directNodes } from '../core/lockfile/parse.js';
import { parseManifest } from '../core/manifest/parse.js';
import { analyzeCompatibility, CompatibilityCancelledError } from '../core/compatibility/preflight.js';
import type { CompatibilityStatus, UpgradeProposal } from '../core/compatibility/types.js';
import { RegistryPackageMetadataProvider, registryForPackage } from '../core/compatibility/registryMetadataProvider.js';
import type { HttpClient } from '../core/registry/http.js';
import { fetchPackument } from '../core/registry/versions.js';
import type { EtagStore } from '../core/registry/versions.js';
import { planSmartUpgrade } from '../core/upgrade/smartPlan.js';
import { buildStagedManifest } from '../core/upgrade/stagedManifest.js';
import { requiresManifestReconciliation } from '../core/upgrade/plan.js';
import { describeRejection } from '../core/upgrade/validate.js';
import type { EligibleUpgrade } from '../core/upgrade/validate.js';
import { advisoriesByNameFromRows } from '../core/advisories/attribution.js';
import { resolveRemediationRequest } from '../core/advisories/remediationRequest.js';
import type { RemediationRequestRejection } from '../core/advisories/remediationRequest.js';
import { evaluateSecurityOutcome } from '../core/advisories/securityOutcome.js';
import type { SecurityOutcomeStatus } from '../core/advisories/securityOutcome.js';
import type { DashboardController, MessageSink } from './dashboardController.js';
import { createNodeNpmResolverDeps, resolveNpmInvocation } from './npmResolver.js';
import { createNodeUpgradeTransactionFileAdapter } from './nodeUpgradeTransactionFiles.js';
import { resolveInstalledPnpmInvocation } from './pnpmResolver.js';
import type { DiscoveredProject, ResolvedProject } from './projectResolution.js';
import { loadProject } from './projectResolution.js';
import { IsolatedResolverVerifier, probePackageManagerVersion } from './resolverVerifier.js';
import { resolveAnalysisForExecution } from './upgradeAnalysisLookup.js';
import type { AnalysisLookupRejection } from './upgradeAnalysisLookup.js';
import { buildUpgradeAnalysisPresentation } from './upgradeAnalysisPresentation.js';
import { describeUpgradeTransactionOutcome } from './upgradeAssistantOutcome.js';
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

export interface RemediationMessage {
  package: string;
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
  /** The original {package, target} request — re-validated fresh at confirm time, never trusted from here. */
  request: UpgradeMessage;
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

export class UpgradeAssistantCoordinator {
  private readonly session = new UpgradeExecutionSession();
  private readonly projectLoader: (candidate: DiscoveredProject) => Promise<ResolvedProject>;
  private analysis: StoredAnalysis | undefined;
  /** The package a handleAnalyzeUpgrade call is currently in flight for, or null — the target `cancel-upgrade { analysisId: null }` refers to, since no analysisId exists yet at that point. */
  private pendingAnalyzePackage: string | null = null;
  /** Set by a cancel-upgrade with `analysisId: null` that arrived mid-analysis — handleAnalyzeUpgrade checks this right before storing/posting its result and drops it instead. */
  private cancelRequestedFor: string | null = null;

  constructor(private readonly options: UpgradeAssistantCoordinatorOptions) {
    this.projectLoader = options.loadProject ?? loadProject;
  }

  isBusy(): boolean {
    return this.session.isBusy();
  }

  /** Dispose immediately only when no mutation is in flight. */
  disposeWhenIdle(): void {
    if (!this.session.isBusy()) this.session.dispose();
  }

  /** An abandoned analysis (modal left open, never confirmed or cancelled) reclaims its lock once its TTL passes, so a later analyze request is never permanently blocked by it. */
  private reclaimExpiredAnalysis(): void {
    if (this.analysis !== undefined && Date.now() >= this.analysis.expiresAt) {
      this.session.release(this.analysis.eligibility.packageName);
      this.analysis = undefined;
    }
  }

  /**
   * Phase 1: eligibility, lock, preflight, smart-plan search, security
   * outcome. Ends by storing the analysis and posting it — never by
   * executing anything.
   */
  async handleAnalyzeUpgrade(message: UpgradeMessage): Promise<void> {
    this.reclaimExpiredAnalysis();

    const controller = await this.options.ensureController();
    if (controller === undefined) return;

    const eligibility = controller.validateUpgradeRequest({
      package: message.package,
      target: message.target,
    });
    if (!eligibility.ok) {
      this.options.sink.postMessage({
        status: 'upgrade-error',
        package: message.package,
        error: describeRejection(eligibility.reason),
      });
      return;
    }

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
        changes: [
          {
            packageName: eligibility.packageName,
            currentVersion: eligibility.currentVersion,
            targetVersion: eligibility.target,
            classification: eligibility.classification,
          },
        ],
      };
      const manifest = parseManifest(preflightProject.manifestText);
      const graph = buildDependencyGraph({
        root: preflightProject.root,
        manifest,
        lockfileText: preflightProject.lockfileText,
        packageManager: preflightProject.packageManager,
        importerId: preflightProject.importerId,
      });
      const npmResolution = resolveNpmInvocation(createNodeNpmResolverDeps(controller.root));
      const packageManagerInvocation =
        !npmResolution.ok
          ? null
          : preflightProject.packageManager === 'npm'
            ? {
                executable: npmResolution.invocation.node,
                prefixArgs: [npmResolution.invocation.npmCliJs],
              }
            : resolveInstalledPnpmInvocation(npmResolution.invocation, controller.root);
      const resolverVerifier = packageManagerInvocation !== null
        ? new IsolatedResolverVerifier({
            packageManager: preflightProject.packageManager,
            packageManagerVersion: probePackageManagerVersion(packageManagerInvocation, controller.root),
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
      const analysis = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Checking compatibility for ${eligibility.packageName}@${eligibility.target}`,
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
      const before = rows.find((row) => row.name === eligibility.packageName)?.advisories ?? [];
      let security: SecurityOutcome | null = null;
      if (before.length > 0) {
        let after: Parameters<typeof evaluateSecurityOutcome>[0]['after'] = 'no-resolver-evidence';
        if (analysis.status !== 'conflict' && resolverVerifier !== undefined) {
          try {
            const materialized = await resolverVerifier.materializeResolvedGraph(proposal);
            if (materialized.ok) {
              after = { graph: materialized.graph, advisoriesByName: advisoriesByNameFromRows(rows) };
            }
          } catch {
            // Left as 'no-resolver-evidence' — never a hard failure of the analysis.
          }
        }
        security = evaluateSecurityOutcome({
          before,
          targetVersion: eligibility.target,
          rootPackageName: eligibility.packageName,
          after,
        });
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
        request: message,
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
      const selected = this.options.getSelectedProject();
      if (selected === undefined) return;
      const preflightProject = await this.projectLoader(selected);
      if (preflightProject.root !== controller.root) {
        this.options.sink.postMessage({
          status: 'remediation-error',
          package: row.name,
          error: { code: 'STALE_SOURCE', message: 'Project dependency files changed. Refresh and try again.' },
        });
        return;
      }

      const npmResolution = resolveNpmInvocation(createNodeNpmResolverDeps(controller.root));
      const packageManagerInvocation =
        !npmResolution.ok
          ? null
          : preflightProject.packageManager === 'npm'
            ? { executable: npmResolution.invocation.node, prefixArgs: [npmResolution.invocation.npmCliJs] }
            : resolveInstalledPnpmInvocation(npmResolution.invocation, controller.root);
      if (packageManagerInvocation === null) {
        this.options.sink.postMessage({
          status: 'remediation-error',
          package: row.name,
          error: { code: 'RESOLVER_UNAVAILABLE', message: 'The package manager could not be located to run this check.' },
        });
        return;
      }

      const resolverVerifier = new IsolatedResolverVerifier({
        packageManager: preflightProject.packageManager,
        packageManagerVersion: probePackageManagerVersion(packageManagerInvocation, controller.root),
        invocation: packageManagerInvocation,
        manifestText: preflightProject.manifestText,
        // No `lockfile` — a fresh, lockfile-free resolve is the one thing
        // this analysis exists to try.
        registry: preflightProject.registry,
        policy: preflightProject.peerPolicy,
      });

      const noOpProposal: UpgradeProposal = {
        requested: {
          packageName: row.name,
          currentVersion,
          targetVersion: currentVersion,
          classification: row.dev ? 'dev' : 'prod',
        },
        changes: [],
      };

      const materialized = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Checking remediation for ${row.name}`,
          cancellable: true,
        },
        async (_progress, token) => {
          const abort = new AbortController();
          const cancellation = token.onCancellationRequested(() => abort.abort());
          try {
            return await resolverVerifier.materializeResolvedGraph(noOpProposal, abort.signal);
          } finally {
            cancellation.dispose();
          }
        }
      );

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
        after: { graph: materialized.graph, advisoriesByName: advisoriesByNameFromRows(controller.lastResultRows()) },
      });

      this.options.sink.postMessage({
        status: 'remediation-result',
        package: row.name,
        result: { status: toRemediationOutcomeStatus(security.status), security },
      });
    } catch (cause) {
      if (!this.options.isDisposed()) {
        this.options.sink.postMessage({ status: 'remediation-error', package: row.name, error: toProtocolError(cause) });
      }
    }
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
      const rechecked = controller.validateUpgradeRequest(stored.request);
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
      // Watcher events received during the lock are deferred, never dropped.
      await this.options.flushDeferredChanges();
      if (this.options.isDisposed()) this.session.dispose();
    }
  }
}
