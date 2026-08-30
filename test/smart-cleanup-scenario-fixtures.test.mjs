import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { computeSourceFingerprint } from '../out/core/cache/sourceFingerprint.js';
import {
  assessDuplicateConsolidation,
  buildCleanupReport,
  buildDeprecatedCleanupFinding,
  buildDuplicateCleanupFinding,
  buildRemovalCleanupFinding,
  resolveCleanupSelection,
  summarizeCleanup,
} from '../out/core/cleanup/index.js';
import { compareProposedGraphSecurityImpact } from '../out/host/proposedGraphSecurityImpact.js';
import { buildSmartCleanupCompletionReport } from '../out/host/smartCleanupCompletionReport.js';
import { isHostToWebviewMessage, isWebviewToHostMessage } from '../out/host/webviewProtocol.js';

const fixture = JSON.parse(
  await readFile(new URL('./fixtures/smart-cleanup/scenarios.json', import.meta.url), 'utf8')
);

function removal(options) {
  return buildRemovalCleanupFinding(options);
}

function edge(name, targetNodeId) {
  return { name, requestedRange: '*', kind: 'runtime', targetNodeId, optional: false };
}

function node(name, path, { version = '1.0.0', direct = false, edges = [] } = {}) {
  return {
    name,
    version,
    range: direct ? '*' : '',
    dev: false,
    direct,
    path,
    deps: edges.map((entry) => entry.name),
    edges,
  };
}

function graph(nodes) {
  return {
    root: '/fixture-project',
    packageManager: 'npm',
    lockfileVersion: 3,
    nodes: new Map(nodes.map((entry) => [entry.path, entry])),
  };
}

function snapshot(dependencyGraph, advisoriesByName, advisories = 'complete') {
  return { graph: dependencyGraph, advisoriesByName: new Map(advisoriesByName), advisories };
}

function attributed(advisory, flaggedPackage, path) {
  return {
    advisory,
    flaggedPackage,
    path,
    flaggedVersion: '3.3.7',
    patchedVersion: { status: 'known', version: '3.3.8' },
  };
}

function packageRow(name, advisories = []) {
  return {
    name,
    current: '1.0.0',
    wanted: '1.0.0',
    latest: '1.0.0',
    dev: false,
    optional: false,
    range: '^1.0.0',
    advisories,
    worstSeverity: advisories.length === 0 ? null : advisories[0].advisory.severity,
    upgradeTo: null,
    upgradeReason: null,
  };
}

function scanSnapshot(rows, { advisories = 'complete', updates = 'complete' } = {}) {
  return {
    rows,
    availability: {
      updates,
      advisories,
      unavailableUpdatePackages: updates === 'complete' ? [] : ['registry-unavailable'],
    },
    hygieneFindings: [],
  };
}

const sourceBefore = computeSourceFingerprint({
  manifestText: '{"dependencies":{"direct-root":"1.0.0"}}',
  lockfileText: 'before-cleanup',
  lockfilePath: '/fixture-project/package-lock.json',
});
const sourceAfter = computeSourceFingerprint({
  manifestText: '{"dependencies":{}}',
  lockfileText: 'after-cleanup',
  lockfilePath: '/fixture-project/package-lock.json',
});

function completionInput(beforeSnapshot, afterSnapshot, overrides = {}) {
  const operation = {
    requestId: 'cleanup-request-1',
    analysisId: 'cleanup-analysis-1',
    projectId: 'fixture-project',
    refreshId: 'cleanup-refresh-1',
    sourceGeneration: 4,
    sourceFingerprint: sourceBefore,
  };
  const before = {
    snapshot: beforeSnapshot,
    projectId: 'fixture-project',
    sourceGeneration: 4,
    sourceFingerprint: sourceBefore,
    deprecatedDirectPackages: [],
    deprecationInstalledVersions: { 'direct-root': '1.0.0' },
  };
  const after = {
    snapshot: afterSnapshot,
    requestId: 'cleanup-request-1',
    analysisId: 'cleanup-analysis-1',
    projectId: 'fixture-project',
    refreshId: 'cleanup-refresh-1',
    generationAtReadStart: 5,
    generationAfterRead: 5,
    sourceFingerprint: sourceAfter,
    confirmedSourceFingerprint: sourceAfter,
    deprecatedDirectPackages: [],
  };
  return {
    operation: { ...operation, ...(overrides.operation ?? {}) },
    before: { ...before, ...(overrides.before ?? {}) },
    after: { ...after, ...(overrides.after ?? {}) },
    actions: overrides.actions ?? [
      { actionId: 'remove:direct-root', packageName: 'direct-root', status: 'completed' },
    ],
    generatedAt: '2026-08-29T00:00:00.000Z',
  };
}

