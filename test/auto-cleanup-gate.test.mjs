import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeSourceFingerprint } from '../out/core/cache/sourceFingerprint.js';
import { shouldAutoAnalyzeCleanup } from '../out/host/usage/autoCleanupGate.js';

function fingerprint(manifestText) {
  return computeSourceFingerprint({ manifestText, lockfileText: null, lockfilePath: null });
}

test('shouldAutoAnalyzeCleanup runs the first time a project fingerprint is seen', () => {
  assert.equal(shouldAutoAnalyzeCleanup(undefined, fingerprint('{}'), false, false), true);
});

test('shouldAutoAnalyzeCleanup does not re-run when the fingerprint is unchanged', () => {
  const current = fingerprint('{"name":"a"}');
  assert.equal(shouldAutoAnalyzeCleanup(current, current, false, false), false);
});

test('shouldAutoAnalyzeCleanup runs again once the fingerprint changes', () => {
  const last = fingerprint('{"name":"a"}');
  const current = fingerprint('{"name":"b"}');
  assert.equal(shouldAutoAnalyzeCleanup(last, current, false, false), true);
});

test('shouldAutoAnalyzeCleanup never runs while usage analysis is busy', () => {
  assert.equal(shouldAutoAnalyzeCleanup(undefined, fingerprint('{}'), true, false), false);
});

test('shouldAutoAnalyzeCleanup never runs while the upgrade/remove lock is held', () => {
  assert.equal(shouldAutoAnalyzeCleanup(undefined, fingerprint('{}'), false, true), false);
});

test('force runs even when the fingerprint is unchanged — an explicit manual refresh', () => {
  const current = fingerprint('{"name":"a"}');
  assert.equal(shouldAutoAnalyzeCleanup(current, current, false, false, true), true);
});

test('force never overrides the busy/lock safety gates', () => {
  assert.equal(shouldAutoAnalyzeCleanup(undefined, fingerprint('{}'), true, false, true), false);
  assert.equal(shouldAutoAnalyzeCleanup(undefined, fingerprint('{}'), false, true, true), false);
});
