import assert from 'node:assert/strict';
import test from 'node:test';

import {
  advisoryNavigationRequest,
  applyUpgradeEnrichmentTerminal,
  beginUpgradeEnrichment,
  completedDashboardSnapshotAbandonsUpgradeEnrichment,
  hasPlannerAddedCoordination,
  plannerAddedUpgradeChanges,
  remainingVulnerabilityPatchedVersionLabel,
  retryUpgradeEnrichment,
  shouldQuarantineUpgradeDerivedData,
  shouldShowUpgradeVulnerabilitySeverity,
  upgradeAnalysisFreshness,
  upgradeReviewDashboardEffect,
} from '../out/host/upgradeReviewUiState.js';

const HOUR = 60 * 60_000;
const NOW = Date.parse('2026-08-26T12:00:00.000Z');

function reviewSnapshot(overrides = {}) {
  return {
    project: { label: 'App', manifestPath: 'apps/web/package.json' },
    generatedAt: new Date(NOW).toISOString(),
    rows: [{ name: 'next', current: '14.2.35', range: '^14.2.0', dev: false }],
    ...overrides,
  };
}

test('background snapshot updates preserve an open upgrade review and its selected target', () => {
  const previous = reviewSnapshot();
  for (const status of ['ready', 'partial-error']) {
    const data = reviewSnapshot({
      generatedAt: new Date(NOW + 30 * 60_000).toISOString(),
      rows: [{ ...previous.rows[0], latest: '16.0.0', worstSeverity: 'high' }],
    });
    assert.equal(upgradeReviewDashboardEffect('next', previous, { status, data }), 'preserve');
  }
});

test('a revalidation notice with unchanged data does not claim project files changed', () => {
  const data = reviewSnapshot();
  assert.equal(upgradeReviewDashboardEffect('next', data, { status: 'stale', data }), 'preserve');
  assert.equal(upgradeReviewDashboardEffect('next', data, { status: 'ready', data }), 'preserve');
});

test('changed dependency declarations retain evidence but require a re-check', () => {
  const data = reviewSnapshot();
  for (const changed of [{ current: '15.0.0' }, { range: '^15' }, { dev: true }, { optional: true }]) {
    const next = reviewSnapshot({ rows: [{ ...data.rows[0], ...changed }] });
    assert.equal(upgradeReviewDashboardEffect('next', data, { status: 'ready', data: next }), 'mark-stale');
  }
  const next = reviewSnapshot({ rows: [...data.rows, { name: 'react', current: '19.0.0' }] });
  assert.equal(upgradeReviewDashboardEffect('next', data, { status: 'ready', data: next }), 'mark-stale');
});

test('project switches, missing packages and terminal dashboard failures reset the review', () => {
  const data = reviewSnapshot();
  for (const incoming of [
    { status: 'loading' },
    { status: 'fatal-error', error: { code: 'FAILED', message: 'Project unreadable' } },
    { status: 'empty', data: reviewSnapshot({ rows: [] }) },
    { status: 'ready', data: reviewSnapshot({ project: { label: 'Other app', manifestPath: data.project.manifestPath } }) },
    { status: 'ready', data: reviewSnapshot({ project: { label: 'App', manifestPath: 'other/package.json' } }) },
  ]) {
    assert.equal(upgradeReviewDashboardEffect('next', data, incoming), 'reset');
  }
  assert.equal(upgradeReviewDashboardEffect(null, data, { status: 'ready', data }), 'reset');
});

function result(overrides = {}) {
  return {
    package: 'react',
    refreshId: 'refresh-1',
    install: 'succeeded',
    application: 'applied',
    verification: 'not-configured',
    changes: [],
    refreshingDerivedData: true,
    ...overrides,
  };
}