test('fixture: a safely removable direct dependency produces one host-owned default action', () => {
  const result = removal(fixture.removal.safe);

  assert.equal(result.finding.recommendation, 'remove');
  assert.equal(result.finding.confidence, 'low-risk');
  assert.equal(result.action?.packageName, 'unused-tool');
  assert.deepEqual(resolveCleanupSelection([result.action], [result.action.id]), {
    ok: true,
    actions: [result.action],
  });
  assert.equal(summarizeCleanup([result.finding], [result.action]).defaultSelectedActions, 1);
});

test('fixture: a peer-blocked dependency remains visible but cannot become executable', () => {
  const result = removal(fixture.removal.blocked);

  assert.equal(result.finding.recommendation, 'blocked');
  assert.equal(result.finding.confidence, 'blocked');
  assert.equal(result.action, null);
  assert.deepEqual(result.finding.relatedActionIds, []);
  assert.match(result.finding.evidence.at(-1).summary, /requires @tiptap\/pm as a peer dependency/i);
});

test('fixture: deprecated plus unused reuses the separately justified removal action', () => {
  const removable = removal(fixture.removal.safe);
  const finding = buildDeprecatedCleanupFinding({
    ...fixture.deprecated.unused,
    relatedRemovalAction: {
      id: removable.action.id,
      confidence: removable.action.confidence,
    },
  });

  assert.equal(finding.recommendation, 'remove-if-unused');
  assert.deepEqual(finding.relatedActionIds, [removable.action.id]);
  assert.deepEqual(finding.evidence[0], {
    kind: 'deprecation',
    message: fixture.deprecated.unused.message,
    suggestedReplacement: 'maintained-tool',
  });
});

test('fixture: deprecated plus used requires migration and never authorizes removal', () => {
  const finding = buildDeprecatedCleanupFinding(fixture.deprecated.used);

  assert.equal(finding.recommendation, 'remediation-required');
  assert.equal(finding.confidence, 'review-required');
  assert.deepEqual(finding.relatedActionIds, []);
});

test('fixture: a potentially convergent duplicate preserves exact versions without inventing an executable action', () => {
  const finding = buildDuplicateCleanupFinding(fixture.duplicates.convergent);

  assert.equal(finding.recommendation, 'analysis-only');
  assert.equal(finding.executable, false);
  assert.deepEqual(finding.evidence[0], {
    kind: 'duplicate-versions',
    versions: ['3.3.11', '3.3.8'],
    excessVersionCount: 1,
  });
});

test('fixture: complete package-manager evidence identifies a safely convergent duplicate', () => {
  const scenario = fixture.duplicates.convergent;
  const assessment = assessDuplicateConsolidation({
    packageName: scenario.packageName,
    resolvedVersions: scenario.versions,
    constraints: scenario.constraints,
    constraintsComplete: true,
    simulation: scenario.simulation,
  });

  assert.deepEqual(assessment, {
    outcome: 'safe-convergence',
    packageName: 'nanoid',
    currentVersions: ['3.3.8', '3.3.11'],
    targetVersion: '3.3.11',
    parentUpgrades: [],
    reason: 'The complete simulation converged on 3.3.11 without changing a direct parent dependency.',
  });
});

test('fixture: incompatible duplicate constraints produce an explicit keep-both result', () => {
  const finding = buildDuplicateCleanupFinding(fixture.duplicates.keepBoth);

  assert.equal(finding.recommendation, 'keep-both');
  assert.equal(finding.confidence, 'blocked');
  assert.equal(finding.executable, false);
  assert.deepEqual(finding.relatedActionIds, []);
});

