/**
 * Concurrency pool.
 *
 * The batch-survival property is the load-bearing one: a single unpublished or
 * 404ing package must never take down the whole table.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runPool, DEFAULT_CONCURRENCY } from '../out/core/registry/pool.js';
import { FetchError } from '../out/core/registry/http.js';

const tick = () => new Promise((r) => setTimeout(r, 1));

test('the default concurrency is 8', () => {
  assert.equal(DEFAULT_CONCURRENCY, 8);
});

test('never exceeds the limit in flight', async () => {
  const items = Array.from({ length: 50 }, (_, i) => i);
  let inFlight = 0;
  let peak = 0;

  await runPool(
    items,
    async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await tick();
      inFlight -= 1;
    },
    { limit: 8 }
  );

  assert.ok(peak <= 8, `peak in-flight was ${peak}, expected <= 8`);
  assert.equal(inFlight, 0);
});

test('actually reaches the limit — it is not accidentally serial', async () => {
  const items = Array.from({ length: 20 }, (_, i) => i);
  let inFlight = 0;
  let peak = 0;

  await runPool(
    items,
    async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await tick();
      inFlight -= 1;
    },
    { limit: 8 }
  );

  assert.equal(peak, 8, `expected to saturate at 8, peaked at ${peak}`);
});

test('one rejection does not kill the batch', async () => {
  const items = [1, 2, 3, 4, 5];

  const results = await runPool(
    items,
    async (n) => {
      if (n === 3) throw new FetchError('REGISTRY_404', 'not found');
      return n * 10;
    },
    { limit: 2 }
  );

  assert.equal(results.length, 5);
  assert.deepEqual(
    results.filter((r) => r.ok).map((r) => r.value),
    [10, 20, 40, 50]
  );
  const failed = results[2];
  assert.equal(failed.ok, false);
  assert.equal(failed.error.code, 'REGISTRY_404');
});

test('every item still fails independently when they all throw', async () => {
  const results = await runPool([1, 2, 3], async () => {
    throw new Error('boom');
  });
  assert.equal(results.length, 3);
  assert.ok(results.every((r) => !r.ok));
});

test('results are in input order, not completion order', async () => {
  const results = await runPool(
    [30, 5, 20],
    async (delay) => {
      await new Promise((r) => setTimeout(r, delay));
      return delay;
    },
    { limit: 3 }
  );
  assert.deepEqual(
    results.map((r) => r.value),
    [30, 5, 20]
  );
});

test('onSettled fires once per item as results land', async () => {
  const seen = [];
  await runPool(
    [1, 2, 3],
    async (n) => n,
    { limit: 1, onSettled: (item, result) => seen.push([item, result.ok]) }
  );
  assert.deepEqual(seen, [
    [1, true],
    [2, true],
    [3, true],
  ]);
});

test('a non-FetchError rejection is normalized, not leaked', async () => {
  const results = await runPool([1], async () => {
    throw new TypeError('something odd');
  });
  assert.equal(results[0].ok, false);
  assert.ok(results[0].error instanceof FetchError);
  assert.equal(results[0].error.code, 'NETWORK');
  assert.equal(results[0].error.message, 'something odd');
});

test('an already-aborted signal yields CANCELLED results, not a throw', async () => {
  const controller = new AbortController();
  controller.abort();

  const results = await runPool([1, 2], async () => 'unreachable', {
    signal: controller.signal,
  });

  assert.equal(results.length, 2);
  assert.ok(results.every((r) => !r.ok && r.error.code === 'CANCELLED'));
});

test('an empty input resolves to an empty array', async () => {
  assert.deepEqual(await runPool([], async () => 1), []);
});
