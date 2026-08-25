import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeSourceFingerprint } from '../out/core/cache/sourceFingerprint.js';
import { shouldRunBackgroundUsageRefresh } from '../out/host/usage/backgroundUsageRefreshGate.js';

function fingerprint(manifestText) {
  return computeSourceFingerprint({ manifestText, lockfileText: null, lockfilePath: null });
}

test('shouldRunBackgroundUsageRefresh runs the first time a project fingerprint is seen', () => {
  assert.equal(shouldRunBackgroundUsageRefresh(false, undefined, fingerprint('{}')), true);
});

test('shouldRunBackgroundUsageRefresh does not re-run when the fingerprint is unchanged', () => {
  const current = fingerprint('{"name":"a"}');
  assert.equal(shouldRunBackgroundUsageRefresh(false, current, current), false);
});

test('shouldRunBackgroundUsageRefresh runs again once the fingerprint changes', () => {
  const last = fingerprint('{"name":"a"}');
  const current = fingerprint('{"name":"b"}');
  assert.equal(shouldRunBackgroundUsageRefresh(false, last, current), true);
});

test('force runs even when the fingerprint is unchanged — manual Refresh and post-mutation reloads guarantee a fresh check', () => {
  const current = fingerprint('{"name":"a"}');
  assert.equal(shouldRunBackgroundUsageRefresh(true, current, current), true);
});

test('force runs on a first-ever fingerprint too, same as a non-forced request', () => {
  assert.equal(shouldRunBackgroundUsageRefresh(true, undefined, fingerprint('{}')), true);
});