test('fixture: complete conflicting peer constraints prove why duplicate versions must remain', () => {
  const scenario = fixture.duplicates.keepBoth;
  const assessment = assessDuplicateConsolidation({
    packageName: scenario.packageName,
    resolvedVersions: scenario.versions,
    constraints: scenario.constraints,
    constraintsComplete: true,
    simulation: scenario.simulation,
  });

  assert.equal(assessment.outcome, 'keep-both');
  assert.deepEqual(assessment.retainedVersions, ['17.0.2', '18.3.1']);
  assert.match(assessment.reason, /no retained version satisfies every supplied dependency and peer range/i);
});

test('fixture: removing the only vulnerable root reports one advisory identity removed, not one per path', () => {
  const vulnerablePath = 'node_modules/direct-root/node_modules/nanoid';
  const before = graph([
    node('direct-root', 'node_modules/direct-root', {
      direct: true,
      edges: [edge('nanoid', vulnerablePath)],
    }),
    node('nanoid', vulnerablePath, { version: '3.3.7' }),
  ]);
  const after = graph([]);
  const impact = compareProposedGraphSecurityImpact(
    snapshot(before, [['nanoid', [fixture.security.advisory]]]),
    snapshot(after, [])
  );

  assert.equal(impact.status, 'complete');
  assert.equal(impact.beforeOccurrenceCount, 1);
  assert.equal(impact.afterOccurrenceCount, 0);
  assert.equal(impact.fixed.length, 1);
  assert.equal(impact.fixed[0].identity, 'CVE-2024-55565');
  assert.deepEqual(impact.fixed[0].beforePaths, [['direct-root', 'nanoid']]);
});

test('fixture: correlated final snapshots turn the removed vulnerability into verified cleanup metrics', () => {
  const advisoryEntry = attributed(fixture.security.advisory, 'nanoid', ['direct-root', 'nanoid']);
  const before = scanSnapshot([packageRow('direct-root', [advisoryEntry])]);
  const after = scanSnapshot([]);
  const result = buildSmartCleanupCompletionReport(completionInput(before, after));

  assert.equal(result.status, 'verified');
  assert.equal(result.report.metrics.directDependencies.improvedBy, 1);
  assert.equal(result.report.metrics.vulnerabilities.before, 1);
  assert.equal(result.report.metrics.vulnerabilities.after, 0);
  assert.equal(result.report.metrics.vulnerabilities.improvedBy, 1);
  assert.equal(result.security.before.affectedDirectDependencies, 1);
  assert.equal(result.security.after.affectedDirectDependencies, 0);
  assert.equal(result.security.removedAdvisories.length, 1);
  assert.equal(result.security.removedAdvisories[0].sourceId, '1139427');
  assert.equal(result.security.removedAdvisories[0].identifiers.includes('CVE-2024-55565'), true);
});

test('fixture: watcher movement during the final reread fails closed as a stale result', () => {
  const input = completionInput(scanSnapshot([packageRow('direct-root')]), scanSnapshot([]), {
    after: { generationAfterRead: 6 },
  });
  const result = buildSmartCleanupCompletionReport(input);

  assert.equal(result.status, 'stale');
  assert.equal(result.code, 'STALE_AFTER_SOURCE');
  assert.equal(result.security, null);
  assert.equal(result.report.metrics.directDependencies.status, 'unavailable');
  assert.equal(result.report.metrics.vulnerabilities.status, 'unavailable');
  assert.doesNotMatch(result.report.headline, /removed|resolved|reduced/);
});

test('fixture: a partial final scan preserves verified local changes but withholds security results', () => {
  const before = scanSnapshot([packageRow('direct-root')]);
  const after = scanSnapshot([], { advisories: 'unavailable' });
  const result = buildSmartCleanupCompletionReport(completionInput(before, after));

  assert.equal(result.status, 'partial');
  assert.equal(result.report.metrics.directDependencies.improvedBy, 1);
  assert.equal(result.report.metrics.vulnerabilities.status, 'unavailable');
  assert.equal(result.security, null);
  assert.doesNotMatch(result.report.headline, /vulnerabilit(?:y|ies) resolved/);
});

