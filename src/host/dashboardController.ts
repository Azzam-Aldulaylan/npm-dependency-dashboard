/**
 * Drives the pipeline for one open panel.
 *
 * Deliberately knows nothing about `vscode.WebviewPanel` — it posts through a
 * `MessageSink`, so the whole open/refresh/cancel lifecycle is testable against
 * a fake sink and a fake HttpClient, with no extension host.
 *
 * Caching is now split in two: an in-memory `lastResult` (this instance's own
 * session, exactly as before) backed by a persisted `PersistedProjectCache`
 * entry (S7) keyed by `options.cacheKey` — S6's project identity plus
 * registry, computed by the panel via `deriveProjectCacheKey`. A cold
 * controller (no in-memory `lastResult` yet — panel just opened, or the user
 * just switched to a project not yet scanned this session) hydrates from that
 * persisted entry before deciding what to show, so a fresh persisted result
 * can render immediately without a network round trip, and a stale one still
 * renders instantly while a revalidation runs underneath it.
 */

import type { AuditRunner } from '../core/audit/npmAudit.js';
import { classifyFreshness } from '../core/cache/freshness.js';
import type { PersistentProjectCacheStore } from '../core/cache/projectCacheStore.js';
import type { ScanSnapshot } from '../core/cache/schema.js';
import type { ProjectSourceFingerprint } from '../core/cache/sourceFingerprint.js';
import { computeSourceFingerprint, isSourceFingerprint, sourceFingerprintsMatch } from '../core/cache/sourceFingerprint.js';
import type { DeclaredDependency } from '../core/manifest/parse.js';
import { parseManifest } from '../core/manifest/parse.js';
import type { PerformanceRecorder } from '../core/performance/measurement.js';
import { createPerformanceSession } from '../core/performance/measurement.js';
import type { BuildPackageRowsOptions } from '../core/pipeline.js';
import { buildPackageRows } from '../core/pipeline.js';
import type { HttpClient } from '../core/registry/http.js';
import { FetchError } from '../core/registry/http.js';
import type { EtagStore } from '../core/registry/versions.js';
import type { AdvisoryLookupRequest } from '../core/advisories/resolve.js';
import { resolveTrustedAdvisoryUrl } from '../core/advisories/resolve.js';
import type {
  BulkRemoveEligibility,
  BulkUpgradeEligibility,
  RemoveRequestInput,
  UpgradeEligibility,
  UpgradeRequestInput,
} from '../core/upgrade/validate.js';
import type { PackageManagerKind, PackageRow } from '../core/types.js';
import { validateBulkRemoveRequest, validateBulkUpgradeRequest, validateUpgradeRequest } from '../core/upgrade/validate.js';
import type { BuildInfo } from './dashboardData.js';
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
  /** Absolute path to the resolved lockfile, or null if none — persisted alongside each cache entry so a file-watcher event can purge every entry sharing an npm-workspace root lockfile. */
  lockfilePath: string | null;
  packageManager?: PackageManagerKind;
  importerId?: string;
  lockfileName?: 'package-lock.json' | 'npm-shrinkwrap.json' | 'pnpm-lock.yaml' | null;
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
  /** Panel-wide, not project-specific — the running extension's own version/build stamp, sent out with every DashboardData so the footer can show it. */
  buildInfo: BuildInfo;
  /** S7 — panel-level, shared across every controller instance the panel builds. */
  projectCacheStore: PersistentProjectCacheStore;
  /** S7 — this project's persisted-cache key: derived from S6 project identity + registry. */
  cacheKey: string;
  /** S7 — reads `dependencyDashboard.cacheTtlMinutes` at the host boundary; called fresh on every freshness check so a config change takes effect on the next check, not just the next controller. */
  ttlMinutesProvider: () => number;
  /** S7 — injected clock for deterministic freshness tests; defaults to the real clock. */
  now?: () => number;
  /** Local diagnostic switch; read for each operation so settings changes apply without reopening VS Code. */
  performanceEnabled?: () => boolean;
  /** Host panels enable real scan progress; tests/other adapters may omit it. */
  progressEnabled?: boolean;
}

function isCancellation(cause: unknown): boolean {
  return cause instanceof FetchError && cause.code === 'CANCELLED';
}

function toProtocolError(cause: unknown): ProtocolError {
  if (cause instanceof FetchError) return { code: cause.code, message: cause.message };
  if (cause instanceof Error) return { code: cause.name, message: cause.message };
  return { code: 'UNKNOWN', message: String(cause) };
}

