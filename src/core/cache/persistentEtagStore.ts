/**
 * A synchronous `EtagStore` (src/core/registry/versions.ts) backed by
 * asynchronous persistence — see writeBackCache.ts for the mechanism. This
 * is the piece that lets registry/version data survive a panel close,
 * shared across every project and every workspace (the spec's "global
 * cache" — a package's version history doesn't depend on which project
 * references it), keyed by the literal request URL exactly as `versions.ts`
 * already does in memory, so cross-registry contamination is impossible by
 * construction: different registries produce different URLs.
 */

import type { CachedResponse, EtagStore } from '../registry/versions.js';
import { hasUrlCredentials } from './keys.js';
import type { KeyValueStore } from './keyValueStore.js';
import { ETAG_CACHE_SCHEMA_VERSION, isPersistedEtagCacheCollection } from './schema.js';
import { WriteBackCache } from './writeBackCache.js';
import type { WriteBackCacheScheduler } from './writeBackCache.js';

export const REGISTRY_CACHE_STORAGE_KEY = 'dependencyDashboard.registryCache';

/**
 * Deliberately generous but finite — packument entries can run to tens of
 * KB each; a few hundred keeps the persisted blob bounded without evicting
 * a project's whole dependency tree's worth of entries after a handful of
 * scans. `/latest` entries (the common case, per the spec's hybrid-fetch
 * design) are tiny by comparison, so this comfortably covers many projects'
 * worth of everyday version checks.
 */
export const MAX_REGISTRY_CACHE_ENTRIES = 500;

/**
 * VS Code stores an extension's whole `globalState` as one serialized value.
 * Full npm packuments can be several MiB each, so the entry-count bound alone
 * does not meaningfully bound that value (three observed packuments occupied
 * more than 11 MiB). Keep this cache below 5 MiB including its schema wrapper,
 * keys, ETags, JSON escaping, and response bodies. Entries remain ordered from
 * oldest to newest write; cumulative pressure evicts from the oldest end, and
 * an entry that cannot fit by itself is not admitted to persistence. Such a
 * response is still available from the synchronous in-memory cache for the
 * rest of the current extension-host session.
 */
export const MAX_REGISTRY_CACHE_SERIALIZED_BYTES = 5 * 1024 * 1024;

/** Registry responses commonly settle on adjacent event-loop turns. Batch the
 * resulting full-cache writes briefly, while bounding a continuous stream so
 * persistence can never be postponed indefinitely. */
export const REGISTRY_CACHE_TRAILING_FLUSH_MS = 50;
export const REGISTRY_CACHE_MAX_FLUSH_DELAY_MS = 250;

export interface PersistentEtagStoreOptions {
  trailingDelayMs?: number;
  maxDelayMs?: number;
  scheduler?: WriteBackCacheScheduler;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/** Exact UTF-8 size of the value handed to `globalState.update`. */
export function serializedEtagCacheBytes(entries: readonly (readonly [string, CachedResponse])[]): number {
  return utf8Bytes(JSON.stringify({
    schemaVersion: ETAG_CACHE_SCHEMA_VERSION,
    entries,
  }));
}

/**
 * Applies both persistence bounds while preserving deterministic
 * oldest-to-newest write order. Repeated keys take their last occurrence,
 * matching `Map` hydration and treating that occurrence as the freshest.
 */
export function boundPersistedEtagEntries(
  entries: readonly (readonly [string, CachedResponse])[],
  maxBytes = MAX_REGISTRY_CACHE_SERIALIZED_BYTES,
  maxEntries = MAX_REGISTRY_CACHE_ENTRIES
): Array<[string, CachedResponse]> {
  const byteBudget = Math.max(0, maxBytes);
  const entryBudget = Math.max(0, maxEntries);
  const emptyCollectionBytes = serializedEtagCacheBytes([]);
  const seenKeys = new Set<string>();
  const newestFirst: Array<[string, CachedResponse]> = [];
  let totalBytes = emptyCollectionBytes;

  // Walk newest-to-oldest so large persisted caches do not stringify every
  // old body merely to discover that the newest 5 MiB already fill the cap.
  // Once an otherwise-admissible entry would exceed the cumulative budget,
  // it and every older entry are the deterministic LRU eviction tail. An
  // individually oversized response is different: it was never admissible,
  // so skip it without flushing useful older entries from persistence.
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const [key, value] = entries[index]!;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    if (hasUrlCredentials(key)) continue;
    if (newestFirst.length >= entryBudget) break;

    const entryBytes = utf8Bytes(JSON.stringify([key, value]));
    if (emptyCollectionBytes + entryBytes > byteBudget) continue;
    const candidateBytes = totalBytes + entryBytes + (newestFirst.length === 0 ? 0 : 1);
    if (candidateBytes > byteBudget) break;
    newestFirst.push([key, value]);
    totalBytes = candidateBytes;
  }
  return newestFirst.reverse();
}