test('targeted enrichment completes only for its exact host correlation', () => {
  const refreshing = beginUpgradeEnrichment(result());
  assert.deepEqual(refreshing, { phase: 'refreshing', refreshId: 'refresh-1', package: 'react' });
  assert.strictEqual(
    applyUpgradeEnrichmentTerminal(refreshing, {
      refreshId: 'another-refresh', package: 'react', outcome: 'succeeded',
    }),
    refreshing,
    'an unrelated dashboard/refresh lifecycle cannot complete this one'
  );
  assert.strictEqual(
    applyUpgradeEnrichmentTerminal(refreshing, {
      refreshId: 'refresh-1', package: 'lodash', outcome: 'succeeded',
    }),
    refreshing,
    'package correlation is also exact'
  );
  assert.equal(
    applyUpgradeEnrichmentTerminal(refreshing, {
      refreshId: 'refresh-1', package: 'react', outcome: 'succeeded',
    }),
    null
  );
});

test('failed and cancelled enrichment terminate refreshing with retryable honest state', () => {
  for (const outcome of ['failed', 'cancelled']) {
    const refreshing = beginUpgradeEnrichment(result());
    const terminal = applyUpgradeEnrichmentTerminal(refreshing, {
      refreshId: 'refresh-1', package: 'react', outcome,
      ...(outcome === 'failed' ? { error: { message: 'Registry unavailable' } } : {}),
    });
    assert.equal(terminal?.phase, 'failed');
    assert.equal(terminal?.outcome, outcome);
    assert.ok(terminal?.message.length > 0);
    assert.deepEqual(retryUpgradeEnrichment(terminal), {
      phase: 'refreshing', refreshId: 'refresh-1', package: 'react',
    });
  }
});

test('superseded enrichment terminates without offering a retry the host would reject', () => {
  const superseded = applyUpgradeEnrichmentTerminal(beginUpgradeEnrichment(result()), {
    refreshId: 'refresh-1', package: 'react', outcome: 'superseded',
  });
  assert.equal(superseded?.phase, 'superseded');
  assert.strictEqual(retryUpgradeEnrichment(superseded), superseded);
});

test('a later authoritative dashboard completion abandons superseded quarantine without claiming targeted success', () => {
  const superseded = applyUpgradeEnrichmentTerminal(beginUpgradeEnrichment(result()), {
    refreshId: 'refresh-1', package: 'react', outcome: 'superseded',
  });
  for (const status of ['ready', 'partial-error', 'empty']) {
    assert.equal(completedDashboardSnapshotAbandonsUpgradeEnrichment(superseded, status), true);
  }
  for (const status of ['stale', 'loading', 'scan-progress']) {
    assert.equal(completedDashboardSnapshotAbandonsUpgradeEnrichment(superseded, status), false);
  }
});

test('dashboard snapshots never bypass exact correlation while targeted enrichment is still running', () => {
  const refreshing = beginUpgradeEnrichment(result());
  assert.equal(completedDashboardSnapshotAbandonsUpgradeEnrichment(refreshing, 'ready'), false);
  assert.deepEqual(refreshing, { phase: 'refreshing', refreshId: 'refresh-1', package: 'react' });
});

test('a later authoritative reload may replace failed or cancelled targeted state without relabeling it succeeded', () => {
  for (const outcome of ['failed', 'cancelled']) {
    const terminal = applyUpgradeEnrichmentTerminal(beginUpgradeEnrichment(result()), {
      refreshId: 'refresh-1', package: 'react', outcome,
    });
    assert.equal(terminal?.phase, 'failed');
    assert.equal(completedDashboardSnapshotAbandonsUpgradeEnrichment(terminal, 'ready'), true);
    assert.equal(completedDashboardSnapshotAbandonsUpgradeEnrichment(terminal, 'stale'), false);
  }
});

test('derived facts and vulnerability severity stay quarantined until correlated success', () => {
  const refreshing = beginUpgradeEnrichment(result());
  const failed = applyUpgradeEnrichmentTerminal(refreshing, {
    refreshId: 'refresh-1', package: 'react', outcome: 'failed',
  });
  assert.equal(shouldQuarantineUpgradeDerivedData(refreshing), true);
  assert.equal(shouldShowUpgradeVulnerabilitySeverity(refreshing), false);
  assert.equal(shouldQuarantineUpgradeDerivedData(failed), true);
  assert.equal(shouldShowUpgradeVulnerabilitySeverity(failed), false);
  assert.equal(shouldQuarantineUpgradeDerivedData(null), false);
  assert.equal(shouldShowUpgradeVulnerabilitySeverity(null), true);
});

