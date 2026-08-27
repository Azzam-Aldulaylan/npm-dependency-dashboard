/**
 * PersistentEtagStore — the globalState-backed registry/version cache. Same
 * fake-KeyValueStore approach as cache-project-store.test.mjs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_REGISTRY_CACHE_SERIALIZED_BYTES,
  PersistentEtagStore,
  REGISTRY_CACHE_STORAGE_KEY,
  boundPersistedEtagEntries,
  loadPersistedEtagEntries,
  serializedEtagCacheBytes,
} from '../out/core/cache/persistentEtagStore.js';

function fakeKeyValueStore(initial) {
  const data = new Map(initial ? [[REGISTRY_CACHE_STORAGE_KEY, initial]] : []);
  const updates = [];
  return {
    raw: data,
    updates,
    get(key) {
      return data.get(key);
    },
    async update(key, value) {
      updates.push({ key, value, bytes: Buffer.byteLength(JSON.stringify(value)) });
      data.set(key, value);
    },
  };
}

function microtaskScheduler() {
  return {
    now: () => 0,
    schedule(callback) {
      const handle = { cancelled: false };
      queueMicrotask(() => {
        if (!handle.cancelled) callback();
      });
      return handle;
    },
    cancel(handle) {
      handle.cancelled = true;
    },
  };
}

function heldScheduler() {
  let nextId = 1;
  const scheduled = new Map();
  return {
    now: () => 0,
    schedule(callback) {
      const id = nextId;
      nextId += 1;
      scheduled.set(id, callback);
      return id;
    },
    cancel(handle) {
      scheduled.delete(handle);
    },
    runPending() {
      const callbacks = [...scheduled.values()];
      scheduled.clear();
      callbacks.forEach((callback) => callback());
    },
  };
}

function persistentEtagStore(store, initialEntries) {
  return new PersistentEtagStore(store, initialEntries, { scheduler: microtaskScheduler() });
}

async function flushed() {
  await new Promise((resolve) => setImmediate(resolve));
}

test('set/get round-trip in memory, synchronously — the sync EtagStore contract is preserved', () => {
  const store = persistentEtagStore(fakeKeyValueStore());
  store.set('https://registry.npmjs.org/clean-pkg', { etag: 'W/"1"', body: '{"version":"1.0.0"}' });
  assert.deepEqual(store.get('https://registry.npmjs.org/clean-pkg'), {
    etag: 'W/"1"',
    body: '{"version":"1.0.0"}',
  });
});

test('two different registries never collide, because the full request URL — including host — is the key', () => {
  const store = persistentEtagStore(fakeKeyValueStore());
  const publicUrl = 'https://registry.npmjs.org/clean-pkg/latest';
  const mirrorUrl = 'https://mirror.example.com/clean-pkg/latest';

  store.set(publicUrl, { etag: 'W/"public"', body: '{"version":"1.0.0"}' });
  store.set(mirrorUrl, { etag: 'W/"mirror"', body: '{"version":"2.0.0"}' });

  assert.equal(store.get(publicUrl).etag, 'W/"public"');
  assert.equal(store.get(mirrorUrl).etag, 'W/"mirror"');
});

test('safe version data is reusable across projects — one shared panel-level store serves every controller', () => {
  const sharedStore = persistentEtagStore(fakeKeyValueStore());
  const url = 'https://registry.npmjs.org/clean-pkg/latest';
  sharedStore.set(url, { etag: 'W/"1"', body: '{"version":"1.0.0"}' });

  // Two "projects" (e.g. two DashboardControllers built across a project
  // switch) sharing the same panel-level store see the identical entry.
  const asSeenByProjectA = sharedStore.get(url);
  const asSeenByProjectB = sharedStore.get(url);
  assert.deepEqual(asSeenByProjectA, asSeenByProjectB);
});

test('a credential-bearing URL is kept in memory for this session but never reaches persistence', async () => {
  const kv = fakeKeyValueStore();
  const store = persistentEtagStore(kv);
  const credentialedUrl = 'https://user:pass@registry.example/clean-pkg/latest';

  store.set(credentialedUrl, { etag: 'W/"1"', body: '{}' });
  assert.deepEqual(store.get(credentialedUrl), { etag: 'W/"1"', body: '{}' }, 'still usable this session');

  await flushed();
  const persisted = kv.raw.get(REGISTRY_CACHE_STORAGE_KEY);
  assert.deepEqual(persisted.entries, [], 'the credentialed key never reached disk');
});

test('a credential-bearing entry does not block an unrelated safe entry from being persisted in the same flush', async () => {
  const kv = fakeKeyValueStore();
  const store = persistentEtagStore(kv);

  store.set('https://user:pass@registry.example/pkg', { etag: 'W/"1"', body: '{}' });
  store.set('https://registry.npmjs.org/clean-pkg/latest', { etag: 'W/"2"', body: '{}' });
  await flushed();

  const persisted = kv.raw.get(REGISTRY_CACHE_STORAGE_KEY);
  assert.deepEqual(persisted.entries, [['https://registry.npmjs.org/clean-pkg/latest', { etag: 'W/"2"', body: '{}' }]]);
});

test('a 150-response registry burst produces one bounded persistence update with the complete newest state', async () => {
  const kv = fakeKeyValueStore();
  const scheduler = heldScheduler();
  const store = new PersistentEtagStore(kv, undefined, { scheduler });

  for (let index = 0; index < 150; index += 1) {
    store.set(`https://registry.npmjs.org/pkg-${index}/latest`, {
      etag: `W/"${index}"`,
      body: `{"version":"1.0.${index}"}`,
    });
  }
  assert.equal(kv.updates.length, 0, 'in-memory writes are batched before persistence');
  assert.equal(store.get('https://registry.npmjs.org/pkg-149/latest').etag, 'W/"149"');

  scheduler.runPending();
  await flushed();

  assert.equal(kv.updates.length, 1);
  const persisted = kv.raw.get(REGISTRY_CACHE_STORAGE_KEY);
  assert.equal(persisted.entries.length, 150);
  assert.equal(persisted.entries.at(-1)[0], 'https://registry.npmjs.org/pkg-149/latest');
  assert.ok(serializedEtagCacheBytes(persisted.entries) <= MAX_REGISTRY_CACHE_SERIALIZED_BYTES);
});

test('a corrupt persisted blob degrades to an empty store rather than throwing, so a fresh fetch just proceeds normally', () => {
  const corrupt = fakeKeyValueStore({ schemaVersion: 1, entries: 'not-an-array' });
  assert.doesNotThrow(() => persistentEtagStore(corrupt));
  assert.equal(persistentEtagStore(corrupt).get('anything'), undefined);
});

test('the store is bounded — entries beyond MAX_REGISTRY_CACHE_ENTRIES are evicted deterministically', async () => {
  const kv = fakeKeyValueStore();
  const store = persistentEtagStore(kv);

  for (let i = 0; i < 520; i += 1) {
    store.set(`https://registry.npmjs.org/pkg-${i}`, { etag: `W/"${i}"`, body: '{}' });
  }
  await flushed();

  const persisted = kv.raw.get(REGISTRY_CACHE_STORAGE_KEY);
  assert.ok(persisted.entries.length <= 500, `expected at most 500 entries, got ${persisted.entries.length}`);
  assert.equal(store.get('https://registry.npmjs.org/pkg-0'), undefined);
  assert.notEqual(store.get('https://registry.npmjs.org/pkg-519'), undefined);
});

test('an individually oversized response is omitted from persistence without evicting otherwise valid entries', async () => {
  const kv = fakeKeyValueStore();
  const store = persistentEtagStore(kv);
  const retainedUrl = 'https://registry.npmjs.org/small/latest';
  const oversizedUrl = 'https://registry.npmjs.org/oversized';

  store.set(retainedUrl, { etag: 'W/"small"', body: '{"version":"1.0.0"}' });
  store.set(oversizedUrl, { etag: 'W/"large"', body: 'x'.repeat(MAX_REGISTRY_CACHE_SERIALIZED_BYTES) });
  await flushed();

  assert.equal(store.get(oversizedUrl)?.body.length, MAX_REGISTRY_CACHE_SERIALIZED_BYTES,
    'the current session can still reuse the response');
  const persisted = kv.raw.get(REGISTRY_CACHE_STORAGE_KEY);
  assert.deepEqual(persisted.entries.map(([url]) => url), [retainedUrl]);
  assert.ok(serializedEtagCacheBytes(persisted.entries) <= MAX_REGISTRY_CACHE_SERIALIZED_BYTES);
});

test('cumulative byte pressure evicts oldest writes deterministically', () => {
  const entries = [
    ['https://registry.npmjs.org/oldest', { etag: 'W/"1"', body: 'a'.repeat(80) }],
    ['https://registry.npmjs.org/middle', { etag: 'W/"2"', body: 'b'.repeat(80) }],
    ['https://registry.npmjs.org/newest', { etag: 'W/"3"', body: 'c'.repeat(80) }],
  ];
  const newestTwoBytes = serializedEtagCacheBytes(entries.slice(1));

  const bounded = boundPersistedEtagEntries(entries, newestTwoBytes, 500);

  assert.deepEqual(bounded.map(([url]) => url), entries.slice(1).map(([url]) => url));
  assert.equal(serializedEtagCacheBytes(bounded), newestTwoBytes);
});

test('cumulative pressure does not backfill an older small entry past a newer admissible LRU boundary', () => {
  const olderSmall = ['https://registry.npmjs.org/older-small', { etag: 'W/"1"', body: 'a' }];
  const middleLarge = ['https://registry.npmjs.org/middle-large', { etag: 'W/"2"', body: 'b'.repeat(120) }];
  const newest = ['https://registry.npmjs.org/newest', { etag: 'W/"3"', body: 'c'.repeat(40) }];
  const singleEntryBudget = Math.max(
    serializedEtagCacheBytes([newest]),
    serializedEtagCacheBytes([middleLarge])
  );

  const bounded = boundPersistedEtagEntries(
    [olderSmall, middleLarge, newest],
    singleEntryBudget,
    500
  );

  assert.deepEqual(bounded, [newest], 'LRU evicts the whole older tail once the next recent entry cannot fit');
});

test('rewriting an entry makes it freshest for byte-bound eviction', () => {
  const originalA = ['https://registry.npmjs.org/a', { etag: 'W/"old-a"', body: 'a'.repeat(80) }];
  const entryB = ['https://registry.npmjs.org/b', { etag: 'W/"b"', body: 'b'.repeat(80) }];
  const freshA = ['https://registry.npmjs.org/a', { etag: 'W/"fresh-a"', body: 'A'.repeat(80) }];
  const entryC = ['https://registry.npmjs.org/c', { etag: 'W/"c"', body: 'c'.repeat(80) }];
  const freshestTwoBytes = serializedEtagCacheBytes([freshA, entryC]);

  const bounded = boundPersistedEtagEntries([originalA, entryB, freshA, entryC], freshestTwoBytes, 500);

  assert.deepEqual(bounded, [freshA, entryC]);
});

test('schema-v2 loading remains compatible, applies the byte bound, and heals oversized persistence', async () => {
  const valid = ['https://registry.npmjs.org/valid/latest', { etag: 'W/"valid"', body: '{}' }];
  const oversized = [
    'https://registry.npmjs.org/oversized',
    { etag: 'W/"large"', body: 'x'.repeat(MAX_REGISTRY_CACHE_SERIALIZED_BYTES) },
  ];
  const kv = fakeKeyValueStore({ schemaVersion: 2, entries: [valid, oversized] });

  assert.deepEqual(loadPersistedEtagEntries(kv), [valid]);
  const store = persistentEtagStore(kv);
  assert.deepEqual(store.get(valid[0]), valid[1]);
  assert.equal(store.get(oversized[0]), undefined);
  await flushed();
  assert.deepEqual(kv.raw.get(REGISTRY_CACHE_STORAGE_KEY), { schemaVersion: 2, entries: [valid] });
});

test('credential filtering and the byte bound are applied before every safe persisted snapshot', async () => {
  const kv = fakeKeyValueStore();
  const store = persistentEtagStore(kv);
  store.set('https://user:secret@registry.example/private', { etag: 'W/"secret"', body: 'x'.repeat(100) });
  for (let i = 0; i < 30; i += 1) {
    store.set(`https://registry.npmjs.org/safe-${i}`, { etag: `W/"${i}"`, body: 'x'.repeat(200_000) });
  }
  await flushed();

  const persisted = kv.raw.get(REGISTRY_CACHE_STORAGE_KEY);
  assert.ok(serializedEtagCacheBytes(persisted.entries) <= MAX_REGISTRY_CACHE_SERIALIZED_BYTES);
  assert.ok(persisted.entries.every(([url]) => !url.includes('@')));
  assert.equal(persisted.entries.at(-1)[0], 'https://registry.npmjs.org/safe-29');
});
