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
import { computeSourceFingerprint } from '../core/cache/sourceFingerprint.js';
import { runSequentialBatch } from '../core/async/sequentialBatch.js';
import { SharedPromise } from '../core/async/sharedPromise.js';
import { directNodes } from '../core/lockfile/parse.js';
import { parseManifest } from '../core/manifest/parse.js';
import { analyzeCompatibility, CompatibilityCancelledError } from '../core/compatibility/preflight.js';
import type { CompatibilityStatus, UpgradeProposal } from '../core/compatibility/types.js';
import { RegistryPackageMetadataProvider, registryForPackage } from '../core/compatibility/registryMetadataProvider.js';
import { FetchError } from '../core/registry/http.js';
import type { HttpClient } from '../core/registry/http.js';
import { fetchPackument } from '../core/registry/versions.js';
import type { EtagStore } from '../core/registry/versions.js';
import type { PackageVersionMetadata } from '../core/registry/versions.js';
import type { DependencyReference } from '../core/usage/types.js';
import type {
  ProjectCompatibilityAnalysis,
  ProjectCompatibilityIdentity,
  ToolingPackageEvidence,
} from '../core/projectCompatibility/index.js';
import type { PerformanceRecorder } from '../core/performance/measurement.js';
import { createPerformanceSession } from '../core/performance/measurement.js';
import { inspectAppliedUpgradeState } from '../core/upgrade/appliedState.js';
import { planSmartUpgrade } from '../core/upgrade/smartPlan.js';
import { loadUpgradeTargets, publishedUpgradeTargetsForRequest } from '../core/upgrade/targets.js';
import { buildStagedManifest, buildStagedManifestForRemoval } from '../core/upgrade/stagedManifest.js';
import { isMajorUpgrade, requiresManifestReconciliation } from '../core/upgrade/plan.js';
import { stillRequiredBy } from '../core/upgrade/removeImpact.js';
import { buildPeerRequirementIndex, peerRequirementsFor } from '../core/upgrade/peerRequirement.js';
import { buildWhyInstalledIndex } from '../core/hygiene/whyInstalled.js';
import { describeBulkRejection, describeBulkRemoveRejection } from '../core/upgrade/validate.js';
import type { EligibleRemoval, EligibleUpgrade } from '../core/upgrade/validate.js';
import { advisoriesByNameFromRows } from '../core/advisories/attribution.js';
import { resolveRemediationRequest } from '../core/advisories/remediationRequest.js';
import type { RemediationRequestRejection } from '../core/advisories/remediationRequest.js';
import { evaluateSecurityOutcome } from '../core/advisories/securityOutcome.js';
import { buildVulnerabilityContexts } from '../core/advisories/vulnerabilityContext.js';
import type { SecurityOutcomeStatus } from '../core/advisories/securityOutcome.js';
import type { DashboardController, MessageSink } from './dashboardController.js';
import { createNodeNpmResolverDeps, resolveNpmInvocation } from './npmResolver.js';
import { createNodeUpgradeTransactionFileAdapter } from './nodeUpgradeTransactionFiles.js';
import { resolveInstalledPnpmInvocation } from './pnpmResolver.js';
import { combineSecurityOutcomes } from './securityOutcomeBatch.js';
import { materializeUpgradeSecurityGraph } from './upgradeSecurityGraph.js';
import type { DiscoveredProject, ResolvedProject } from './projectResolution.js';
import { loadProject } from './projectResolution.js';
import { IsolatedResolverVerifier } from './resolverVerifier.js';
import { collectProjectCompatibilityEvidence, parseProjectManifestCompatibilityEvidence } from './projectCompatibility/projectEvidenceCollector.js';
import {
  analyzeProjectCompatibilityMedium,
  appendProjectCompatibilityImportAnalysis,
  targetExportsEvidence,
  targetPrivateSubpathPrefixes,
  removedTargetPackageCommands,
} from './projectCompatibility/projectCompatibilityAnalysis.js';
import { TargetPackageInspector } from './projectCompatibility/targetPackageInspector.js';
import { TargetPackageSurfaceCache } from './projectCompatibility/targetPackageInspector.js';
import {
  projectCompatibilityEvidenceIsCurrent,
  projectCompatibilityFinalReadIsCurrent,
} from './projectCompatibility/projectCompatibilityFreshness.js';
import { resolveAnalysisForExecution } from './upgradeAnalysisLookup.js';
import type { AnalysisLookupRejection } from './upgradeAnalysisLookup.js';
import { UPGRADE_ANALYSIS_RETENTION_MS } from './upgradeFreshness.js';
import {
  buildUpgradeAnalysisChanges,
  buildUpgradeAnalysisFiles,
  buildUpgradeAnalysisPresentation,
  buildUpgradeAnalysisVerification,
} from './upgradeAnalysisPresentation.js';
import { buildRemoveAnalysisPresentation } from './removeAnalysisPresentation.js';
import {
  classifyUpgradeApplication,
  describeRemoveTransactionOutcome,
  describeUpgradeTransactionOutcome,
} from './upgradeAssistantOutcome.js';
import { UpgradeExecutionSession } from './upgradeRunner.js';
import { OperationReservation, SourceGenerationGuard } from './operationReservation.js';
import { runUpgradeTransaction } from './upgradeTransaction.js';
import { selectVerificationScripts } from './verificationPolicy.js';
import type { VerificationScript } from './verificationPolicy.js';
import type {
  ProtocolError,
  RemediationOutcomeStatus,
  SecurityOutcome,
  UpgradeAnalysisSmartPlan,
  UpgradeResultPresentation,
} from './webviewProtocol.js';

export interface UpgradeChangeRequest {
  package: string;
  target: string;
}

export interface UpgradeMessage extends UpgradeChangeRequest {
  /** Client-minted correlation nonce for this analysis attempt — see webviewProtocol.ts's own doc on `WebviewToHostMessage`'s `requestId`. Never trust/execution surface; echoed back verbatim on every message belonging to this attempt, never stored on StoredAnalysis. */
  requestId: string;
}

export interface LoadUpgradeTargetsMessage {
  package: string;
  requestId: string;
}

export interface BulkUpgradeMessage {
  changes: UpgradeChangeRequest[];
  requestId: string;
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
  /** Reads and applies post-mutation package.json/lockfile state without waiting for registry/audit enrichment. */
  readAndApplyMutationLocalState?(): Promise<
    { project: ResolvedProject; structurallyCurrent: boolean } | undefined
  >;
  /** Starts the expensive derived-data scan after local state has already been published. */
  refreshMutationEnrichmentInBackground?(
    refreshId: string,
    packageName: string,
    structurallyCurrent: boolean
  ): void;
  flushDeferredChanges(): Promise<void>;
  /**
   * Fires once the mutation lock is actually released after a transaction
   * that called `reloadFinalState()` — the moment a background usage
   * refresh queued during that reload (see UsageAnalysisCoordinator's
   * `requestBackgroundUsageRefresh`) is allowed to actually start. Called
   * after deferred watcher changes are flushed so background work observes
   * the authoritative post-mutation project state.
   */
  onMutationLockReleased?(): void;
  performanceEnabled?(): boolean;
  /** Test seam; production always uses the host-owned project loader. */
  loadProject?: (candidate: DiscoveredProject) => Promise<ResolvedProject>;
  /** Test seam; production always uses vscode.window.withProgress with a real cancellation token — see defaultWithCompatibilityProgress. */
  withCompatibilityProgress?: <T>(title: string, run: (signal: AbortSignal) => Promise<T>) => Promise<T>;
  /** Test seam; production always reads the real `dependencyDashboard` upgrade configuration — see defaultGetUpgradeConfiguration. */
  getUpgradeConfiguration?: () => { ignoreScripts: boolean; verificationScripts: unknown[] };
  /** Reuses UsageReferenceStore for finding navigation; returns one opaque usage id for the supplied host-owned references. */
  storeProjectCompatibilityReferences?(
    packageName: string,
    references: readonly DependencyReference[],
    folder: vscode.WorkspaceFolder
  ): string | null;
  /** Monotonic generation advanced synchronously by relevant source/config watcher events. */
  projectCompatibilitySourceGeneration?: () => number;
}

