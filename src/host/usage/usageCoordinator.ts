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
import { shouldAutoAnalyzeCleanup } from './autoCleanupGate.js';
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
  private backgroundRun: Promise<boolean> | undefined;
  private backgroundCancellationRequested = false;
  private backgroundPromoted = false;

  constructor(private readonly options: UsageCoordinatorOptions) {}

  isBusy(): boolean {
    return this.activeCts !== undefined || this.backgroundRun !== undefined;
  }

  dispose(): void {
    this.activeCts?.cancel();
    this.activeCts?.dispose();
    this.activeCts = undefined;
    this.backgroundCancellationRequested = true;
    this.backgroundRun = undefined;
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
    if (background && this.backgroundCancellationRequested) cts.cancel();
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
              if (background && !this.backgroundPromoted) return;
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
      // Cancellation means the user chose a foreground action. Never publish
      // or cache a partial background scan as if it were complete.
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
      if ((!background || this.backgroundPromoted) && !this.options.isDisposed()) {
        this.options.sink.postMessage({ status: 'cleanup-error', error: toProtocolError(cause) });
      }
      return false;
    } finally {
      if (this.activeCts === cts) {
        cts.dispose();
        this.activeCts = undefined;
      }
      performance.finish();
    }
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
      }
      performance.finish({ packages: packageNames.length });
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
    this.backgroundCancellationRequested = false;
    this.backgroundPromoted = false;
    const run = this.handleAnalyzeCleanup({ background: true });
    this.backgroundRun = run;
    try {
      const completed = await run;
      if (completed) this.lastAutoCleanupFingerprint.set(controller.root, fingerprint);
    } finally {
      if (this.backgroundRun === run) this.backgroundRun = undefined;
      this.backgroundCancellationRequested = false;
      this.backgroundPromoted = false;
    }
  }

  /** Explicit actions outrank the invisible auto-cleanup pass. Waits only for
   * the currently active bounded read batch to observe cancellation. */
  async cancelBackgroundAnalysis(): Promise<void> {
    const run = this.backgroundRun;
    if (run === undefined) return;
    this.backgroundCancellationRequested = true;
    this.activeCts?.cancel();
    await run;
  }

  /** A foreground usage request can consume the identical full-project scan
   * already in flight instead of cancelling it and rereading every file. */
  async joinBackgroundAnalysis(): Promise<boolean> {
    const run = this.backgroundRun;
    if (run === undefined) return false;
    return await run;
  }

  /** Turns the invisible auto pass into the user's visible cleanup request,
   * retaining its completed work while enabling real progress messages. */
  async promoteAndJoinBackgroundAnalysis(): Promise<boolean> {
    const run = this.backgroundRun;
    if (run === undefined) return false;
    this.backgroundPromoted = true;
    this.options.sink.postMessage({ status: 'cleanup-analyzing', scanned: 0, total: 0 });
    return await run;
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
