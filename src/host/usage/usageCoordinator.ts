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
 * Caching: an in-memory, per-project, per-package cache keyed by the
 * project's own source fingerprint (src/core/cache/sourceFingerprint.ts —
 * the same manifest/lockfile hash DashboardController's persisted cache
 * already uses), with a short TTL. This intentionally does not watch every
 * source file for edits — see the redesign brief's own "a simple session/
 * project cache is acceptable initially, do not over-engineer" — a stale
 * cache entry is bounded by the TTL, and a manifest/lockfile change
 * invalidates it immediately via the fingerprint mismatch.
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
import { computeSourceFingerprint, sourceFingerprintsMatch } from '../../core/cache/sourceFingerprint.js';
import type { ProjectSourceFingerprint } from '../../core/cache/sourceFingerprint.js';
import { buildUnusedFinding } from '../../core/usage/unused.js';
import type { DependencyUsageResult } from '../../core/usage/types.js';
import type { DependencyFinding } from '../../core/hygiene/types.js';
import { peerRequirementsFor } from '../../core/upgrade/peerRequirement.js';
import { stillRequiredBy } from '../../core/upgrade/removeImpact.js';
import { assessRemoval } from '../../core/upgrade/removalAssessment.js';
import { createPerformanceSession } from '../../core/performance/measurement.js';
import type { DashboardController, MessageSink } from '../dashboardController.js';
import type { DiscoveredProject } from '../projectResolution.js';
import type { RemovalImpactAssessment } from '../webviewProtocol.js';
import { shouldRunBackgroundUsageRefresh } from './backgroundUsageRefreshGate.js';
import { analyzeDependencyUsage } from './usageAnalyzer.js';
import { UsageReferenceStore } from './usageReferenceStore.js';

export interface WhereUsedMessage {
  package: string;
}

export interface AnalyzeRemovalImpactMessage {
  packages: string[];
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

interface CachedUsage {
  result: DependencyUsageResult;
  fingerprint: ProjectSourceFingerprint;
  cachedAt: number;
}

export const USAGE_CACHE_TTL_MS = 10 * 60_000;

function toProtocolError(cause: unknown): { code: string; message: string } {
  if (cause instanceof Error) return { code: cause.name, message: cause.message };
  return { code: 'UNKNOWN', message: String(cause) };
}

export class UsageAnalysisCoordinator {
  private readonly referenceStore = new UsageReferenceStore();
  /** root -> packageName -> cached result. */
  private readonly cache = new Map<string, Map<string, CachedUsage>>();
  /** root -> fingerprint last auto-analyzed by requestBackgroundUsageRefresh. */
  private readonly lastAutoFingerprint = new Map<string, ProjectSourceFingerprint>();
  private activeCts: vscode.CancellationTokenSource | undefined;
  /** At most one slot: multiple requests before it can run collapse into it — force always wins. See requestBackgroundUsageRefresh. */
  private pendingBackgroundRequest: { force: boolean } | undefined;
  /** Guards the async gap between deciding to run a pending request and handleAnalyzeCleanup actually claiming `activeCts`, so two callers racing to service the same pending slot can't both start a scan. */
  private schedulingBackgroundRefresh = false;

  constructor(private readonly options: UsageCoordinatorOptions) {}

  isBusy(): boolean {
    return this.activeCts !== undefined;
  }

