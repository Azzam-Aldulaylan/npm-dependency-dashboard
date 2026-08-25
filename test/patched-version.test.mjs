/**
 * resolveFirstPatchedVersion — the provable "first patched version" for an
 * advisory. See src/core/version/resolve.ts's own header for the three-state
 * result and why `none` and `unknown` are never collapsed together.
 *
 * The floor is always the actual resolved vulnerable version
 * (`resolvedVersion`, third argument) — never an unbounded "earliest
 * historical version outside the range" search. That earlier approach could
 * surface a version *older* than what's installed (the "Patched in 0.0.0"
 * trap this file's tests guard against).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveFirstPatchedVersion } from '../out/core/version/resolve.js';

test('the exact regression case: historical unaffected versions below the resolved version are never returned', () => {
  const result = resolveFirstPatchedVersion(
    ['0.0.0', '1.0.0', '4.0.0', '4.0.5', '4.0.6'],
    '>=4.0.0 <4.0.6',
    '4.0.5'
  );
  assert.deepEqual(result, { status: 'known', version: '4.0.6' });
});

test('historical safe versions below the resolved version are ignored', () => {
  const result = resolveFirstPatchedVersion(['0.0.0', '1.0.0', '3.0.0', '3.4.2', '3.5.0'], '<3.4.2', '3.4.0');
  assert.deepEqual(result, { status: 'known', version: '3.4.2' });
});

test('a version equal to the resolved vulnerable version is never returned as the fix', () => {
  const result = resolveFirstPatchedVersion(['3.4.2', '3.5.0'], '<3.4.2', '3.4.2');
  // 3.4.2 itself does not satisfy "<3.4.2" and so would be "unaffected", but
  // it equals the resolved version, not strictly ahead of it.
  assert.deepEqual(result, { status: 'known', version: '3.5.0' });
});

test('the first later safe version is selected, not the highest', () => {
  const result = resolveFirstPatchedVersion(['1.0.0', '1.5.0', '2.0.0', '3.0.0'], '<1.5.0', '1.0.0');
  assert.deepEqual(result, { status: 'known', version: '1.5.0' });
});

test('a transitive flagged version (deeper than the direct dependency) is used as the floor', () => {
  // form-data@4.0.5, introduced through axios — axios's own version never
  // enters this calculation.
  const result = resolveFirstPatchedVersion(['4.0.0', '4.0.5', '4.0.6'], '>=4.0.0 <4.0.6', '4.0.5');
  assert.deepEqual(result, { status: 'known', version: '4.0.6' });
});

test('a direct flagged version is used as the floor', () => {
  const result = resolveFirstPatchedVersion(['1.0.0', '1.2.0', '1.3.0'], '<1.2.0', '1.0.0');
  assert.deepEqual(result, { status: 'known', version: '1.2.0' });
});

test('disjoint advisory ranges: a resolved version in the first branch fixes at that branch\'s ceiling', () => {
  const versions = ['6.13.0', '6.14.0', '7.0.0-alpha.0', '8.17.0', '8.18.0'];
  const range = '>=6.0.0 <6.14.0 || >=7.0.0-alpha.0 <8.18.0';
  const result = resolveFirstPatchedVersion(versions, range, '6.13.0');
  assert.deepEqual(result, { status: 'known', version: '6.14.0' });
});

test('disjoint advisory ranges: a resolved version in the second branch is never fixed by an older safe branch', () => {
  const versions = ['6.13.0', '6.14.0', '7.0.0-alpha.0', '8.17.0', '8.18.0'];
  const range = '>=6.0.0 <6.14.0 || >=7.0.0-alpha.0 <8.18.0';
  const result = resolveFirstPatchedVersion(versions, range, '8.17.0');
  assert.deepEqual(result, { status: 'known', version: '8.18.0' });
});

test('multiple vulnerable ranges (a re-introduced vulnerability) still finds the first version outside the range ahead of resolved', () => {
  const result = resolveFirstPatchedVersion(
    ['1.0.0', '1.1.0', '1.2.0', '1.3.0'],
    '>=1.0.0 <1.1.0 || >=1.2.0 <1.3.0',
    '1.0.0'
  );
  assert.deepEqual(result, { status: 'known', version: '1.1.0' });
});

test('latest version still vulnerable, and no other version published ahead of resolved, is none', () => {
  const result = resolveFirstPatchedVersion(['1.0.0'], '<=1.0.0', '1.0.0');
  assert.deepEqual(result, { status: 'none' });
});

test('no known non-vulnerable published version ahead of resolved returns none, not unknown', () => {
  const result = resolveFirstPatchedVersion(['1.0.0', '1.0.1', '1.0.2'], '<=1.0.2', '1.0.0');
  assert.deepEqual(result, { status: 'none' });
});

test('prereleases are excluded from a stable-line patched version by default', () => {
  const result = resolveFirstPatchedVersion(['2.0.0-beta.1', '2.0.0'], '<2.0.0-beta.2', '2.0.0-beta.1');
  assert.deepEqual(result, { status: 'known', version: '2.0.0' });
});

test('a prerelease-line resolved version includes prereleases as candidates', () => {
  const result = resolveFirstPatchedVersion(['2.0.0-beta.1', '2.0.0-beta.2'], '<2.0.0-beta.2', '2.0.0-beta.1');
  assert.deepEqual(result, { status: 'known', version: '2.0.0-beta.2' });
});

test('a malformed advisory range is unknown, never guessed', () => {
  const result = resolveFirstPatchedVersion(['1.0.0', '2.0.0'], 'not-a-real-range', '1.0.0');
  assert.deepEqual(result, { status: 'unknown' });
});

test('an empty version list is unknown', () => {
  const result = resolveFirstPatchedVersion([], '<1.0.0', '0.5.0');
  assert.deepEqual(result, { status: 'unknown' });
});

test('a version list with only invalid semver strings is unknown', () => {
  const result = resolveFirstPatchedVersion(['not-a-version', 'also-not-one'], '<1.0.0', '0.5.0');
  assert.deepEqual(result, { status: 'unknown' });
});

test('a missing resolved version (null) is unknown, never guessed from history alone', () => {
  const result = resolveFirstPatchedVersion(['3.0.0', '3.4.0', '3.4.2', '3.5.0', '4.0.0'], '<3.4.2', null);
  assert.deepEqual(result, { status: 'unknown' });
});

test('an invalid resolved version string is unknown', () => {
  const result = resolveFirstPatchedVersion(['1.0.0', '2.0.0'], '<1.0.0', 'not-a-version');
  assert.deepEqual(result, { status: 'unknown' });
});

test('no downgrade: never returns a version lower than or equal to the resolved vulnerable version', () => {
  const versions = ['0.0.0', '1.0.0', '3.0.0', '4.0.0', '4.0.5', '4.0.6'];
  const result = resolveFirstPatchedVersion(versions, '>=4.0.0 <4.0.6', '4.0.5');
  assert.notEqual(result.status === 'known' && result.version, '0.0.0');
  assert.notEqual(result.status === 'known' && result.version, '1.0.0');
  assert.notEqual(result.status === 'known' && result.version, '3.0.0');
  assert.deepEqual(result, { status: 'known', version: '4.0.6' });
});
