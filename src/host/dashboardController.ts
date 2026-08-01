/**
 * Drives the pipeline for one open panel.
 *
 * Deliberately knows nothing about `vscode.WebviewPanel` — it posts through a
 * `MessageSink`, so the whole open/refresh/cancel lifecycle is testable against
 * a fake sink and a fake HttpClient, with no extension host.
 *
 * Caching is in-memory and per-session by design: the cache lives and dies with
 * this instance, which lives and dies with the panel. There is no
 * workspaceState/globalState persistence and no TTL, which is why a cached
 * result is always replayed as `stale` rather than `ready` — without a
 * freshness clock, "we have this from earlier in the session" is the strongest
 * honest claim available.
 */

import type { AuditRunner } from '../core/audit/npmAudit.js';
import type { DeclaredDependency } from '../core/manifest/parse.js';
import { parseManifest } from '../core/manifest/parse.js';
import type { BuildPackageRowsOptions, BuildPackageRowsResult } from '../core/pipeline.js';
import { buildPackageRows } from '../core/pipeline.js';
import type { HttpClient } from '../core/registry/http.js';
import { FetchError } from '../core/registry/http.js';
import type { EtagStore } from '../core/registry/versions.js';
import type { UpgradeEligibility, UpgradeRequestInput } from '../core/upgrade/validate.js';
import { validateUpgradeRequest } from '../core/upgrade/validate.js';
import { toHostToWebviewMessage } from './dashboardData.js';
import type { HostToWebviewMessage, ProtocolError, SelectedProjectInfo } from './webviewProtocol.js';

export interface MessageSink {
  postMessage(message: HostToWebviewMessage): void;
}

export interface DashboardControllerOptions {
  /** Absolute path to the directory holding package.json. */
  root: string;
  manifestText: string;
  lockfileText: string | null;
  /** Already resolved by the caller via resolveRegistry. */
  registry: string;
  httpClient: HttpClient;
  etagStore: EtagStore;
  /** Omit to skip the optional `npm audit` enrichment. */
  auditRunner?: AuditRunner;
  /** S6 — display info for the currently selected project, sent out with every DashboardData. */
  projectInfo: SelectedProjectInfo;
  /** S6 — whether more than one project candidate was discovered. */
  canChangeProject: boolean;
}

function isCancellation(cause: unknown): boolean {
  return cause instanceof FetchError && cause.code === 'CANCELLED';
}

function toProtocolError(cause: unknown): ProtocolError {
  if (cause instanceof FetchError) return { code: cause.code, message: cause.message };
  if (cause instanceof Error) return { code: cause.name, message: cause.message };
  return { code: 'UNKNOWN', message: String(cause) };
}

/** The project-specific slice of options that a reload replaces — everything but the fetch machinery. */
export type ProjectSnapshot = Pick<
  DashboardControllerOptions,
  'root' | 'manifestText' | 'lockfileText' | 'registry' | 'projectInfo' | 'canChangeProject'
>;

export class DashboardController {
  private options: DashboardControllerOptions;
  private lastResult: BuildPackageRowsResult | undefined;
  private lastGeneratedAt: string | undefined;
  private inFlight: AbortController | undefined;
  /**
   * Derived from `options.manifestText` — recomputed by `updateProjectSnapshot`
   * whenever the snapshot changes, so it always reflects the manifest the most
   * recent (or in-flight) scan actually read. This is the host-owned source of
   * dependencies/devDependencies/optionalDependencies classification for the
   * Upgrade action's npm save flag; the webview never supplies or sees it.
   *
   * Wrapped in try/catch rather than left to throw: an invalid manifestText
   * already surfaces as a fatal-error from run() (see the existing "an
   * unreadable manifest is a fatal error" test) — that failure path must not
   * change to throwing out of the constructor instead, before a sink even
   * exists to report it to.
   */
  private declaredDependencies: DeclaredDependency[];

  constructor(options: DashboardControllerOptions) {
    this.options = options;
    this.declaredDependencies = DashboardController.parseDeclaredDependencies(options.manifestText);
  }

  private static parseDeclaredDependencies(manifestText: string): DeclaredDependency[] {
    try {
      return parseManifest(manifestText).dependencies;
    } catch {
      return [];
    }
  }

