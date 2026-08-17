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
 */

import * as vscode from 'vscode';

import { computeSourceFingerprint, sourceFingerprintsMatch } from '../../core/cache/sourceFingerprint.js';
import type { ProjectSourceFingerprint } from '../../core/cache/sourceFingerprint.js';
import { buildUnusedFinding } from '../../core/usage/unused.js';
import type { DependencyUsageResult } from '../../core/usage/types.js';
import type { DependencyFinding } from '../../core/hygiene/types.js';
import type { DashboardController, MessageSink } from '../dashboardController.js';
import type { DiscoveredProject } from '../projectResolution.js';
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
}

interface CachedUsage {
  result: DependencyUsageResult;
  fingerprint: ProjectSourceFingerprint;
  cachedAt: number;
}

const USAGE_CACHE_TTL_MS = 10 * 60_000;

function toProtocolError(cause: unknown): { code: string; message: string } {
  if (cause instanceof Error) return { code: cause.name, message: cause.message };
  return { code: 'UNKNOWN', message: String(cause) };
}

export class UsageAnalysisCoordinator {
  private readonly referenceStore = new UsageReferenceStore();
  /** root -> packageName -> cached result. */
  private readonly cache = new Map<string, Map<string, CachedUsage>>();
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

  private getCached(root: string, packageName: string, fingerprint: ProjectSourceFingerprint): DependencyUsageResult | undefined {
    const entry = this.cache.get(root)?.get(packageName);
    if (entry === undefined) return undefined;
    if (Date.now() - entry.cachedAt > USAGE_CACHE_TTL_MS) return undefined;
    if (!sourceFingerprintsMatch(entry.fingerprint, fingerprint)) return undefined;
    return entry.result;
  }

  private setCached(root: string, packageName: string, fingerprint: ProjectSourceFingerprint, result: DependencyUsageResult): void {
    let projectCache = this.cache.get(root);
    if (projectCache === undefined) {
      projectCache = new Map();
      this.cache.set(root, projectCache);
    }
    projectCache.set(packageName, { result, fingerprint, cachedAt: Date.now() });
  }

  /** On-demand, single-package usage scan — never runs a full cleanup pass just to answer one package. */
  async handleWhereUsed(message: WhereUsedMessage): Promise<void> {
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
    const cached = this.getCached(controller.root, message.package, fingerprint);
    if (cached !== undefined) {
      const usageId = this.referenceStore.store(message.package, cached, selected.folder);
      this.options.sink.postMessage({ status: 'usage-result', package: message.package, analysis: { usageId, result: cached } });
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
      });
      if (this.options.isDisposed() || this.activeCts !== cts) return;

      const result = resultsByPackage.get(message.package);
      if (result === undefined) return;
      this.setCached(controller.root, message.package, fingerprint, result);
      const usageId = this.referenceStore.store(message.package, result, selected.folder);
      this.options.sink.postMessage({ status: 'usage-result', package: message.package, analysis: { usageId, result } });
    } catch (cause) {
      if (!this.options.isDisposed()) {
        this.options.sink.postMessage({ status: 'usage-error', package: message.package, error: toProtocolError(cause) });
      }
    } finally {
      if (this.activeCts === cts) {
        cts.dispose();
        this.activeCts = undefined;
      }
    }
  }

  /**
   * Explicit "Analyze cleanup" entry point — every direct dependency at
   * once, one pass over the workspace's source files (see
   * usageAnalyzer.ts's own doc for why this costs the same I/O as a single
   * package). Never runs automatically.
   */
  async handleAnalyzeCleanup(): Promise<void> {
    if (this.isBusy()) {
      this.options.sink.postMessage({
        status: 'cleanup-error',
        error: { code: 'ANALYSIS_IN_PROGRESS', message: 'Another usage analysis is already in progress for this project.' },
      });
      return;
    }

    const controller = await this.options.ensureController();
    if (controller === undefined) return;
    const rows = controller.lastResultRows();
    const packageNames = rows.map((row) => row.name);
    const selected = this.options.getSelectedProject();
    if (selected === undefined) return;

    if (packageNames.length === 0) {
      this.options.sink.postMessage({ status: 'cleanup-result', findings: [] });
      return;
    }

    const cts = new vscode.CancellationTokenSource();
    this.activeCts = cts;
    this.options.sink.postMessage({ status: 'cleanup-analyzing', scanned: 0, total: 0 });

    try {
      const source = controller.upgradeSource;
      const resultsByPackage = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Analyzing dependency usage',
          cancellable: true,
        },
        async (progress, token) => {
          const cancellation = token.onCancellationRequested(() => cts.cancel());
          try {
            let lastScanned = 0;
            return await analyzeDependencyUsage({
              folder: selected.folder,
              dir: selected.dir,
              manifestText: source.manifestText,
              packageNames,
              token: cts.token,
              onProgress: (scanned, total) => {
                const increment = total > 0 ? ((scanned - lastScanned) / total) * 100 : 0;
                lastScanned = scanned;
                progress.report({ message: `${scanned} of ${total} files checked`, increment });
                this.options.sink.postMessage({ status: 'cleanup-analyzing', scanned, total });
              },
            });
          } finally {
            cancellation.dispose();
          }
        }
      );
      if (this.options.isDisposed() || this.activeCts !== cts) return;

      const fingerprint = this.fingerprintFor(controller);
      const findings: DependencyFinding[] = [];
      for (const [name, result] of resultsByPackage) {
        this.setCached(controller.root, name, fingerprint, result);
        const finding = buildUnusedFinding(name, result);
        if (finding !== null) findings.push(finding);
      }
      this.options.sink.postMessage({ status: 'cleanup-result', findings });
    } catch (cause) {
      if (!this.options.isDisposed()) {
        this.options.sink.postMessage({ status: 'cleanup-error', error: toProtocolError(cause) });
      }
    } finally {
      if (this.activeCts === cts) {
        cts.dispose();
        this.activeCts = undefined;
      }
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
