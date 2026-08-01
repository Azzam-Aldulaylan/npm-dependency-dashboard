/**
 * PersistentEtagStore — the globalState-backed registry/version cache. Same
 * fake-KeyValueStore approach as cache-project-store.test.mjs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PersistentEtagStore, REGISTRY_CACHE_STORAGE_KEY } from '../out/core/cache/persistentEtagStore.js';

function fakeKeyValueStore(initial) {
  const data = new Map(initial ? [[REGISTRY_CACHE_STORAGE_KEY, initial]] : []);
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

test('set/get round-trip in memory, synchronously — the sync EtagStore contract is preserved', () => {
  const store = new PersistentEtagStore(fakeKeyValueStore());
  store.set('https://registry.npmjs.org/clean-pkg', { etag: 'W/"1"', body: '{"version":"1.0.0"}' });
  assert.deepEqual(store.get('https://registry.npmjs.org/clean-pkg'), {
    etag: 'W/"1"',
    body: '{"version":"1.0.0"}',
  });
});

test('two different registries never collide, because the full request URL — including host — is the key', () => {
  const store = new PersistentEtagStore(fakeKeyValueStore());
  const publicUrl = 'https://registry.npmjs.org/clean-pkg/latest';
  const mirrorUrl = 'https://mirror.example.com/clean-pkg/latest';

  store.set(publicUrl, { etag: 'W/"public"', body: '{"version":"1.0.0"}' });
  store.set(mirrorUrl, { etag: 'W/"mirror"', body: '{"version":"2.0.0"}' });

  assert.equal(store.get(publicUrl).etag, 'W/"public"');
  assert.equal(store.get(mirrorUrl).etag, 'W/"mirror"');
});

test('safe version data is reusable across projects — one shared panel-level store serves every controller', () => {
  const sharedStore = new PersistentEtagStore(fakeKeyValueStore());
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
  const store = new PersistentEtagStore(kv);
  const credentialedUrl = 'https://user:pass@registry.example/clean-pkg/latest';

  store.set(credentialedUrl, { etag: 'W/"1"', body: '{}' });
  assert.deepEqual(store.get(credentialedUrl), { etag: 'W/"1"', body: '{}' }, 'still usable this session');

  await flushed();
  const persisted = kv.raw.get(REGISTRY_CACHE_STORAGE_KEY);
  assert.deepEqual(persisted.entries, [], 'the credentialed key never reached disk');
});

test('a credential-bearing entry does not block an unrelated safe entry from being persisted in the same flush', async () => {
  const kv = fakeKeyValueStore();
  const store = new PersistentEtagStore(kv);

  store.set('https://user:pass@registry.example/pkg', { etag: 'W/"1"', body: '{}' });
  store.set('https://registry.npmjs.org/clean-pkg/latest', { etag: 'W/"2"', body: '{}' });
  await flushed();

  const persisted = kv.raw.get(REGISTRY_CACHE_STORAGE_KEY);
  assert.deepEqual(persisted.entries, [['https://registry.npmjs.org/clean-pkg/latest', { etag: 'W/"2"', body: '{}' }]]);
});

test('a corrupt persisted blob degrades to an empty store rather than throwing, so a fresh fetch just proceeds normally', () => {
  const corrupt = fakeKeyValueStore({ schemaVersion: 1, entries: 'not-an-array' });
  assert.doesNotThrow(() => new PersistentEtagStore(corrupt));
  assert.equal(new PersistentEtagStore(corrupt).get('anything'), undefined);
});

test('the store is bounded — entries beyond MAX_REGISTRY_CACHE_ENTRIES are evicted deterministically', async () => {
  const kv = fakeKeyValueStore();
  const store = new PersistentEtagStore(kv);

  for (let i = 0; i < 520; i += 1) {
    store.set(`https://registry.npmjs.org/pkg-${i}`, { etag: `W/"${i}"`, body: '{}' });
  }
  await flushed();

  const persisted = kv.raw.get(REGISTRY_CACHE_STORAGE_KEY);
  assert.ok(persisted.entries.length <= 500, `expected at most 500 entries, got ${persisted.entries.length}`);
  assert.equal(store.get('https://registry.npmjs.org/pkg-0'), undefined);
  assert.notEqual(store.get('https://registry.npmjs.org/pkg-519'), undefined);
});