/**
 * Flattens a completed pipeline result down to the plain-object shape that's
 * both rendered and persisted — never the live `BuildPackageRowsResult`
 * itself, whose `advisoriesError` is a `FetchError` instance carrying a stack
 * trace and other fields that have no business on disk.
 */
function toScanSnapshot(result: {
  rows: ScanSnapshot['rows'];
  advisoriesError?: ProtocolError;
  auditUnavailable?: boolean;
  hygieneFindings?: ScanSnapshot['hygieneFindings'];
}): ScanSnapshot {
  const snapshot: ScanSnapshot = { rows: result.rows };
  if (result.advisoriesError !== undefined) {
    snapshot.advisoriesError = { code: result.advisoriesError.code, message: result.advisoriesError.message };
  }
  if (result.auditUnavailable === true) snapshot.auditUnavailable = true;
  if (result.hygieneFindings !== undefined) snapshot.hygieneFindings = result.hygieneFindings;
  return snapshot;
}

/** The project-specific slice of options that a reload replaces — everything but the fetch machinery. */
export type ProjectSnapshot = Pick<
  DashboardControllerOptions,
  | 'root'
  | 'manifestText'
  | 'lockfileText'
  | 'lockfilePath'
  | 'packageManager'
  | 'importerId'
  | 'lockfileName'
  | 'registry'
  | 'projectInfo'
  | 'canChangeProject'
  | 'cacheKey'
>;

export class DashboardController {
  private options: DashboardControllerOptions;
  private lastResult: ScanSnapshot | undefined;
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
  /**
   * Monotonically increasing — the revalidation generation. Bumped by
   * `beginRevalidation()`, the single explicit entry point for "eligibility
   * must not be trusted from this point forward until a matching
   * revalidation proves otherwise": a watcher event (called by the panel
   * *before* its debounce, not after), the start of every reload attempt
   * (`reloadAndScan`, each drained `reloadAfterFileChange` iteration,
   * `run()` itself — covering manual reloads, file-change reloads, timer
   * refreshes, and stale-`handleReady` revalidation alike), and a project
   * snapshot replacement (`updateProjectSnapshot`, via its own
   * `beginRevalidation()` call). This is the Upgrade-eligibility security
   * boundary's other half — see `isEligible`.
   */
  private revalidationGeneration = 0;
  /**
   * The `revalidationGeneration` value as of the last time `this.options`
   * were confirmed to accurately describe reality — set at construction, by
   * `updateProjectSnapshot` (an actual fresh disk read), and re-confirmed
   * forward by `run()` itself every time it grants eligibility (a granted
   * scan proves `this.options` were still accurate as of that generation,
   * chaining the watermark forward without needing another real disk read —
   * see `run()`'s grant site for why this chaining is required:
   * `revalidationGeneration` advances on *every* `run()` call, including a
   * plain background-timer tick with no project reload at all, so without
   * re-confirming here, `optionsGeneration` would permanently fall behind
   * after the very first successful scan). `handleReady`'s fresh-hydration
   * branch grants eligibility too, but never needs to touch this field
   * itself — its own precondition (`optionsGeneration ===
   * revalidationGeneration`) is already required to hold before it grants
   * anything, so there is nothing left to advance.
   *
   * `beginRevalidation()` alone does not touch `this.options` or this field
   * — it fires the instant a watcher event arrives (or a reload attempt
   * begins), before any disk read has happened — so right after it,
   * `optionsGeneration < revalidationGeneration` precisely captures "we know
   * the source may have changed, but `this.options` still holds the
   * pre-change content." Eligibility must never be granted while that gap
   * exists: a cold hydration (or a background-timer-triggered `run()` that
   * races an already-pending, not-yet-applied file-change reload) would
   * otherwise validate stale in-memory options against a
   * `revalidationGeneration` that only *coincidentally* matches — see
   * `isEligible`/`handleReady`/`run`.
   */
  private optionsGeneration = 0;
  /** The `revalidationGeneration` `lastResult` was last validated against, or `undefined` if it never was — `undefined` is the explicit "revalidation in progress / not yet validated" state `validateUpgradeRequest` checks. */
  private eligibleGeneration: number | undefined;

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

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private performanceEnabled(): boolean {
    return this.options.performanceEnabled?.() ?? false;
  }

  /** Absolute path to the directory holding package.json — the Upgrade task's cwd. */
  get root(): string {
    return this.options.root;
  }