  /** Absolute path to the directory holding package.json — the Upgrade task's cwd. */
  get root(): string {
    return this.options.root;
  }

  /**
   * Replaces the controller's project snapshot in place — root, manifestText,
   * lockfileText, registry — and re-derives `declaredDependencies` from the
   * new manifestText. Called by DashboardPanel after re-resolving the project
   * (a fresh `resolveProject()` read from disk), so that a subsequent
   * `handleRefresh` scans against what package.json/the lockfile actually
   * contain now — including a package.json/lockfile an upgrade task itself
   * just rewrote — rather than whatever was read when the panel first opened.
   * The fetch machinery (httpClient/etagStore/auditRunner) is untouched, so
   * ETag caching keeps working across reloads.
   */
  updateProjectSnapshot(snapshot: ProjectSnapshot): void {
    this.options = { ...this.options, ...snapshot };
    this.declaredDependencies = DashboardController.parseDeclaredDependencies(snapshot.manifestText);
  }

  /**
   * The actual security boundary for the Upgrade action: `request` is
   * whatever the webview sent, trusted only as far as it matches `lastResult`
   * and `declaredDependencies` — both derived from the host's own last scan,
   * never from the webview. See src/core/upgrade/validate.ts.
   */
  validateUpgradeRequest(request: UpgradeRequestInput): UpgradeEligibility {
    return validateUpgradeRequest(this.lastResult?.rows, this.declaredDependencies, request);
  }

  /**
   * The webview mounted and asked for state. Anything already in hand goes out
   * immediately so the table is never blank when we have rows to show, but a
   * fresh run always follows — the replayed snapshot is only a head start.
   */
  async handleReady(sink: MessageSink): Promise<void> {
    const cached = this.lastResult;
    if (cached === undefined) {
      sink.postMessage({ status: 'loading' });
    } else {
      sink.postMessage(
        toHostToWebviewMessage(
          cached,
          { isEmpty: cached.rows.length === 0, isStale: true },
          this.options.projectInfo,
          this.options.canChangeProject,
          this.lastGeneratedAt
        )
      );
    }
    await this.run(sink);
  }

  /** Manual refresh: the cache is discarded, never consulted. */
  async handleRefresh(sink: MessageSink): Promise<void> {
    this.lastResult = undefined;
    this.lastGeneratedAt = undefined;
    sink.postMessage({ status: 'loading' });
    await this.run(sink);
  }

  /** Call from the panel's onDidDispose so an in-flight run stops with it. */
  dispose(): void {
    this.inFlight?.abort();
    this.inFlight = undefined;
  }

  private async run(sink: MessageSink): Promise<void> {
    // A newer run supersedes an older one outright. Without this, two runs race
    // to post and the slower — older — one can land last and win.
    this.inFlight?.abort();
    const controller = new AbortController();
    this.inFlight = controller;

    const buildOptions: BuildPackageRowsOptions = {
      root: this.options.root,
      manifestText: this.options.manifestText,
      lockfileText: this.options.lockfileText,
      registry: this.options.registry,
      httpClient: this.options.httpClient,
      etagStore: this.options.etagStore,
      signal: controller.signal,
      ...(this.options.auditRunner === undefined
        ? {}
        : { auditRunner: this.options.auditRunner }),
    };

    try {
      const result = await buildPackageRows(buildOptions);
      // The pipeline checks the signal at each stage boundary, but a run that
      // was already past the last boundary when the abort fired still resolves
      // normally. Superseded or disposed, its result is not wanted either way.
      if (controller.signal.aborted) return;

      const generatedAt = new Date().toISOString();
      this.lastResult = result;
      this.lastGeneratedAt = generatedAt;
      sink.postMessage(
        toHostToWebviewMessage(
          result,
          { isEmpty: result.rows.length === 0, isStale: false },
          this.options.projectInfo,
          this.options.canChangeProject,
          generatedAt
        )
      );
    } catch (cause) {
      if (controller.signal.aborted || isCancellation(cause)) return;
      // Nothing renderable at all: an unreadable manifest, an unsupported
      // lockfile version. Degraded-data failures never reach here — the
      // pipeline folds those into advisoriesError/auditUnavailable.
      sink.postMessage({ status: 'fatal-error', error: toProtocolError(cause) });
    }
  }
}
