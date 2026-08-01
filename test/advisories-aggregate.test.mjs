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
    wanted: '1.2.0',
    availableVersions: ['1.0.0', '1.2.0'],
    advisories: [],
  });
  assert.equal(target, null);
});

test('fixAvailable: false means no fix, regardless of other data', () => {
  const target = resolveUpgradeTarget({
    installed: '1.0.0',
    range: '^1.0.0',
    wanted: '1.2.0',
    availableVersions: ['1.0.0', '1.2.0'],
    advisories: [attributed('high', ['pkg', 'nested'])],
    fixAvailable: false,
  });
  assert.equal(target, null);
});

test('fixAvailable: true resolves to the wanted version', () => {
  const target = resolveUpgradeTarget({
    installed: '1.0.0',
    range: '^1.0.0',
    wanted: '1.2.0',
    availableVersions: ['1.0.0', '1.2.0'],
    advisories: [attributed('high', ['pkg', 'nested'])],
    fixAvailable: true,
  });
  assert.equal(target, '1.2.0');
});

test('fixAvailable object names the specific target version, possibly a major bump', () => {
  const target = resolveUpgradeTarget({
    installed: '1.0.0',
    range: '^1.0.0',
    wanted: '1.2.0',
    availableVersions: ['1.0.0', '1.2.0', '2.0.0'],
    advisories: [attributed('critical', ['pkg', 'nested'])],
    fixAvailable: { name: 'pkg', version: '2.0.0', isSemVerMajor: true },
  });
  assert.equal(target, '2.0.0');
});

test('the downgrade trap: a fixAvailable version not ahead of installed is refused', () => {
  const target = resolveUpgradeTarget({
    installed: '2.0.0',
    range: '*',
    wanted: '2.0.0',
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
    wanted: '1.0.0', // registry's own "latest" happens to still be vulnerable in this scenario
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
    wanted: '1.2.0',
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
    wanted: '1.0.0',
    availableVersions: ['1.0.0', '2.0.0'],
    advisories,
  });
  assert.equal(target, null, 'no in-range version is clean, so no upgrade is offered');
});