  /** Host-only source state used to build preflight and transaction inputs. */
  get upgradeSource(): {
    manifestText: string;
    lockfileText: string | null;
    lockfilePath: string | null;
    registry: string;
    packageManager: PackageManagerKind;
    importerId: string;
    lockfileName: 'package-lock.json' | 'npm-shrinkwrap.json' | 'pnpm-lock.yaml' | null;
  } {
    return {
      manifestText: this.options.manifestText,
      lockfileText: this.options.lockfileText,
      lockfilePath: this.options.lockfilePath,
      registry: this.options.registry,
      packageManager: this.options.packageManager ?? 'npm',
      importerId: this.options.importerId ?? '.',
      lockfileName: this.options.lockfileName ?? null,
    };
  }

  /**
   * Replaces the controller's project snapshot in place — root, manifestText,
   * lockfileText, registry, cacheKey — and re-derives `declaredDependencies`
   * from the new manifestText. Called by DashboardPanel after re-resolving the
   * project (a fresh `resolveProject()` read from disk), so that a subsequent
   * `handleRefresh` scans against what package.json/the lockfile actually
   * contain now — including a package.json/lockfile an upgrade task itself
   * just rewrote — rather than whatever was read when the panel first opened.
   * The fetch machinery (httpClient/etagStore/auditRunner/projectCacheStore) is
   * untouched, so ETag caching and persisted cache lookups keep working across
   * reloads.
   *
   * @param generationAtReadStart — the caller's own `beginRevalidation()`
   *   return value, captured *before* the disk read that produced `snapshot`
   *   started (not right before calling this method — before the `await`).
   *   Required so this method can tell whether anything ELSE called
   *   `beginRevalidation()` (a watcher event, an independent reload attempt)
   *   while that read was in flight. If something did, `snapshot` may
   *   already be stale relative to it — the caller's disk read could have
   *   started before, and captured content from before, whatever change
   *   that other call was reacting to. `snapshot` is still applied either
   *   way (still worth showing — newer than what it replaces), but
   *   `optionsGeneration` is only advanced (marking `this.options` as
   *   confirmed current) when `generationAtReadStart` still matches
   *   `revalidationGeneration` right now — proving nothing else landed in
   *   between. Getting this wrong is exactly how a stale reload can go on
   *   to grant Upgrade eligibility for content that predates a
   *   since-known file change: `run()`'s own grant check trusts
   *   `optionsGeneration` completely, so if this method advanced it
   *   unconditionally (to "whatever `revalidationGeneration` happens to be
   *   right now"), a scan of `snapshot`'s stale content could still pass
   *   that check purely because a *later* watcher event's bump got
   *   attributed to *this* update instead of the change it actually
   *   described.
   */
  updateProjectSnapshot(snapshot: ProjectSnapshot, generationAtReadStart: number): void {
    const optionsAreStillConfirmedCurrent = generationAtReadStart === this.revalidationGeneration;
    this.options = { ...this.options, ...snapshot };
    this.declaredDependencies = DashboardController.parseDeclaredDependencies(snapshot.manifestText);
    this.beginRevalidation();
    if (optionsAreStillConfirmedCurrent) {
      // Nothing called beginRevalidation() between when the disk read that
      // produced `snapshot` started and right now — `this.options` really
      // do reflect the freshest known state, so it's safe to mark them
      // confirmed current as of this update's own generation.
      this.optionsGeneration = this.revalidationGeneration;
    }
    // else: something else landed while the read was in flight (its own
    // beginRevalidation() call already left revalidationGeneration ahead of
    // optionsGeneration) — `snapshot` is applied for display, but
    // optionsGeneration is deliberately left where it was, so a subsequent
    // run() cannot mistake this update for "fully confirmed current."
  }