/** Removal review retention is unchanged; Upgrade Review has its own longer, soft-stale-aware retention. */
const REMOVAL_ANALYSIS_TTL_MS = 10 * 60_000;

/** Production default for `UpgradeAssistantCoordinatorOptions.withCompatibilityProgress` — the exact `vscode.window.withProgress`/`AbortController` wiring `handleAnalyzeUpgradeRequests`'s compatibility preflight used inline before this seam existed. */
async function defaultWithCompatibilityProgress<T>(title: string, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title, cancellable: true },
    async (_progress, token) => {
      const abort = new AbortController();
      const cancellation = token.onCancellationRequested(() => abort.abort());
      try {
        return await run(abort.signal);
      } finally {
        cancellation.dispose();
      }
    }
  );
}

/** Production default for `UpgradeAssistantCoordinatorOptions.getUpgradeConfiguration`. */
function defaultGetUpgradeConfiguration(): { ignoreScripts: boolean; verificationScripts: unknown[] } {
  const configuration = vscode.workspace.getConfiguration('dependencyDashboard');
  return {
    ignoreScripts: configuration.get<boolean>('upgrade.ignoreScripts', true),
    verificationScripts: configuration.get<unknown[]>('upgrade.verificationScripts', []),
  };
}

function toProtocolError(cause: unknown): ProtocolError {
  if (cause instanceof FetchError) return { code: cause.code, message: cause.message };
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

function projectCompatibilityFingerprint(project: ResolvedProject, evidenceFingerprint: string): string {
  const fingerprint = computeSourceFingerprint({
    manifestText: project.manifestText,
    lockfileText: project.lockfileText,
    lockfilePath: project.lockfilePath,
    packageManager: project.packageManager,
    importerId: project.importerId,
  });
  // Do not send an absolute lockfile path to the webview; hashes + topology identity are sufficient correlation.
  return [
    fingerprint.manifestHash,
    fingerprint.lockfileHash ?? 'no-lockfile',
    project.packageManager,
    project.importerId,
    project.lockfileName ?? 'no-lockfile',
    evidenceFingerprint,
  ].join(':');
}

function resolvedProjectSourceMatches(left: ResolvedProject, right: ResolvedProject): boolean {
  return left.root === right.root &&
    left.manifestText === right.manifestText &&
    left.lockfileText === right.lockfileText &&
    left.lockfilePath === right.lockfilePath &&
    left.registry === right.registry &&
    left.packageManager === right.packageManager &&
    left.importerId === right.importerId &&
    JSON.stringify(left.peerPolicy) === JSON.stringify(right.peerPolicy) &&
    JSON.stringify(left.resolvedRegistry) === JSON.stringify(right.resolvedRegistry);
}

function waitForAnalysisWork<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException('Upgrade analysis cancelled.', 'AbortError'));
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(new DOMException('Upgrade analysis cancelled.', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    void work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

async function loadToolingPackageEvidence(input: {
  graph: ReturnType<typeof buildDependencyGraph>;
  declarations: Readonly<Record<string, string>>;
  metadataProvider: RegistryPackageMetadataProvider;
}): Promise<{ packages: ToolingPackageEvidence[]; incomplete: boolean }> {
  const relevant = ['@typescript-eslint/eslint-plugin', '@typescript-eslint/parser']
    .filter((name) => input.declarations[name] !== undefined);
  if (relevant.length === 0) return { packages: [], incomplete: false };
  const directByName = new Map(directNodes(input.graph).map((node) => [node.name, node]));
  const packages: ToolingPackageEvidence[] = [];
  let incomplete = false;
  for (const name of relevant) {
    const node = directByName.get(name);
    if (node?.version === null || node?.version === undefined) {
      packages.push({ name, resolvedVersion: null, declaredRange: input.declarations[name] ?? null, peerDependencies: {} });
      incomplete = true;
      continue;
    }
    try {
      const metadata = await input.metadataProvider.getPackageVersionMetadata(name, node.version);
      packages.push({
        name,
        resolvedVersion: node.version,
        declaredRange: input.declarations[name] ?? null,
        peerDependencies: metadata.peerDependencies,
        optionalPeers: Object.entries(metadata.peerDependenciesMeta)
          .filter(([, value]) => value.optional)
          .map(([peer]) => peer),
      });
    } catch {
      packages.push({ name, resolvedVersion: node.version, declaredRange: input.declarations[name] ?? null, peerDependencies: {} });
      incomplete = true;
    }
  }
  return { packages, incomplete };
}

function attachTrustedProjectCompatibilityNavigation(input: {
  analysis: ProjectCompatibilityAnalysis;
  packageName: string;
  folder: vscode.WorkspaceFolder;
  store?: UpgradeAssistantCoordinatorOptions['storeProjectCompatibilityReferences'];
}): void {
  if (input.store === undefined) return;
  const navigable: Array<{ evidence: ProjectCompatibilityAnalysis['findings'][number]['evidence'][number]; reference: DependencyReference }> = [];
  const MAX_NAVIGABLE_PROJECT_EVIDENCE = 500;
  outer: for (const finding of input.analysis.findings) {
    for (const evidence of finding.evidence) {
      if (evidence.filePath === undefined) continue;
      const kind = evidence.kind === 'package-script'
        ? 'script' as const
        : evidence.kind === 'project-config'
          ? 'config' as const
          : 'import' as const;
      navigable.push({
        evidence,
        reference: {
          filePath: evidence.filePath,
          line: evidence.line ?? 1,
          column: evidence.column ?? 1,
          snippet: evidence.snippet ?? evidence.context ?? evidence.filePath,
          kind,
          ...(evidence.context === undefined ? {} : { context: evidence.context }),
        },
      });
      if (navigable.length >= MAX_NAVIGABLE_PROJECT_EVIDENCE) break outer;
    }
  }
  const usageId = input.store(input.packageName, navigable.map((entry) => entry.reference), input.folder);
  if (usageId === null) return;
  navigable.forEach((entry, referenceIndex) => {
    entry.evidence.usageId = usageId;
    entry.evidence.referenceIndex = referenceIndex;
  });
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
  requests: UpgradeChangeRequest[];
  /** Host-proven selectable targets used when a request differs from row.upgradeTo. */
  publishedTargetsByPackage: ReadonlyMap<string, ReadonlySet<string>>;
  eligibility: EligibleUpgrade;
  /** The disk snapshot preflight ran against — the baseline the post-confirm recheck below compares fresh disk reads to. */
  snapshot: ResolvedProject;
  proposal: UpgradeProposal;
  compatibilityStatus: CompatibilityStatus;
  /** Set only when planSmartUpgrade found a validated coordinated plan — the only proposal `handleUseSmartPlan` is ever allowed to execute. */
  smartPlanProposal: UpgradeProposal | null;
  ignoreScripts: boolean;
  verificationScripts: VerificationScript[];
  /** Source/config evidence consumed by project compatibility, re-read before execution. */
  projectCompatibilityEvidenceFingerprint: string | null;
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

interface PendingRemovalAnalysis {
  packageName: string;
  cancelled: boolean;
  reservationHeld: boolean;
  releaseStarted: boolean;
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
  private readonly reservation: OperationReservation;
  /** Advanced synchronously by host watcher/HEAD notifications. */
  private readonly sourceGeneration = new SourceGenerationGuard();
  private readonly projectLoader: (candidate: DiscoveredProject) => Promise<ResolvedProject>;
  private readonly withCompatibilityProgress: <T>(title: string, run: (signal: AbortSignal) => Promise<T>) => Promise<T>;
  private readonly getUpgradeConfiguration: () => { ignoreScripts: boolean; verificationScripts: unknown[] };
  private analysis: StoredAnalysis | undefined;
  private removal: StoredRemoval | undefined;
  /** Registered before controller lookup so `cancel-remove { analysisId: null }` also cancels that initial async gap. */
  private pendingRemovalAnalysis: PendingRemovalAnalysis | undefined;
  /** The package a handleAnalyzeUpgrade call is currently in flight for, or null — the target `cancel-upgrade { analysisId: null }` refers to, since no analysisId exists yet at that point. */
  private pendingAnalyzePackage: string | null = null;
  /** Set by a cancel-upgrade with `analysisId: null` that arrived mid-analysis — handleAnalyzeUpgrade checks this right before storing/posting its result and drops it instead. */
  private cancelRequestedFor: string | null = null;
  /**
   * Host source invalidation is terminal for the webview, unlike its own
   * quiet Cancel action. Retain the package through the analysis finally
   * block so a watcher burst posts exactly one terminal message.
   */
  private sourceInvalidatedAnalyzePackage: string | null = null;
  private activeRemediationAbort: AbortController | undefined;
  private activeUpgradeAnalysisAbort: AbortController | undefined;
  /** One exact deep inventory is enough to make immediate re-analysis/cache reuse cheap without retaining many large file lists. */
  private readonly targetPackageSurfaceCache = new TargetPackageSurfaceCache();

  constructor(private readonly options: UpgradeAssistantCoordinatorOptions) {
    this.reservation = new OperationReservation({
      reserve: (packageName) => this.session.reserve(packageName),
      release: (packageName) => this.session.release(packageName),
      flushDeferredChanges: () => options.flushDeferredChanges(),
      resumePendingBackground: () => options.onMutationLockReleased?.(),
      isDisposed: () => options.isDisposed(),
      dispose: () => this.session.dispose(),
    });
    this.projectLoader = options.loadProject ?? loadProject;
    this.withCompatibilityProgress = options.withCompatibilityProgress ?? defaultWithCompatibilityProgress;
    this.getUpgradeConfiguration = options.getUpgradeConfiguration ?? defaultGetUpgradeConfiguration;
  }

  isBusy(): boolean {
    return this.session.isBusy();
  }

  /** File reloads defer only while a package-manager transaction can write. */
  isMutationBusy(): boolean {
    return this.reservation.isMutationBusy;
  }

  isRemediationBusy(): boolean {
    return this.activeRemediationAbort !== undefined;
  }

  /** Dispose immediately only when no mutation is in flight. */
  disposeWhenIdle(): void {
    this.activeRemediationAbort?.abort();
    this.activeUpgradeAnalysisAbort?.abort();
    if (this.reservation.isMutationBusy) return;
    this.analysis = undefined;
    this.removal = undefined;
    void this.reservation
      .releaseCurrent()
      .then((released) => {
        if (!released) this.reservation.disposeIfIdle();
      })
      .catch(() => {});
  }

  private reserve(packageName: string): boolean {
    return this.reservation.reserve(packageName);
  }

  /**
   * The single release path for cancellation, failures, TTL reclamation,
   * controller-unavailable exits, and mutation completion. The reservation
   * is cleared synchronously; host follow-up work is failure-contained so a
   * rejected reload can neither become unhandled nor poison later releases.
   */
  private async releaseReservation(packageName: string): Promise<void> {
    await this.reservation.release(packageName);
  }

  /**
   * Called synchronously for watched source/dependency changes and genuine
   * HEAD changes. Read-only reviews are revoked immediately; a transaction
   * already inside its mutation boundary remains the sole deferral owner.
   */
  handleProjectSourceChanged(): void {
    this.sourceGeneration.advance();
    if (this.reservation.isMutationBusy) return;

    if (this.pendingAnalyzePackage !== null) {
      const packageName = this.pendingAnalyzePackage;
      const webviewAlreadyCancelled =
        this.cancelRequestedFor === packageName && this.sourceInvalidatedAnalyzePackage !== packageName;
      this.cancelRequestedFor = packageName;
      if (!webviewAlreadyCancelled && this.sourceInvalidatedAnalyzePackage !== packageName) {
        this.sourceInvalidatedAnalyzePackage = packageName;
        this.options.sink.postMessage({
          status: 'upgrade-error',
          package: packageName,
          error: {
            code: 'STALE_SOURCE',
            message: 'Project files changed while upgrade analysis was running. Analyze again.',
          },
        });
      }
      this.activeUpgradeAnalysisAbort?.abort();
    }
    if (this.analysis !== undefined) {
      const stored = this.analysis;
      this.analysis = undefined;
      this.options.sink.postMessage({ status: 'upgrade-analysis-stale', analysisId: stored.id });
      void this.releaseReservation(stored.eligibility.packageName);
    }
    if (this.removal !== undefined) {
      const stored = this.removal;
      this.removal = undefined;
      this.options.sink.postMessage({
        status: 'remove-error',
        package: stored.eligibility.packageName,
        error: {
          code: 'STALE_SOURCE',
          message: 'Project files changed while the removal review was open. Analyze again.',
        },
      });
      void this.releaseReservation(stored.eligibility.packageName);
    }
  }

  /** An abandoned analysis (modal left open, never confirmed or cancelled) reclaims its lock once its TTL passes, so a later analyze request is never permanently blocked by it. */
  private reclaimExpiredAnalysis(): void {
    if (this.analysis !== undefined && Date.now() >= this.analysis.expiresAt) {
      void this.releaseReservation(this.analysis.eligibility.packageName);
      this.analysis = undefined;
    }
  }

  /** Same reclaim as reclaimExpiredAnalysis, for an abandoned removal review. */
  private reclaimExpiredRemoval(): void {
    if (this.removal !== undefined && Date.now() >= this.removal.expiresAt) {
      void this.releaseReservation(this.removal.eligibility.packageName);
      this.removal = undefined;
    }
  }

  /**
   * Checked before every progressive partial post in
   * handleAnalyzeUpgradeRequests — a mid-stream `cancel-upgrade{analysisId:
   * null}` (recorded as `cancelRequestedFor`) or panel disposal should stop
   * further sections from being computed/posted, not merely be discarded at
   * the very end the way a single pre-final check would. Returns true (and,
   * for a real cancellation match, clears `cancelRequestedFor`) exactly when
   * the caller should stop and return without posting.
   */
  private droppedByCancellation(packageName: string): boolean {
    if (this.options.isDisposed()) return true;
    if (this.cancelRequestedFor !== packageName) return false;
    this.cancelRequestedFor = null;
    return true;
  }

  /**
   * Load one package's bounded, host-derived upgrade choices on demand.
   * This is deliberately outside the dashboard's Stage-1 scan: opening the
   * Manage workspace for one dependency is the point at which a full
   * packument becomes useful enough to justify its parse cost.
   */
  async handleLoadUpgradeTargets(message: LoadUpgradeTargetsMessage): Promise<void> {
    const controller = await this.options.ensureController();
    if (controller === undefined) return;

    const row = controller.lastResultRows().find((candidate) => candidate.name === message.package);
    if (row === undefined || row.current === null || row.upgradeTo === null) {
      this.options.sink.postMessage({
        status: 'upgrade-targets-error',
        package: message.package,
        requestId: message.requestId,
        error: { code: 'NO_ELIGIBLE_UPGRADE', message: 'No upgrade is currently available for this package.' },
      });
      return;
    }

    // Reuse the existing default-target eligibility gate before doing any
    // network work. This proves the package is declared, safe, and backed by
    // a current trusted scan without adding a weaker read-only side door.
    const eligibility = controller.validateUpgradeRequest({ package: row.name, target: row.upgradeTo });
    if (!eligibility.ok) {
      this.options.sink.postMessage({
        status: 'upgrade-targets-error',
        package: message.package,
        requestId: message.requestId,
        error: describeBulkRejection({
          ok: false,
          reason: 'change-rejected',
          packageName: message.package,
          changeReason: eligibility.reason,
        }),
      });
      return;
    }

    this.options.sink.postMessage({
      status: 'upgrade-targets-loading',
      package: message.package,
      requestId: message.requestId,
    });
    try {
      const source = controller.upgradeSource;
      const targets = await loadUpgradeTargets(
        this.options.httpClient,
        this.options.etagStore,
        registryForPackage(source.resolvedRegistry, row.name),
        row.name,
        row.current,
        row.upgradeTo
      );
      const stillEligible = controller.validateUpgradeRequest({ package: row.name, target: row.upgradeTo });
      if (!stillEligible.ok) {
        this.options.sink.postMessage({
          status: 'upgrade-targets-error',
          package: message.package,
          requestId: message.requestId,
          error: describeBulkRejection({
            ok: false,
            reason: 'change-rejected',
            packageName: message.package,
            changeReason: stillEligible.reason,
          }),
        });
        return;
      }
      this.options.sink.postMessage({
        status: 'upgrade-targets',
        package: message.package,
        requestId: message.requestId,
        targets,
      });
    } catch (cause) {
      if (this.options.isDisposed()) return;
      this.options.sink.postMessage({
        status: 'upgrade-targets-error',
        package: message.package,
        requestId: message.requestId,
        error: toProtocolError(cause),
      });
    }
  }

  private async publishedTargetsFor(
    controller: DashboardController,
    requests: readonly UpgradeChangeRequest[]
  ): Promise<ReadonlyMap<string, ReadonlySet<string>>> {
    const source = controller.upgradeSource;
    const entries = await Promise.all(
      requests.map(async (request): Promise<readonly [string, ReadonlySet<string>]> => {
        const row = controller.lastResultRows().find((candidate) => candidate.name === request.package);
        if (row === undefined || row.current === null) return [request.package, new Set()];
        const published = await publishedUpgradeTargetsForRequest(
          this.options.httpClient,
          this.options.etagStore,
          registryForPackage(source.resolvedRegistry, row.name),
          row.name,
          row.current,
          row.upgradeTo,
          request.target
        );
        return [row.name, published];
      })
    );
    return new Map(entries);
  }

  /**
   * Phase 1: eligibility, lock, preflight, smart-plan search, security
   * outcome. Ends by storing the analysis and posting it — never by
   * executing anything.
   */
  async handleAnalyzeUpgrade(message: UpgradeMessage): Promise<void> {
    await this.handleAnalyzeUpgradeRequests(message.requestId, [{ package: message.package, target: message.target }]);
  }

  async handleAnalyzeBulkUpgrade(message: BulkUpgradeMessage): Promise<void> {
    await this.handleAnalyzeUpgradeRequests(message.requestId, message.changes);
  }

  private async handleAnalyzeUpgradeRequests(requestId: string, messages: readonly UpgradeChangeRequest[]): Promise<void> {
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

    let publishedTargetsByPackage: ReadonlyMap<string, ReadonlySet<string>> = new Map();
    let batch = controller.validateBulkUpgradeRequest(messages);
    if (!batch.ok && batch.reason === 'change-rejected' && batch.changeReason === 'stale-target') {
      try {
        publishedTargetsByPackage = await this.publishedTargetsFor(controller, messages);
      } catch (cause) {
        this.options.sink.postMessage({
          status: 'upgrade-error',
          package: batch.packageName ?? messages[0]?.package ?? 'unknown',
          error: toProtocolError(cause),
        });
        return;
      }
      batch = controller.validateBulkUpgradeRequest(messages, publishedTargetsByPackage);
    }
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
    if (!this.reserve(eligibility.packageName)) {
      this.options.sink.postMessage({
        status: 'upgrade-error',
        package: eligibility.packageName,
        error: { code: 'UPGRADE_IN_PROGRESS', message: 'Another upgrade is already in progress for this project.' },
      });
      return;
    }
    this.pendingAnalyzePackage = eligibility.packageName;
    const analysisAbort = new AbortController();
    this.activeUpgradeAnalysisAbort = analysisAbort;

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

      // --- Stage 0: overview — everything below is synchronous/cheap, no
      // network or resolver work, so it can post immediately. ---
      const upgradeConfiguration = this.getUpgradeConfiguration();
      const verificationScripts = selectVerificationScripts(source.manifestText, upgradeConfiguration.verificationScripts);

      const manifestPath = path.join(controller.root, 'package.json');
      const expectedLockfilePath =
        source.lockfilePath ??
        path.join(controller.root, source.packageManager === 'pnpm' ? 'pnpm-lock.yaml' : 'package-lock.json');

      const overviewChanges = buildUpgradeAnalysisChanges({
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
      });

      if (this.droppedByCancellation(eligibility.packageName)) return;
      this.options.sink.postMessage({
        status: 'upgrade-analysis-partial',
        requestId,
        package: eligibility.packageName,
        section: {
          kind: 'overview',
          currentVersion: eligibility.currentVersion,
          targetVersion: eligibility.target,
          classification: eligibility.classification,
          majorUpdate: isMajorUpgrade(eligibility.currentVersion, eligibility.target),
          changes: overviewChanges,
          verification: buildUpgradeAnalysisVerification(verificationScripts.map((script) => script.scriptName)),
          files: buildUpgradeAnalysisFiles(manifestPath, expectedLockfilePath),
        },
      });

      // Project source collection starts beside dependency-tree preflight so
      // neither blocks the other's first useful result. A scan failure is
      // represented as partial evidence later; it never fails Upgrade Review.
      const manifestProjectEvidence = parseProjectManifestCompatibilityEvidence(preflightProject.manifestText);
      const endProjectFirstResult = performance.start('project compatibility time to first result');
      const endProjectTotal = performance.start('project compatibility total analysis');
      const projectEvidencePromise = collectProjectCompatibilityEvidence({
        folder: selected.folder,
        dir: selected.dir,
        manifestText: preflightProject.manifestText,
        packageName: eligibility.packageName,
        signal: analysisAbort.signal,
      }).catch(() => ({
        ...manifestProjectEvidence,
        imports: [],
        ruleFiles: [],
        scannedFileCount: 0,
        truncated: true,
        evidenceFingerprint: 'unavailable',
      }));
      this.options.sink.postMessage({
        status: 'upgrade-analyzing',
        package: eligibility.packageName,
        phase: 'project-compatibility',
        requestId,
      });

      // Security's real cost (a resolver-graph materialization) only applies
      // when there's actually something to evaluate — when none of the
      // requested packages currently carry advisories, the outcome is
      // knowable right now, before compatibility even runs. `securityPosted`
      // short-circuits the deferred, resolver-driven branch further below
      // once this has already answered the question.
      const rows = controller.lastResultRows();
      const securityInputs = eligibilities.flatMap((item) => {
        const before = rows.find((row) => row.name === item.packageName)?.advisories ?? [];
        return before.length === 0 ? [] : [{ item, before }];
      });
      let securityPosted = false;
      if (securityInputs.length === 0) {
        if (this.droppedByCancellation(eligibility.packageName)) return;
        this.options.sink.postMessage({
          status: 'upgrade-analysis-partial',
          requestId,
          package: eligibility.packageName,
          section: { kind: 'security', security: null },
        });
        securityPosted = true;
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

      this.options.sink.postMessage({ status: 'upgrade-analyzing', package: eligibility.packageName, phase: 'compatibility', requestId });
      const endCompatibility = performance.start('compatibility preflight');
      const compatibilityTitle =
        eligibilities.length === 1
          ? `Checking compatibility for ${eligibility.packageName}@${eligibility.target}`
          : `Checking compatibility for ${eligibilities.length} dependency upgrades`;
      const compatibilityResultPromise = this.withCompatibilityProgress(compatibilityTitle, async (signal) => {
        const combined = new AbortController();
        const abort = (): void => combined.abort();
        signal.addEventListener('abort', abort, { once: true });
        analysisAbort.signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted || analysisAbort.signal.aborted) combined.abort();
        try {
          return await analyzeCompatibility({
            graph,
            proposal,
            metadataProvider,
            policy: preflightProject.peerPolicy,
            ...(resolverVerifier === undefined ? {} : { resolverVerifier }),
            signal: combined.signal,
          });
        } finally {
          signal.removeEventListener('abort', abort);
          analysisAbort.signal.removeEventListener('abort', abort);
        }
      }
      ).then(
        (analysis) => ({ ok: true as const, analysis }),
        (cause: unknown) => ({ ok: false as const, cause })
      );

      // Chain directly from compatibility completion: its resolver verify
      // and temp-dir cleanup have settled before this callback runs, while
      // project evidence/metadata work below may still be in flight.
      const securityGraphPromise = compatibilityResultPromise.then(async (compatibilityResult) => {
        if (
          !compatibilityResult.ok ||
          securityPosted ||
          compatibilityResult.analysis.status === 'conflict' ||
          resolverVerifier === undefined
        ) return undefined;
        const endSecurityResolver = performance.start('security graph materialization');
        const proposedGraph = await materializeUpgradeSecurityGraph({
          compatibilityStatus: compatibilityResult.analysis.status,
          proposal,
          materializer: resolverVerifier,
          signal: analysisAbort.signal,
        });
        endSecurityResolver({ resolved: proposedGraph !== undefined });
        return proposedGraph;
      });

      // --- project compatibility, fast then enriched medium then deep ---
      // The source scan above is local and bounded. Exact metadata normally
      // reuses the compatibility provider's in-flight/cache entry.
      const projectEvidence = await projectEvidencePromise;
      const readMetadata = async (version: string): Promise<PackageVersionMetadata | undefined> => {
        try {
          return await metadataProvider.getPackageVersionMetadata(eligibility.packageName, version);
        } catch {
          return undefined;
        }
      };
      const hasScripts = Object.keys(projectEvidence.scripts).length > 0;
      const hasToolingDeclarations = ['@typescript-eslint/eslint-plugin', '@typescript-eslint/parser']
        .some((name) => projectEvidence.declaredDependencies[name] !== undefined);
      const targetMetadataPromise = readMetadata(eligibility.target);
      const currentMetadataPromise = hasScripts
        ? readMetadata(eligibility.currentVersion)
        : Promise.resolve(undefined);
      const toolingPromise = hasToolingDeclarations
        ? loadToolingPackageEvidence({
          graph,
          declarations: projectEvidence.declaredDependencies,
          metadataProvider,
        })
        : Promise.resolve({ packages: [], incomplete: false });
      const targetMetadata = await waitForAnalysisWork(targetMetadataPromise, analysisAbort.signal);
      const projectIdentity: ProjectCompatibilityIdentity = {
        packageName: eligibility.packageName,
        currentVersion: eligibility.currentVersion,
        targetVersion: eligibility.target,
        requestId,
        sourceFingerprint: projectCompatibilityFingerprint(preflightProject, projectEvidence.evidenceFingerprint),
      };
      const endProjectFast = performance.start('project compatibility fast analysis');
      let projectCompatibility = await analyzeProjectCompatibilityMedium({
        identity: projectIdentity,
        project: projectEvidence,
        ...(targetMetadata === undefined ? {} : { targetMetadata }),
        toolingPackages: [],
        toolingMetadataIncomplete: hasToolingDeclarations,
        ...(hasScripts ? {} : { targetCommands: [] }),
      });
      endProjectFast({ findings: projectCompatibility.findings.length });
      endProjectFirstResult({ findings: projectCompatibility.findings.length });
      attachTrustedProjectCompatibilityNavigation({
        analysis: projectCompatibility,
        packageName: eligibility.packageName,
        folder: selected.folder,
        store: this.options.storeProjectCompatibilityReferences,
      });
      if (this.droppedByCancellation(eligibility.packageName)) return;
      this.options.sink.postMessage({
        status: 'upgrade-analysis-partial',
        requestId,
        package: eligibility.packageName,
        section: { kind: 'project-compatibility', projectCompatibility },
      });

      // Dependency-tree resolution remains independent: fast local/metadata
      // project findings above can render while its resolver work is still
      // running, then the ordinary compatibility section settles normally.
      const compatibilityResult = await compatibilityResultPromise;
      if (!compatibilityResult.ok) throw compatibilityResult.cause;
      const analysis = compatibilityResult.analysis;
      endCompatibility({ status: analysis.status });
      if (this.droppedByCancellation(eligibility.packageName)) return;
      this.options.sink.postMessage({
        status: 'upgrade-analysis-partial',
        requestId,
        package: eligibility.packageName,
        section: {
          kind: 'compatibility',
          compatibility: {
            status: analysis.status,
            completeness: analysis.completeness,
            findings: analysis.findings,
            ...(analysis.resolverVerification === undefined ? {} : { resolverVerification: analysis.resolverVerification }),
          },
        },
      });

      if (hasScripts || hasToolingDeclarations) {
        const [currentMetadata, tooling] = await waitForAnalysisWork(
          Promise.all([currentMetadataPromise, toolingPromise]),
          analysisAbort.signal
        );
        const targetCommands = hasScripts
          ? removedTargetPackageCommands({
              packageName: eligibility.packageName,
              ...(currentMetadata === undefined ? {} : { currentMetadata }),
              ...(targetMetadata === undefined ? {} : { targetMetadata }),
            })
          : [];
        const endProjectMedium = performance.start('project compatibility medium analysis');
        projectCompatibility = await analyzeProjectCompatibilityMedium({
          identity: projectIdentity,
          project: projectEvidence,
          ...(targetMetadata === undefined ? {} : { targetMetadata }),
          toolingPackages: tooling.packages,
          toolingMetadataIncomplete: tooling.incomplete,
          ...(targetCommands === undefined ? {} : { targetCommands }),
        });
        endProjectMedium({ findings: projectCompatibility.findings.length });
        attachTrustedProjectCompatibilityNavigation({
          analysis: projectCompatibility,
          packageName: eligibility.packageName,
          folder: selected.folder,
          store: this.options.storeProjectCompatibilityReferences,
        });
        if (this.droppedByCancellation(eligibility.packageName)) return;
        this.options.sink.postMessage({
          status: 'upgrade-analysis-partial',
          requestId,
          package: eligibility.packageName,
          section: { kind: 'project-compatibility', projectCompatibility },
        });
      }

      let targetSurface: Parameters<typeof appendProjectCompatibilityImportAnalysis>[0]['targetSurface'];
      let importUnavailableReason: string | undefined;
      if (targetMetadata === undefined) {
        importUnavailableReason = 'target-metadata-unavailable';
      } else {
        const exports = targetExportsEvidence(targetMetadata.exports, targetMetadata.exportsTruncated !== true);
        const needsCompleteFiles =
          exports.status !== 'known' &&
          projectEvidence.imports.some((reference) => reference.specifier !== eligibility.packageName);
        if (!needsCompleteFiles) {
          targetSurface = {
            packageName: eligibility.packageName,
            version: eligibility.target,
            exports,
            privateSubpathPrefixes: targetPrivateSubpathPrefixes(eligibility.packageName),
          };
        } else if (!npmResolution.ok) {
          importUnavailableReason = 'target-package-inspector-unavailable';
        } else {
          try {
            const endTargetInventory = performance.start('project compatibility target package inventory');
            const packageRegistry = registryForPackage(preflightProject.resolvedRegistry, eligibility.packageName);
            const cacheKey = `${packageRegistry}\0${eligibility.packageName}\0${eligibility.target}`;
            const cachedSurface = this.targetPackageSurfaceCache.get(cacheKey);
            // Both operations use package-manager child processes. The
            // security graph began earlier to overlap metadata/local work,
            // but must settle before an uncached package inventory starts.
            if (cachedSurface === undefined) await securityGraphPromise;
            const surface = cachedSurface ?? await new TargetPackageInspector(
                {
                  executable: npmResolution.invocation.node,
                  prefixArgs: [npmResolution.invocation.npmCliJs],
                  version: npmResolution.invocation.version,
                },
                packageRegistry
              ).inspect(eligibility.packageName, eligibility.target, analysisAbort.signal);
            if (cachedSurface === undefined) this.targetPackageSurfaceCache.set(cacheKey, surface);
            endTargetInventory({ files: surface.files.length, cached: cachedSurface !== undefined });
            targetSurface = {
              packageName: surface.packageName,
              version: surface.version,
              exports,
              files: { completeness: 'complete', paths: surface.files },
              privateSubpathPrefixes: targetPrivateSubpathPrefixes(eligibility.packageName),
            };
          } catch {
            importUnavailableReason = 'target-package-inventory-unavailable';
          }
        }
      }
      const endProjectDeep = performance.start('project compatibility import analysis');
      projectCompatibility = await appendProjectCompatibilityImportAnalysis({
        analysis: projectCompatibility,
        project: projectEvidence,
        ...(targetSurface === undefined ? {} : { targetSurface }),
        ...(importUnavailableReason === undefined ? {} : { unavailableReason: importUnavailableReason }),
        signal: analysisAbort.signal,
      });
      endProjectDeep({ findings: projectCompatibility.findings.length });
      endProjectTotal({ findings: projectCompatibility.findings.length });
      attachTrustedProjectCompatibilityNavigation({
        analysis: projectCompatibility,
        packageName: eligibility.packageName,
        folder: selected.folder,
        store: this.options.storeProjectCompatibilityReferences,
      });
      if (this.droppedByCancellation(eligibility.packageName)) return;
      this.options.sink.postMessage({
        status: 'upgrade-analysis-partial',
        requestId,
        package: eligibility.packageName,
        section: { kind: 'project-compatibility', projectCompatibility },
      });

      // --- security outcome (best-effort; never blocks the rest of the
      // analysis) — relocated here, right after compatibility, since its
      // only real data dependency is `analysis.status`, not the smart-plan
      // search below. Skipped when the Stage-0 early-post above already
      // answered this (no advisories to evaluate at all). ---
      let security: SecurityOutcome | null = null;
      if (!securityPosted) {
        let after: Parameters<typeof evaluateSecurityOutcome>[0]['after'] = 'no-resolver-evidence';
        const proposedSecurityGraph = await securityGraphPromise;
        if (proposedSecurityGraph !== undefined) {
          after = { graph: proposedSecurityGraph, advisoriesByName: advisoriesByNameFromRows(rows) };
        }
        const combinedSecurity = combineSecurityOutcomes(
          securityInputs.map(({ item, before }) =>
            evaluateSecurityOutcome({
              before,
              targetVersion: item.target,
              rootPackageName: item.packageName,
              after,
            })
          )
        );
        security = combinedSecurity === null
          ? null
          : {
              ...combinedSecurity,
              contexts: buildVulnerabilityContexts({
                graph,
                attributedAdvisories: securityInputs.flatMap(({ before }) => before),
                ...(proposedSecurityGraph === undefined
                  ? {}
                  : { proposed: { graph: proposedSecurityGraph, proposal } }),
              }),
            };

        if (this.droppedByCancellation(eligibility.packageName)) return;
        this.options.sink.postMessage({
          status: 'upgrade-analysis-partial',
          requestId,
          package: eligibility.packageName,
          section: { kind: 'security', security },
        });
      }

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
        this.options.sink.postMessage({ status: 'upgrade-analyzing', package: eligibility.packageName, phase: 'smart-plan', requestId });
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

        if (this.droppedByCancellation(eligibility.packageName)) return;
        this.options.sink.postMessage({
          status: 'upgrade-analysis-partial',
          requestId,
          package: eligibility.packageName,
          section: { kind: 'smart-plan', smartPlan },
        });
      }

      // A cancel-upgrade with `analysisId: null` arrived while the above was
      // in flight — drop the result rather than storing/posting it, and let
      // `finally` release the lock like any other unsuccessful exit. Every
      // partial post above already checked this at the moment its own data
      // became ready; this is the last-line defense for the gap between the
      // final partial and final assembly.
      if (this.droppedByCancellation(eligibility.packageName)) return;

      // Source/config files are not part of the dependency lock snapshot, so
      // re-read their bounded evidence once before retaining an actionable
      // review. A change during medium/deep analysis invalidates the result
      // instead of silently attaching findings to an older source state.
      const finalReadGeneration = this.options.projectCompatibilitySourceGeneration?.() ?? 0;
      const [finalProjectEvidence, finalDiskSnapshot] = await Promise.all([
        collectProjectCompatibilityEvidence({
          folder: selected.folder,
          dir: selected.dir,
          manifestText: preflightProject.manifestText,
          packageName: eligibility.packageName,
          signal: analysisAbort.signal,
        }).catch(() => null),
        this.projectLoader(selected).catch(() => null),
      ]);
      if (
        !projectCompatibilityFinalReadIsCurrent({
          generationBeforeRead: finalReadGeneration,
          generationAfterRead: this.options.projectCompatibilitySourceGeneration?.() ?? 0,
          expectedFingerprint: projectEvidence.evidenceFingerprint === 'unavailable'
            ? null
            : projectEvidence.evidenceFingerprint,
          observedFingerprint: finalProjectEvidence?.evidenceFingerprint ?? null,
        }) ||
        finalDiskSnapshot === null ||
        !resolvedProjectSourceMatches(finalDiskSnapshot, preflightProject)
      ) {
        this.options.sink.postMessage({
          status: 'upgrade-error',
          package: eligibility.packageName,
          error: {
            code: 'STALE_SOURCE',
            message: 'Project source changed during compatibility analysis. Refresh and try again.',
          },
        });
        return;
      }

      const analysisId = randomBytes(16).toString('hex');
      const analyzedAt = new Date().toISOString();
      const expiresAt = Date.now() + UPGRADE_ANALYSIS_RETENTION_MS;
      this.analysis = {
        id: analysisId,
        requests: [...messages],
        publishedTargetsByPackage,
        eligibility,
        snapshot: preflightProject,
        proposal,
        compatibilityStatus: analysis.status,
        smartPlanProposal,
        ignoreScripts: upgradeConfiguration.ignoreScripts,
        verificationScripts,
        projectCompatibilityEvidenceFingerprint:
          projectEvidence.evidenceFingerprint === 'unavailable' ? null : projectEvidence.evidenceFingerprint,
        expiresAt,
      };

      this.options.sink.postMessage({
        status: 'upgrade-analysis',
        requestId,
        analysis: buildUpgradeAnalysisPresentation({
          analysisId,
          analyzedAt,
          expiresAt: new Date(expiresAt).toISOString(),
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
          projectCompatibility,
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
      if (analysisAbort.signal.aborted) {
        this.droppedByCancellation(eligibility.packageName);
        return;
      }
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
      if (!succeeded) await this.releaseReservation(eligibility.packageName);
      if (this.pendingAnalyzePackage === eligibility.packageName) this.pendingAnalyzePackage = null;
      if (this.cancelRequestedFor === eligibility.packageName) this.cancelRequestedFor = null;
      if (this.sourceInvalidatedAnalyzePackage === eligibility.packageName) {
        this.sourceInvalidatedAnalyzePackage = null;
      }
      if (this.activeUpgradeAnalysisAbort === analysisAbort) this.activeUpgradeAnalysisAbort = undefined;
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
      if (this.pendingAnalyzePackage !== null) {
        this.cancelRequestedFor = this.pendingAnalyzePackage;
        this.activeUpgradeAnalysisAbort?.abort();
      }
      return;
    }
    if (this.analysis === undefined || this.analysis.id !== message.analysisId) return;
    void this.releaseReservation(this.analysis.eligibility.packageName);
    this.analysis = undefined;
  }

  /**
   * Called (debounced, via dashboardPanel.ts's watcher timers) after a
   * manifest/lockfile/configuration or analyzed source change. If an analysis
   * is currently open, re-reads disk with the same projectLoader used by the
   * authoritative STALE_SOURCE recheck and compares against the exact same
   * fields executeStoredAnalysis compares below — never a second, looser
   * definition of "changed." A mismatch posts a lightweight,
   * non-authoritative `upgrade-analysis-stale` hint; it never touches
   * `this.analysis` or the lock, and never substitutes for the real
   * STALE_SOURCE recheck confirm/use-smart-plan still run unconditionally.
   *
   * FileChangeCoordinator's own reload is deferred for exactly as long as
   * `this.isBusy()` is true, which is true for the entire duration an
   * analysis is open (the panel-wide lock is reserved across preflight and
   * however long the review panel stays open) — so this is the one place
   * that still checks disk during that window; detecting staleness of an
   * *open* analysis is exactly the case the deferred reload cannot cover.
   */
  async checkOpenAnalysisFreshness(): Promise<void> {
    const stored = this.analysis;
    if (stored === undefined || this.options.isDisposed()) return;
    const selected = this.options.getSelectedProject();
    if (selected === undefined) return;
    const disk = await this.projectLoader(selected);
    // Re-check after the await: a confirm/cancel/TTL-reclaim may have
    // superseded this exact stored analysis while disk was being re-read.
    if (this.analysis !== stored || this.options.isDisposed()) return;
    let matches = resolvedProjectSourceMatches(disk, stored.snapshot);
    if (matches && stored.projectCompatibilityEvidenceFingerprint !== null) {
      const evidence = await collectProjectCompatibilityEvidence({
        folder: selected.folder,
        dir: selected.dir,
        manifestText: disk.manifestText,
        packageName: stored.eligibility.packageName,
      }).catch(() => null);
      // A confirm/cancel/new analysis may supersede this one during the
      // bounded source scan; never stale a newer retained review.
      if (this.analysis !== stored || this.options.isDisposed()) return;
      matches = projectCompatibilityEvidenceIsCurrent(
        stored.projectCompatibilityEvidenceFingerprint,
        evidence?.evidenceFingerprint ?? null
      );
    }
    if (!matches) {
      this.options.sink.postMessage({ status: 'upgrade-analysis-stale', analysisId: stored.id });
    }
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

    const requestedPackage = message.changes[0]?.package ?? 'unknown';
    if (this.pendingRemovalAnalysis !== undefined) {
      this.options.sink.postMessage({
        status: 'remove-error',
        package: requestedPackage,
        error: { code: 'UPGRADE_IN_PROGRESS', message: 'Another dependency operation is already in progress for this project.' },
      });
      return;
    }
    const pending: PendingRemovalAnalysis = {
      packageName: requestedPackage,
      cancelled: false,
      reservationHeld: false,
      releaseStarted: false,
    };
    this.pendingRemovalAnalysis = pending;

    const controller = await this.options.ensureController();
    if (controller === undefined || pending.cancelled || this.pendingRemovalAnalysis !== pending) {
      if (this.pendingRemovalAnalysis === pending) this.pendingRemovalAnalysis = undefined;
      return;
    }

    const batch = controller.validateBulkRemoveRequest(message.changes);
    if (!batch.ok) {
      this.options.sink.postMessage({
        status: 'remove-error',
        package: batch.packageName ?? message.changes[0]?.package ?? 'unknown',
        error: describeBulkRemoveRejection(batch),
      });
      if (this.pendingRemovalAnalysis === pending) this.pendingRemovalAnalysis = undefined;
      return;
    }
    const eligibility = batch.removals[0];
    if (eligibility === undefined) {
      if (this.pendingRemovalAnalysis === pending) this.pendingRemovalAnalysis = undefined;
      return;
    }
    const eligibilities = batch.removals;

    // Same reservation discipline as an upgrade — held across analysis and
    // however long the review modal stays open, not merely execution.
    if (!this.reserve(eligibility.packageName)) {
      this.options.sink.postMessage({
        status: 'remove-error',
        package: eligibility.packageName,
        // Reuses the upgrade flow's own code: it is the same panel-wide
        // lock, so the webview's existing upgradeErrorClearsActiveState/
        // upgradeErrorIsUserVisible already treat this race the right way
        // (quiet, doesn't clear whatever this webview is itself tracking).
        error: { code: 'UPGRADE_IN_PROGRESS', message: 'Another dependency operation is already in progress for this project.' },
      });
      if (this.pendingRemovalAnalysis === pending) this.pendingRemovalAnalysis = undefined;
      return;
    }
    pending.reservationHeld = true;
    const analysisSourceGeneration = this.sourceGeneration.capture();

    let succeeded = false;
    try {
      const selected = this.options.getSelectedProject();
      if (selected === undefined) return;
      const source = controller.upgradeSource;
      const preflightProject = await this.projectLoader(selected);
      if (pending.cancelled || this.pendingRemovalAnalysis !== pending || this.options.isDisposed()) return;
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
      const peerRequirementIndex = buildPeerRequirementIndex(graph);
      const whyInstalledIndex = buildWhyInstalledIndex(graph);
      const requiredPeerBlock = eligibilities
        .map((item) => ({
          packageName: item.packageName,
          requirements: peerRequirementsFor(graph, item.packageName, removingNames, peerRequirementIndex).filter((requirement) => !requirement.optional),
        }))
        .find((item) => item.requirements.length > 0);
      if (requiredPeerBlock !== undefined) {
        const owners = requiredPeerBlock.requirements.map((requirement) => requirement.requiredBy).join(', ');
        this.options.sink.postMessage({
          status: 'remove-error',
          package: requiredPeerBlock.packageName,
          error: {
            code: 'REQUIRED_PEER_DEPENDENCY',
            message: `${requiredPeerBlock.packageName} is required as a peer dependency by ${owners}. Remove the requiring package in the same operation or keep this dependency.`,
          },
        });
        return;
      }
      const changes = eligibilities.map((item) => ({
        packageName: item.packageName,
        classification: item.classification,
        stillRequiredBy: stillRequiredBy(graph, manifest.dependencies, item.packageName, removingNames, whyInstalledIndex),
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
      const removal: StoredRemoval = {
        id: analysisId,
        requests: [...message.changes],
        eligibility,
        eligibilities,
        snapshot: preflightProject,
        ignoreScripts,
        verificationScripts,
        expiresAt: Date.now() + REMOVAL_ANALYSIS_TTL_MS,
      };
      if (pending.cancelled || this.pendingRemovalAnalysis !== pending || this.options.isDisposed()) return;
      if (!this.sourceGeneration.commitIfCurrent(analysisSourceGeneration, () => {
        this.removal = removal;
      })) {
        this.options.sink.postMessage({
          status: 'remove-error',
          package: eligibility.packageName,
          error: {
            code: 'STALE_SOURCE',
            message: 'Project files changed while removal impact was being analyzed. Analyze again.',
          },
        });
        return;
      }

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
      if (!pending.cancelled && this.pendingRemovalAnalysis === pending && !this.options.isDisposed()) {
        this.options.sink.postMessage({ status: 'remove-error', package: eligibility.packageName, error: toProtocolError(cause) });
      }
      return;
    } finally {
      if (this.pendingRemovalAnalysis === pending) this.pendingRemovalAnalysis = undefined;
      if (!succeeded && pending.reservationHeld && !pending.releaseStarted) {
        pending.releaseStarted = true;
        await this.releaseReservation(eligibility.packageName);
      }
    }
  }

  async handleConfirmRemove(message: AnalysisMessage): Promise<void> {
    await this.executeStoredRemoval(message.analysisId);
  }

  handleCancelRemove(message: CancelUpgradeMessage): void {
    if (message.analysisId === null) {
      const pending = this.pendingRemovalAnalysis;
      if (pending === undefined || pending.cancelled) return;
      pending.cancelled = true;
      // Free the request slot synchronously. The abandoned operation compares
      // identity after every await, so it cannot clear or publish over a
      // replacement that starts immediately after this cancellation.
      this.pendingRemovalAnalysis = undefined;
      if (pending.reservationHeld && !pending.releaseStarted) {
        pending.releaseStarted = true;
        void this.releaseReservation(pending.packageName);
      }
      return;
    }
    if (this.removal === undefined || this.removal.id !== message.analysisId) return;
    void this.releaseReservation(this.removal.eligibility.packageName);
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
    const now = Date.now();
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
      now,
      wantsSmartPlan,
    });
    if (!lookup.ok || stored === undefined) {
      this.options.sink.postMessage({
        status: 'upgrade-error',
        package: stored?.eligibility.packageName ?? 'unknown',
        error: ANALYSIS_LOOKUP_ERRORS[lookup.ok ? 'STALE_ANALYSIS' : lookup.reason],
      });
      if (stored !== undefined && now >= stored.expiresAt) {
        this.analysis = undefined;
        await this.releaseReservation(stored.eligibility.packageName);
      }
      return;
    }
    // `wantsSmartPlan` guarantees `hasSmartPlan` was true for `lookup.ok` to
    // be true, so `smartPlanProposal` is never null here — the `??`
    // fallback below only exists to satisfy the type checker, not because
    // this path is reachable.
    const proposal = wantsSmartPlan ? (stored.smartPlanProposal ?? stored.proposal) : stored.proposal;
    const executionSourceGeneration = this.sourceGeneration.capture();

    // Single-use: cleared now, regardless of outcome, so a retry always goes
    // through a fresh handleAnalyzeUpgrade.
    this.analysis = undefined;

    const controller = await this.options.ensureController();
    if (controller === undefined) {
      await this.releaseReservation(stored.eligibility.packageName);
      return;
    }

    try {
      const selected = this.options.getSelectedProject();
      if (selected === undefined) return;

      // A modal can remain open while project/config files change. Re-read
      // and repeat the host-owned eligibility check immediately before the
      // snapshot; the stored analysis is never execution authority.
      const disk = await this.projectLoader(selected);
      const sourceStillMatches = disk.root === controller.root && resolvedProjectSourceMatches(disk, stored.snapshot);
      const rechecked = controller.validateBulkUpgradeRequest(
        stored.requests,
        stored.publishedTargetsByPackage
      );
      const currentProjectEvidence = sourceStillMatches && stored.projectCompatibilityEvidenceFingerprint !== null
        ? await collectProjectCompatibilityEvidence({
            folder: selected.folder,
            dir: selected.dir,
            manifestText: disk.manifestText,
            packageName: stored.eligibility.packageName,
          }).catch(() => null)
        : null;
      const projectEvidenceStillMatches = projectCompatibilityEvidenceIsCurrent(
        stored.projectCompatibilityEvidenceFingerprint,
        currentProjectEvidence?.evidenceFingerprint ?? null
      );
      if (!sourceStillMatches || !projectEvidenceStillMatches || !rechecked.ok) {
        this.options.sink.postMessage({
          status: 'upgrade-error',
          package: stored.eligibility.packageName,
          error: {
            code: 'STALE_SOURCE',
            message: 'Project dependency or analyzed source files changed while the analysis was open. Refresh and try again.',
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

      if (!this.sourceGeneration.isCurrent(executionSourceGeneration)) {
        this.options.sink.postMessage({
          status: 'upgrade-error',
          package: stored.eligibility.packageName,
          error: {
            code: 'STALE_SOURCE',
            message: 'Project files changed before the upgrade could begin. Refresh and try again.',
          },
        });
        return;
      }
      if (!this.reservation.beginMutation(stored.eligibility.packageName)) return;
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

      let finalProject: ResolvedProject | undefined;
      let structurallyCurrent = false;
      let appliedState: ReturnType<typeof inspectAppliedUpgradeState> = {
        confirmed: false,
        changes: proposal.changes.map((change) => ({
          packageName: change.packageName,
          previousVersion: change.currentVersion,
          requestedVersion: change.targetVersion,
          currentVersion: null,
          declaredRange: null,
          classification: null,
        })),
      };
      try {
        if (this.options.readAndApplyMutationLocalState === undefined) {
          finalProject = await this.projectLoader(selected);
        } else {
          const localRead = await this.options.readAndApplyMutationLocalState();
          finalProject = localRead?.project;
          structurallyCurrent = localRead?.structurallyCurrent === true;
        }
        if (finalProject !== undefined) appliedState = inspectAppliedUpgradeState(finalProject, proposal.changes);
      } catch {
        // A successful task is not enough to claim the requested state was
        // applied. Keep the explicit unconfirmed result and let the normal
        // enrichment reload recover/display whatever can still be read.
      }

      const usedTargetedRefresh =
        finalProject !== undefined &&
        this.options.readAndApplyMutationLocalState !== undefined &&
        this.options.refreshMutationEnrichmentInBackground !== undefined;
      const refreshId = randomBytes(16).toString('hex');
      if (this.options.isDisposed()) return;

      const application: UpgradeResultPresentation['application'] = classifyUpgradeApplication(
        transaction.completion,
        structurallyCurrent,
        appliedState.confirmed
      );
      const verification: UpgradeResultPresentation['verification'] =
        transaction.verification.status === 'passed'
          ? 'passed'
          : transaction.verification.status === 'failed'
            ? 'failed'
            : transaction.verification.status === 'not-run' && transaction.verification.reason === 'not-configured'
              ? 'not-configured'
              : 'not-run';

      if (transaction.install.status === 'succeeded' || application === 'rolled-back') {
        this.options.sink.postMessage({
          status: 'upgrade-result',
          result: {
            package: stored.eligibility.packageName,
            refreshId,
            install: transaction.install.status === 'succeeded' ? 'succeeded' : 'failed',
            application,
            verification,
            changes: appliedState.changes,
            refreshingDerivedData: usedTargetedRefresh,
          },
        });
      }

      if (usedTargetedRefresh) {
        this.options.refreshMutationEnrichmentInBackground?.(
          refreshId,
          stored.eligibility.packageName,
          structurallyCurrent
        );
      } else if (!this.options.isDisposed()) {
        // Compatibility fallback for embedders/tests that have not supplied
        // the targeted-refresh hooks. The result above is still surfaced
        // before this potentially expensive scan.
        await this.options.reloadFinalState();
      }
      if (this.options.isDisposed()) return;

      const presentation = describeUpgradeTransactionOutcome(
        stored.eligibility.packageName,
        source.packageManager,
        transaction,
        structurallyCurrent && appliedState.confirmed
      );
      if (
        presentation.kind === 'verified' ||
        (presentation.kind === 'unverified' && transaction.verification.status === 'not-run')
      ) {
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
      await this.releaseReservation(stored.eligibility.packageName);
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
    const now = Date.now();
    if (stored === undefined || stored.id !== analysisId || now >= stored.expiresAt) {
      this.options.sink.postMessage({
        status: 'remove-error',
        package: stored?.eligibility.packageName ?? 'unknown',
        error: { code: 'STALE_ANALYSIS', message: 'This removal analysis is no longer current. Analyze again.' },
      });
      if (stored !== undefined && now >= stored.expiresAt) {
        this.removal = undefined;
        await this.releaseReservation(stored.eligibility.packageName);
      }
      return;
    }
    const executionSourceGeneration = this.sourceGeneration.capture();

    // Single-use: cleared now, regardless of outcome, so a retry always goes through a fresh handleAnalyzeBulkRemove.
    this.removal = undefined;

    const controller = await this.options.ensureController();
    if (controller === undefined) {
      await this.releaseReservation(stored.eligibility.packageName);
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

      if (!this.sourceGeneration.isCurrent(executionSourceGeneration)) {
        this.options.sink.postMessage({
          status: 'remove-error',
          package: stored.eligibility.packageName,
          error: {
            code: 'STALE_SOURCE',
            message: 'Project files changed before removal could begin. Refresh and try again.',
          },
        });
        return;
      }
      if (!this.reservation.beginMutation(stored.eligibility.packageName)) return;
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
      await this.releaseReservation(stored.eligibility.packageName);
    }
  }
}
