import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runSequentialBatch } from '../out/core/async/sequentialBatch.js';

test('batch work is strictly sequential and one failed item does not fail the batch', async () => {
  const abort = new AbortController();
  const started = [];
  const errors = [];
  let active = 0;
  let maximumActive = 0;
  const result = await runSequentialBatch({
    items: ['a', 'bad', 'c'],
    signal: abort.signal,
    onStart: (item) => started.push(item),
    run: async (item) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await Promise.resolve();
      active -= 1;
      if (item === 'bad') throw new Error('isolated failure');
    },
    onError: (item) => errors.push(item),
  });
  assert.deepEqual(result, { completed: 3, cancelled: false });
  assert.deepEqual(started, ['a', 'bad', 'c']);
  assert.deepEqual(errors, ['bad']);
  assert.equal(maximumActive, 1);
});

test('cancellation stops before another item starts and does not count the interrupted item', async () => {
  const abort = new AbortController();
  const started = [];
  const result = await runSequentialBatch({
    items: ['a', 'b'],
    signal: abort.signal,
    onStart: (item) => started.push(item),
    run: async () => abort.abort(),
    onError: () => assert.fail('cancellation is not an item error'),
  });
  assert.deepEqual(result, { completed: 0, cancelled: true });
  assert.deepEqual(started, ['a']);
});
