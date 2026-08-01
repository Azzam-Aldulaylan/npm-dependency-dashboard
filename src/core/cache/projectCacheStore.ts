/**
 * Persisted project-specific install-state cache — the workspaceState half
 * of the split (project-specific data never leaves the workspace it belongs
 * to; VS Code already scopes `workspaceState` per workspace, so this store
 * only needs to disambiguate *within* one workspace, which is exactly what
 * `deriveProjectCacheKey`'s S6-identity-plus-registry key does).
 */

import type { KeyValueStore } from './keyValueStore.js';
import type { PersistedProjectCache } from './schema.js';
import { CACHE_SCHEMA_VERSION, isPersistedProjectCacheCollection } from './schema.js';
import { WriteBackCache } from './writeBackCache.js';

export const PROJECT_CACHE_STORAGE_KEY = 'dependencyDashboard.projectCache';

/**
 * Bounded so a workspace with many monorepo members (or one revisited over
 * many sessions) can't grow this without limit — a project falling out of
 * the cache just means its next open re-scans, same as a cold cache always
 * has.
 */
export const MAX_PROJECT_CACHE_ENTRIES = 50;

export function loadPersistedProjectCacheEntries(store: KeyValueStore): Array<[string, PersistedProjectCache]> {
  const raw = store.get(PROJECT_CACHE_STORAGE_KEY);
  if (!isPersistedProjectCacheCollection(raw)) return [];
  return raw.entries;
}

export class PersistentProjectCacheStore {
  private readonly cache: WriteBackCache<PersistedProjectCache>;

  constructor(
    store: KeyValueStore,
    initialEntries: Array<[string, PersistedProjectCache]> = loadPersistedProjectCacheEntries(store)
  ) {
    this.cache = new WriteBackCache<PersistedProjectCache>({
      initialEntries,
      maxEntries: MAX_PROJECT_CACHE_ENTRIES,
      persist: async (entries) => {
        await store.update(PROJECT_CACHE_STORAGE_KEY, { schemaVersion: CACHE_SCHEMA_VERSION, entries });
      },
    });
  }

  get(cacheKey: string): PersistedProjectCache | undefined {
    return this.cache.get(cacheKey);
  }

  set(cacheKey: string, value: PersistedProjectCache): void {
    this.cache.set(cacheKey, value);
  }

  /** Used by file-watcher invalidation — a manifest/lockfile change drops the affected entry outright rather than trying to patch it. */
  delete(cacheKey: string): void {
    this.cache.delete(cacheKey);
  }

  /**
   * Purges every persisted entry recorded against this exact absolute
   * lockfile path — not just the currently selected project's own entry.
   * An npm workspace keeps one lockfile at the repo root covering every
   * member; when it changes, every member's persisted install-state is
   * equally stale, even members with no live controller or watcher right
   * now. Matching is by the exact absolute path each entry was persisted
   * with, never by relative-path string comparison, so two unrelated
   * projects that merely happen to share a relative lockfile name in
   * different workspace folders can never collide here.
   */
  deleteByLockfilePath(lockfilePath: string): void {
    this.cache.deleteWhere((value) => value.lockfilePath === lockfilePath);
  }

  dispose(): void {
    this.cache.dispose();
  }
}
