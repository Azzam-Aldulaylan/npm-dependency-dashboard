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
  await new Promise((resolve) => setImmediate(resolve));
}

function manualScheduler() {
  let currentTime = 0;
  let nextId = 1;
  const scheduled = new Map();
  return {
    now: () => currentTime,
    schedule(callback, delayMs) {
      const id = nextId;
      nextId += 1;
      scheduled.set(id, { at: currentTime + delayMs, callback });
      return id;
    },
    cancel(handle) {
      scheduled.delete(handle);
    },
    advanceBy(delayMs) {
      const target = currentTime + delayMs;
      while (true) {
        const due = [...scheduled.entries()]
          .filter(([, task]) => task.at <= target)
          .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
        if (due === undefined) break;
        const [id, task] = due;
        scheduled.delete(id);
        currentTime = task.at;
        task.callback();
      }
      currentTime = target;
    },
    get pendingCount() {
      return scheduled.size;
    },
  };
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

test('opt-in batching applies a trailing debounce and persists the newest complete snapshot once', async () => {
  const { calls, persist } = fakePersist();
  const scheduler = manualScheduler();
  const cache = new WriteBackCache({
    maxEntries: 10,
    persist,
    batching: { trailingDelayMs: 50, maxDelayMs: 250, scheduler },
  });

  cache.set('a', 1);
  scheduler.advanceBy(30);
  cache.set('b', 2);
  scheduler.advanceBy(49);
  await flushed();
  assert.equal(calls.length, 0, 'the trailing timer was reset by the second mutation');

  scheduler.advanceBy(1);
  await flushed();
  assert.deepEqual(calls, [[['a', 1], ['b', 2]]]);
});

test('opt-in batching reaches its maximum delay during a continuous mutation stream', async () => {
  const { calls, persist } = fakePersist();
  const scheduler = manualScheduler();
  const cache = new WriteBackCache({
    maxEntries: 10,
    persist,
    batching: { trailingDelayMs: 50, maxDelayMs: 120, scheduler },
  });

  cache.set('a', 0);
  scheduler.advanceBy(40);
  cache.set('a', 1);
  scheduler.advanceBy(40);
  cache.set('a', 2);
  scheduler.advanceBy(39);
  cache.set('a', 3);
  await flushed();
  assert.equal(calls.length, 0);

  scheduler.advanceBy(1);
  await flushed();
  assert.deepEqual(calls, [[['a', 3]]], 'the maximum deadline flushes despite continued writes');
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

test('a rejected batched flush does not prevent the next batch from persisting current state', async () => {
  const calls = [];
  let rejectNextCall = true;
  const scheduler = manualScheduler();
  const cache = new WriteBackCache({
    maxEntries: 10,
    batching: { trailingDelayMs: 50, maxDelayMs: 250, scheduler },
    persist: async (entries) => {
      calls.push(entries);
      if (rejectNextCall) {
        rejectNextCall = false;
        throw new Error('transient storage failure');
      }
    },
  });

  cache.set('a', 1);
  scheduler.advanceBy(50);
  await flushed();
  assert.equal(calls.length, 1);

  cache.set('b', 2);
  scheduler.advanceBy(50);
  await flushed();
  assert.deepEqual(calls[1], [['a', 1], ['b', 2]]);
});

test('a mutation already queued before dispose() still reaches persist, with the final snapshot', async () => {
  const { calls, persist } = fakePersist();
  const cache = new WriteBackCache({ maxEntries: 10, persist });

  cache.set('a', 1);
  cache.dispose();
  cache.set('b', 2);
  await flushed();

  assert.equal(calls.length, 1, 'the flush that was already queued before dispose still ran');
  assert.deepEqual(calls[0], [['a', 1]], 'it captured the final pre-disposal snapshot');
});

test('dispose() cancels a batched timer and immediately queues one final pre-disposal snapshot', async () => {
  const { calls, persist } = fakePersist();
  const scheduler = manualScheduler();
  const cache = new WriteBackCache({
    maxEntries: 10,
    persist,
    batching: { trailingDelayMs: 50, maxDelayMs: 250, scheduler },
  });

  cache.set('a', 1);
  assert.equal(scheduler.pendingCount, 1);
  cache.dispose();
  cache.set('b', 2);
  assert.equal(scheduler.pendingCount, 0, 'dispose cancels the timer and post-disposal writes schedule nothing');
  await flushed();

  assert.deepEqual(calls, [[['a', 1]]]);
  scheduler.advanceBy(1_000);
  await flushed();
  assert.equal(calls.length, 1, 'the cancelled timer cannot cause a duplicate write');
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
