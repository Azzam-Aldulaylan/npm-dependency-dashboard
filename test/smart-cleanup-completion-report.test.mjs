import assert from 'node:assert/strict';
import test from 'node:test';

import { computeSourceFingerprint } from '../out/core/cache/sourceFingerprint.js';
import { vulnerabilitySnapshotMetrics } from '../out/core/advisories/metrics.js';
import { buildSmartCleanupCompletionReport } from '../out/host/smartCleanupCompletionReport.js';

const sourceBefore = computeSourceFingerprint({
  manifestText: '{"dependencies":{"a":"1","b":"1","c":"1"}}',
  lockfileText: 'before',
  lockfilePath: '/project/package-lock.json',
});
const sourceAfter = computeSourceFingerprint({
  manifestText: '{"dependencies":{"b":"1","c":"1"}}',
  lockfileText: 'after',
  lockfilePath: '/project/package-lock.json',
});

function advisory(id, severity = 'high', identifiers = []) {
  return {
    id,
    severity,
    title: `Advisory ${id}`,
    url: `https://github.com/advisories/GHSA-${id}`,
    vulnerableVersions: '<2.0.0',
    identifiers,
  };
}

function attributed(source, flaggedPackage, path, identifiers = []) {
  return {
    advisory: advisory(source, 'high', identifiers),
    flaggedPackage,
    path,
    flaggedVersion: '1.0.0',
    patchedVersion: { status: 'known', version: '2.0.0' },
  };
}

function row(name, advisories = [], deprecated) {
  return {
    name,
    current: '1.0.0',
    wanted: '1.0.0',
    latest: '1.0.0',
    dev: false,
    optional: false,
    range: '^1.0.0',
    advisories,
    worstSeverity: advisories.length === 0 ? null : 'high',
    upgradeTo: null,
    upgradeReason: null,
    ...(deprecated === undefined ? {} : { deprecated }),
  };
}

function snapshot(rows, { advisories = 'complete', updates = 'complete', duplicates = [] } = {}) {
  return {
    rows,
    availability: {
      updates,
      advisories,
      unavailableUpdatePackages: updates === 'complete' ? [] : ['unavailable-package'],
    },
    ...(advisories === 'unavailable'
      ? { advisoriesError: { code: 'NETWORK', message: 'unavailable' } }
      : {}),
    hygieneFindings: duplicates.map((packageName) => ({
      kind: 'duplicate-version',
      packageName,
      summary: 'duplicates',
      evidence: { kind: 'duplicate-version', versions: [{ version: '1.0.0', paths: ['a'] }, { version: '2.0.0', paths: ['b'] }] },
    })),
  };
}

const operation = {
  requestId: 'request-1',
  analysisId: 'analysis-1',
  projectId: 'project-1',
  refreshId: 'refresh-1',
  sourceGeneration: 7,
  sourceFingerprint: sourceBefore,
};

function completion(overrides = {}) {
  const shared = attributed(101, 'shared', ['a', 'shared'], [{ type: 'GHSA', value: 'GHSA-AAAA-BBBB-CCCC' }]);
  const secondPath = attributed(101, 'shared', ['a', 'nested', 'shared'], [{ type: 'CVE', value: 'CVE-2026-12345' }]);
  const removed = attributed(102, 'removed-package', ['a', 'removed-package']);
  const before = snapshot([
    row('a', [shared, secondPath, removed]),
    row('b', [attributed(101, 'shared', ['b', 'shared'])]),
    row('c'),
  ], { duplicates: ['shared'] });
  const after = snapshot([
    row('b', [attributed(101, 'shared', ['b', 'shared'], [{ type: 'CVE', value: 'CVE-2026-12345' }])]),
    row('c'),
  ]);
  return buildSmartCleanupCompletionReport({
    operation,
    before: {
      snapshot: before,
      projectId: 'project-1',
      sourceGeneration: 7,
      sourceFingerprint: sourceBefore,
      deprecatedDirectPackages: ['a'],
      deprecationInstalledVersions: { a: '1.0.0', b: '1.0.0', c: '1.0.0' },
    },
    after: {
      snapshot: after,
      requestId: 'request-1',
      analysisId: 'analysis-1',
      projectId: 'project-1',
      refreshId: 'refresh-1',
      generationAtReadStart: 9,
      generationAfterRead: 9,
      sourceFingerprint: sourceAfter,
      confirmedSourceFingerprint: sourceAfter,
      deprecatedDirectPackages: [],
    },
    actions: [{ actionId: 'remove:a', packageName: 'a', status: 'completed' }],
    generatedAt: '2026-08-29T00:00:00.000Z',
    ...overrides,
  });
}