  /**
   * The single explicit entry point for "eligibility must not be trusted
   * from this point forward until a matching revalidation proves
   * otherwise." Revokes Upgrade eligibility immediately — `lastResult` (and
   * whatever the webview currently sees) is left completely untouched, only
   * `isEligible()`'s answer changes — and is always safe to call more than
   * once in a row: each call simply advances the internal generation
   * counter again, so nothing breaks if, say, a watcher event and the
   * reload it schedules both call this for what is conceptually the same
   * change.
   *
   * Called from three kinds of places: the panel's raw watcher-event hook
   * (before its own debounce even runs — the debounce window is exactly the
   * gap where the file has already changed on disk but `lastResult` still
   * reflects the old content), the start of every reload attempt
   * (`reloadAndScan`, each drained `reloadAfterFileChange` iteration, and
   * `run()` itself internally — covering manual reloads, file-change
   * reloads, timer-triggered background refreshes, and stale-`handleReady`
   * revalidation alike), and `updateProjectSnapshot` (a project reload must
   * never grant eligibility — routing it through here guarantees that by
   * construction, since this method only ever revokes).
   *
   * Returns the new generation for callers that need to correlate their own
   * specific revalidation attempt against a *later* one superseding it
   * (see `run()`); external callers (the panel) are free to ignore it.
   */
  beginRevalidation(): number {
    this.revalidationGeneration += 1;
    return this.revalidationGeneration;
  }

  /**
   * Posts the current `lastResult` (if any) as `stale`, announcing that a
   * revalidation is now in progress. Call immediately after
   * `beginRevalidation()`, from the *earliest* point a revalidation is known
   * to be starting — a watcher event, before its own debounce; the start of
   * a manual/post-upgrade reload, before its own disk read — not only once
   * `run()` itself actually begins scanning. `run()` also calls this itself
   * (covering paths, like a background-timer tick, with no earlier call
   * site to have announced it already); calling it more than once for the
   * same revalidation is a harmless, idempotent duplicate — always the same
   * data, since nothing updates `lastResult` until a scan actually
   * completes.
   *
   * This is what makes background revalidation (timer- or file-change-
   * triggered, which otherwise posts nothing until it completes) visible in
   * the webview at all, so it can disable Upgrade buttons for the entire
   * duration — including the debounce window and the disk read, not just
   * the network round trip. A no-op when there is nothing to announce
   * (nothing has ever rendered yet — a cold start's own `loading` message
   * already covers that).
   */
  announceRevalidating(sink: MessageSink): void {
    if (this.lastResult === undefined) return;
    sink.postMessage(
      toHostToWebviewMessage(
        this.lastResult,
        { isEmpty: this.lastResult.rows.length === 0, isStale: true },
        this.options.projectInfo,
        this.options.canChangeProject,
        this.options.buildInfo,
        this.lastGeneratedAt
      )
    );
  }

  /**
   * True only for data validated against the exact source state currently in
   * `this.options` — no watcher event, project reload, or reload attempt has
   * begun since `lastResult` was last confirmed to match it.
   * `eligibleGeneration` is only ever set in two places, and both already
   * apply the TTL gate at the moment eligibility is granted rather than
   * here: `handleReady`'s hydration branch only sets it when
   * `classifyFreshness` said `'fresh'` (a TTL-stale persisted entry is never
   * granted eligibility to begin with — "fresh fingerprint-matching
   * persisted data may be eligible, stale persisted data must not"), and
   * `run()`'s success path only sets it when nothing called
   * `beginRevalidation()` again while the scan that just produced this exact
   * data was in flight — and both sites additionally require
   * `optionsGeneration === revalidationGeneration` (see that field's own
   * doc) before granting anything at all, so a bump that landed *before*
   * `this.options` ever caught up to it (a watcher event that fired before
   * the first hydration, or before a background-timer tick that races an
   * already-pending file-change reload) can never be mistaken for "nothing
   * changed."
   *
   * Deliberately does NOT re-check `classifyFreshness` live on every call:
   * that would make eligibility re-derive "is this old enough to distrust"
   * continuously from the same clock the *display* staleness banner uses —
   * including `cacheTtlMinutes: 0` ("always revalidate" for display
   * purposes), which would then make Upgrade permanently ineligible even
   * one millisecond after a scan that just completed cleanly. The TTL
   * decides whether to *trust a replay without revalidating*; it is not a
   * ticking expiry on a scan that already ran moments ago.
   */
  private isEligible(): boolean {
    return this.eligibleGeneration !== undefined && this.eligibleGeneration === this.revalidationGeneration;
  }

