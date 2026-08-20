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
 * "Analyze cleanup" also runs once automatically per project fingerprint —
 * see autoAnalyzeCleanupIfStale/autoCleanupGate.ts. That auto-run is always
 * `background: true`: it skips the VS Code progress notification and the
 * `cleanup-analyzing` posts, and swallows failures instead of surfacing a
 * `cleanup-error` banner, so it never disables toolbar actions or announces
 * itself — badges simply appear once the result lands. An explicit user
 * click is never `background` and keeps today's visible progress/error UI.
 */

import * as vscode from 'vscode';

import { computeSourceFingerprint, sourceFingerprintsMatch } from '../../core/cache/sourceFingerprint.js';
import type { ProjectSourceFingerprint } from '../../core/cache/sourceFingerprint.js';
import { buildUnusedFinding } from '../../core/usage/unused.js';
import type { DependencyUsageResult } from '../../core/usage/types.js';
import type { DependencyFinding } from '../../core/hygiene/types.js';
import { createPerformanceSession } from '../../core/performance/measurement.js';
import type { DashboardController, MessageSink } from '../dashboardController.js';
import type { DiscoveredProject } from '../projectResolution.js';
import { shouldAutoAnalyzeCleanup } from './autoCleanupGate.js';
import { analyzeDependencyUsage } from './usageAnalyzer.js';
import { UsageReferenceStore } from './usageReferenceStore.js';

export interface WhereUsedMessage {
  package: string;
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
  /** Whether the panel-wide upgrade/remove lock is held — see autoAnalyzeCleanupIfStale. */
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
  /** root -> fingerprint last auto-analyzed by autoAnalyzeCleanupIfStale — see autoCleanupGate.ts. */
  private readonly lastAutoCleanupFingerprint = new Map<string, ProjectSourceFingerprint>();
  private activeCts: vscode.CancellationTokenSource | undefined;

  constructor(private readonly options: UsageCoordinatorOptions) {}

  isBusy(): boolean {
    return this.activeCts !== undefined;
  }

  dispose(): void {
    this.activeCts?.cancel();
    this.activeCts?.dispose();
    this.activeCts = undefined;
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
      }
      performance.finish({ cached: false });
    }
  }

  /**
   * "Analyze cleanup" — every direct dependency at once, one pass over the
   * workspace's source files (see usageAnalyzer.ts's own doc for why this
   * costs the same I/O as a single package).
   *
   * `background: true` (only ever set by autoAnalyzeCleanupIfStale) skips
   * the VS Code progress notification and every `cleanup-analyzing` post,
   * and swallows a failure instead of posting `cleanup-error` — an
   * auto-triggered run must never disable toolbar actions or announce
   * itself; it either quietly succeeds (badges appear) or quietly does
   * nothing. An explicit click always runs with `background: false`
   * (today's visible progress/error UI, unchanged).
   */
  async handleAnalyzeCleanup(options: { background?: boolean } = {}): Promise<void> {
    const background = options.background ?? false;
    if (this.isBusy()) {
      if (!background) {
        this.options.sink.postMessage({
          status: 'cleanup-error',
          error: { code: 'ANALYSIS_IN_PROGRESS', message: 'Another usage analysis is already in progress for this project.' },
        });
      }
      return;
    }

    const controller = await this.options.ensureController();
    if (controller === undefined) return;
    const rows = controller.lastResultRows();
    const packageNames = rows.map((row) => row.name);
    const selected = this.options.getSelectedProject();
    if (selected === undefined) return;

    if (packageNames.length === 0) {
      const analyzedAt = new Date().toISOString();
      this.options.sink.postMessage({
        status: 'cleanup-result',
        findings: [],
        analyzedAt,
        cacheExpiresAt: new Date(Date.now() + USAGE_CACHE_TTL_MS).toISOString(),
      });
      return;
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
              if (background) return;
              const increment = total > 0 ? ((scanned - lastScanned) / total) * 100 : 0;
              lastScanned = scanned;
              progress?.report({ message: `${scanned} of ${total} files checked`, increment });
              this.options.sink.postMessage({ status: 'cleanup-analyzing', scanned, total });
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
      if (this.options.isDisposed() || this.activeCts !== cts) return;

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
    } catch (cause) {
      if (!background && !this.options.isDisposed()) {
        this.options.sink.postMessage({ status: 'cleanup-error', error: toProtocolError(cause) });
      }
    } finally {
      if (this.activeCts === cts) {
        cts.dispose();
        this.activeCts = undefined;
      }
      performance.finish();
    }
  }

  /**
   * Auto-runs "Analyze cleanup" once per project fingerprint — see
   * autoCleanupGate.ts. Called after every scan reaches the webview
   * (dashboardPanel.ts); a no-op the vast majority of the time since the
   * fingerprint rarely changes between calls.
   *
   * `force: true` (only ever set for an explicit manual Refresh — see
   * dashboardPanel.ts's own doc on why) skips the fingerprint-match check
   * entirely, so a refresh always re-verifies usage in the background even
   * when nothing on disk changed — "do the full cycle again, like the first
   * open" is the explicit UX this exists for. Still respects the
   * busy/upgrade-lock gates either way; those are safety, not a performance
   * cap this flag is meant to override.
   */
  async autoAnalyzeCleanupIfStale(controller: DashboardController, options: { force?: boolean } = {}): Promise<void> {
    const fingerprint = this.fingerprintFor(controller);
    const last = this.lastAutoCleanupFingerprint.get(controller.root);
    const shouldRun = shouldAutoAnalyzeCleanup(
      last,
      fingerprint,
      this.isBusy(),
      this.options.isUpgradeBusy?.() ?? false,
      options.force === true
    );
    if (!shouldRun) return;
    this.lastAutoCleanupFingerprint.set(controller.root, fingerprint);
    await this.handleAnalyzeCleanup({ background: true });
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
