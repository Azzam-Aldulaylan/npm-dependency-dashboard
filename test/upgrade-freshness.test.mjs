import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isUpgradeAnalysisExpired,
  isUpgradeAnalysisSoftStale,
  UPGRADE_ANALYSIS_RETENTION_MS,
  UPGRADE_ANALYSIS_SOFT_STALE_MS,
} from '../out/host/upgradeFreshness.js';
import { resolveAnalysisForExecution } from '../out/host/upgradeAnalysisLookup.js';

const NOW = Date.parse('2026-08-26T12:00:00.000Z');

test('Upgrade Review becomes softly stale at one hour, not before', () => {
  assert.equal(
    isUpgradeAnalysisSoftStale(new Date(NOW - UPGRADE_ANALYSIS_SOFT_STALE_MS + 1).toISOString(), NOW),
    false
  );
  assert.equal(
    isUpgradeAnalysisSoftStale(new Date(NOW - UPGRADE_ANALYSIS_SOFT_STALE_MS).toISOString(), NOW),
    true
  );
});

test('host retention outlives soft staleness so the hint does not itself expire execution authority', () => {
  assert.equal(UPGRADE_ANALYSIS_SOFT_STALE_MS, 60 * 60_000);
  assert.ok(UPGRADE_ANALYSIS_RETENTION_MS > UPGRADE_ANALYSIS_SOFT_STALE_MS);

  const result = resolveAnalysisForExecution({
    stored: {
      id: 'analysis-id',
      compatibilityStatus: 'compatible',
      hasSmartPlan: false,
      expiresAt: NOW + UPGRADE_ANALYSIS_RETENTION_MS,
    },
    requestedAnalysisId: 'analysis-id',
    now: NOW + UPGRADE_ANALYSIS_SOFT_STALE_MS,
    wantsSmartPlan: false,
  });
  assert.equal(result.ok, true, 'the one-hour soft-stale boundary remains executable');
});

test('unparseable analysis timestamps degrade to unknown rather than stale', () => {
  assert.equal(isUpgradeAnalysisSoftStale('not-a-date', NOW), false);
  assert.equal(isUpgradeAnalysisSoftStale('1', NOW), false, 'parseable-but-non-ISO input is still malformed');
});

test('retained analysis expiry is strict before the two-hour deadline and hard at the deadline', () => {
  const expiresAt = new Date(NOW + UPGRADE_ANALYSIS_RETENTION_MS).toISOString();
  assert.equal(isUpgradeAnalysisExpired(expiresAt, NOW + UPGRADE_ANALYSIS_RETENTION_MS - 1), false);
  assert.equal(isUpgradeAnalysisExpired(expiresAt, NOW + UPGRADE_ANALYSIS_RETENTION_MS), true);
});

test('malformed retained-analysis expiry fails closed', () => {
  assert.equal(isUpgradeAnalysisExpired('not-a-date', NOW), true);
  assert.equal(isUpgradeAnalysisExpired('1', NOW), true, 'parseable-but-non-ISO input is still malformed');
});