  dispose(): void {
    this.activeCts?.cancel();
    this.activeCts?.dispose();
    this.activeCts = undefined;
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

  private getCached(root: string, packageName: string, fingerprint: ProjectSourceFingerprint): CachedUsage | undefined {
    const entry = this.cache.get(root)?.get(packageName);
    if (entry === undefined) return undefined;
    if (Date.now() - entry.cachedAt > USAGE_CACHE_TTL_MS) return undefined;
    if (!sourceFingerprintsMatch(entry.fingerprint, fingerprint)) return undefined;
    return entry;
  }

  private setCached(root: string, packageName: string, fingerprint: ProjectSourceFingerprint, result: DependencyUsageResult): CachedUsage {
    let projectCache = this.cache.get(root);
    if (projectCache === undefined) {
      projectCache = new Map();
      this.cache.set(root, projectCache);
    }
    const entry = { result, fingerprint, cachedAt: Date.now() };
    projectCache.set(packageName, entry);
    return entry;
  }

  /** On-demand, single-package usage scan — never runs a full cleanup pass just to answer one package. */
  async handleWhereUsed(message: WhereUsedMessage, bypassCache = false): Promise<void> {
    if (this.isBusy()) {
      this.options.sink.postMessage({
        status: 'usage-error',
        package: message.package,
        error: { code: 'ANALYSIS_IN_PROGRESS', message: 'Another usage analysis is already in progress for this project.' },
      });
      return;
    }

    const controller = await this.options.ensureController();
    if (controller === undefined) return;
    const row = controller.lastResultRows().find((candidate) => candidate.name === message.package);
    if (row === undefined) {
      this.options.sink.postMessage({
        status: 'usage-error',
        package: message.package,
        error: { code: 'UNKNOWN_PACKAGE', message: 'This package is not part of the current scan.' },
      });
      return;
    }
    const selected = this.options.getSelectedProject();
    if (selected === undefined) return;

    const fingerprint = this.fingerprintFor(controller);
    const performance = createPerformanceSession(
      'Dependency Dashboard usage analysis',
      this.options.performanceEnabled?.() ?? false
    );
    const endCache = performance.start('usage cache lookup');
    const cached = bypassCache ? undefined : this.getCached(controller.root, message.package, fingerprint);
    endCache({ hit: cached !== undefined, bypassed: bypassCache });
    if (cached !== undefined) {
      const usageId = this.referenceStore.store(message.package, cached.result, selected.folder);
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

    this.options.sink.postMessage({ status: 'usage-analyzing', package: message.package });
    const cts = new vscode.CancellationTokenSource();
    this.activeCts = cts;
    try {
      const source = controller.upgradeSource;
      const resultsByPackage = await analyzeDependencyUsage({
        folder: selected.folder,
        dir: selected.dir,
        manifestText: source.manifestText,
        packageNames: [message.package],
        token: cts.token,
        performance,
      });
      if (this.options.isDisposed() || this.activeCts !== cts) return;

      const result = resultsByPackage.get(message.package);
      if (result === undefined) return;
      const cachedEntry = this.setCached(controller.root, message.package, fingerprint, result);
      const usageId = this.referenceStore.store(message.package, result, selected.folder);
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
      if (!this.options.isDisposed()) {
        this.options.sink.postMessage({ status: 'usage-error', package: message.package, error: toProtocolError(cause) });
      }
    } finally {
      if (this.activeCts === cts) {
        cts.dispose();
        this.activeCts = undefined;
        this.triggerPendingBackgroundRefresh();
      }
      performance.finish({ cached: false });
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
    const rows = controller.lastResultRows();
    const packageNames = rows.map((row) => row.name);
    const selected = this.options.getSelectedProject();
    if (selected === undefined) return false;

    if (packageNames.length === 0) {
      const analyzedAt = new Date().toISOString();
      this.options.sink.postMessage({
        status: 'cleanup-result',
        findings: [],
        analyzedAt,
        cacheExpiresAt: new Date(Date.now() + USAGE_CACHE_TTL_MS).toISOString(),
      });
      return true;
    }

    const cts = new vscode.CancellationTokenSource();
    this.activeCts = cts;
    const performance = createPerformanceSession(
      'Dependency Dashboard cleanup usage analysis',
      this.options.performanceEnabled?.() ?? false
    );
    performance.setMetadata('direct dependencies', packageNames.length);
    performance.setMetadata('background', background);
    if (!background) this.options.sink.postMessage({ status: 'cleanup-analyzing', scanned: 0, total: 0 });

    try {
      const source = controller.upgradeSource;
      const runScan = async (
        progress: vscode.Progress<{ message?: string; increment?: number }> | undefined,
        onCancellationToken: vscode.CancellationToken | undefined
      ): Promise<Map<string, DependencyUsageResult>> => {
        const cancellation = onCancellationToken?.onCancellationRequested(() => cts.cancel());
        try {
          let lastScanned = 0;
          return await analyzeDependencyUsage({
            folder: selected.folder,
            dir: selected.dir,
            manifestText: source.manifestText,
            packageNames,
            token: cts.token,
            performance,
            onProgress: (scanned, total) => {
              const increment = total > 0 ? ((scanned - lastScanned) / total) * 100 : 0;
              lastScanned = scanned;
              progress?.report({ message: `${scanned} of ${total} files checked`, increment });
              if (!background) this.options.sink.postMessage({ status: 'cleanup-analyzing', scanned, total });
            },
          });
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
      if (cts.token.isCancellationRequested || this.options.isDisposed() || this.activeCts !== cts) return false;

      const fingerprint = this.fingerprintFor(controller);
      const findings: DependencyFinding[] = [];
      let analyzedAt = new Date().toISOString();
      let cacheExpiresAt = new Date(Date.now() + USAGE_CACHE_TTL_MS).toISOString();
      for (const [name, result] of resultsByPackage) {
        const cachedEntry = this.setCached(controller.root, name, fingerprint, result);
        analyzedAt = result.scannedAt;
        cacheExpiresAt = new Date(cachedEntry.cachedAt + USAGE_CACHE_TTL_MS).toISOString();
        const finding = buildUnusedFinding(name, result);
        if (finding !== null) findings.push(finding);
      }
      this.options.sink.postMessage({ status: 'cleanup-result', findings, analyzedAt, cacheExpiresAt });
      return true;
    } catch (cause) {
      if (!background && !this.options.isDisposed()) {
        this.options.sink.postMessage({ status: 'cleanup-error', error: toProtocolError(cause) });
      }
      return false;
    } finally {
      if (this.activeCts === cts) {
        cts.dispose();
        this.activeCts = undefined;
        this.triggerPendingBackgroundRefresh();
      }
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
   * coordinator's own `activeCts` is cleared) and DashboardPanel's
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

      const fingerprint = this.fingerprintFor(controller);
      const last = this.lastAutoFingerprint.get(controller.root);
      if (!shouldRunBackgroundUsageRefresh(pending.force, last, fingerprint)) return;

      const completed = await this.handleAnalyzeCleanup({ background: true });
      if (completed) this.lastAutoFingerprint.set(controller.root, fingerprint);
    } finally {
      this.schedulingBackgroundRefresh = false;
    }
    // A request that arrived while the above was scheduling/running gets
    // its turn now, without the caller having to poll for it.
    await this.runPendingBackgroundRefresh();
  }

  private triggerPendingBackgroundRefresh(): void {
    void this.runPendingBackgroundRefresh();
  }

  /**
   * A read-only removal-impact preview for one or more packages — the single
   * "Analyze removal" card in the Manage dependency modal, and the bulk
   * Review step's inline impact check (see Part 5 of the redesign brief),
   * both funnel through here. Shares this coordinator's own single-flight
   * `activeCts` guard, the identical one-pass `analyzeDependencyUsage` batch
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
   * are silently dropped, never trusted as-is — the same discipline
   * `handleWhereUsed` applies to a single package name.
   */
  async handleAnalyzeRemovalImpact(message: AnalyzeRemovalImpactMessage): Promise<void> {
    if (this.isBusy()) {
      this.options.sink.postMessage({
        status: 'removal-impact-error',
        error: { code: 'ANALYSIS_IN_PROGRESS', message: 'Another usage analysis is already in progress for this project.' },
      });
      return;
    }

    const controller = await this.options.ensureController();
    if (controller === undefined) return;
    const rowNames = new Set(controller.lastResultRows().map((row) => row.name));
    const packageNames = [...new Set(message.packages)].filter((name) => rowNames.has(name));
    const selected = this.options.getSelectedProject();
    if (selected === undefined) return;

    if (packageNames.length === 0) {
      this.options.sink.postMessage({ status: 'removal-impact-result', assessments: [], generatedAt: new Date().toISOString() });
      return;
    }

    const cts = new vscode.CancellationTokenSource();
    this.activeCts = cts;
    const performance = createPerformanceSession(
      'Dependency Dashboard removal impact analysis',
      this.options.performanceEnabled?.() ?? false
    );
    performance.setMetadata('candidates', packageNames.length);
    this.options.sink.postMessage({ status: 'removal-impact-analyzing', scanned: 0, total: 0 });

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

      const resultsByPackage = await analyzeDependencyUsage({
        folder: selected.folder,
        dir: selected.dir,
        manifestText: source.manifestText,
        packageNames,
        token: cts.token,
        performance,
        onProgress: (scanned, total) => {
          this.options.sink.postMessage({ status: 'removal-impact-analyzing', scanned, total });
        },
      });
      // Cancellation means the user closed the review before results were
      // ready — same discipline as a cancelled background cleanup scan:
      // never publish a partial result as if it were complete.
      if (this.options.isDisposed() || this.activeCts !== cts || cts.token.isCancellationRequested) return;

      // analyzeDependencyUsage always returns an entry for every name it was
      // given (see its own implementation), so `usageResult` is only ever
      // undefined here as a defensive fallback, never in practice.
      const assessments: RemovalImpactAssessment[] = packageNames.flatMap((name) => {
        const usageResult = resultsByPackage.get(name);
        if (usageResult === undefined) return [];
        const usageId = this.referenceStore.store(name, usageResult, selected.folder);
        const assessment = assessRemoval({
          usage: { references: usageResult.references, truncated: usageResult.truncated },
          peerRequirements: peerRequirementsFor(graph, name, removing),
          stillRequiredBy: stillRequiredBy(graph, manifest.dependencies, name, removing),
        });
        return [{ packageName: name, assessment, usageId }];
      });

      this.options.sink.postMessage({ status: 'removal-impact-result', assessments, generatedAt: new Date().toISOString() });
    } catch (cause) {
      if (!this.options.isDisposed()) {
        this.options.sink.postMessage({ status: 'removal-impact-error', error: toProtocolError(cause) });
      }
    } finally {
      if (this.activeCts === cts) {
        cts.dispose();
        this.activeCts = undefined;
        this.triggerPendingBackgroundRefresh();
      }
      performance.finish({ packages: packageNames.length });
    }
  }

  handleCancel(): void {
    this.activeCts?.cancel();
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
