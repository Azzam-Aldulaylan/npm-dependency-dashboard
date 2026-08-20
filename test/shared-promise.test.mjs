import assert from 'node:assert/strict';
import test from 'node:test';

import { SharedPromise } from '../out/core/async/sharedPromise.js';

test('shared action work runs once for concurrent and sequential consumers', async () => {
  const shared = new SharedPromise();
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const factory = async () => {
    calls += 1;
    await gate;
    return { graph: 'fresh' };
  };

  const first = shared.get(factory);
  const concurrent = shared.get(factory);
  release();
  assert.equal(await first, await concurrent);
  assert.equal(await shared.get(factory), await first);
  assert.equal(calls, 1);
});

test('shared action work does not retry one failed freshness boundary per consumer', async () => {
  const shared = new SharedPromise();
  let calls = 0;
  const factory = async () => {
    calls += 1;
    throw new Error('resolver unavailable');
  };

  await assert.rejects(() => shared.get(factory), /resolver unavailable/);
  await assert.rejects(() => shared.get(factory), /resolver unavailable/);
  assert.equal(calls, 1);
});