  /**
   * The actual security boundary for the Upgrade action: `request` is
   * whatever the webview sent, trusted only as far as it matches `lastResult`
   * and `declaredDependencies` — both derived from the host's own last scan,
   * never from the webview — and only when `isEligible()` confirms that scan
   * still describes the current source state. A stale replay, a hydrated-
   * but-TTL-expired persisted entry, data mid-revalidation after a file
   * change or project reload, or a revalidation that failed are all rejected
   * here regardless of what `lastResult` itself contains — this is the
   * actual gate; the webview disabling its own Upgrade buttons in the same
   * situations is a UX nicety, not the boundary.
   *
   * `lastResult === undefined` is checked separately, before `isEligible()`,
   * so a controller that has genuinely never completed a single scan keeps
   * reporting the more specific, more actionable `no-scan-result` ("run a
   * scan") rather than the generic `revalidating` ("try again shortly") —
   * `isEligible()` alone can't tell those two apart, since a cold
   * controller's `eligibleGeneration` is `undefined` in both cases.
   */
  validateUpgradeRequest(request: UpgradeRequestInput): UpgradeEligibility {
    if (this.lastResult === undefined) return { ok: false, reason: 'no-scan-result' };
    if (!this.isEligible()) return { ok: false, reason: 'revalidating' };
    return validateUpgradeRequest(this.lastResult.rows, this.declaredDependencies, request);
  }

  /** Same freshness gate as a single upgrade, applied atomically to every requested change. */
  validateBulkUpgradeRequest(requests: readonly UpgradeRequestInput[]): BulkUpgradeEligibility {
    if (this.lastResult === undefined) {
      return { ok: false, reason: 'change-rejected', changeReason: 'no-scan-result' };
    }
    if (!this.isEligible()) {
      return { ok: false, reason: 'change-rejected', changeReason: 'revalidating' };
    }
    return validateBulkUpgradeRequest(this.lastResult.rows, this.declaredDependencies, requests);
  }

  /** Same freshness gate as a bulk upgrade, applied atomically to every requested removal. */
  validateBulkRemoveRequest(requests: readonly RemoveRequestInput[]): BulkRemoveEligibility {
    if (this.lastResult === undefined) {
      return { ok: false, reason: 'change-rejected', changeReason: 'no-scan-result' };
    }
    if (!this.isEligible()) {
      return { ok: false, reason: 'change-rejected', changeReason: 'revalidating' };
    }
    return validateBulkRemoveRequest(this.lastResult.rows, this.declaredDependencies, requests);
  }

  /**
   * The security boundary for "open advisory source" (Problem 4): the
   * webview names an advisory, never a URL — this resolves that name
   * against `lastResult`, the host's own last completed scan, and returns
   * the URL *that scan itself recorded*, or `null` for any reason at all
   * (unknown package/advisory, or a URL that isn't `https:`). Staleness
   * (`isEligible()`) is deliberately not checked here — unlike an Upgrade
   * request, opening a browser tab to an advisory mutates nothing, so a
   * revalidation in flight is not a reason to refuse it.
   */
  resolveAdvisoryUrl(request: AdvisoryLookupRequest): string | null {
    if (this.lastResult === undefined) return null;
    return resolveTrustedAdvisoryUrl(this.lastResult.rows, request);
  }

  /**
   * The host's own last completed scan rows — the "before" side of
   * security-outcome evaluation (see evaluateSecurityOutcome in
   * src/core/advisories/securityOutcome.ts) and the source
   * `advisoriesByNameFromRows` (attribution.ts) reconstructs an advisory
   * lookup map from, to re-attribute against a proposed post-upgrade graph
   * without a second bulk-advisory fetch. Deliberately not gated by
   * `isEligible()`: the upgrade-eligibility re-checks that already surround
   * every call site cover staleness, and this alone mutates nothing.
   */
  lastResultRows(): readonly PackageRow[] {
    return this.lastResult?.rows ?? [];
  }

  /**
   * S7 — a watched file affecting this project's manifest or lockfile changed
   * (or a successful upgrade just rewrote them). Drops the persisted entry so
   * nothing later replays data that's now known to be wrong; deliberately
   * leaves the in-memory `lastResult` alone so the panel can keep the last
   * good render on screen until the caller's follow-up rescan (`run` via
   * `handleRefresh`/`refreshInBackground`) actually replaces it.
   */
  invalidateCache(): void {
    this.options.projectCacheStore.delete(this.options.cacheKey);
  }

  private currentSourceFingerprint(): ProjectSourceFingerprint {
    return computeSourceFingerprint({
      manifestText: this.options.manifestText,
      lockfileText: this.options.lockfileText,
      packageManager: this.options.packageManager ?? 'npm',
      importerId: this.options.importerId ?? '.',
      lockfilePath: this.options.lockfilePath,
    });
  }

