/**
 * Severity aggregation and fixAvailable-gated upgrade targeting.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { worstSeverity, resolveUpgradeTarget } from '../out/core/advisories/aggregate.js';

function attributed(severity, path) {
  return {
    advisory: { id: 1, severity, title: 't', url: 'u', vulnerableVersions: '*' },
    flaggedPackage: path[path.length - 1],
    path,
  };
}

// ------------------------------------------------------------- worstSeverity

test('worstSeverity picks the highest-ranked severity present', () => {
  const advisories = [attributed('low', ['a']), attributed('critical', ['a', 'b']), attributed('moderate', ['a'])];
  assert.equal(worstSeverity(advisories), 'critical');
});

test('worstSeverity is null for an empty list', () => {
  assert.equal(worstSeverity([]), null);
});

// ------------------------------------------------------ resolveUpgradeTarget

test('no attributed advisories: no upgrade to offer', () => {
  const target = resolveUpgradeTarget({
    installed: '1.0.0',
    range: '^1.0.0',
    availableVersions: ['1.0.0', '1.2.0'],
    advisories: [],
  });
  assert.equal(target, null);
});

test('fixAvailable: false means no fix, regardless of other data', () => {
  const target = resolveUpgradeTarget({
    installed: '1.0.0',
    range: '^1.0.0',
    availableVersions: ['1.0.0', '1.2.0'],
    advisories: [attributed('high', ['pkg', 'nested'])],
    fixAvailable: false,
  });
  assert.equal(target, null);
});

// fixAvailable: true only means "fixable without an explicit version bump" —
// it names no version at all. Treating some unrelated "wanted" version as
// proof of a fix would be an unverified guess, so it must fall through to the
// same self-computed check used when audit is unavailable entirely.

test('fixAvailable: true falls through to the self-computed check, not a blind trust of "wanted"', () => {
  const advisories = [attributed('high', ['pkg'])].map((a) => ({
    ...a,
    advisory: { ...a.advisory, vulnerableVersions: '<1.2.0' },
  }));
  const target = resolveUpgradeTarget({
    installed: '1.0.0',
    range: '^1.0.0',
    availableVersions: ['1.0.0', '1.0.1', '1.2.0'],
    advisories,
    fixAvailable: true,
  });
  assert.equal(target, '1.2.0', 'the self-computed check finds a version actually proven clean');
});

test('fixAvailable: true cannot vouch for a purely transitive advisory either', () => {
  // No own advisory (path length > 1 only) means there is nothing to verify a
  // version against — `true` does not change that.
  const target = resolveUpgradeTarget({
    installed: '1.0.0',
    range: '^1.0.0',
    availableVersions: ['1.0.0', '1.2.0'],
    advisories: [attributed('critical', ['pkg', 'nested-dep'])],
    fixAvailable: true,
  });
  assert.equal(target, null);
});

test('fixAvailable object names the specific target version, possibly a major bump', () => {
  const target = resolveUpgradeTarget({
    installed: '1.0.0',
    range: '^1.0.0',
    availableVersions: ['1.0.0', '1.2.0', '2.0.0'],
    advisories: [attributed('critical', ['pkg', 'nested'])],
    fixAvailable: { name: 'pkg', version: '2.0.0', isSemVerMajor: true },
  });
  assert.equal(target, '2.0.0');
});

test('no real installed version: a fixAvailable object is refused outright, never treated as "anything is ahead"', () => {
  // installed: null means there is no real installed version to compare
  // against at all (a workspace link, an unresolvable specifier, or no
  // lockfile) — this must never be offered as an upgrade target regardless
  // of what fixAvailable names, even though nothing here can prove the
  // target ISN'T ahead of some hypothetical installed version either.
  const target = resolveUpgradeTarget({
    installed: null,
    range: '^1.0.0',
    availableVersions: ['1.0.0', '1.2.0', '2.0.0'],
    advisories: [attributed('critical', ['pkg', 'nested'])],
    fixAvailable: { name: 'pkg', version: '2.0.0', isSemVerMajor: true },
  });
  assert.equal(target, null);
});

test('the downgrade trap: a fixAvailable version not ahead of installed is refused', () => {
  const target = resolveUpgradeTarget({
    installed: '2.0.0',
    range: '*',
    availableVersions: ['1.9.0', '2.0.0'],
    advisories: [attributed('high', ['pkg', 'nested'])],
    fixAvailable: { name: 'pkg', version: '1.9.0', isSemVerMajor: false },
  });
  assert.equal(target, null);
});

test('without fixAvailable, self-computed fallback finds a clean in-range version for an own advisory', () => {
  const advisories = [attributed('high', ['pkg'])]; // path length 1: the direct dep's own version is flagged
  const target = resolveUpgradeTarget({
    installed: '1.0.0',
    range: '^1.0.0',
    availableVersions: ['1.0.0', '1.0.1', '1.2.0'],
    advisories: advisories.map((a) => ({ ...a, advisory: { ...a.advisory, vulnerableVersions: '<1.2.0' } })),
  });
  assert.equal(target, '1.2.0');
});

test('the self-computed fallback cannot vouch for a purely transitive advisory', () => {
  // Only a nested package is flagged (path length 2) — proving a bump to the
  // direct dependency actually re-resolves it requires a real dependency
  // resolver, which is exactly what fixAvailable would have told us.
  const advisories = [attributed('critical', ['pkg', 'nested-dep'])];
  const target = resolveUpgradeTarget({
    installed: '1.0.0',
    range: '^1.0.0',
    availableVersions: ['1.0.0', '1.2.0'],
    advisories,
  });
  assert.equal(target, null);
});

test('the self-computed fallback never offers a version outside the declared range', () => {
  const advisories = [attributed('high', ['pkg'])].map((a) => ({
    ...a,
    advisory: { ...a.advisory, vulnerableVersions: '<3.0.0' },
  }));
  const target = resolveUpgradeTarget({
    installed: '1.0.0',
    range: '^1.0.0', // 2.0.0 is clean but out of range
    availableVersions: ['1.0.0', '2.0.0'],
    advisories,
  });
  assert.equal(target, null, 'no in-range version is clean, so no upgrade is offered');
});
