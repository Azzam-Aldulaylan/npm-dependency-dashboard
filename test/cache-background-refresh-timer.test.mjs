/**
 * BackgroundRefreshTimer — a fake TimerScheduler stands in for
 * setInterval/clearInterval, so this stays deterministic and never runs a
 * real 30-minute timer during the suite.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BackgroundRefreshTimer } from '../out/core/cache/backgroundRefreshTimer.js';

function fakeScheduler() {
  let nextHandle = 1;
  const active = new Map();
  return {
    active,
    setInterval(callback, ms) {
      const handle = { id: nextHandle++, ms, callback };
      active.set(handle.id, handle);
      return handle;
    },
    clearInterval(handle) {
      active.delete(handle.id);
    },
  };
}

test('start() begins running and isRunning reflects it', () => {
  const scheduler = fakeScheduler();
  const timer = new BackgroundRefreshTimer(scheduler, 1_800_000, () => {});

  assert.equal(timer.isRunning, false);
  timer.start();
  assert.equal(timer.isRunning, true);
  assert.equal(scheduler.active.size, 1);
});

test('calling start() twice does not create a second interval', () => {
  const scheduler = fakeScheduler();
  const timer = new BackgroundRefreshTimer(scheduler, 1_800_000, () => {});

  timer.start();
  timer.start();

  assert.equal(scheduler.active.size, 1);
});

test('stop() clears the interval via the scheduler and isRunning becomes false', () => {
  const scheduler = fakeScheduler();
  const timer = new BackgroundRefreshTimer(scheduler, 1_800_000, () => {});

  timer.start();
  timer.stop();

  assert.equal(timer.isRunning, false);
  assert.equal(scheduler.active.size, 0, 'the scheduler resource was actually released, not just forgotten');
});

test('dispose() also stops a running timer — panel-close disposal path', () => {
  const scheduler = fakeScheduler();
  const timer = new BackgroundRefreshTimer(scheduler, 1_800_000, () => {});

  timer.start();
  timer.dispose();

  assert.equal(timer.isRunning, false);
  assert.equal(scheduler.active.size, 0);
});

test('stop() before start() (never opened, or already closed) is a safe no-op', () => {
  const scheduler = fakeScheduler();
  const timer = new BackgroundRefreshTimer(scheduler, 1_800_000, () => {});

  assert.doesNotThrow(() => timer.stop());
  assert.equal(timer.isRunning, false);
});

test('the injected callback fires on each scheduler tick, not on a schedule of its own', () => {
  const scheduler = fakeScheduler();
  let ticks = 0;
  const timer = new BackgroundRefreshTimer(scheduler, 1_800_000, () => {
    ticks += 1;
  });

  timer.start();
  const [handle] = scheduler.active.values();
  handle.callback();
  handle.callback();

  assert.equal(ticks, 2);
});
