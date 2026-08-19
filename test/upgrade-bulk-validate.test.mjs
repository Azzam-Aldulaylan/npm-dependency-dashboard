import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateBulkUpgradeRequest } from '../out/core/upgrade/validate.js';

function row(name, target) {
  return {
    name,
    current: '1.0.0',
    wanted: target,
    latest: target,
    dev: false,
    range: '^1.0.0',
    advisories: [],
    worstSeverity: null,
    upgradeTo: target,
    upgradeReason: 'update',
  };
}

const rows = [row('alpha', '1.1.0'), row('beta', '2.0.0')];
const declared = [
  { name: 'alpha', range: '^1.0.0', dev: false, optional: false },
  { name: 'beta', range: '^1.0.0', dev: true, optional: false },
];

test('a coordinated request validates every change and preserves host-owned classifications', () => {
  const result = validateBulkUpgradeRequest(rows, declared, [
    { package: 'alpha', target: '1.1.0' },
    { package: 'beta', target: '2.0.0' },
  ]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.upgrades.map(({ packageName, target, classification }) => ({ packageName, target, classification })), [
    { packageName: 'alpha', target: '1.1.0', classification: 'prod' },
    { packageName: 'beta', target: '2.0.0', classification: 'dev' },
  ]);
});

test('one stale target rejects the whole batch', () => {
  const result = validateBulkUpgradeRequest(rows, declared, [
    { package: 'alpha', target: '1.1.0' },
    { package: 'beta', target: '9.9.9' },
  ]);
  assert.deepEqual(result, {
    ok: false,
    reason: 'change-rejected',
    packageName: 'beta',
    changeReason: 'stale-target',
  });
});

test('empty and duplicate-package batches are rejected before execution', () => {
  assert.deepEqual(validateBulkUpgradeRequest(rows, declared, []), { ok: false, reason: 'empty-batch' });
  assert.deepEqual(
    validateBulkUpgradeRequest(rows, declared, [
      { package: 'alpha', target: '1.1.0' },
      { package: 'alpha', target: '1.1.0' },
    ]),
    { ok: false, reason: 'duplicate-package', packageName: 'alpha' }
  );
});