test('canonical vulnerability metrics deduplicate paths and roots without depending on aliases', () => {
  const shared = attributed(101, 'shared', ['a', 'shared'], [{ type: 'GHSA', value: 'GHSA-AAAA-BBBB-CCCC' }]);
  const alternateAlias = attributed(101, 'shared', ['b', 'shared'], [{ type: 'CVE', value: 'CVE-2026-12345' }]);
  const metrics = vulnerabilitySnapshotMetrics([row('a', [shared, shared]), row('b', [alternateAlias])]);
  assert.equal(metrics.advisoryFindings, 1);
  assert.equal(metrics.affectedDirectDependencies, 2);
  assert.equal(metrics.severity.high, 1);
  assert.deepEqual(metrics.findings[0].directRoots, ['a', 'b']);
});

test('a shared public alias never merges findings for different flagged packages', () => {
  const sharedAlias = [{ type: 'CVE', value: 'CVE-2026-26960' }];
  const metrics = vulnerabilitySnapshotMetrics([
    row('root-a', [attributed(201, 'package-a', ['root-a', 'package-a'], sharedAlias)]),
    row('root-b', [attributed(202, 'package-b', ['root-b', 'package-b'], sharedAlias)]),
  ]);
  assert.equal(metrics.advisoryFindings, 2);
  assert.deepEqual(metrics.findings.map((finding) => finding.flaggedPackage), ['package-a', 'package-b']);
});

test('a correlated complete refresh produces actual before/after report metrics and advisory set differences', () => {
  const result = completion();
  assert.equal(result.status, 'verified');
  assert.equal(result.report.metrics.directDependencies.before, 3);
  assert.equal(result.report.metrics.directDependencies.after, 2);
  assert.equal(result.report.metrics.duplicateVersionGroups.improvedBy, 1);
  assert.equal(result.report.metrics.deprecatedDirectDependencies.improvedBy, 1);
  assert.equal(result.report.metrics.vulnerabilities.before, 2);
  assert.equal(result.report.metrics.vulnerabilities.after, 1);
  assert.equal(result.security.before.affectedDirectDependencies, 2);
  assert.equal(result.security.after.affectedDirectDependencies, 1);
  assert.deepEqual(result.security.removedAdvisories.map((finding) => finding.sourceId), ['102']);
  assert.deepEqual(result.security.remainingAdvisories.map((finding) => finding.sourceId), ['101']);
  assert.deepEqual(result.security.introducedAdvisories, []);
});

test('request, project, refresh, and source mismatches fail closed with no verified metrics', () => {
  const mismatches = [
    ['REQUEST_MISMATCH', { after: { requestId: 'other' } }],
    ['ANALYSIS_MISMATCH', { after: { analysisId: 'other' } }],
    ['PROJECT_MISMATCH', { after: { projectId: 'other' } }],
    ['REFRESH_MISMATCH', { after: { refreshId: 'other' } }],
    ['STALE_BEFORE_SOURCE', { before: { sourceGeneration: 8 } }],
    ['STALE_BEFORE_SOURCE', { before: { sourceFingerprint: sourceAfter } }],
    ['STALE_AFTER_SOURCE', { after: { generationAfterRead: 10 } }],
    ['STALE_AFTER_SOURCE', { after: { confirmedSourceFingerprint: sourceBefore } }],
  ];
  for (const [expectedCode, change] of mismatches) {
    const originalInput = {
      operation,
      before: {
        snapshot: snapshot([row('a')]),
        projectId: 'project-1',
        sourceGeneration: 7,
        sourceFingerprint: sourceBefore,
      },
      after: {
        snapshot: snapshot([]),
        requestId: 'request-1',
        analysisId: 'analysis-1',
        projectId: 'project-1',
        refreshId: 'refresh-1',
        generationAtReadStart: 9,
        generationAfterRead: 9,
        sourceFingerprint: sourceAfter,
        confirmedSourceFingerprint: sourceAfter,
      },
      actions: [],
      generatedAt: '2026-08-29T00:00:00.000Z',
    };
    const result = buildSmartCleanupCompletionReport({
      ...originalInput,
      before: { ...originalInput.before, ...(change.before ?? {}) },
      after: { ...originalInput.after, ...(change.after ?? {}) },
    });
    assert.equal(result.status, 'stale');
    assert.equal(result.code, expectedCode);
    assert.equal(result.security, null);
    assert.equal(result.report.metrics.directDependencies.status, 'unavailable');
    assert.equal(result.report.metrics.vulnerabilities.status, 'unavailable');
  }
});

