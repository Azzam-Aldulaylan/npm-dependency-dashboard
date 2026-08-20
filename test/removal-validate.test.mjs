/**
 * validateRemoveRequest — removal eligibility never depends on whether the
 * package has a resolved installed version or an available update, unlike
 * an upgrade. This is exactly what makes "Manage should normally be
 * available for every direct dependency row" (including workspace-linked,
 * file:, git:, or no-lockfile rows, where Upgrade is unavailable) true —
 * see src/host/upgradeAction.ts's unavailableReasonText for the upgrade
 * side of the same rows.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateRemoveRequest } from '../out/core/upgrade/validate.js';

function row(overrides = {}) {
  return {
    name: 'left-pad',
    current: '1.0.0',
    wanted: '1.0.0',
    latest: '1.0.0',
    dev: false,
    range: '^1.0.0',
    advisories: [],
    worstSeverity: null,
    upgradeTo: null,
    upgradeReason: null,
    ...overrides,
  };
}

function declared(overrides = {}) {
  return { name: 'left-pad', range: '^1.0.0', dev: false, optional: false, ...overrides };
}

test('removal is eligible for an ordinary, fully-resolved dependency', () => {
  const result = validateRemoveRequest([row()], [declared()], { package: 'left-pad' });
  assert.deepEqual(result, { ok: true, packageName: 'left-pad', classification: 'prod' });
});

for (const unresolvable of ['workspace-link', 'file', 'git', 'alias', 'tarball', 'no-lockfile']) {
  test(`removal is still eligible for an unresolvable (${unresolvable}) dependency with no installed version`, () => {
    const result = validateRemoveRequest([row({ current: null, unresolvable })], [declared()], {
      package: 'left-pad',
    });
    assert.deepEqual(result, { ok: true, packageName: 'left-pad', classification: 'prod' });
  });
}

test('removal is eligible for a dependency that is already up to date', () => {
  const result = validateRemoveRequest(
    [row({ current: '2.0.0', wanted: '2.0.0', latest: '2.0.0' })],
    [declared({ range: '^2.0.0' })],
    { package: 'left-pad' }
  );
  assert.equal(result.ok, true);
});

test('an unknown package is rejected', () => {
  const result = validateRemoveRequest([row()], [declared()], { package: 'not-in-scan' });
  assert.deepEqual(result, { ok: false, reason: 'unknown-package' });
});

test('a package present in the scan but no longer declared directly is rejected', () => {
  const result = validateRemoveRequest([row()], [], { package: 'left-pad' });
  assert.deepEqual(result, { ok: false, reason: 'not-declared' });
});

test('no scan result at all is rejected', () => {
  const result = validateRemoveRequest(undefined, [declared()], { package: 'left-pad' });
  assert.deepEqual(result, { ok: false, reason: 'no-scan-result' });
});

test('classification is derived from the declared dependency, not the row', () => {
  const dev = validateRemoveRequest([row({ dev: true })], [declared({ dev: true })], { package: 'left-pad' });
  assert.equal(dev.ok, true);
  assert.equal(dev.classification, 'dev');

  const optional = validateRemoveRequest([row()], [declared({ optional: true })], { package: 'left-pad' });
  assert.equal(optional.ok, true);
  assert.equal(optional.classification, 'optional');
});