test('analysis freshness has exact one-hour soft and two-hour hard boundaries', () => {
  const expiresAt = new Date(NOW + 2 * HOUR).toISOString();
  assert.equal(upgradeAnalysisFreshness(new Date(NOW - HOUR + 1).toISOString(), expiresAt, NOW), 'fresh');
  assert.equal(upgradeAnalysisFreshness(new Date(NOW - HOUR).toISOString(), expiresAt, NOW), 'soft-stale');
  assert.equal(
    upgradeAnalysisFreshness(new Date(NOW).toISOString(), new Date(NOW + 1).toISOString(), NOW),
    'fresh',
    'one millisecond before hard expiry remains actionable'
  );
  assert.equal(
    upgradeAnalysisFreshness(new Date(NOW).toISOString(), new Date(NOW).toISOString(), NOW),
    'expired',
    'hard expiry is inclusive'
  );
});

test('malformed timestamps never manufacture execution authority', () => {
  assert.equal(upgradeAnalysisFreshness('not-a-date', new Date(NOW + HOUR).toISOString(), NOW), 'expired');
  assert.equal(upgradeAnalysisFreshness(new Date(NOW).toISOString(), 'not-a-date', NOW), 'expired');
});

test('bulk Smart Plan counting compares against every requested package and target', () => {
  const requested = [
    { packageName: 'a', targetVersion: '2.0.0' },
    { packageName: 'b', targetVersion: '3.0.0' },
  ];
  const coordinated = [
    { packageName: 'a', currentVersion: '1.0.0', targetVersion: '2.0.0' },
    { packageName: 'b', currentVersion: '2.0.0', targetVersion: '3.0.0' },
    { packageName: 'c', currentVersion: '4.0.0', targetVersion: '5.0.0' },
  ];
  assert.deepEqual(plannerAddedUpgradeChanges(requested, coordinated), [coordinated[2]]);
  assert.equal(hasPlannerAddedCoordination(requested, coordinated), true);
  assert.equal(hasPlannerAddedCoordination(requested, coordinated.slice(0, 2)), false);
});

test('retargeting a requested dependency is also planner-added coordination', () => {
  assert.deepEqual(
    plannerAddedUpgradeChanges(
      [{ packageName: 'a', targetVersion: '2.0.0' }],
      [{ packageName: 'a', currentVersion: '1.0.0', targetVersion: '2.1.0' }]
    ).map((change) => change.packageName),
    ['a']
  );
});

test('a transitive patched version is labeled for the flagged package, not as a root upgrade instruction', () => {
  assert.equal(remainingVulnerabilityPatchedVersionLabel('minimist'), 'Patched version for minimist');
  assert.doesNotMatch(remainingVulnerabilityPatchedVersionLabel('minimist'), /webpack/);
});

test('advisory navigation carries only trusted identifiers and an exact cloned path', () => {
  const path = ['webpack', 'loader-utils', 'json5'];
  const request = advisoryNavigationRequest('webpack', 1234, path);
  path.push('mutated-after-click');
  assert.deepEqual(request, {
    type: 'open-advisory',
    package: 'webpack',
    advisoryId: 1234,
    path: ['webpack', 'loader-utils', 'json5'],
  });
  assert.equal(Object.hasOwn(request, 'url'), false);

  assert.deepEqual(advisoryNavigationRequest('webpack', 1234, path, 'CVE-2026-67213'), {
    type: 'open-advisory',
    package: 'webpack',
    advisoryId: 1234,
    path: ['webpack', 'loader-utils', 'json5', 'mutated-after-click'],
    reference: 'CVE-2026-67213',
  });
});
