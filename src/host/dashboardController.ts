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
import type { BuildPackageRowsOptions, BuildPackageRowsResult } from '../core/pipeline.js';
import { buildPackageRows } from '../core/pipeline.js';
import type { HttpClient } from '../core/registry/http.js';
import { FetchError } from '../core/registry/http.js';
import type { EtagStore } from '../core/registry/versions.js';
import { toHostToWebviewMessage } from './dashboardData.js';
import type { HostToWebviewMessage, ProtocolError } from './webviewProtocol.js';

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
}

function isCancellation(cause: unknown): boolean {
  return cause instanceof FetchError && cause.code === 'CANCELLED';
}

function toProtocolError(cause: unknown): ProtocolError {
  if (cause instanceof FetchError) return { code: cause.code, message: cause.message };
  if (cause instanceof Error) return { code: cause.name, message: cause.message };
  return { code: 'UNKNOWN', message: String(cause) };
}

export class DashboardController {
  private readonly options: DashboardControllerOptions;
  private lastResult: BuildPackageRowsResult | undefined;
  private lastGeneratedAt: string | undefined;
  private inFlight: AbortController | undefined;

  constructor(options: DashboardControllerOptions) {
    this.options = options;
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
