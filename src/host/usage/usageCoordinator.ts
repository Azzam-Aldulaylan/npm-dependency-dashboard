/**
 * Host-side coordinator for on-demand usage analysis — "Where is this
 * used?" (one package) and "Analyze cleanup" (every direct dependency),
 * sharing the same analyzer (usageAnalyzer.ts) and the same trusted
 * reference store (usageReferenceStore.ts).
 *
 * At most one usage analysis runs at a time for the whole panel — a second
 * request while one is in flight is rejected, mirroring the existing "one
 * upgrade at a time" rule (UpgradeAssistantCoordinator) rather than
 * introducing a new concurrency model. Entirely read-only: no manifest/
 * lockfile write, so unlike an upgrade this never needs the panel's mutation
 * lock — only its own single-flight guard.
 *
 * Caching: an in-memory, per-project, per-package cache keyed by both the
 * manifest/lockfile source fingerprint and a watcher-owned source/config
 * generation, with a short TTL as a secondary bound. Relevant file events
 * synchronously advance only the selected project's generation, so stale
 * entries and in-flight publications are rejected without fingerprinting or
 * retaining the source tree.
 *
 * "Analyze cleanup" also runs automatically — quietly, in the background,
 * never as part of the initial loading skeleton — after dependency data
 * settles: first open, manual Refresh, and every successful Upgrade/Remove
 * (single, bulk, or Smart). `requestBackgroundUsageRefresh` is the single
 * entry point every one of those callers uses; see its own doc for how a
 * request that can't run immediately (another usage analysis in flight, or
 * the panel's upgrade/remove mutation lock still held) is retried once
 * whatever was blocking it clears, instead of being silently dropped.
 * `background: true` on `handleAnalyzeCleanup` (only ever set by that
 * mechanism) skips the VS Code progress notification and the
 * `cleanup-analyzing` posts, and swallows failures instead of surfacing a
 * `cleanup-error` banner, so it never disables toolbar actions or announces
 * itself — badges simply appear once the result lands. An explicit user
 * click is never `background` and keeps today's visible progress/error UI.
 */

import * as vscode from 'vscode';

import { buildDependencyGraph } from '../../core/lockfile/build.js';
import { parseManifest } from '../../core/manifest/parse.js';
import { computeSourceFingerprint } from '../../core/cache/sourceFingerprint.js';
import type { ProjectSourceFingerprint } from '../../core/cache/sourceFingerprint.js';
import { buildUnusedFinding } from '../../core/usage/unused.js';
import type { DependencyReference, DependencyUsageResult } from '../../core/usage/types.js';
import type { DependencyFinding } from '../../core/hygiene/types.js';
import { buildWhyInstalledIndex } from '../../core/hygiene/whyInstalled.js';
import { isFrameworkConventionPackage } from '../../core/usage/frameworkConventions.js';
import { buildPeerRequirementIndex, peerRequirementsFor } from '../../core/upgrade/peerRequirement.js';
import { stillRequiredBy } from '../../core/upgrade/removeImpact.js';
import { assessRemoval } from '../../core/upgrade/removalAssessment.js';
import { createPerformanceSession } from '../../core/performance/measurement.js';
import type { DashboardController, MessageSink } from '../dashboardController.js';
import type { DiscoveredProject } from '../projectResolution.js';
import type { RemovalImpactAssessment } from '../webviewProtocol.js';
import { shouldRunBackgroundUsageRefresh } from './backgroundUsageRefreshGate.js';
import type { ProjectUsageAnalysisMarker } from './backgroundUsageRefreshGate.js';
import { analyzeDependencyUsage } from './usageAnalyzer.js';
import {
  UsageAnalysisState,
  ForegroundUsageOperationRegistry,
  foregroundUsageBusyMessage,
  canJoinBackgroundUsageScan,
  shouldCancelUnderlyingUsageScan,
  usageScanFailureAudience,
  usageSourceIdentitiesMatch,
  USAGE_ANALYSIS_REUSE_MS,
  type UsageSourceIdentity,
} from './usageAnalysisState.js';
import { UsageReferenceStore } from './usageReferenceStore.js';

export interface WhereUsedMessage {
  package: string;
}

export interface AnalyzeRemovalImpactMessage {
  requestId: string;
  packages: string[];
}

export interface CancelRemovalImpactMessage {
  requestId: string;
}

export interface OpenUsageReferenceMessage {
  usageId: string;
  referenceIndex: number;
}

export interface UsageCoordinatorOptions {
  sink: MessageSink;
  ensureController(): Promise<DashboardController | undefined>;
  getSelectedProject(): DiscoveredProject | undefined;
  isDisposed(): boolean;
  performanceEnabled?(): boolean;
  /** Whether the panel-wide upgrade/remove mutation lock is held — see requestBackgroundUsageRefresh. */
  isUpgradeBusy?(): boolean;
}

export const USAGE_CACHE_TTL_MS = USAGE_ANALYSIS_REUSE_MS;

interface ActiveUsageScan {
  projectId: string;
  identity: UsageSourceIdentity;
  packageNames: ReadonlySet<string>;
  backgroundOwner: boolean;
  cts: vscode.CancellationTokenSource;
  progressSubscribers: Set<(scanned: number, total: number) => void>;
  promise: Promise<Map<string, DependencyUsageResult>>;
}

interface ForegroundUsageConsumerValue {
  scan: ActiveUsageScan;
  ownsScan: boolean;
}

