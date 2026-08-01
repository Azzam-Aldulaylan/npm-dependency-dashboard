/**
 * WriteBackCache — the sync-read/async-persist mechanism shared by both
 * persisted stores. A fake `persist` records every flush so tests can assert
 * on exactly what would have hit disk, and when.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WriteBackCache } from '../out/core/cache/writeBackCache.js';

function fakePersist() {
  const calls = [];
  return {
    calls,
    persist: async (entries) => {
      calls.push(entries);
    },
  };
}

async function flushed() {
  // Let the chained writeQueue microtasks settle.
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test('eviction is deterministic FIFO-by-most-recent-write once maxEntries is exceeded', () => {
  const { persist } = fakePersist();
  const cache = new WriteBackCache({ maxEntries: 2, persist });

  cache.set('a', 1);
  cache.set('b', 2);
  cache.set('c', 3); // over capacity — 'a' is the oldest untouched entry, evicted

  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.get('b'), 2);
  assert.equal(cache.get('c'), 3);
  assert.equal(cache.size, 2);
});

test('re-setting an existing key refreshes its position, so it is not the one evicted next', () => {
  const { persist } = fakePersist();
  const cache = new WriteBackCache({ maxEntries: 2, persist });

  cache.set('a', 1);
  cache.set('b', 2);
  cache.set('a', 10); // touched again — now the freshest, 'b' is oldest
  cache.set('c', 3);

  assert.equal(cache.get('a'), 10, 'a survives because it was re-written');
  assert.equal(cache.get('b'), undefined, 'b was the oldest untouched entry');
  assert.equal(cache.get('c'), 3);
});

test('a burst of sets while a flush is in flight is coalesced into the next flush, not lost', async () => {
  const { calls, persist } = fakePersist();
  const cache = new WriteBackCache({ maxEntries: 10, persist });

  cache.set('a', 1);
  cache.set('a', 2);
  cache.set('a', 3);
  await flushed();

  const lastCall = calls[calls.length - 1];
  assert.deepEqual(lastCall, [['a', 3]], 'the flush persists the current state, not a stale captured snapshot');
});

test('a persist rejection does not permanently break future flushes — the next set() still reaches persist', async () => {
  const calls = [];
  let rejectNextCall = true;
  const persist = async (entries) => {
    calls.push(entries);
    if (rejectNextCall) {
      rejectNextCall = false;
      throw new Error('transient storage failure');
    }
  };
  const cache = new WriteBackCache({ maxEntries: 10, persist });

  cache.set('a', 1); // this flush rejects
  await flushed();
  assert.equal(calls.length, 1, 'the failing flush still ran');

  cache.set('b', 2); // must still schedule and run a fresh flush, not be silently dropped forever
  await flushed();

  assert.equal(calls.length, 2, 'a later set() still reaches persist after an earlier rejection');
  assert.deepEqual(calls[1], [
    ['a', 1],
    ['b', 2],
  ]);
});

test('a mutation already queued before dispose() still reaches persist, with the final snapshot', async () => {
  const { calls, persist } = fakePersist();
  const cache = new WriteBackCache({ maxEntries: 10, persist });

  cache.set('a', 1);
  cache.dispose();
  await flushed();

  assert.equal(calls.length, 1, 'the flush that was already queued before dispose still ran');
  assert.deepEqual(calls[0], [['a', 1]], 'and it persisted the final snapshot, not nothing');
});

test('dispose() prevents any further scheduled writes from reaching persist', async () => {
  const { calls, persist } = fakePersist();
  const cache = new WriteBackCache({ maxEntries: 10, persist });

  cache.set('a', 1);
  await flushed();
  const callsBeforeDispose = calls.length;

  cache.dispose();
  cache.set('b', 2); // in-memory read/write still works after dispose
  await flushed();

  assert.equal(cache.get('b'), 2, 'the in-memory map itself is unaffected by dispose');
  assert.equal(calls.length, callsBeforeDispose, 'no flush was scheduled for the post-dispose write');
});

test('deleteWhere removes every matching entry in one pass and persists the reduced set', async () => {
  const { calls, persist } = fakePersist();
  const cache = new WriteBackCache({
    maxEntries: 10,
    persist,
    initialEntries: [
      ['a', { owner: 'x' }],
      ['b', { owner: 'y' }],
      ['c', { owner: 'x' }],
    ],
  });

  cache.deleteWhere((value) => value.owner === 'x');
  await flushed();

  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.get('c'), undefined);
  assert.deepEqual(cache.get('b'), { owner: 'y' });
  assert.deepEqual(calls[calls.length - 1], [['b', { owner: 'y' }]]);
});

test('deleteWhere with no matches does not schedule a needless flush', async () => {
  const { calls, persist } = fakePersist();
  const cache = new WriteBackCache({ maxEntries: 10, persist, initialEntries: [['a', { owner: 'x' }]] });

  cache.deleteWhere((value) => value.owner === 'nonexistent');
  await flushed();

  assert.equal(calls.length, 0);
});