test('fixture: a stale final snapshot yields unavailable metrics and no verified cleanup claim', () => {
  const reason = fixture.reports.stale.reason;
  const report = buildCleanupReport({
    generatedAt: '2026-08-29T00:00:00.000Z',
    metrics: {
      directDependencies: { before: null, after: null, unavailableReason: reason },
      deprecatedDirectDependencies: { before: null, after: null, unavailableReason: reason },
      duplicateVersionGroups: { before: null, after: null, unavailableReason: reason },
      vulnerabilities: { before: null, after: null, unavailableReason: reason },
    },
    actions: [{
      actionId: 'remove:unused-tool',
      packageName: 'unused-tool',
      status: 'failed',
      message: reason,
    }],
  });

  assert.equal(report.metrics.directDependencies.status, 'unavailable');
  assert.equal(report.metrics.vulnerabilities.status, 'unavailable');
  assert.match(report.headline, /1 cleanup action failed/);
  assert.doesNotMatch(report.headline, /removed|resolved|reduced/);
});

test('fixture: unavailable advisory verification does not erase verified dependency results', () => {
  const report = buildCleanupReport({
    generatedAt: '2026-08-29T00:00:00.000Z',
    metrics: {
      directDependencies: { before: 10, after: 9 },
      deprecatedDirectDependencies: { before: 1, after: 1 },
      duplicateVersionGroups: { before: 2, after: 2 },
      vulnerabilities: {
        before: null,
        after: null,
        unavailableReason: fixture.reports.unavailableSecurity.reason,
      },
    },
    actions: [{ actionId: 'remove:unused-tool', packageName: 'unused-tool', status: 'completed' }],
  });

  assert.equal(report.metrics.directDependencies.status, 'verified');
  assert.equal(report.metrics.directDependencies.improvedBy, 1);
  assert.deepEqual(report.metrics.vulnerabilities, {
    status: 'unavailable',
    reason: fixture.reports.unavailableSecurity.reason,
  });
  assert.match(report.headline, /1 direct dependency removed/);
  assert.doesNotMatch(report.headline, /vulnerabilit(?:y|ies) resolved/);
});

test('fixture: partial execution reports verified improvements and failed actions together', () => {
  const report = buildCleanupReport({
    generatedAt: '2026-08-29T00:00:00.000Z',
    metrics: {
      directDependencies: { before: 12, after: 11 },
      deprecatedDirectDependencies: { before: 2, after: 1 },
      duplicateVersionGroups: { before: 3, after: 3 },
      vulnerabilities: { before: 4, after: 3 },
    },
    actions: [
      { actionId: 'remove:legacy-unused', packageName: 'legacy-unused', status: 'completed' },
      { actionId: 'remove:blocked-late', packageName: 'blocked-late', status: 'failed', message: 'Source changed.' },
    ],
  });

  assert.match(report.headline, /1 direct dependency removed/);
  assert.match(report.headline, /1 vulnerability resolved/);
  assert.match(report.headline, /1 deprecated direct dependency removed/);
  assert.match(report.headline, /1 cleanup action failed/);
});

test('fixture: cancel plus successful rollback is a valid terminal removal state', () => {
  const cancellation = { type: 'cancel-remove', analysisId: 'analysis-cleanup-1', requestId: 'cleanup-1' };
  const rolledBack = {
    status: 'remove-result',
    result: {
      analysisId: 'analysis-cleanup-1',
      packages: ['unused-tool'],
      outcome: 'rolled-back',
      verification: 'not-run',
      rollback: 'succeeded',
      message: 'Cleanup was cancelled and dependency files were restored.',
    },
  };

  assert.equal(isWebviewToHostMessage(cancellation), true);
  assert.equal(isHostToWebviewMessage(rolledBack), true);
});

test('fixture: a cancelled and restored cleanup verifies unchanged snapshots without claiming gains', () => {
  const unchanged = scanSnapshot([packageRow('direct-root')]);
  const input = completionInput(unchanged, unchanged, {
    after: {
      sourceFingerprint: sourceBefore,
      confirmedSourceFingerprint: sourceBefore,
    },
    actions: [{
      actionId: 'remove:direct-root',
      packageName: 'direct-root',
      status: 'skipped',
      message: 'Cleanup was cancelled and dependency files were restored.',
    }],
  });
  const result = buildSmartCleanupCompletionReport(input);

  assert.equal(result.status, 'verified');
  assert.equal(result.report.metrics.directDependencies.improvedBy, 0);
  assert.equal(result.report.metrics.vulnerabilities.improvedBy, 0);
  assert.deepEqual(result.security.removedAdvisories, []);
  assert.deepEqual(result.security.introducedAdvisories, []);
  assert.doesNotMatch(result.report.headline, /removed|resolved|reduced/);
});
