import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_USAGE_FILE_CONCURRENCY,
  scanFilesBounded,
} from '../out/core/usage/boundedFileScan.js';

test('usage file reads are bounded and consumed in deterministic input order', async () => {
  const items = Array.from({ length: 25 }, (_, index) => index);
  let inFlight = 0;
  let peak = 0;
  const consumed = [];

  const result = await scanFilesBounded({
    items,
    read: async (item) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, (DEFAULT_USAGE_FILE_CONCURRENCY - (item % DEFAULT_USAGE_FILE_CONCURRENCY))));
      inFlight -= 1;
      return String(item);
    },
    consume: (_item, text) => consumed.push(Number(text)),
  });

  assert.equal(peak, DEFAULT_USAGE_FILE_CONCURRENCY);
  assert.deepEqual(consumed, items, 'completion order never changes reference ordering');
  assert.deepEqual(result, { processed: items.length, cancelled: false });
});

test('usage file scan isolates an unreadable file and continues the batch', async () => {
  const consumed = [];
  const result = await scanFilesBounded({
    items: [1, 2, 3],
    read: async (item) => {
      if (item === 2) throw new Error('unreadable');
      return String(item);
    },
    consume: (item) => consumed.push(item),
    concurrency: 2,
  });

  assert.deepEqual(consumed, [1, 3]);
  assert.deepEqual(result, { processed: 3, cancelled: false });
});

test('usage cancellation stops queued batches', async () => {
  let cancelled = false;
  const started = [];
  const result = await scanFilesBounded({
    items: [1, 2, 3, 4, 5],
    concurrency: 2,
    isCancelled: () => cancelled,
    read: async (item) => {
      started.push(item);
      if (item === 1) cancelled = true;
      return String(item);
    },
    consume: () => assert.fail('a cancelled batch must not publish partial references'),
  });

  assert.deepEqual(started, [1, 2]);
  assert.deepEqual(result, { processed: 0, cancelled: true });
});
