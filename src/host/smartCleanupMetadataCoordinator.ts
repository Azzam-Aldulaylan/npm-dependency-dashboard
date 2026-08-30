import { registryForPackage } from '../core/compatibility/registryMetadataProvider.js';
import { detectDeprecatedFindings } from '../core/hygiene/deprecated.js';
import { DEFAULT_CONCURRENCY, runPool } from '../core/registry/pool.js';
import type { EtagStore } from '../core/registry/versions.js';
import { fetchPackageVersionMetadata } from '../core/registry/versions.js';
import type { HttpClient } from '../core/registry/http.js';
import { isSafeSemverVersion } from '../core/upgrade/plan.js';
import type { PackageRow } from '../core/types.js';
import type { DashboardController, MessageSink } from './dashboardController.js';
import { installedVersionDeprecation } from './installedVersionDeprecation.js';
import { smartCleanupProjectCapability } from './smartCleanupProjectCapability.js';

export interface SmartCleanupMetadataCoordinatorOptions {
  sink: MessageSink;
  httpClient: HttpClient;
  etagStore: EtagStore;
  ensureController(): Promise<DashboardController | undefined>;
  isDisposed(): boolean;
  /** Monotonic project/source generation advanced at the synchronous watcher boundary. */
  sourceGeneration(): number;
}

export interface SmartCleanupDeprecationEvidence {
  deprecatedPackages: readonly string[];
  /** Exact installed versions for every direct dependency covered by the metadata run. */
  installedVersions: Readonly<Record<string, string>>;
}

/**
 * Lazy metadata enrichment used only by Smart Cleanup. The normal dashboard
 * intentionally keeps its small `/latest` requests; this coordinator asks
 * for exact installed-version manifests only after the user opens cleanup.
 */
export class SmartCleanupMetadataCoordinator {
  private active: { requestId: string; abort: AbortController } | undefined;
  private completed: {
    requestId: string;
    sourceGeneration: number;
    evidence: SmartCleanupDeprecationEvidence;
  } | undefined;

  constructor(private readonly options: SmartCleanupMetadataCoordinatorOptions) {}

  get isBusy(): boolean {
    return this.active !== undefined;
  }

  cancel(requestId?: string): void {
    if (requestId !== undefined && this.active !== undefined && this.active.requestId !== requestId) return;
    if (requestId === undefined || this.active?.requestId === requestId) {
      this.active?.abort.abort();
      this.active = undefined;
    }
    if (requestId === undefined || this.completed?.requestId === requestId) this.completed = undefined;
  }

  currentDeprecationEvidence(): SmartCleanupDeprecationEvidence | undefined {
    const completed = this.completed;
    return completed !== undefined && completed.sourceGeneration === this.options.sourceGeneration()
      ? completed.evidence
      : undefined;
  }

  dispose(): void {
    this.cancel();
  }

  async analyze(requestId: string): Promise<void> {
    if (this.active !== undefined) return;
    const abort = new AbortController();
    const active = { requestId, abort };
    this.active = active;
    // Capture before even awaiting controller acquisition. A watcher/project
    // switch can land during ensureController(), while its in-memory snapshot
    // still contains the old strings; comparing only those strings afterward
    // would incorrectly bless that pre-change snapshot.
    const sourceGeneration = this.options.sourceGeneration();

    try {
      const controller = await this.options.ensureController();
      if (abort.signal.aborted || this.active !== active || this.options.isDisposed()) return;
      if (controller === undefined) return;
      if (this.options.sourceGeneration() !== sourceGeneration) {
        this.options.sink.postMessage({
          status: 'smart-cleanup-metadata-error',
          requestId,
          error: { code: 'STALE_SOURCE', message: 'Project dependencies changed during cleanup analysis. Analyze again.' },
        });
        return;
      }

      const source = controller.upgradeSource;
      const rows = controller.lastResultRows();
      const candidates = rows.filter(
        (row): row is typeof row & { current: string } =>
          row.current !== null && row.unresolvable === undefined && isSafeSemverVersion(row.current)
      );
      const candidateNames = new Set(candidates.map((row) => row.name));
      const skippedPackages = rows
        .filter((row) => !candidateNames.has(row.name))
        .map((row) => row.name);
      this.options.sink.postMessage({
        status: 'smart-cleanup-metadata-analyzing',
        requestId,
        completed: 0,
        total: candidates.length,
      });

      let completed = 0;
      const settled = await runPool(
        candidates,
        (row, signal) =>
          fetchPackageVersionMetadata(
            this.options.httpClient,
            this.options.etagStore,
            registryForPackage(source.resolvedRegistry, row.name),
            row.name,
            row.current,
            signal
          ),
        {
          limit: DEFAULT_CONCURRENCY,
          signal: abort.signal,
          onSettled: () => {
            completed += 1;
            if (this.active !== active || this.options.isDisposed()) return;
            this.options.sink.postMessage({
              status: 'smart-cleanup-metadata-analyzing',
              requestId,
              completed,
              total: candidates.length,
            });
          },
        }
      );
      if (abort.signal.aborted || this.active !== active || this.options.isDisposed()) return;

      const currentController = await this.options.ensureController();
      if (
        this.options.sourceGeneration() !== sourceGeneration ||
        currentController !== controller ||
        currentController.upgradeSource.manifestText !== source.manifestText ||
        currentController.upgradeSource.lockfileText !== source.lockfileText ||
        currentController.upgradeSource.lockfilePath !== source.lockfilePath ||
        currentController.upgradeSource.registry !== source.registry ||
        JSON.stringify(currentController.upgradeSource.resolvedRegistry) !== JSON.stringify(source.resolvedRegistry) ||
        currentController.upgradeSource.packageManager !== source.packageManager ||
        currentController.upgradeSource.importerId !== source.importerId ||
        currentController.upgradeSource.lockfileName !== source.lockfileName
      ) {
        this.options.sink.postMessage({
          status: 'smart-cleanup-metadata-error',
          requestId,
          error: { code: 'STALE_SOURCE', message: 'Project dependencies changed during cleanup analysis. Analyze again.' },
        });
        return;
      }

      const exactRows: PackageRow[] = [];
      const unavailablePackages: string[] = [...skippedPackages];
      const installedVersions: Record<string, string> = {};
      for (let index = 0; index < candidates.length; index += 1) {
        const row = candidates[index];
        const result = settled[index];
        if (row === undefined || result === undefined) continue;
        if (!result.ok) {
          unavailablePackages.push(row.name);
          continue;
        }
        installedVersions[row.name] = row.current;
        const deprecation = installedVersionDeprecation(result.value);
        if (deprecation !== null) {
          exactRows.push({ ...row, deprecated: deprecation.message });
        }
      }
      this.completed = unavailablePackages.length === 0
        ? {
            requestId,
            sourceGeneration,
            evidence: {
              deprecatedPackages: exactRows.map((row) => row.name).sort((left, right) => left.localeCompare(right)),
              installedVersions,
            },
          }
        : undefined;
      this.options.sink.postMessage({
        status: 'smart-cleanup-metadata-result',
        requestId,
        findings: detectDeprecatedFindings(exactRows),
        unavailablePackages: unavailablePackages.sort((left, right) => left.localeCompare(right)),
        capability: smartCleanupProjectCapability(source),
      });
    } finally {
      if (this.active === active) this.active = undefined;
    }
  }
}
