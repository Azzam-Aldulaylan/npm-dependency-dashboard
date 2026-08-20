import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateBulkRemoveRequest } from '../out/core/upgrade/validate.js';

function row(name) {
  return {
    name,
    current: '1.0.0',
    wanted: '1.0.0',
    latest: '1.0.0',
    dev: false,
    range: '^1.0.0',
    advisories: [],
    worstSeverity: null,
    upgradeTo: null,
    upgradeReason: null,
  };
}

const rows = [row('alpha'), row('beta')];
const declared = [
  { name: 'alpha', range: '^1.0.0', dev: false, optional: false },
  { name: 'beta', range: '^1.0.0', dev: true, optional: false },
];

test('a coordinated removal validates every package and preserves host-owned classifications', () => {
  const result = validateBulkRemoveRequest(rows, declared, [{ package: 'alpha' }, { package: 'beta' }]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.removals, [
    { ok: true, packageName: 'alpha', classification: 'prod' },
    { ok: true, packageName: 'beta', classification: 'dev' },
  ]);
});

test('removal never requires an available upgrade — unlike validateBulkUpgradeRequest', () => {
  // Neither row has upgradeTo set; a removal must still validate.
  const result = validateBulkRemoveRequest(rows, declared, [{ package: 'alpha' }]);
  assert.equal(result.ok, true);
});

test('an undeclared or unknown package rejects the whole batch', () => {
  assert.deepEqual(validateBulkRemoveRequest(rows, declared, [{ package: 'ghost' }]), {
    ok: false,
    reason: 'change-rejected',
    packageName: 'ghost',
    changeReason: 'unknown-package',
  });
  const undeclaredRows = [...rows, row('gamma')];
  assert.deepEqual(validateBulkRemoveRequest(undeclaredRows, declared, [{ package: 'gamma' }]), {
    ok: false,
    reason: 'change-rejected',
    packageName: 'gamma',
    changeReason: 'not-declared',
  });
});

test('empty and duplicate-package batches are rejected before execution', () => {
  assert.deepEqual(validateBulkRemoveRequest(rows, declared, []), { ok: false, reason: 'empty-batch' });
  assert.deepEqual(
    validateBulkRemoveRequest(rows, declared, [{ package: 'alpha' }, { package: 'alpha' }]),
    { ok: false, reason: 'duplicate-package', packageName: 'alpha' }
  );
});

test('no scan result rejects every removal', () => {
  assert.deepEqual(validateBulkRemoveRequest(undefined, declared, [{ package: 'alpha' }]), {
    ok: false,
    reason: 'change-rejected',
    packageName: 'alpha',
    changeReason: 'no-scan-result',
  });
});