  /**
   * Hydrates `lastResult` from the persisted entry for this cacheKey, but
   * only if it still matches what's actually on disk right now. A cacheKey
   * alone doesn't prove that — the project's manifest/lockfile could have
   * been edited while the panel was closed (no watcher running to invalidate
   * it then), and `updateProjectSnapshot` always runs before this is called
   * on an existing controller, so `this.options` already reflects a fresh
   * disk read. A mismatch means the entry describes a state that no longer
   * exists: it is deleted outright (not merely skipped) so it doesn't keep
   * failing this same comparison forever, and a real scan follows exactly as
   * if nothing had ever been cached.
   */
  private hydrateFromPersistedCache(performance: PerformanceRecorder): void {
    const endRead = performance.start('cache read');
    const cached = this.options.projectCacheStore.get(this.options.cacheKey);
    endRead({ hit: cached !== undefined });
    if (cached === undefined) return;

    const endValidation = performance.start('cache validation');
    // `isSourceFingerprint` here is defense in depth, not the primary
    // control — a real persisted entry already passed schema validation
    // (schema.ts) before ever reaching the store, so `cached.sourceFingerprint`
    // should always be well-formed. Guarding it anyway keeps this method
    // consistent with the rest of the cache layer's rule: never trust the
    // shape of anything read back from storage, never crash on it either.
    if (
      !isSourceFingerprint(cached.sourceFingerprint) ||
      !sourceFingerprintsMatch(cached.sourceFingerprint, this.currentSourceFingerprint())
    ) {
      endValidation({ valid: false });
      this.options.projectCacheStore.delete(this.options.cacheKey);
      return;
    }
    endValidation({ valid: true });

    // PersistedProjectCache is a structural superset of ScanSnapshot (adds
    // generatedAt/lockfilePath/sourceFingerprint) — assigning it here just
    // carries those extra fields along invisibly; nothing that reads
    // `lastResult` as a ScanSnapshot ever looks at them.
    this.lastResult = cached;
    this.lastGeneratedAt = cached.generatedAt;
  }

  private persistSnapshot(snapshot: ScanSnapshot, generatedAt: string, performance: PerformanceRecorder): void {
    const endWrite = performance.start('cache write');
    this.options.projectCacheStore.set(this.options.cacheKey, {
      ...snapshot,
      generatedAt,
      lockfilePath: this.options.lockfilePath,
      sourceFingerprint: this.currentSourceFingerprint(),
    });
    endWrite({ rows: snapshot.rows.length });
  }

  /**
   * The webview mounted and asked for state.
   *
   * If nothing is in memory yet, first hydrate from the persisted cache — a
   * cold controller (new panel, or just switched to this project) may still
   * have a usable snapshot from a previous session. Then classify freshness
   * against the configured TTL: a fresh snapshot renders as `ready` and skips
   * the network entirely; anything else (stale, or no timestamp to judge by)
   * renders immediately as a head start while a real run follows underneath.
   */
  async handleReady(sink: MessageSink): Promise<void> {
    const cachePerformance = createPerformanceSession('Dependency Dashboard cache', this.performanceEnabled());
    if (this.lastResult === undefined) {
      this.hydrateFromPersistedCache(cachePerformance);
    }
    const cached = this.lastResult;
    if (cached === undefined) {
      cachePerformance.finish({ hit: false });
      sink.postMessage({ status: 'loading' });
      await this.run(sink);
      return;
    }

    const endFreshness = cachePerformance.start('cache freshness');
    const freshness = classifyFreshness(this.lastGeneratedAt, this.options.ttlMinutesProvider(), this.now());
    endFreshness({ freshness });
    cachePerformance.finish({ hit: true, freshness });
    if (freshness === 'fresh') {
      // Fresh, fingerprint-matching data (hydrateFromPersistedCache already
      // deleted and refused to hydrate anything that didn't match) may
      // authorize an Upgrade — restore eligibility for it explicitly, since
      // a cold controller's `eligibleGeneration` starts undefined and
      // hydration alone (unlike a completed `run()`) never sets it. Gated on
      // `optionsGeneration === revalidationGeneration`: the fingerprint
      // match above only proves the persisted entry matches `this.options`
      // as they stand — if a watcher event already called
      // `beginRevalidation()` before `this.options` ever caught up to it
      // (construction happened, then a file changed, then the webview's
      // first `ready` arrived — all before the debounced reload ran), that
      // match is against content already known to be stale, and must not
      // grant eligibility.
      if (this.optionsGeneration === this.revalidationGeneration) {
        this.eligibleGeneration = this.revalidationGeneration;
      }
      sink.postMessage(
        toHostToWebviewMessage(
          cached,
          { isEmpty: cached.rows.length === 0, isStale: false },
          this.options.projectInfo,
          this.options.canChangeProject,
          this.options.buildInfo,
          this.lastGeneratedAt
        )
      );
      return;
    }

    // Not fresh (TTL-stale, or no timestamp to judge by) — `run()` itself
    // announces the stale replay (carrying `cached`) as its own first
    // action via `beginRevalidation`'s call site there, then continues with
    // a real scan; posting it again here would just be a redundant duplicate.
    await this.run(sink);
  }

