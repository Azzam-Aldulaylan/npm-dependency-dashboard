import { test } from 'node:test';
import assert from 'node:assert/strict';

import { summarizeUpgradeSecurity } from '../out/host/upgradeSecuritySummary.js';

const advisory = (id) => ({
  advisory: { id, severity: 'high', title: `Advisory ${id}`, vulnerableVersions: '<2.0.0', url: null },
  flaggedPackage: 'transitive-package',
  path: ['root-package', 'transitive-package'],
  patchedVersion: { status: 'unknown' },
});

const remaining = (id, status) => ({
  ...advisory(id),
  status,
  resolvedVersion: null,
});

test('unknown outcomes are surfaced instead of displayed as zero vulnerabilities', () => {
  const summary = summarizeUpgradeSecurity({
    status: 'unknown',
    resolvedAdvisories: [],
    remaining: [remaining(1, 'unknown')],
  });

  assert.deepEqual(summary, {
    beforeCount: 1,
    confirmedRemainingCount: 0,
    unknownCount: 1,
    afterLabel: '1 undetermined',
  });
});

test('remaining and undetermined outcomes are both represented', () => {
  const summary = summarizeUpgradeSecurity({
    status: 'remains',
    resolvedAdvisories: [advisory(1)],
    remaining: [remaining(2, 'remains'), remaining(3, 'unknown')],
  });

  assert.equal(summary.beforeCount, 3);
  assert.equal(summary.afterLabel, '1 remains, 1 undetermined');
});

test('zero is displayed only when all known advisories were proven resolved', () => {
  const summary = summarizeUpgradeSecurity({
    status: 'resolved',
    resolvedAdvisories: [advisory(1)],
    remaining: [],
  });

  assert.equal(summary.afterLabel, '0');
});
