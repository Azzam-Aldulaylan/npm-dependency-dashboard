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
  const failures = [];
  const result = await scanFilesBounded({
    items: [1, 2, 3],
    read: async (item) => {
      if (item === 2) throw new Error('unreadable');
      return String(item);
    },
    consume: (item) => consumed.push(item),
    onReadFailure: (item) => failures.push(item),
    concurrency: 2,
  });

  assert.deepEqual(consumed, [1, 3]);
  assert.deepEqual(failures, [2]);
  assert.deepEqual(result, { processed: 3, cancelled: false });
});

test('usage file scan reports an explicit null read as incomplete evidence', async () => {
  const failures = [];
  const result = await scanFilesBounded({
    items: ['readable', 'oversized'],
    read: async (item) => item === 'oversized' ? null : item,
    consume: () => undefined,
    onReadFailure: (item) => failures.push(item),
  });

  assert.deepEqual(failures, ['oversized']);
  assert.deepEqual(result, { processed: 2, cancelled: false });
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

test('an already-cancelled empty scan is not reported as complete', async () => {
  const result = await scanFilesBounded({
    items: [],
    read: async () => '',
    consume: () => undefined,
    isCancelled: () => true,
  });
  assert.deepEqual(result, { processed: 0, cancelled: true });
});

test('item completion reports the exact deterministic item, including config-only entries', async () => {
  const completed = [];
  await scanFilesBounded({
    items: [
      { path: '.eslintrc', source: false },
      { path: 'src/a.ts', source: true },
      { path: 'vite.config.ts', source: true },
      { path: 'vitest.config.json', source: false },
    ],
    concurrency: 2,
    read: async (item) => item.path,
    consume: () => undefined,
    onItemProcessed: (item, processed, total) => completed.push([item.path, processed, total]),
  });
  assert.deepEqual(completed, [
    ['.eslintrc', 1, 4],
    ['src/a.ts', 2, 4],
    ['vite.config.ts', 3, 4],
    ['vitest.config.json', 4, 4],
  ]);
});