function loadValidatedPersistedEtagEntries(store: KeyValueStore): Array<[string, CachedResponse]> {
  const raw = store.get(REGISTRY_CACHE_STORAGE_KEY);
  if (!isPersistedEtagCacheCollection(raw)) return [];
  return raw.entries;
}

/** Reads, validates, and bounds the persisted collection; returns [] for anything missing, corrupt, or the wrong schema version — never throws. */
export function loadPersistedEtagEntries(store: KeyValueStore): Array<[string, CachedResponse]> {
  return boundPersistedEtagEntries(loadValidatedPersistedEtagEntries(store));
}

export class PersistentEtagStore implements EtagStore {
  private readonly cache: WriteBackCache<CachedResponse>;

  constructor(
    store: KeyValueStore,
    initialEntries: Array<[string, CachedResponse]> = loadValidatedPersistedEtagEntries(store),
    options: PersistentEtagStoreOptions = {}
  ) {
    const boundedInitialEntries = boundPersistedEtagEntries(initialEntries);
    this.cache = new WriteBackCache<CachedResponse>({
      initialEntries,
      maxEntries: MAX_REGISTRY_CACHE_ENTRIES,
      batching: {
        trailingDelayMs: options.trailingDelayMs ?? REGISTRY_CACHE_TRAILING_FLUSH_MS,
        maxDelayMs: options.maxDelayMs ?? REGISTRY_CACHE_MAX_FLUSH_DELAY_MS,
        ...(options.scheduler === undefined ? {} : { scheduler: options.scheduler }),
      },
      persist: async (entries) => {
        // Defense in depth (see keys.ts) — a URL npmrc.ts would already have
        // refused to resolve must still never reach disk if one somehow did.
        // The same normalization also enforces the exact serialized byte cap;
        // count alone cannot bound a collection of full response bodies.
        const safeEntries = boundPersistedEtagEntries(entries);
        await store.update(REGISTRY_CACHE_STORAGE_KEY, {
          schemaVersion: ETAG_CACHE_SCHEMA_VERSION,
          entries: safeEntries,
        });
      },
    });

    // Heal a previously-valid schema-v2 snapshot that predates the byte cap.
    // Route the rewrite through WriteBackCache's serial queue so it cannot
    // race a registry response arriving immediately after construction. The
    // delete calls also make the in-memory view bounded; re-setting the final
    // retained entry schedules a rewrite even when WriteBackCache's own
    // count cap already removed every over-count key during construction.
    const retainedKeys = new Set(boundedInitialEntries.map(([key]) => key));
    for (const key of new Set(initialEntries.map(([entryKey]) => entryKey))) {
      if (!retainedKeys.has(key)) this.cache.delete(key);
    }
    const normalizationChanged =
      initialEntries.length !== boundedInitialEntries.length ||
      initialEntries.some(([key, value], index) => {
        const bounded = boundedInitialEntries[index];
        return bounded === undefined || bounded[0] !== key || bounded[1] !== value;
      });
    const newestRetained = boundedInitialEntries.at(-1);
    if (normalizationChanged && newestRetained !== undefined) {
      this.cache.set(newestRetained[0], newestRetained[1]);
    }
  }

  get(key: string): CachedResponse | undefined {
    return this.cache.get(key);
  }

  set(key: string, value: CachedResponse): void {
    this.cache.set(key, value);
  }

  dispose(): void {
    this.cache.dispose();
  }
}