type ForegroundUsageConsumer = import('./usageAnalysisState.js').ForegroundUsageOperation<ForegroundUsageConsumerValue>;

function toProtocolError(cause: unknown): { code: string; message: string } {
  if (cause instanceof Error) return { code: cause.name, message: cause.message };
  return { code: 'UNKNOWN', message: String(cause) };
}

export class UsageAnalysisCoordinator {
  private readonly referenceStore = new UsageReferenceStore();
  private readonly analysisState = new UsageAnalysisState(USAGE_CACHE_TTL_MS);
  /** Request-visible usage state currently rendered by package, scoped to its project. */
  private readonly visibleUsageProjects = new Map<string, string>();
  /** Cleanup findings have no protocol reset, so retain their real analysis time for an expired empty supersession result. */
  private visibleCleanup: { projectId: string; analyzedAt?: string } | undefined;
  /** Correlation identity for the removal-impact result currently visible in the webview. */
  private visibleRemovalImpact: {
    projectId: string;
    requestId: string;
    packages: readonly string[];
    /** Host-derived packages whose completed assessment permits deliberate removal. */
    selectablePackages: ReadonlySet<string>;
    identity: UsageSourceIdentity;
    ready: boolean;
  } | undefined;
  /** Registered before the first await so cancel can terminate even controller/project lookup races. */
  private activeRemovalImpactRequest: {
    requestId: string;
    packages: readonly string[];
    cancelled: boolean;
    consumer?: ForegroundUsageConsumer;
  } | undefined;
  /** Project-wide completion marker; explicit and automatic cleanup passes share the same one-hour reuse window. */
  private readonly lastProjectAnalysis = new Map<string, ProjectUsageAnalysisMarker>();
  private activeScan: ActiveUsageScan | undefined;
  private readonly foregroundOperations = new ForegroundUsageOperationRegistry<ForegroundUsageConsumerValue>();
  /** At most one slot: multiple requests before it can run collapse into it — force always wins. See requestBackgroundUsageRefresh. */
  private pendingBackgroundRequest: { force: boolean } | undefined;
  /** Guards the async gap before handleAnalyzeCleanup claims `activeScan`, so racing callers cannot both start a scan. */
  private schedulingBackgroundRefresh = false;

  constructor(private readonly options: UsageCoordinatorOptions) {}

  isBusy(): boolean {
    return this.activeScan !== undefined;
  }

  /**
   * Synchronous watcher boundary. No source-tree read is needed: advancing
   * this project-only generation immediately makes cache entries and async
   * completions stale, while other projects remain isolated.
   */
  invalidateProjectSource(projectId = this.options.getSelectedProject()?.id): number {
    if (projectId === undefined) return 0;
    const generation = this.analysisState.invalidate(projectId);
    this.lastProjectAnalysis.delete(projectId);
    if (this.activeScan?.projectId === projectId) this.activeScan.cts.cancel();
    this.supersedeVisibleAnalysis(projectId);
    return generation;
  }

  /**
   * Cache invalidation alone is insufficient when a source-only watcher event
   * does not replace the dashboard snapshot: already-rendered usage/removal
   * evidence would otherwise remain visible until the user requested it
   * again. Reuse only existing protocol states, and revoke opaque reference
   * authority before publishing the supersession messages.
   */
  private supersedeVisibleAnalysis(projectId: string): void {
    const packages = [...this.visibleUsageProjects]
      .filter(([, visibleProjectId]) => visibleProjectId === projectId)
      .map(([packageName]) => packageName);
    const cleanupVisible = this.visibleCleanup?.projectId === projectId;
    const removalVisible = this.visibleRemovalImpact?.projectId === projectId;
    if (
      packages.length > 0 ||
      cleanupVisible ||
      removalVisible ||
      this.options.getSelectedProject()?.id === projectId
    ) this.referenceStore.clear();
    if (packages.length === 0 && !cleanupVisible && !removalVisible) return;
    for (const packageName of packages) {
      this.visibleUsageProjects.delete(packageName);
      this.options.sink.postMessage({
        status: 'usage-error',
        package: packageName,
        error: {
          code: 'STALE_SOURCE',
          message: 'Project source or configuration changed. Re-analyze usage.',
        },
      });
    }
    if (cleanupVisible) {
      const analyzedAt = this.visibleCleanup?.analyzedAt ?? new Date().toISOString();
      this.visibleCleanup = undefined;
      // There is no cleanup-idle protocol message. An empty result with an
      // already-expired cache boundary clears stale likely-unused findings
      // while accurately presenting the previous analysis as stale.
      this.options.sink.postMessage({
        status: 'cleanup-result',
        findings: [],
        analyzedAt,
        cacheExpiresAt: new Date(0).toISOString(),
      });
    }
    if (removalVisible) {
      const visible = this.visibleRemovalImpact;
      this.visibleRemovalImpact = undefined;
      if (visible === undefined) return;
      this.options.sink.postMessage({
        status: 'removal-impact-error',
        requestId: visible.requestId,
        packages: [...visible.packages],
        error: {
          code: 'STALE_SOURCE',
          message: 'Project source or configuration changed. Re-analyze removal impact.',
        },
      });
    }
  }