test('partial advisory availability preserves local graph facts but refuses a security delta', () => {
  const baseBefore = snapshot([row('a')]);
  const partialAfter = snapshot([], { advisories: 'unavailable' });
  const result = buildSmartCleanupCompletionReport({
    operation,
    before: { snapshot: baseBefore, projectId: 'project-1', sourceGeneration: 7, sourceFingerprint: sourceBefore },
    after: {
      snapshot: partialAfter,
      requestId: 'request-1',
      analysisId: 'analysis-1',
      projectId: 'project-1',
      refreshId: 'refresh-1',
      generationAtReadStart: 9,
      generationAfterRead: 9,
      sourceFingerprint: sourceAfter,
      confirmedSourceFingerprint: sourceAfter,
    },
    actions: [{ actionId: 'remove:a', packageName: 'a', status: 'completed' }],
  });
  assert.equal(result.status, 'partial');
  assert.equal(result.report.metrics.directDependencies.status, 'verified');
  assert.equal(result.report.metrics.vulnerabilities.status, 'unavailable');
  assert.equal(result.security, null);
});

test('partial update availability prevents an overall verified result without discarding complete security evidence', () => {
  const beforeSnapshot = snapshot([row('a')], { updates: 'partial' });
  const afterSnapshot = snapshot([], { updates: 'partial' });
  const result = buildSmartCleanupCompletionReport({
    operation,
    before: {
      snapshot: beforeSnapshot,
      projectId: 'project-1',
      sourceGeneration: 7,
      sourceFingerprint: sourceBefore,
      deprecatedDirectPackages: [],
      deprecationInstalledVersions: { a: '1.0.0' },
    },
    after: {
      snapshot: afterSnapshot,
      requestId: 'request-1',
      analysisId: 'analysis-1',
      projectId: 'project-1',
      refreshId: 'refresh-1',
      generationAtReadStart: 9,
      generationAfterRead: 9,
      sourceFingerprint: sourceAfter,
      confirmedSourceFingerprint: sourceAfter,
      deprecatedDirectPackages: [],
    },
    actions: [],
  });
  assert.equal(result.status, 'partial');
  assert.equal(result.report.metrics.vulnerabilities.status, 'verified');
  assert.notEqual(result.security, null);
});

test('a restored cleanup may verify equal snapshots without claiming an improvement', () => {
  const unchanged = snapshot([row('a')], { duplicates: ['shared'] });
  const result = buildSmartCleanupCompletionReport({
    operation,
    before: {
      snapshot: unchanged,
      projectId: 'project-1',
      sourceGeneration: 7,
      sourceFingerprint: sourceBefore,
      deprecatedDirectPackages: [],
      deprecationInstalledVersions: { a: '1.0.0' },
    },
    after: {
      snapshot: unchanged,
      requestId: 'request-1',
      analysisId: 'analysis-1',
      projectId: 'project-1',
      refreshId: 'refresh-1',
      generationAtReadStart: 9,
      generationAfterRead: 9,
      sourceFingerprint: sourceBefore,
      confirmedSourceFingerprint: sourceBefore,
      deprecatedDirectPackages: [],
    },
    actions: [{ actionId: 'remove:a', packageName: 'a', status: 'skipped', message: 'Restored' }],
  });
  assert.equal(result.status, 'verified');
  assert.equal(result.report.metrics.directDependencies.improvedBy, 0);
  assert.equal(result.report.metrics.duplicateVersionGroups.improvedBy, 0);
  assert.equal(result.report.metrics.vulnerabilities.improvedBy, 0);
  assert.deepEqual(result.security.removedAdvisories, []);
  assert.deepEqual(result.security.introducedAdvisories, []);
});
