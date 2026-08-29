/**
 * Persisted cache record shapes and their runtime validators — pure, no
 * vscode. Every persisted value (workspaceState's per-project install-state,
 * globalState's registry/ETag cache) is read back as `unknown` and must pass
 * one of these validators before anything touches its fields; a value that
 * doesn't is treated exactly like "no cache", never partially trusted and
 * never thrown on (a corrupted extension-storage blob must degrade to a
 * normal fetch, not crash the extension).
 *
 * `entries` is an array of `[key, value]` tuples rather than a
 * `Record<string, V>` deliberately — a plain object built from untrusted
 * JSON risks `__proto__`/`constructor`/`prototype` key pollution (the same
 * concern src/core/manifest/parse.ts and src/core/advisories/bulk.ts guard
 * against for the same reason); a tuple array has no such surface.
 */

import type { CachedResponse } from '../registry/versions.js';
import type { DependencyFinding } from '../hygiene/types.js';
import type { PackageRow, ScanDataAvailability } from '../types.js';
import type { ProtocolError } from '../validation.js';
import { isAbsentOr, isDependencyFinding, isPackageRow, isProtocolError, isRecord, isScanDataAvailability, isStringOrNull } from '../validation.js';
import type { ProjectSourceFingerprint } from './sourceFingerprint.js';
import { isSourceFingerprint } from './sourceFingerprint.js';

/**
 * Bumped whenever the persisted project-cache shape or semantics change
 * incompatibly. A
 * stored blob whose version doesn't match exactly is ignored outright — no
 * attempt at forward/backward migration, which would be its own source of
 * subtly-wrong data for a cache that's allowed to just be empty instead.
 *
 * 2: `PersistedProjectCache` gained `sourceFingerprint` — a v1 entry has no
 * fingerprint to compare against, so it must be rejected outright rather
 * than treated as an automatic, unverifiable match.
 *
 * 3: package rows gained registry descriptions. Version 2 rows are still
 * structurally safe, but accepting them would make an upgraded extension
 * keep displaying the description fallback until some unrelated source
 * change invalidated the cache. Rejecting the old project snapshot forces
 * one correct regeneration.
 *
 * 4: package rows gained their optional-dependency classification. Version 3
 * rows cannot distinguish optional dependencies from production dependencies,
 * so they must be regenerated before the Manage UI renders their type.
 *
 * 5: snapshots gained explicit update/advisory availability. Older rows can
 * contain null update metadata or no advisories without saying whether those
 * are proven facts or failed lookups, so replaying them would be misleading.
 *
 * 6: advisory rows gained public CVE/GHSA aliases. Version 5 rows remain
 * structurally valid, but replaying them would keep showing only npm's raw
 * source id until an unrelated refresh replaced the snapshot. Force one
 * regeneration so the newly available public identifiers are visible.
 *
 * 7: the first alias-enrichment implementation discarded verified first-page
 * identifiers if a later optional GitHub page failed. Reject those development
 * snapshots so they cannot keep replaying CVE-less rows after that pagination
 * behavior is corrected.
 */
export const CACHE_SCHEMA_VERSION = 7;

/**
 * The registry response cache did not change when project rows gained a
 * description. Keep its independent version stable so the one-time project
 * refresh can reuse validated response bodies and ETags instead of turning
 * into an unnecessary network cold start.
 */
export const ETAG_CACHE_SCHEMA_VERSION = 2;

function isValidIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

// ------------------------------------------------------- project cache

/**
 * The part of a scan result worth remembering, independent of *when* it was
 * produced — shared between `DashboardController`'s in-memory state and the
 * persisted cache record so both use the same structural shape. Deliberately
 * structural (not `BuildPackageRowsResult` from src/core/pipeline.ts, whose
 * `advisoriesError` is a live `FetchError` instance) — `FetchError`
 * structurally satisfies `ProtocolError` (it has `.code`/`.message`, plus
 * more), so a `BuildPackageRowsResult` is always assignable here without
 * pipeline.ts needing to know this type exists.
 */