  /**
   * Reuses the existing opaque UsageReferenceStore boundary for compatibility
   * findings. The references were collected by the host; display paths never
   * become navigation authority in the webview.
   */
  storeProjectCompatibilityReferences(
    packageName: string,
    references: readonly DependencyReference[],
    folder: vscode.WorkspaceFolder
  ): string | null {
    if (references.length === 0) return null;
    return this.referenceStore.store(packageName, {
      packageName,
      references: [...references],
      truncated: false,
      scannedFileCount: 0,
      scannedAt: new Date().toISOString(),
    }, folder);
  }

  dispose(): void {
    if (this.activeRemovalImpactRequest !== undefined) this.activeRemovalImpactRequest.cancelled = true;
    this.activeScan?.cts.cancel();
    this.foregroundOperations.cancelActive((consumer) => {
      if (shouldCancelUnderlyingUsageScan(consumer.ownsScan)) consumer.scan.cts.cancel();
    });
    this.pendingBackgroundRequest = undefined;
    this.referenceStore.clear();
  }

  private fingerprintFor(controller: DashboardController): ProjectSourceFingerprint {
    const source = controller.upgradeSource;
    return computeSourceFingerprint({
      manifestText: source.manifestText,
      lockfileText: source.lockfileText,
      packageManager: source.packageManager,
      importerId: source.importerId,
      lockfilePath: source.lockfilePath,
    });
  }

  private identityFor(controller: DashboardController, selected: DiscoveredProject): UsageSourceIdentity {
    return this.analysisState.identity(selected.id, this.fingerprintFor(controller));
  }

  private isCurrent(projectId: string, identity: UsageSourceIdentity): boolean {
    return this.analysisState.isCurrent(projectId, identity);
  }

  /**
   * Returns a host-only freshness guard for a canonical selected subset of the
   * exact visible removal-impact result Smart Cleanup is asking to execute.
   * Source/config watcher events synchronously revoke this guard, including
   * while the later removal review is open, so a newly-added import can never
   * reuse an old "unused" result. Blocked/unknown assessments are deliberately
   * excluded even if a forged webview asks for them.
   */
  smartCleanupRemovalEvidence(
    requestId: string,
    packages: readonly string[]
  ): { isCurrent(): boolean } | null {
    const visible = this.visibleRemovalImpact;
    const selected = this.options.getSelectedProject();
    if (
      visible === undefined ||
      !visible.ready ||
      selected === undefined ||
      visible.projectId !== selected.id ||
      visible.requestId !== requestId ||
      packages.length === 0 ||
      packages.some((name, index) =>
        (index > 0 && (packages[index - 1]?.localeCompare(name) ?? -1) >= 0) ||
        !visible.selectablePackages.has(name)
      )
    ) return null;

    const captured = visible;
    return {
      isCurrent: () => {
        const current = this.visibleRemovalImpact;
        return (
          current === captured &&
          current.ready &&
          this.options.getSelectedProject()?.id === captured.projectId &&
          this.isCurrent(captured.projectId, captured.identity) &&
          usageSourceIdentitiesMatch(current.identity, captured.identity)
        );
      },
    };
  }

  private startScan(input: {
    projectId: string;
    identity: UsageSourceIdentity;
    selected: DiscoveredProject;
    manifestText: string;
    packageNames: readonly string[];
    backgroundOwner: boolean;
    performance: ReturnType<typeof createPerformanceSession>;
    onProgress?: (scanned: number, total: number) => void;
  }): ActiveUsageScan {
    const cts = new vscode.CancellationTokenSource();
    const progressSubscribers = new Set<(scanned: number, total: number) => void>();
    if (input.onProgress !== undefined) progressSubscribers.add(input.onProgress);
    const scan = {
      projectId: input.projectId,
      identity: input.identity,
      packageNames: new Set(input.packageNames),
      backgroundOwner: input.backgroundOwner,
      cts,
      progressSubscribers,
      promise: Promise.resolve(new Map<string, DependencyUsageResult>()),
    } satisfies ActiveUsageScan;
    scan.promise = analyzeDependencyUsage({
      folder: input.selected.folder,
      dir: input.selected.dir,
      manifestText: input.manifestText,
      packageNames: input.packageNames,
      token: cts.token,
      performance: input.performance,
      onProgress: (scanned, total) => {
        for (const subscriber of progressSubscribers) subscriber(scanned, total);
      },
    }).finally(() => {
      if (this.activeScan === scan) {
        this.activeScan = undefined;
        cts.dispose();
        this.triggerPendingBackgroundRefresh();
      }
    });
    this.activeScan = scan;
    return scan;
  }

  private joinBackgroundScan(
    projectId: string,
    identity: UsageSourceIdentity,
    packageNames: readonly string[]
  ): ActiveUsageScan | undefined {
    const scan = this.activeScan;
    if (scan === undefined || !canJoinBackgroundUsageScan({
      backgroundOwner: scan.backgroundOwner,
      scanProjectId: scan.projectId,
      requestedProjectId: projectId,
      scanIdentity: scan.identity,
      requestedIdentity: identity,
      scannedPackages: scan.packageNames,
      requestedPackages: packageNames,
    })) return undefined;
    return scan;
  }

  private createForegroundConsumer(
    scan: ActiveUsageScan,
    ownsScan: boolean
  ): ForegroundUsageConsumer | undefined {
    return this.foregroundOperations.claim({ scan, ownsScan });
  }

  private releaseForegroundConsumer(consumer: ForegroundUsageConsumer): void {
    this.foregroundOperations.release(consumer);
  }

  private cancelForegroundConsumer(consumer: ForegroundUsageConsumer): void {
    this.foregroundOperations.cancel(consumer, (active) => {
      if (shouldCancelUnderlyingUsageScan(active.ownsScan)) active.scan.cts.cancel();
    });
  }

