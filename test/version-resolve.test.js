/**
 * Regression tests for the two version bugs found during planning.
 *
 * Run: npm run build && node --test test/
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveWanted,
  resolveLatest,
  isSafeUpgradeTarget,
} from '../out/core/version/resolve.js';

// The canary bug. Without dist-tags.latest as the base, a naive
// "max by semver" returns 19.3.0-canary because 19.3.0 > 19.2.8 on
// major.minor.patch alone — the prerelease tag never enters the comparison.
const REACT_LIKE = {
  versions: ['19.2.7', '19.2.8', '19.3.0-canary-cbb046ab-20260731'],
  distTags: { latest: '19.2.8', canary: '19.3.0-canary-cbb046ab-20260731' },
};

test('Latest never offers a canary to a stable install', () => {
  const latest = resolveLatest(REACT_LIKE.versions, REACT_LIKE.distTags, '19.2.7');
  assert.equal(latest, '19.2.8');
});

test('Latest never offers a nightly to a stable install (typescript case)', () => {
  const versions = ['5.4.5', '5.5.0', '7.1.0-dev.20260731.1'];
  const distTags = { latest: '5.5.0', dev: '7.1.0-dev.20260731.1' };
  assert.equal(resolveLatest(versions, distTags, '5.4.5'), '5.5.0');
});

test('a prerelease install may be offered a newer prerelease on its own line', () => {
  const versions = ['1.0.0', '2.0.0-beta.1', '2.0.0-beta.3'];
  const distTags = { latest: '1.0.0' };
  assert.equal(resolveLatest(versions, distTags, '2.0.0-beta.1'), '2.0.0-beta.3');
});

test('a prerelease install is not offered an unrelated nightly line', () => {
  const versions = ['5.5.0', '5.6.0-beta.1', '7.1.0-dev.20260731.1'];
  const distTags = { latest: '5.5.0' };
  // 7.1.0-dev is a different line than the installed 5.6.0-beta.1.
  assert.equal(resolveLatest(versions, distTags, '5.6.0-beta.1'), '5.5.0');
});

test('Wanted respects the declared range and excludes prereleases by default', () => {
  const versions = ['18.2.0', '18.3.0', '19.0.0', '18.4.0-beta.1'];
  assert.equal(resolveWanted(versions, '^18.0.0', '18.2.0'), '18.3.0');
});

test('Wanted includes prereleases when the install is itself a prerelease', () => {
  const versions = ['18.2.0', '18.3.0', '18.4.0-beta.1'];
  const wanted = resolveWanted(versions, '^18.0.0', '18.4.0-beta.0');
  assert.equal(wanted, '18.4.0-beta.1');
});

// The downgrade trap: advisory fix data can name a version lower than what's
// installed. Offering it would silently downgrade the user.
test('an upgrade target below the installed version is refused', () => {
  assert.equal(isSafeUpgradeTarget('0.0.0', '5.0.1'), false);
  assert.equal(isSafeUpgradeTarget('4.9.0', '5.0.1'), false);
});

test('an upgrade target equal to installed is refused', () => {
  assert.equal(isSafeUpgradeTarget('5.0.1', '5.0.1'), false);
});

test('a genuine upgrade target is allowed', () => {
  assert.equal(isSafeUpgradeTarget('5.1.0', '5.0.1'), true);
});