export interface ScanSnapshot {
  rows: PackageRow[];
  availability: ScanDataAvailability;
  advisoriesError?: ProtocolError;
  auditUnavailable?: boolean;
  /** Deprecated + duplicate-version findings — see src/core/hygiene/index.ts. Optional so a pre-existing persisted entry (written before this field existed) still passes validation as "no findings computed yet" rather than being rejected outright. */
  hygieneFindings?: DependencyFinding[];
}

/**
 * One project's persisted install-state snapshot — the workspaceState
 * payload. `lockfilePath` (absolute, host-only — never sent to the webview)
 * records which on-disk lockfile produced this snapshot, so a file-watcher
 * event on that exact path can purge every persisted entry that depends on
 * it in one pass — the mechanism that correctly handles an npm workspace's
 * single root lockfile covering several member projects without needing to
 * re-discover or re-resolve every candidate just to find out which ones
 * share it.
 */
export interface PersistedProjectCache extends ScanSnapshot {
  generatedAt: string;
  lockfilePath: string | null;
  /** Hashes of the manifest/lockfile text (plus lockfile identity) this snapshot was actually produced from — compared against a freshly-read fingerprint at hydration time so a file edited while the panel was closed can never produce a fresh cache hit on reopen. See sourceFingerprint.ts. */
  sourceFingerprint: ProjectSourceFingerprint;
}

export function isPersistedProjectCache(value: unknown): value is PersistedProjectCache {
  if (!isRecord(value)) return false;
  const rows = value['rows'];
  return (
    isValidIsoTimestamp(value['generatedAt']) &&
    isStringOrNull(value['lockfilePath']) &&
    isSourceFingerprint(value['sourceFingerprint']) &&
    Array.isArray(rows) &&
    rows.every(isPackageRow) &&
    isScanDataAvailability(value['availability']) &&
    isAbsentOr(value['advisoriesError'], isProtocolError) &&
    isAbsentOr(value['auditUnavailable'], (v) => typeof v === 'boolean') &&
    isAbsentOr(value['hygieneFindings'], (v) => Array.isArray(v) && v.every(isDependencyFinding)) &&
    ((value['availability'] as ScanDataAvailability).advisories === 'unavailable') ===
      (value['advisoriesError'] !== undefined)
  );
}

export interface PersistedProjectCacheCollection {
  schemaVersion: number;
  entries: Array<[string, PersistedProjectCache]>;
}

export function isPersistedProjectCacheCollection(value: unknown): value is PersistedProjectCacheCollection {
  if (!isRecord(value)) return false;
  if (value['schemaVersion'] !== CACHE_SCHEMA_VERSION) return false;
  const entries = value['entries'];
  return (
    Array.isArray(entries) &&
    entries.every(
      (entry) =>
        Array.isArray(entry) &&
        entry.length === 2 &&
        typeof entry[0] === 'string' &&
        isPersistedProjectCache(entry[1])
    )
  );
}

// --------------------------------------------------------- registry cache

function isCachedResponse(value: unknown): value is CachedResponse {
  return isRecord(value) && typeof value['etag'] === 'string' && typeof value['body'] === 'string';
}

export interface PersistedEtagCacheCollection {
  schemaVersion: number;
  entries: Array<[string, CachedResponse]>;
}

export function isPersistedEtagCacheCollection(value: unknown): value is PersistedEtagCacheCollection {
  if (!isRecord(value)) return false;
  if (value['schemaVersion'] !== ETAG_CACHE_SCHEMA_VERSION) return false;
  const entries = value['entries'];
  return (
    Array.isArray(entries) &&
    entries.every(
      (entry) =>
        Array.isArray(entry) &&
        entry.length === 2 &&
        typeof entry[0] === 'string' &&
        isCachedResponse(entry[1])
    )
  );
}