  private cacheResults(
    projectId: string,
    identity: UsageSourceIdentity,
    results: ReadonlyMap<string, DependencyUsageResult>
  ): void {
    if (!this.isCurrent(projectId, identity)) return;
    for (const [name, result] of results) this.analysisState.set(projectId, name, identity, result);
  }

  /** On-demand, single-package usage scan — never runs a full cleanup pass just to answer one package. */
  async handleWhereUsed(message: WhereUsedMessage, bypassCache = false): Promise<void> {
    const controller = await this.options.ensureController();
    if (controller === undefined) return;
    const row = controller.lastResultRows().find((candidate) => candidate.name === message.package);
    if (row === undefined) {
      this.visibleUsageProjects.delete(message.package);
      this.options.sink.postMessage({
        status: 'usage-error',
        package: message.package,
        error: { code: 'UNKNOWN_PACKAGE', message: 'This package is not part of the current scan.' },
      });
      return;
    }
    const selected = this.options.getSelectedProject();
    if (selected === undefined) return;

    const identity = this.identityFor(controller, selected);
    const performance = createPerformanceSession(
      'Dependency Dashboard usage analysis',
      this.options.performanceEnabled?.() ?? false
    );
    const endCache = performance.start('usage cache lookup');
    const cached = bypassCache ? undefined : this.analysisState.get(selected.id, message.package, identity);
    if (cached !== undefined) performance.increment('usage cache hits');
    endCache({ hit: cached !== undefined, bypassed: bypassCache });
    if (cached !== undefined) {
      const usageId = this.referenceStore.store(message.package, cached.result, selected.folder);
      this.visibleUsageProjects.set(message.package, selected.id);
      this.options.sink.postMessage({
        status: 'usage-result',
        package: message.package,
        analysis: {
          usageId,
          result: cached.result,
          cacheExpiresAt: new Date(cached.cachedAt + USAGE_CACHE_TTL_MS).toISOString(),
          fromCache: true,
        },
      });
      performance.finish({ cached: true });
      return;
    }

    if (this.foregroundOperations.isClaimed()) {
      this.visibleUsageProjects.delete(message.package);
      this.options.sink.postMessage(foregroundUsageBusyMessage('usage', message.package));
      performance.finish({ cached: false, joined: false });
      return;
    }

    let scan = this.joinBackgroundScan(selected.id, identity, [message.package]);
    const joined = scan !== undefined;
    if (joined) performance.increment('usage joined scans');
    if (scan === undefined && this.isBusy()) {
      this.visibleUsageProjects.delete(message.package);
      this.options.sink.postMessage(foregroundUsageBusyMessage('usage', message.package));
      performance.finish({ cached: false, joined: false });
      return;
    }
    this.visibleUsageProjects.set(message.package, selected.id);
    this.options.sink.postMessage({ status: 'usage-analyzing', package: message.package });
    const source = controller.upgradeSource;
    scan ??= this.startScan({
      projectId: selected.id,
      identity,
      selected,
      manifestText: source.manifestText,
      packageNames: [message.package],
      backgroundOwner: false,
      performance,
    });
    const consumer = this.createForegroundConsumer(scan, !joined);
    if (consumer === undefined) {
      if (!joined) scan.cts.cancel();
      this.visibleUsageProjects.delete(message.package);
      this.options.sink.postMessage(foregroundUsageBusyMessage('usage', message.package));
      performance.finish({ cached: false, joined });
      return;
    }
    try {
      const resultsByPackage = await scan.promise;
      if (
        consumer.cancelled ||
        scan.cts.token.isCancellationRequested ||
        this.options.isDisposed() ||
        !this.isCurrent(selected.id, identity)
      ) return;

      const result = resultsByPackage.get(message.package);
      if (result === undefined) return;
      const cachedEntry = this.analysisState.set(selected.id, message.package, identity, result);
      const usageId = this.referenceStore.store(message.package, result, selected.folder);
      this.visibleUsageProjects.set(message.package, selected.id);
      this.options.sink.postMessage({
        status: 'usage-result',
        package: message.package,
        analysis: {
          usageId,
          result,
          cacheExpiresAt: new Date(cachedEntry.cachedAt + USAGE_CACHE_TTL_MS).toISOString(),
          fromCache: false,
        },
      });
    } catch (cause) {
      const failureAudience = usageScanFailureAudience({
        backgroundOwner: scan.backgroundOwner,
        foregroundWaiters: consumer.cancelled ? 0 : 1,
      });
      if (failureAudience !== 'quiet' && !consumer.cancelled && !this.options.isDisposed() && this.isCurrent(selected.id, identity)) {
        this.visibleUsageProjects.delete(message.package);
        this.options.sink.postMessage({ status: 'usage-error', package: message.package, error: toProtocolError(cause) });
      }
    } finally {
      this.releaseForegroundConsumer(consumer);
      performance.finish({ cached: false, joined });
    }
  }

