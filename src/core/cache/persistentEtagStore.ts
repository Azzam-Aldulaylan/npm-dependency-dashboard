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
import { CACHE_SCHEMA_VERSION, isPersistedEtagCacheCollection } from './schema.js';
import { WriteBackCache } from './writeBackCache.js';

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

/** Reads and validates the persisted collection; returns [] for anything missing, corrupt, or the wrong schema version — never throws. */
export function loadPersistedEtagEntries(store: KeyValueStore): Array<[string, CachedResponse]> {
  const raw = store.get(REGISTRY_CACHE_STORAGE_KEY);
  if (!isPersistedEtagCacheCollection(raw)) return [];
  return raw.entries;
}

export class PersistentEtagStore implements EtagStore {
  private readonly cache: WriteBackCache<CachedResponse>;

  constructor(store: KeyValueStore, initialEntries: Array<[string, CachedResponse]> = loadPersistedEtagEntries(store)) {
    this.cache = new WriteBackCache<CachedResponse>({
      initialEntries,
      maxEntries: MAX_REGISTRY_CACHE_ENTRIES,
      persist: async (entries) => {
        // Defense in depth (see keys.ts) — a URL npmrc.ts would already have
        // refused to resolve must still never reach disk if one somehow did.
        const safeEntries = entries.filter(([key]) => !hasUrlCredentials(key));
        await store.update(REGISTRY_CACHE_STORAGE_KEY, {
          schemaVersion: CACHE_SCHEMA_VERSION,
          entries: safeEntries,
        });
      },
    });
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
