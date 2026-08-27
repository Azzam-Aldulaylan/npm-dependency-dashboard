import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BranchChangeCoordinator } from '../out/host/branchChangeCoordinator.js';

function schedulerFixture() {
  const scheduled = new Map();
  let id = 0;
  return {
    scheduler: {
      setTimeout(callback) {
        const handle = ++id;
        scheduled.set(handle, callback);
        return handle;
      },
      clearTimeout(handle) {
        scheduled.delete(handle);
      },
    },
    async runAll() {
      while (scheduled.size > 0) {
        const callbacks = [...scheduled.values()];
        scheduled.clear();
        for (const callback of callbacks) callback();
        await Promise.resolve();
        await Promise.resolve();
      }
    },
  };
}

test('a HEAD plus filesystem burst is owned by one debounced reconciliation', async () => {
  const fixture = schedulerFixture();
  const calls = [];
  let coordinator;
  coordinator = new BranchChangeCoordinator(fixture.scheduler, {
    isMutationBusy: () => false,
    async reconcile(generation) {
      calls.push(generation);
      coordinator.claim(generation);
    },
  }, 300);
  coordinator.notify();
  coordinator.notify();
  assert.equal(coordinator.hasPending, true, 'filesystem handling is superseded during debounce');
  await fixture.runAll();
  assert.deepEqual(calls, [2]);
  assert.equal(coordinator.hasPending, false);
});

test('HEAD reconciliation waits for a real mutation and runs once on release', async () => {
  const fixture = schedulerFixture();
  let mutating = true;
  let calls = 0;
  let coordinator;
  coordinator = new BranchChangeCoordinator(fixture.scheduler, {
    isMutationBusy: () => mutating,
    async reconcile(generation) {
      calls += 1;
      coordinator.claim(generation);
    },
  }, 300);
  coordinator.notify();
  await fixture.runAll();
  assert.equal(calls, 0);
  mutating = false;
  coordinator.mutationReleased();
  await fixture.runAll();
  assert.equal(calls, 1);
});

test('a newer HEAD during reconciliation supersedes the old result and schedules one successor', async () => {
  const fixture = schedulerFixture();
  const calls = [];
  let coordinator;
  coordinator = new BranchChangeCoordinator(fixture.scheduler, {
    isMutationBusy: () => false,
    async reconcile(generation) {
      calls.push(generation);
      if (generation === 1) coordinator.notify();
      coordinator.claim(generation);
    },
  }, 300);
  coordinator.notify();
  await fixture.runAll();
  assert.deepEqual(calls, [1, 2]);
  assert.equal(coordinator.hasPending, false);
});

test('selection side effects require a successful generation claim and stale picker results cannot apply', () => {
  const fixture = schedulerFixture();
  const coordinator = new BranchChangeCoordinator(fixture.scheduler, {
    isMutationBusy: () => false,
    async reconcile() {},
  }, 300);
  const first = coordinator.notify();
  assert.equal(coordinator.claim(first), true, 'current discovery may mutate state and open its picker');
  coordinator.notify();
  assert.equal(coordinator.isCurrent(first), false, 'a newer HEAD invalidates the open picker lease');
  assert.equal(coordinator.claim(first), false, 'the stale generation cannot claim state afterward');
});

test('a mutation beginning after claim restores pending reconciliation for release', () => {
  const fixture = schedulerFixture();
  const coordinator = new BranchChangeCoordinator(fixture.scheduler, {
    isMutationBusy: () => true,
    async reconcile() {},
  }, 300);
  const generation = coordinator.notify();
  assert.equal(coordinator.claim(generation), true);
  assert.equal(coordinator.deferClaimed(generation), true);
  assert.equal(coordinator.hasPending, true);
});
