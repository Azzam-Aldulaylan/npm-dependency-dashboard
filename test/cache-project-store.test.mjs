/**
 * PersistentProjectCacheStore — the workspaceState-backed project cache.
 * Uses a fake KeyValueStore (a plain Map behind the duck-typed
 * get/update interface) so this stays a pure node:test suite with no vscode
 * dependency, exactly as versions.test.mjs already does for EtagStore.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PersistentProjectCacheStore, PROJECT_CACHE_STORAGE_KEY } from '../out/core/cache/projectCacheStore.js';
import { CACHE_SCHEMA_VERSION } from '../out/core/cache/schema.js';

function fakeKeyValueStore(initial) {
  const data = new Map(initial ? [[PROJECT_CACHE_STORAGE_KEY, initial]] : []);
  return {
    raw: data,
    get(key) {
      return data.get(key);
    },
    async update(key, value) {
      data.set(key, value);
    },
  };
}

async function flushed() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const FINGERPRINT = { manifestHash: 'h-manifest', lockfileHash: 'h-lockfile', lockfilePath: null };
const entry = (rows, lockfilePath = null) => ({
  rows,
  generatedAt: '2026-08-01T12:00:00.000Z',
  lockfilePath,
  sourceFingerprint: FINGERPRINT,
});

test('set/get round-trip in memory, and the underlying store receives the persisted shape', async () => {
  const kv = fakeKeyValueStore();
  const store = new PersistentProjectCacheStore(kv);

  store.set('project-a', entry([{ name: 'x' }]));
  assert.deepEqual(store.get('project-a'), entry([{ name: 'x' }]));

  await flushed();
  const persisted = kv.raw.get(PROJECT_CACHE_STORAGE_KEY);
  assert.equal(persisted.schemaVersion, CACHE_SCHEMA_VERSION);
  assert.deepEqual(persisted.entries, [['project-a', entry([{ name: 'x' }])]]);
});

test('a project cache entry is isolated from every other cacheKey in the same store', () => {
  const store = new PersistentProjectCacheStore(fakeKeyValueStore());
  store.set('project-a', entry([{ name: 'a-only' }]));
  store.set('project-b', entry([{ name: 'b-only' }]));

  assert.deepEqual(store.get('project-a').rows, [{ name: 'a-only' }]);
  assert.deepEqual(store.get('project-b').rows, [{ name: 'b-only' }]);
  assert.equal(store.get('project-c'), undefined);
});

test('a corrupt or malformed persisted blob degrades to an empty store rather than throwing', () => {
  const corrupt = fakeKeyValueStore({ schemaVersion: 999, entries: [] });
  assert.doesNotThrow(() => new PersistentProjectCacheStore(corrupt));
  assert.equal(new PersistentProjectCacheStore(corrupt).get('anything'), undefined);

  const garbage = fakeKeyValueStore('not even an object');
  assert.doesNotThrow(() => new PersistentProjectCacheStore(garbage));
});

test('deleteByLockfilePath purges every entry recorded against that exact absolute path — the npm-workspace shared-lockfile case', async () => {
  const store = new PersistentProjectCacheStore(fakeKeyValueStore());
  const sharedLockfile = '/repo/package-lock.json';
  store.set('workspace-member-a', entry([{ name: 'a' }], sharedLockfile));
  store.set('workspace-member-b', entry([{ name: 'b' }], sharedLockfile));
  store.set('unrelated-project', entry([{ name: 'c' }], '/other/repo/package-lock.json'));

  store.deleteByLockfilePath(sharedLockfile);
  await flushed();

  assert.equal(store.get('workspace-member-a'), undefined);
  assert.equal(store.get('workspace-member-b'), undefined);
  assert.notEqual(store.get('unrelated-project'), undefined, 'a different absolute path is never touched');
});

test('deleteByLockfilePath does not match on relative-path-only similarity, only the exact absolute path', () => {
  const store = new PersistentProjectCacheStore(fakeKeyValueStore());
  store.set('folder-one-project', entry([{ name: 'x' }], '/workspace/one/package-lock.json'));
  store.set('folder-two-project', entry([{ name: 'y' }], '/workspace/two/package-lock.json'));

  store.deleteByLockfilePath('/workspace/one/package-lock.json');

  assert.equal(store.get('folder-one-project'), undefined);
  assert.notEqual(
    store.get('folder-two-project'),
    undefined,
    'a different workspace folder happening to share the lockfile filename must not collide'
  );
});

test('the store is bounded — entries beyond MAX_PROJECT_CACHE_ENTRIES are evicted deterministically', async () => {
  const kv = fakeKeyValueStore();
  const store = new PersistentProjectCacheStore(kv);

  for (let i = 0; i < 55; i += 1) {
    store.set(`project-${i}`, entry([{ name: `p${i}` }]));
  }
  await flushed();

  const persisted = kv.raw.get(PROJECT_CACHE_STORAGE_KEY);
  assert.ok(persisted.entries.length <= 50, `expected at most 50 entries, got ${persisted.entries.length}`);
  assert.equal(store.get('project-0'), undefined, 'the oldest entries are the ones evicted');
  assert.notEqual(store.get('project-54'), undefined, 'the most recently written entry survives');
});