  /**
   * Manual refresh: must genuinely bypass any freshness decision, so the
   * in-memory cache is discarded up front — never consulted, regardless of
   * how fresh it is — and a real scan always runs. The persisted entry is
   * left as-is until `run()` either replaces it with the new result or
   * decides (via its own aborted/failure checks) not to.
   */
  async handleRefresh(sink: MessageSink): Promise<void> {
    this.lastResult = undefined;
    this.lastGeneratedAt = undefined;
    sink.postMessage({ status: 'loading' });
    await this.run(sink);
  }

  /**
   * S7 — background revalidation: file-watcher- or timer-triggered. Unlike
   * `handleRefresh`, it never clears `lastResult` or posts `loading` first —
   * the whole point is that the last good render stays on screen, unchanged,
   * until (and unless) a new result actually arrives. A failure here is
   * silently absorbed by `run()`'s own catch block (it only posts
   * `fatal-error` when there is nothing renderable at all).
   */
  async refreshInBackground(sink: MessageSink): Promise<void> {
    await this.run(sink);
  }

  /**
   * S7 — used by the panel's ~30-minute background timer to respect the
   * configured TTL: true only when there is a renderable snapshot that is no
   * longer fresh, so the timer's fixed cadence doesn't force a network round
   * trip while the configured TTL still considers the data good.
   */
  needsBackgroundRefresh(): boolean {
    if (this.lastResult === undefined) return false;
    return classifyFreshness(this.lastGeneratedAt, this.options.ttlMinutesProvider(), this.now()) !== 'fresh';
  }

  /** Call from the panel's onDidDispose so an in-flight run stops with it. */
  dispose(): void {
    this.inFlight?.abort();
    this.inFlight = undefined;
  }

