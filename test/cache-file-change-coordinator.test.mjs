/**
 * FileChangeCoordinator — the pure decision layer behind a watcher-triggered
 * invalidation: coalescing, upgrade-busy deferral, and serialized
 * generation-checked reloads. No vscode dependency — the actual watcher
 * subscription and disk re-read stay in dashboardPanel.ts/fileChangeReload.ts.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FileChangeCoordinator } from '../out/core/cache/fileChangeCoordinator.js';

function recordingReload(behavior) {
  const calls = [];
  let active = 0;
  let maxConcurrent = 0;
  const reload = async (kinds, generation) => {
    active += 1;
    maxConcurrent = Math.max(maxConcurrent, active);
    calls.push({ kinds: [...kinds], generation });
    if (behavior) await behavior(kinds, generation);
    active -= 1;
  };
  return { reload, calls, get maxConcurrent() { return maxConcurrent; } };
}

test('two notify() calls before flush() coalesce into one reload with the union of kinds', async () => {
  const { reload, calls } = recordingReload();
  const coordinator = new FileChangeCoordinator({ isBusy: () => false, currentGeneration: () => 0, reload });

  coordinator.notify('manifest');
  coordinator.notify('lockfile');
  coordinator.notify('manifest'); // duplicate, still one reload
  await coordinator.flush();

  assert.equal(calls.length, 1, 'exactly one reload for the whole burst');
  assert.deepEqual(calls[0].kinds.sort(), ['lockfile', 'manifest']);
});

test('flush() with nothing pending is a no-op', async () => {
  const { reload, calls } = recordingReload();
  const coordinator = new FileChangeCoordinator({ isBusy: () => false, currentGeneration: () => 0, reload });

  await coordinator.flush();

  assert.equal(calls.length, 0);
});

test('a burst that arrives while isBusy() is true is deferred, not dropped — flushDeferred() processes it once released', async () => {
  const { reload, calls } = recordingReload();
  let busy = true;
  const coordinator = new FileChangeCoordinator({ isBusy: () => busy, currentGeneration: () => 0, reload });

  coordinator.notify('lockfile');
  await coordinator.flush();
  assert.equal(calls.length, 0, 'nothing reloaded yet — the upgrade owns these files right now');
  assert.equal(coordinator.hasDeferred, true);

  busy = false;
  await coordinator.flushDeferred();

  assert.equal(calls.length, 1, 'the deferred burst was processed once the lock released');
  assert.deepEqual(calls[0].kinds, ['lockfile']);
  assert.equal(coordinator.hasDeferred, false);
});

test('flushDeferred() with nothing deferred is a no-op', async () => {
  const { reload, calls } = recordingReload();
  const coordinator = new FileChangeCoordinator({ isBusy: () => false, currentGeneration: () => 0, reload });

  await coordinator.flushDeferred();

  assert.equal(calls.length, 0);
});

test('a burst deferred during busy, then released and re-acquired before flushDeferred() runs, defers again rather than racing it', async () => {
  const { reload, calls } = recordingReload();
  let busy = true;
  const coordinator = new FileChangeCoordinator({ isBusy: () => busy, currentGeneration: () => 0, reload });

  coordinator.notify('manifest');
  await coordinator.flush();
  assert.equal(coordinator.hasDeferred, true);

  // Still busy (a second operation grabbed the lock immediately) when flushDeferred is called.
  await coordinator.flushDeferred();
  assert.equal(calls.length, 0, 'still deferred — never reloaded while busy');
  assert.equal(coordinator.hasDeferred, true);

  busy = false;
  await coordinator.flushDeferred();
  assert.equal(calls.length, 1);
});

test('a reload whose generation has gone stale by the time its turn comes up is skipped outright', async () => {
  const { reload, calls } = recordingReload();
  let generation = 0;
  const coordinator = new FileChangeCoordinator({ isBusy: () => false, currentGeneration: () => generation, reload });

  coordinator.notify('manifest'); // captured at generation 0
  generation = 1; // a project switch happened before flush() ran
  await coordinator.flush();

  assert.equal(calls.length, 0, 'the burst belonged to a selection that no longer exists');
});

test('discardPending() drops both a not-yet-flushed burst and anything already deferred, without ever reloading either', async () => {
  const { reload, calls } = recordingReload();
  let busy = true;
  const coordinator = new FileChangeCoordinator({ isBusy: () => busy, currentGeneration: () => 0, reload });

  coordinator.notify('lockfile');
  await coordinator.flush(); // deferred, since busy
  assert.equal(coordinator.hasDeferred, true);

  coordinator.notify('manifest'); // a second, not-yet-flushed burst
  assert.equal(coordinator.hasPending, true);

  coordinator.discardPending();
  busy = false;
  await coordinator.flush();
  await coordinator.flushDeferred();

  assert.equal(calls.length, 0, 'an authoritative full reload superseded everything queued for the old state');
  assert.equal(coordinator.hasPending, false);
  assert.equal(coordinator.hasDeferred, false);
});

test('concurrent flush() calls never let their reload() invocations run at the same time', async () => {
  // Not destructured — `maxConcurrent` is a getter, and destructuring it
  // would read its value once at time zero (always 0) instead of live.
  const recorder = recordingReload(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  const coordinator = new FileChangeCoordinator({ isBusy: () => false, currentGeneration: () => 0, reload: recorder.reload });

  coordinator.notify('manifest');
  const first = coordinator.flush();
  await new Promise((resolve) => setTimeout(resolve, 5));
  coordinator.notify('lockfile');
  const second = coordinator.flush();

  await Promise.all([first, second]);

  assert.equal(recorder.calls.length, 2, 'both bursts eventually reloaded');
  assert.equal(recorder.maxConcurrent, 1, 'never more than one reload() call in flight at once');
});

test('a notify() that arrives while reload() is running is drained automatically once it settles — no second flush() call required', async () => {
  let releaseFirstReload;
  const firstReloadHeldOpen = new Promise((resolve) => {
    releaseFirstReload = resolve;
  });
  const recorder = recordingReload(async (kinds) => {
    if (kinds.has('manifest')) await firstReloadHeldOpen;
  });
  const coordinator = new FileChangeCoordinator({ isBusy: () => false, currentGeneration: () => 0, reload: recorder.reload });

  coordinator.notify('manifest');
  const first = coordinator.flush(); // starts running, held open by firstReloadHeldOpen

  // A second, independent file event arrives while the first reload is still in flight.
  coordinator.notify('lockfile');
  assert.equal(coordinator.hasPending, true, 'the second burst is recorded as pending');

  releaseFirstReload();
  await first; // flush() itself only resolves once the whole drain (both reloads) settles

  assert.equal(recorder.calls.length, 2, 'the second reload ran without any second explicit flush() call');
  assert.deepEqual(recorder.calls[1].kinds, ['lockfile']);
  assert.equal(coordinator.hasPending, false, 'nothing left stranded after the drain');
});

test('watcher recreation (which clears the host debounce timer) cannot cancel the only scheduled processing for pending coordinator state', async () => {
  // Simulates dashboardPanel.ts's actual failure mode: `reload()` itself
  // recreates the watcher, which cancels the host's own debounce timer —
  // the thing that would otherwise have been the *only* mechanism left to
  // eventually call flush() for a burst that arrived mid-reload. The
  // coordinator must never depend on that timer surviving.
  let hostTimerCancelled = false;
  let releaseFirstReload;
  const firstReloadHeldOpen = new Promise((resolve) => {
    releaseFirstReload = resolve;
  });
  const recorder = recordingReload(async (kinds) => {
    if (kinds.has('manifest')) {
      await firstReloadHeldOpen;
      // The reload's own side effect: recreate the watcher, cancelling
      // whatever debounce timer the host had scheduled for a later burst.
      hostTimerCancelled = true;
    }
  });
  const coordinator = new FileChangeCoordinator({ isBusy: () => false, currentGeneration: () => 0, reload: recorder.reload });

  coordinator.notify('manifest');
  const first = coordinator.flush();

  coordinator.notify('lockfile'); // the host would normally schedule a debounce timer for this — never fired below
  releaseFirstReload();
  await first;

  assert.equal(hostTimerCancelled, true, 'sanity check: the simulated watcher-recreation side effect did run');
  assert.equal(recorder.calls.length, 2, 'the second burst still ran, even though nothing external ever called flush() for it again');
});

test('a reload() that throws does not break the chain — a later flush still runs its own reload', async () => {
  let callCount = 0;
  const reload = async () => {
    callCount += 1;
    if (callCount === 1) throw new Error('disk read failed');
  };
  const coordinator = new FileChangeCoordinator({ isBusy: () => false, currentGeneration: () => 0, reload });

  coordinator.notify('manifest');
  await assert.doesNotReject(coordinator.flush(), 'flush() itself never rejects even if reload() throws');

  coordinator.notify('lockfile');
  await coordinator.flush();

  assert.equal(callCount, 2, 'the second reload still ran despite the first one throwing');
});

test('dispose() clears pending and deferred state and stops accepting further notifications', async () => {
  const { reload, calls } = recordingReload();
  let busy = true;
  const coordinator = new FileChangeCoordinator({ isBusy: () => busy, currentGeneration: () => 0, reload });

  coordinator.notify('lockfile');
  await coordinator.flush(); // deferred
  coordinator.dispose();
  busy = false;

  coordinator.notify('manifest'); // must be ignored — disposed
  await coordinator.flush();
  await coordinator.flushDeferred();

  assert.equal(calls.length, 0);
  assert.equal(coordinator.hasPending, false);
  assert.equal(coordinator.hasDeferred, false);
});
