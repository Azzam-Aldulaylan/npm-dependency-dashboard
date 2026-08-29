import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeSourceFingerprint } from '../out/core/cache/sourceFingerprint.js';
import { shouldRunBackgroundUsageRefresh } from '../out/host/usage/backgroundUsageRefreshGate.js';

function fingerprint(manifestText) {
  return computeSourceFingerprint({ manifestText, lockfileText: null, lockfilePath: null });
}

function identity(manifestText, generation = 0) {
  return { fingerprint: fingerprint(manifestText), generation };
}

function analyzed(identityValue, analyzedAt = 0) {
  return { identity: identityValue, analyzedAt };
}

test('shouldRunBackgroundUsageRefresh runs the first time a project fingerprint is seen', () => {
  assert.equal(shouldRunBackgroundUsageRefresh(false, undefined, identity('{}')), true);
});

test('shouldRunBackgroundUsageRefresh does not re-run when the fingerprint is unchanged', () => {
  const current = identity('{"name":"a"}');
  assert.equal(shouldRunBackgroundUsageRefresh(false, analyzed(current), current, 3_599_999), false);
});

test('shouldRunBackgroundUsageRefresh runs again once the fingerprint changes', () => {
  const last = identity('{"name":"a"}');
  const current = identity('{"name":"b"}');
  assert.equal(shouldRunBackgroundUsageRefresh(false, analyzed(last), current, 1), true);
});

test('force runs even when the fingerprint is unchanged — manual Refresh and post-mutation reloads guarantee a fresh check', () => {
  const current = identity('{"name":"a"}');
  assert.equal(shouldRunBackgroundUsageRefresh(true, analyzed(current), current, 1), true);
});

test('force runs on a first-ever fingerprint too, same as a non-forced request', () => {
  assert.equal(shouldRunBackgroundUsageRefresh(true, undefined, identity('{}')), true);
});

test('a source/config generation change re-runs without rebuilding a tree fingerprint', () => {
  const last = identity('{"name":"a"}', 3);
  const current = identity('{"name":"a"}', 4);
  assert.equal(shouldRunBackgroundUsageRefresh(false, analyzed(last), current, 1), true);
});

test('a matching project-wide analysis remains reusable until the one-hour boundary', () => {
  const current = identity('{"name":"a"}');
  const last = analyzed(current, 10_000);
  assert.equal(shouldRunBackgroundUsageRefresh(false, last, current, 10_000 + 60 * 60_000 - 1), false);
  assert.equal(shouldRunBackgroundUsageRefresh(false, last, current, 10_000 + 60 * 60_000), true);
});
