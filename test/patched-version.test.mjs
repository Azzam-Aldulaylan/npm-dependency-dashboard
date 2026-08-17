/**
 * resolveFirstPatchedVersion — the provable "first patched version" for an
 * advisory. See src/core/version/resolve.ts's own header for the three-state
 * result and why `none` and `unknown` are never collapsed together.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveFirstPatchedVersion } from '../out/core/version/resolve.js';

test('a simple vulnerable range with a known patched version returns the lowest fixed version', () => {
  const result = resolveFirstPatchedVersion(['3.0.0', '3.4.0', '3.4.2', '3.5.0', '4.0.0'], '<3.4.2', null);
  assert.deepEqual(result, { status: 'known', version: '3.4.2' });
});

test('multiple vulnerable ranges (a re-introduced vulnerability) still finds the first version outside the range', () => {
  const result = resolveFirstPatchedVersion(['1.0.0', '1.1.0', '1.2.0', '1.3.0'], '>=1.0.0 <1.1.0 || >=1.2.0 <1.3.0', null);
  assert.deepEqual(result, { status: 'known', version: '1.1.0' });
});

test('latest version still vulnerable, and no other version published, is unknown, not none', () => {
  // Only one version exists at all and it's inside the vulnerable range —
  // still distinct from "we checked every version and all are vulnerable"
  // because there's no meaningful "checked the history" to report.
  const result = resolveFirstPatchedVersion(['1.0.0'], '<=1.0.0', null);
  assert.deepEqual(result, { status: 'none' });
});

test('no known non-vulnerable published version among several returns none, not unknown', () => {
  const result = resolveFirstPatchedVersion(['1.0.0', '1.0.1', '1.0.2'], '<=1.0.2', null);
  assert.deepEqual(result, { status: 'none' });
});

test('prereleases are excluded from a stable-line patched version by default', () => {
  const result = resolveFirstPatchedVersion(['2.0.0-beta.1', '2.0.0'], '<2.0.0-beta.1', null);
  assert.deepEqual(result, { status: 'known', version: '2.0.0' });
});

test('a prerelease-line install includes prereleases as candidates', () => {
  const result = resolveFirstPatchedVersion(['2.0.0-beta.1', '2.0.0-beta.2'], '<2.0.0-beta.2', '2.0.0-beta.1');
  assert.deepEqual(result, { status: 'known', version: '2.0.0-beta.2' });
});

test('a malformed advisory range is unknown, never guessed', () => {
  const result = resolveFirstPatchedVersion(['1.0.0', '2.0.0'], 'not-a-real-range', null);
  assert.deepEqual(result, { status: 'unknown' });
});

test('an empty version list is unknown', () => {
  const result = resolveFirstPatchedVersion([], '<1.0.0', null);
  assert.deepEqual(result, { status: 'unknown' });
});

test('a version list with only invalid semver strings is unknown', () => {
  const result = resolveFirstPatchedVersion(['not-a-version', 'also-not-one'], '<1.0.0', null);
  assert.deepEqual(result, { status: 'unknown' });
});

test('the returned version is the lowest fix, not the highest — distinct from resolveUpgradeTarget in aggregate.ts', () => {
  const result = resolveFirstPatchedVersion(['1.0.0', '1.5.0', '2.0.0', '3.0.0'], '<1.5.0', null);
  assert.deepEqual(result, { status: 'known', version: '1.5.0' });
});
