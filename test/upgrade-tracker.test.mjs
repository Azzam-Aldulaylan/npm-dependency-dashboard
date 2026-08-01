/**
 * Panel-wide upgrade locking, pending-run settlement on disposal, and
 * task-outcome interpretation — isolated from the vscode.Task machinery in
 * upgradeRunner.ts so they're directly testable.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { UpgradeLock, PendingUpgradeRuns, isSuccessfulExitCode } from '../out/host/upgradeTracker.js';

// -------------------------------------------------------------- UpgradeLock

test('a second acquire while the lock is held is refused, for the same package', () => {
  const lock = new UpgradeLock();
  assert.equal(lock.tryAcquire('left-pad'), true, 'first click acquires it');
  assert.equal(lock.tryAcquire('left-pad'), false, 'a duplicate click while running is refused');
  assert.equal(lock.isHeld(), true);
});

test('one upgrade per panel: a different package cannot acquire while the lock is held', () => {
  const lock = new UpgradeLock();
  assert.equal(lock.tryAcquire('left-pad'), true);
  // Not per-package: a second, *different* package must also be refused —
  // two npm installs must never race to write the same package.json/lockfile.
  assert.equal(lock.tryAcquire('right-pad'), false);
  assert.equal(lock.isHeld(), true);
});

test('releasing the actual holder frees the lock for a later acquire', () => {
  const lock = new UpgradeLock();
  lock.tryAcquire('left-pad');
  lock.release('left-pad');
  assert.equal(lock.isHeld(), false);
  assert.equal(lock.tryAcquire('right-pad'), true, 'a fresh click after release is allowed, any package');
});

test('releasing a name that is not the current holder is a no-op', () => {
  const lock = new UpgradeLock();
  lock.tryAcquire('left-pad');
  lock.release('right-pad'); // not the holder — must not clear left-pad's hold
  assert.equal(lock.isHeld(), true);
  assert.equal(lock.tryAcquire('right-pad'), false, 'left-pad still holds the lock');
});

test('clear releases the lock unconditionally, e.g. on panel disposal', () => {
  const lock = new UpgradeLock();
  lock.tryAcquire('left-pad');
  lock.clear();
  assert.equal(lock.isHeld(), false);
  assert.equal(lock.tryAcquire('right-pad'), true);
});

test('a duplicate request is refused while the original remains the holder, not overwritten', () => {
  const lock = new UpgradeLock();
  assert.equal(lock.tryAcquire('left-pad'), true, 'the original request acquires the lock');

  // A rapid duplicate click — same package or a different one — is refused.
  // This is exactly what DashboardPanel.handleUpgrade turns into an
  // UPGRADE_IN_PROGRESS response for the *duplicate* request.
  assert.equal(lock.tryAcquire('left-pad'), false, 'a duplicate for the same package is refused');
  assert.equal(lock.tryAcquire('right-pad'), false, 'a duplicate for a different package is refused too');

  // The original request is still the one holding the lock, proven by: the
  // duplicate's own name can't release it (no-op), but the original's can.
  lock.release('right-pad');
  assert.equal(lock.isHeld(), true, 'the failed duplicate must not have disturbed the original hold');
  lock.release('left-pad');
  assert.equal(lock.isHeld(), false, 'only the true original holder can release it');
});

test('refresh cannot start while an upgrade holds the lock, and can once it releases', () => {
  const lock = new UpgradeLock();
  // Mirrors DashboardPanel.handle's refresh guard: `if (upgradeSession.isBusy()) return;`
  const refreshWouldRun = () => !lock.isHeld();

  assert.equal(refreshWouldRun(), true, 'no upgrade is active yet, so refresh is allowed');

  lock.tryAcquire('left-pad');
  assert.equal(refreshWouldRun(), false, 'an upgrade is active — refresh must not start');

  lock.release('left-pad');
  assert.equal(refreshWouldRun(), true, 'refresh is allowed again once the upgrade releases the lock');
});

test('S6: a project change cannot start while an upgrade holds the lock, and can once it releases', () => {
  const lock = new UpgradeLock();
  // Mirrors DashboardPanel.handle's change-project guard, the identical
  // check as refresh — one upgrade lock gates both actions.
  const changeProjectWouldRun = () => !lock.isHeld();

  assert.equal(changeProjectWouldRun(), true, 'no upgrade is active yet, so a project change is allowed');

  lock.tryAcquire('left-pad');
  assert.equal(changeProjectWouldRun(), false, 'an upgrade is active — the project change must not start');

  lock.release('left-pad');
  assert.equal(changeProjectWouldRun(), true, 'a project change is allowed again once the upgrade releases the lock');
});

// ----------------------------------------------------------- PendingUpgradeRuns

test('settleAll calls every still-registered callback exactly once', () => {
  const pending = new PendingUpgradeRuns();
  let calls = 0;
  pending.track(() => {
    calls += 1;
  });
  pending.track(() => {
    calls += 1;
  });
  assert.equal(pending.pendingCount, 2);

  pending.settleAll();

  assert.equal(calls, 2);
  assert.equal(pending.pendingCount, 0);
});

test('settleAll a second time calls nothing — a settled run does not hang, and does not double-fire', () => {
  const pending = new PendingUpgradeRuns();
  let calls = 0;
  pending.track(() => {
    calls += 1;
  });
  pending.settleAll();
  pending.settleAll();
  assert.equal(calls, 1);
});

test('a run that finishes on its own unregisters via the returned function, so disposal never re-invokes it', () => {
  const pending = new PendingUpgradeRuns();
  let disposedCallbackFired = false;
  const untrack = pending.track(() => {
    disposedCallbackFired = true;
  });

  // The run finished normally (e.g. the task's onDidEndTaskProcess fired)
  // before any disposal happened.
  untrack();
  assert.equal(pending.pendingCount, 0);

  pending.settleAll();
  assert.equal(disposedCallbackFired, false, 'a completed run must not also receive a DISPOSED settle');
});

test('mixed: an unfinished run is settled by dispose, a finished one is left alone', () => {
  const pending = new PendingUpgradeRuns();
  let finishedRunFiredOnDispose = false;
  let unfinishedRunFiredOnDispose = false;

  const untrackFinished = pending.track(() => {
    finishedRunFiredOnDispose = true;
  });
  pending.track(() => {
    unfinishedRunFiredOnDispose = true;
  });

  untrackFinished(); // this one completed on its own first

  pending.settleAll();

  assert.equal(finishedRunFiredOnDispose, false);
  assert.equal(unfinishedRunFiredOnDispose, true);
});

// ----------------------------------------------------------------- exit code

test('only a literal exit code of 0 is success', () => {
  assert.equal(isSuccessfulExitCode(0), true);
});

test('a nonzero exit code is not success', () => {
  assert.equal(isSuccessfulExitCode(1), false);
  assert.equal(isSuccessfulExitCode(127), false);
  assert.equal(isSuccessfulExitCode(-1), false);
});

test('an undefined exit code is not success', () => {
  assert.equal(isSuccessfulExitCode(undefined), false);
});