  /**
   * "Analyze cleanup" — every direct dependency at once, one pass over the
   * workspace's source files (see usageAnalyzer.ts's own doc for why this
   * costs the same I/O as a single package). Runs either from an explicit
   * user request (the 'analyze-cleanup' message handler in
   * dashboardPanel.ts) or automatically via requestBackgroundUsageRefresh.
   *
   * `background: true` (only ever set by requestBackgroundUsageRefresh)
   * skips the VS Code progress notification and every `cleanup-analyzing`
   * post, and swallows a failure instead of posting `cleanup-error` — an
   * auto-triggered run must never disable toolbar actions or announce
   * itself; it either quietly succeeds (badges appear) or quietly does
   * nothing. An explicit click always runs with `background: false`
   * (today's visible progress/error UI, unchanged).
   */
  async handleAnalyzeCleanup(options: { background?: boolean } = {}): Promise<boolean> {
    const background = options.background ?? false;
    if (this.isBusy()) {
      if (!background) {
        this.options.sink.postMessage({
          status: 'cleanup-error',
          error: { code: 'ANALYSIS_IN_PROGRESS', message: 'Another usage analysis is already in progress for this project.' },
        });
      }
      return false;
    }

    const controller = await this.options.ensureController();
    if (controller === undefined) return false;
    // `ensureController` may yield while another request starts a scan. Do
    // not overwrite that scan's ownership after the initial fast-path check.
    if (this.isBusy()) {
      if (!background) {
        this.options.sink.postMessage({
          status: 'cleanup-error',
          error: { code: 'ANALYSIS_IN_PROGRESS', message: 'Another usage analysis is already in progress for this project.' },
        });
      }
      return false;
    }
    const rows = controller.lastResultRows();
    const packageNames = rows.map((row) => row.name);
    const selected = this.options.getSelectedProject();
    if (selected === undefined) return false;
    const identity = this.identityFor(controller, selected);

    if (packageNames.length === 0) {
      const analyzedAt = new Date().toISOString();
      this.lastProjectAnalysis.set(selected.id, { identity, analyzedAt: Date.now() });
      this.visibleCleanup = { projectId: selected.id, analyzedAt };
      this.options.sink.postMessage({
        status: 'cleanup-result',
        findings: [],
        analyzedAt,
        cacheExpiresAt: new Date(Date.now() + USAGE_CACHE_TTL_MS).toISOString(),
      });
      return true;
    }

    const performance = createPerformanceSession(
      'Dependency Dashboard cleanup usage analysis',
      this.options.performanceEnabled?.() ?? false
    );
    performance.setMetadata('direct dependencies', packageNames.length);
    performance.setMetadata('background', background);
    if (!background) {
      const previousAnalyzedAt = this.visibleCleanup?.projectId === selected.id
        ? this.visibleCleanup.analyzedAt
        : undefined;
      this.visibleCleanup = { projectId: selected.id, ...(previousAnalyzedAt === undefined
        ? {}
        : { analyzedAt: previousAnalyzedAt }) };
      this.options.sink.postMessage({ status: 'cleanup-analyzing', scanned: 0, total: 0 });
    }

    let consumer: ForegroundUsageConsumer | undefined;
    try {
      const source = controller.upgradeSource;
      const runScan = async (
        progress: vscode.Progress<{ message?: string; increment?: number }> | undefined,
        onCancellationToken: vscode.CancellationToken | undefined
      ): Promise<Map<string, DependencyUsageResult>> => {
        let lastScanned = 0;
        const scan = this.startScan({
          projectId: selected.id,
          identity,
          selected,
          manifestText: source.manifestText,
          packageNames,
          backgroundOwner: background,
          performance,
          onProgress: (scanned, total) => {
            const increment = total > 0 ? ((scanned - lastScanned) / total) * 100 : 0;
            lastScanned = scanned;
            progress?.report({ message: `${scanned} of ${total} files checked`, increment });
            if (!background) this.options.sink.postMessage({ status: 'cleanup-analyzing', scanned, total });
          },
        });
        if (!background) {
          consumer = this.createForegroundConsumer(scan, true);
          if (consumer === undefined) {
            scan.cts.cancel();
            throw new Error('Another usage analysis is already in progress for this project.');
          }
        }
        const cancellation = onCancellationToken?.onCancellationRequested(() => {
          if (consumer !== undefined) this.cancelForegroundConsumer(consumer);
        });
        try {
          return await scan.promise;
        } finally {
          cancellation?.dispose();
        }
      };
      const resultsByPackage = background
        ? await runScan(undefined, undefined)
        : await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Analyzing dependency usage', cancellable: true },
            (progress, token) => runScan(progress, token)
          );
      if (
        consumer?.cancelled === true ||
        this.options.isDisposed() ||
        !this.isCurrent(selected.id, identity)
      ) return false;

      const findings: DependencyFinding[] = [];
      let analyzedAt = new Date().toISOString();
      let cacheExpiresAt = new Date(Date.now() + USAGE_CACHE_TTL_MS).toISOString();
      for (const [name, result] of resultsByPackage) {
        const cachedEntry = this.analysisState.set(selected.id, name, identity, result);
        analyzedAt = result.scannedAt;
        cacheExpiresAt = new Date(cachedEntry.cachedAt + USAGE_CACHE_TTL_MS).toISOString();
        const finding = buildUnusedFinding(name, result);
        if (finding !== null) findings.push(finding);
      }
      this.visibleCleanup = { projectId: selected.id, analyzedAt };
      this.lastProjectAnalysis.set(selected.id, { identity, analyzedAt: Date.now() });
      this.options.sink.postMessage({ status: 'cleanup-result', findings, analyzedAt, cacheExpiresAt });
      return true;
    } catch (cause) {
      const failureAudience = usageScanFailureAudience({
        backgroundOwner: background,
        foregroundWaiters: 0,
      });
      if (failureAudience === 'owner' && consumer?.cancelled !== true && !this.options.isDisposed() && this.isCurrent(selected.id, identity)) {
        this.options.sink.postMessage({ status: 'cleanup-error', error: toProtocolError(cause) });
      }
      return false;
    } finally {
      if (consumer !== undefined) this.releaseForegroundConsumer(consumer);
      performance.finish();
    }
  }

  /**
   * Single entry point for "dependency data just settled, make sure a
   * current background usage pass eventually runs" — every caller (first
   * `ready`, manual Refresh, and the reload after a successful Upgrade/
   * Remove) calls this instead of running its own ad-hoc trigger. Never
   * spins or polls: if it can't run right now — another usage analysis
   * (foreground or background) is in flight, or the panel's upgrade/remove
   * mutation lock is still held — it records the request and returns;
   * `triggerPendingBackgroundRefresh` (called from every place this
   * coordinator's own `activeScan` is cleared) and DashboardPanel's
   * post-mutation-lock-release hook both retry it the moment whatever was
   * blocking it clears.
   *
   * `force: true` (manual Refresh, and every successful mutation reload)
   * always eventually runs a fresh pass even if the project's source
   * fingerprint hasn't changed since the last auto-run; a plain request
   * (first open, background revalidation) only actually scans once the
   * fingerprint has changed. Multiple requests before either can run
   * collapse into one pending slot — force always wins, so a forced request
   * can never be dropped just because a plain one already claimed the slot.
   */
  async requestBackgroundUsageRefresh(options: { force?: boolean } = {}): Promise<void> {
    const force = options.force === true;
    this.pendingBackgroundRequest = { force: force || (this.pendingBackgroundRequest?.force ?? false) };
    await this.runPendingBackgroundRefresh();
  }

  /**
   * Idempotent — safe to call after anything that might have unblocked a
   * pending request. A no-op if nothing is pending or something still
   * blocks it (busy, mutation lock, or another caller already servicing the
   * pending slot).
   */
  async runPendingBackgroundRefresh(): Promise<void> {
    if (this.schedulingBackgroundRefresh) return;
    if (this.pendingBackgroundRequest === undefined) return;
    if (this.isBusy() || (this.options.isUpgradeBusy?.() ?? false)) return;

    this.schedulingBackgroundRefresh = true;
    try {
      // Claimed synchronously, before the first await below, so a second
      // concurrent caller can't also decide to service the same request.
      const pending = this.pendingBackgroundRequest;
      this.pendingBackgroundRequest = undefined;

      const controller = await this.options.ensureController();
      if (
        controller === undefined ||
        this.options.isDisposed() ||
        this.isBusy() ||
        (this.options.isUpgradeBusy?.() ?? false)
      ) {
        // Couldn't run after all — put it back (unless something newer
        // already replaced it) rather than dropping it silently.
        if (this.pendingBackgroundRequest === undefined) this.pendingBackgroundRequest = pending;
        return;
      }

      const selected = this.options.getSelectedProject();
      if (selected === undefined) return;
      const identity = this.identityFor(controller, selected);
      const last = this.lastProjectAnalysis.get(selected.id);
      if (!shouldRunBackgroundUsageRefresh(pending.force, last, identity)) return;

      await this.handleAnalyzeCleanup({ background: true });
    } finally {
      this.schedulingBackgroundRefresh = false;
    }
    // A request that arrived while the above was scheduling/running gets
    // its turn now, without the caller having to poll for it.
    await this.runPendingBackgroundRefresh();
  }

  private triggerPendingBackgroundRefresh(): void {
    // This path has no foreground caller to receive a rejection. Background
    // refresh errors are intentionally quiet, but must never become an
    // unhandled promise rejection in the extension host.
    void this.runPendingBackgroundRefresh().catch(() => undefined);
  }

  /**
   * A read-only removal-impact preview for one or more packages — the single
   * "Analyze removal" card in the Manage dependency modal, and the bulk
   * Review step's inline impact check (see Part 5 of the redesign brief),
   * both funnel through here. Shares this coordinator's own single-flight
   * shared scan guard, the identical one-pass `analyzeDependencyUsage` batch
   * scan `handleAnalyzeCleanup` already uses (one workspace read regardless
   * of how many packages are requested), and the same `UsageReferenceStore`
   * — "View references" on a source-reference evidence entry opens through
   * the existing `open-usage-reference` trust boundary, never a new one.
   *
   * Deliberately lighter-weight than the upgrade/removal execution path:
   * this never mutates anything and never gates the actual removal
   * transaction, so — like `handleWhereUsed`/`handleAnalyzeCleanup` — it
   * trusts `controller.upgradeSource` (the source that produced the current
   * scan) directly rather than re-reading disk. The real security boundary
   * for execution is unchanged: `bulk-remove` -> `confirm-remove` always
   * re-reads disk and re-validates eligibility fresh, regardless of what
   * this preview showed.
   *
   * Package names that aren't a real direct dependency of the current scan
   * reject the whole correlated request as stale. Returning a smaller package
   * set would leave the webview waiting for the exact set it requested.
   */
  async handleAnalyzeRemovalImpact(message: AnalyzeRemovalImpactMessage): Promise<void> {
    const requestedPackages = [...new Set(message.packages)].sort((left, right) => left.localeCompare(right));
    const operation: NonNullable<UsageAnalysisCoordinator['activeRemovalImpactRequest']> = {
      requestId: message.requestId,
      packages: requestedPackages,
      cancelled: false,
    };
    if (this.activeRemovalImpactRequest !== undefined) {
      this.options.sink.postMessage({
        ...foregroundUsageBusyMessage('removal'),
        requestId: message.requestId,
        packages: requestedPackages,
      });
      return;
    }
    this.activeRemovalImpactRequest = operation;

    const controller = await this.options.ensureController();
    if (controller === undefined || operation.cancelled || this.options.isDisposed() || this.activeRemovalImpactRequest !== operation) {
      if (this.activeRemovalImpactRequest === operation) this.activeRemovalImpactRequest = undefined;
      return;
    }
    const rowNames = new Set(controller.lastResultRows().map((row) => row.name));
    const packageNames = requestedPackages.filter((name) => rowNames.has(name));
    const selected = this.options.getSelectedProject();
    if (selected === undefined || operation.cancelled || this.options.isDisposed() || this.activeRemovalImpactRequest !== operation) {
      if (this.activeRemovalImpactRequest === operation) this.activeRemovalImpactRequest = undefined;
      return;
    }

    if (packageNames.length !== requestedPackages.length) {
      this.visibleRemovalImpact = undefined;
      this.options.sink.postMessage({
        status: 'removal-impact-error',
        requestId: message.requestId,
        packages: requestedPackages,
        error: {
          code: 'STALE_SOURCE',
          message: 'The selected dependencies are no longer current. Refresh and analyze removal impact again.',
        },
      });
      if (this.activeRemovalImpactRequest === operation) this.activeRemovalImpactRequest = undefined;
      return;
    }

    const performance = createPerformanceSession(
      'Dependency Dashboard removal impact analysis',
      this.options.performanceEnabled?.() ?? false
    );
    performance.setMetadata('candidates', packageNames.length);
    const identity = this.identityFor(controller, selected);
    const endCache = performance.start('removal usage cache lookup');
    const cached = this.analysisState.getComplete(selected.id, packageNames, identity);
    if (cached !== undefined) performance.increment('usage cache hits', cached.size);
    endCache({ hit: cached !== undefined, packages: cached?.size ?? 0 });
    let consumer: ForegroundUsageConsumer | undefined;
    let joinedProgressSubscriber: ((scanned: number, total: number) => void) | undefined;
    let joined = false;

    if (cached === undefined && this.foregroundOperations.isClaimed()) {
      this.visibleRemovalImpact = undefined;
      this.options.sink.postMessage({
        ...foregroundUsageBusyMessage('removal'),
        requestId: message.requestId,
        packages: packageNames,
      });
      performance.finish({ packages: packageNames.length, cached: false, joined: false });
      if (this.activeRemovalImpactRequest === operation) this.activeRemovalImpactRequest = undefined;
      return;
    }

    try {
      const source = controller.upgradeSource;
      const manifest = parseManifest(source.manifestText);
      const graph = buildDependencyGraph({
        root: controller.root,
        manifest,
        lockfileText: source.lockfileText,
        packageManager: source.packageManager,
        importerId: source.importerId,
      });
      const removing = new Set(packageNames);
      const peerRequirementIndex = buildPeerRequirementIndex(graph);
      const whyInstalledIndex = buildWhyInstalledIndex(graph);

      let resultsByPackage: ReadonlyMap<string, DependencyUsageResult>;
      if (cached !== undefined) {
        resultsByPackage = new Map([...cached].map(([name, entry]) => [name, entry.result]));
      } else {
        let scan = this.joinBackgroundScan(selected.id, identity, packageNames);
        joined = scan !== undefined;
        if (joined) performance.increment('usage joined scans');
        if (scan === undefined && this.isBusy()) {
          this.visibleRemovalImpact = undefined;
          this.options.sink.postMessage({
            ...foregroundUsageBusyMessage('removal'),
            requestId: message.requestId,
            packages: packageNames,
          });
          return;
        }
        this.visibleRemovalImpact = {
          projectId: selected.id,
          requestId: message.requestId,
          packages: packageNames,
          selectablePackages: new Set(),
          identity,
          ready: false,
        };
        this.options.sink.postMessage({
          status: 'removal-impact-analyzing',
          requestId: message.requestId,
          packages: packageNames,
          scanned: 0,
          total: 0,
        });
        scan ??= this.startScan({
          projectId: selected.id,
          identity,
          selected,
          manifestText: source.manifestText,
          packageNames,
          backgroundOwner: false,
          performance,
          onProgress: (scanned, total) => {
            if (operation.cancelled || this.activeRemovalImpactRequest !== operation) return;
            this.options.sink.postMessage({
              status: 'removal-impact-analyzing',
              requestId: message.requestId,
              packages: packageNames,
              scanned,
              total,
            });
          },
        });
        if (joined) {
          joinedProgressSubscriber = (scanned, total) => {
            if (consumer?.cancelled === true || operation.cancelled || this.activeRemovalImpactRequest !== operation) return;
            this.options.sink.postMessage({
              status: 'removal-impact-analyzing',
              requestId: message.requestId,
              packages: packageNames,
              scanned,
              total,
            });
          };
          scan.progressSubscribers.add(joinedProgressSubscriber);
        }
        consumer = this.createForegroundConsumer(scan, !joined);
        if (consumer !== undefined) operation.consumer = consumer;
        if (consumer === undefined) {
          if (!joined) scan.cts.cancel();
          this.visibleRemovalImpact = undefined;
          this.options.sink.postMessage({
            ...foregroundUsageBusyMessage('removal'),
            requestId: message.requestId,
            packages: packageNames,
          });
          return;
        }
        resultsByPackage = await scan.promise;
        if (
          operation.cancelled ||
          this.activeRemovalImpactRequest !== operation ||
          consumer.cancelled ||
          scan.cts.token.isCancellationRequested ||
          this.options.isDisposed() ||
          !this.isCurrent(selected.id, identity)
        ) return;
        // Fresh removal scans and joined cleanup scans both make their
        // bounded parsed results reusable by later usage/removal requests.
        this.cacheResults(selected.id, identity, resultsByPackage);
      }
      // Cancellation means the user closed the review before results were
      // ready — same discipline as a cancelled background cleanup scan:
      // never publish a partial result as if it were complete.
      if (
        operation.cancelled ||
        this.activeRemovalImpactRequest !== operation ||
        this.options.isDisposed() ||
        !this.isCurrent(selected.id, identity)
      ) return;

      // analyzeDependencyUsage always returns an entry for every name it was
      // given (see its own implementation), so `usageResult` is only ever
      // undefined here as a defensive fallback, never in practice.
      const assessments: RemovalImpactAssessment[] = packageNames.flatMap((name) => {
        const usageResult = resultsByPackage.get(name);
        if (usageResult === undefined) return [];
        const usageId = this.referenceStore.store(name, usageResult, selected.folder);
        const assessment = assessRemoval({
          usage: {
            references: usageResult.references,
            truncated: usageResult.truncated,
            conventionUncertainty: isFrameworkConventionPackage(name),
          },
          peerRequirements: peerRequirementsFor(graph, name, removing, peerRequirementIndex),
          stillRequiredBy: stillRequiredBy(graph, manifest.dependencies, name, removing, whyInstalledIndex),
        });
        return [{ packageName: name, assessment, usageId }];
      });

      this.visibleRemovalImpact = {
        projectId: selected.id,
        requestId: message.requestId,
        packages: packageNames,
        selectablePackages: new Set(
          assessments
            .filter(({ assessment }) => assessment.status === 'low-risk' || assessment.status === 'review')
            .map(({ packageName }) => packageName)
        ),
        identity,
        ready: true,
      };
      this.options.sink.postMessage({
        status: 'removal-impact-result',
        requestId: message.requestId,
        packages: packageNames,
        assessments,
        generatedAt: new Date().toISOString(),
      });
    } catch (cause) {
      const failureAudience = usageScanFailureAudience({
        backgroundOwner: consumer?.value.scan.backgroundOwner ?? false,
        foregroundWaiters: consumer?.cancelled === true ? 0 : 1,
      });
      if (
        failureAudience !== 'quiet' &&
        consumer?.cancelled !== true &&
        !operation.cancelled &&
        this.activeRemovalImpactRequest === operation &&
        !this.options.isDisposed() &&
        this.isCurrent(selected.id, identity)
      ) {
        this.visibleRemovalImpact = undefined;
        this.options.sink.postMessage({
          status: 'removal-impact-error',
          requestId: message.requestId,
          packages: packageNames,
          error: toProtocolError(cause),
        });
      }
    } finally {
      if (joinedProgressSubscriber !== undefined && consumer !== undefined) {
        consumer.value.scan.progressSubscribers.delete(joinedProgressSubscriber);
      }
      if (consumer !== undefined) this.releaseForegroundConsumer(consumer);
      if (this.activeRemovalImpactRequest === operation) this.activeRemovalImpactRequest = undefined;
      performance.finish({ packages: packageNames.length, cached: cached !== undefined, joined });
    }
  }

  handleCancelRemovalImpact(message: CancelRemovalImpactMessage): void {
    const operation = this.activeRemovalImpactRequest;
    if (operation === undefined || operation.requestId !== message.requestId || operation.cancelled) return;
    operation.cancelled = true;
    if (this.visibleRemovalImpact?.requestId === message.requestId) this.visibleRemovalImpact = undefined;
    const consumer = operation.consumer;
    if (consumer !== undefined) {
      this.foregroundOperations.cancel(consumer, (value) => {
        if (shouldCancelUnderlyingUsageScan(value.ownsScan)) value.scan.cts.cancel();
      });
    }
  }

  handleCancel(): void {
    this.foregroundOperations.cancelActive((consumer) => {
      if (shouldCancelUnderlyingUsageScan(consumer.ownsScan)) consumer.scan.cts.cancel();
    });
  }

  /**
   * The only place a usage-analysis reference is ever opened — see
   * usageReferenceStore.ts's own doc for the trust boundary. A forged/stale
   * id or an out-of-range index resolves to null and is silently a no-op,
   * matching how DashboardPanel.openAdvisory already treats the equivalent
   * case for advisory URLs.
   */
  handleOpenReference(message: OpenUsageReferenceMessage): void {
    const resolved = this.referenceStore.resolveReference(message.usageId, message.referenceIndex);
    if (resolved === null) return;
    const { folder, reference } = resolved;
    const uri = vscode.Uri.joinPath(folder.uri, ...reference.filePath.split('/'));
    void vscode.window.showTextDocument(uri).then((editor) => {
      if (reference.line <= 0) return;
      const position = new vscode.Position(Math.max(0, reference.line - 1), Math.max(0, reference.column - 1));
      editor.selection = new vscode.Selection(position, position);
      editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
    });
  }
}