  private async run(sink: MessageSink): Promise<void> {
    const performance = createPerformanceSession('Dependency Dashboard scan', this.performanceEnabled());
    // Every run — manual, background-timer-triggered, file-change-triggered,
    // or a stale-handleReady follow-up alike — is itself a revalidation
    // attempt: eligibility must not be trusted while it's in flight, however
    // it was triggered. `generationBeforeThisRun` is captured *before* this
    // run's own `beginRevalidation()` call — it's what lets completion tell
    // apart "nothing else was pending when I started, my own bump is the
    // only thing that happened" from "something *else* had already called
    // beginRevalidation() and `this.options` never caught up to it before I
    // started scanning against them" (see the `optionsGeneration` check
    // below) — a plain equality check against `beginRevalidation()`'s own
    // return value can't make that distinction, since this run's own call
    // unconditionally advances past whatever `optionsGeneration` says,
    // every single time, even for the very first scan a fresh controller
    // ever runs.
    //
    // `generationAtStart` (the value *after* this run's own bump) is what
    // completion compares `this.revalidationGeneration` against — captured
    // now, before the network round trip, so completion can tell whether the
    // source changed *again* (a watcher event, a project reload, another
    // call to this same method) while this scan was still running. Not the
    // same thing `controller.signal.aborted` guards below: that only catches
    // an explicit newer `run()` call superseding this one; a bare
    // `beginRevalidation()` call (e.g. from a watcher event) does not itself
    // start a new run, and this scan's rows can still finish and be worth
    // *showing* — they just must not be trusted to *authorize an Upgrade*
    // against a source that has already moved on.
    const generationBeforeThisRun = this.revalidationGeneration;
    const generationAtStart = this.beginRevalidation();

    // A newer run supersedes an older one outright. Without this, two runs race
    // to post and the slower — older — one can land last and win.
    this.inFlight?.abort();
    const controller = new AbortController();
    this.inFlight = controller;

    // Announce that a revalidation is now actively running — a no-op if
    // there's nothing to carry (a cold start already posted its own
    // `loading`) or `lastResult` was just explicitly cleared (`handleRefresh`
    // already posted its own `loading` for that case), and a harmless
    // duplicate if an earlier call site (a watcher event, reloadAndScan's own
    // start) already announced this same revalidation — see
    // `announceRevalidating`'s own doc.
    this.announceRevalidating(sink);

    const buildOptions: BuildPackageRowsOptions = {
      root: this.options.root,
      manifestText: this.options.manifestText,
      lockfileText: this.options.lockfileText,
      packageManager: this.options.packageManager ?? 'npm',
      importerId: this.options.importerId ?? '.',
      registry: this.options.registry,
      httpClient: this.options.httpClient,
      etagStore: this.options.etagStore,
      signal: controller.signal,
      performance,
      ...(this.options.auditRunner === undefined || this.options.packageManager === 'pnpm'
        ? {}
        : { auditRunner: this.options.auditRunner }),
      ...(this.options.progressEnabled === true
        ? {
            onProgress: (progress) => {
              sink.postMessage({ status: 'scan-progress', ...progress });
            },
          }
        : {}),
    };

    try {
      const result = await buildPackageRows(buildOptions);
      // The pipeline checks the signal at each stage boundary, but a run that
      // was already past the last boundary when the abort fired still resolves
      // normally. Superseded or disposed, its result — and any cache write —
      // is not wanted either way.
      if (controller.signal.aborted) return;

      const generatedAt = new Date().toISOString();
      const snapshot = toScanSnapshot(result);
      this.lastResult = snapshot;
      this.lastGeneratedAt = generatedAt;
      this.persistSnapshot(snapshot, generatedAt, performance);
      // Only a scan whose source didn't change out from under it restores
      // Upgrade eligibility — if `beginRevalidation()` was called again
      // (`revalidationGeneration` has moved) since this run started, the
      // rows above are still worth showing (newer than what was there
      // before), but a fresh reload for the *even newer* state is already on
      // its way (a watcher event that arrived mid-scan, or an independent
      // reload attempt) and must be the one to grant eligibility, not this
      // now-superseded scan. The `optionsGeneration` check catches the same
      // hazard one step earlier: this scan's `buildOptions` were captured
      // from `this.options` above, so if a bump had already landed *before*
      // this run even started (checked against `generationBeforeThisRun`,
      // not `generationAtStart` — this run's *own* `beginRevalidation()` call
      // always advances past whatever `optionsGeneration` says, even for a
      // perfectly ordinary first scan, so comparing against the post-bump
      // value would reject every run unconditionally) without `this.options`
      // catching up to it yet (a background-timer tick racing an already-
      // pending, not-yet-applied file-change reload), `this.options` — and
      // therefore this whole scan — was stale from the moment it began,
      // regardless of what happened afterward.
      if (generationAtStart === this.revalidationGeneration && this.optionsGeneration === generationBeforeThisRun) {
        this.eligibleGeneration = generationAtStart;
        // A granted scan is itself a re-confirmation that `this.options`
        // are accurate as of this generation — advance the watermark to
        // match, not just `eligibleGeneration`. Without this, a second
        // background-only revalidation (a plain timer tick — no
        // `updateProjectSnapshot` in between, since nothing re-reads disk
        // for that path) would find `optionsGeneration` still stuck at
        // whatever it was after the *first* grant while `revalidationGeneration`
        // had already moved on from this run's own `beginRevalidation()`
        // call, permanently failing the check above for every scan after
        // the first. Chaining the confirmation forward like this is safe
        // precisely because we only reach here when both checks already
        // passed — nothing invalidated it in between.
        this.optionsGeneration = generationAtStart;
      }
      sink.postMessage(
        toHostToWebviewMessage(
          snapshot,
          { isEmpty: snapshot.rows.length === 0, isStale: false },
          this.options.projectInfo,
          this.options.canChangeProject,
          this.options.buildInfo,
          generatedAt
        )
      );
    } catch (cause) {
      if (controller.signal.aborted || isCancellation(cause)) return;
      // Nothing renderable at all: an unreadable manifest, an unsupported
      // lockfile version. Degraded-data failures never reach here — the
      // pipeline folds those into advisoriesError/auditUnavailable. If a good
      // snapshot is already on screen (a background revalidation that failed),
      // leave it exactly as it was rather than blowing it away with an error.
      if (this.lastResult === undefined) {
        sink.postMessage({ status: 'fatal-error', error: toProtocolError(cause) });
      }
    } finally {
      performance.finish({ cancelled: controller.signal.aborted });
    }
  }
}
