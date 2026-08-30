import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_SMART_CLEANUP_ACTIONS,
  buildCleanupReport,
  buildDeprecatedCleanupFinding,
  buildDuplicateCleanupFinding,
  buildRemovalCleanupFinding,
  canonicalCleanupActionBatch,
  cleanupSummaryHeadline,
  defaultCleanupActionIds,
  rankCleanupFindings,
  resolveCleanupSelection,
  summarizeCleanup,
} from '../../../out/core/cleanup/index.js';

function removal(overrides = {}) {
  return buildRemovalCleanupFinding({
    findingId: 'finding:left-pad',
    actionId: 'action:left-pad',
    packageName: 'left-pad',
    classification: 'prod',
    directUsage: 'not-found',
    transitivelyPresent: false,
    assessment: { status: 'low-risk', evidence: [] },
    ...overrides,
  });
}

function action(id, packageName, confidence = 'low-risk') {
  return {
    id,
    kind: 'remove-direct-dependency',
    packageName,
    classification: 'prod',
    confidence,
    reason: 'test evidence',
    sourceFindingIds: [`finding:${packageName}`],
  };
}

test('direct project use always keeps the direct declaration', () => {
  const result = removal({
    directUsage: 'used',
    transitivelyPresent: true,
    assessment: { status: 'low-risk', evidence: [] },
  });
  assert.equal(result.finding.confidence, 'blocked');
  assert.equal(result.finding.recommendation, 'keep-direct');
  assert.equal(result.action, null);
  assert.deepEqual(result.finding.relatedActionIds, []);
  assert.equal(summarizeCleanup([result.finding], []).opportunities, 0);
});

test('transitive presence contributes zero removal confidence', () => {
  const absent = removal({ transitivelyPresent: false });
  const present = removal({ transitivelyPresent: true });
  assert.equal(absent.finding.confidence, present.finding.confidence);
  assert.equal(absent.finding.recommendation, present.finding.recommendation);
  assert.equal(absent.action?.confidence, present.action?.confidence);
  assert.ok(present.finding.evidence.some((entry) => entry.kind === 'transitive-presence'));
});

test('incomplete direct-usage evidence can never produce an action', () => {
  const result = removal({ directUsage: 'unknown' });
  assert.equal(result.finding.confidence, 'unknown');
  assert.equal(result.action, null);
});

test('review-required removal is executable only by deliberate selection and is not selected by default', () => {
  const result = removal({
    assessment: {
      status: 'review',
      evidence: [{ kind: 'config-reference', summary: 'Referenced by eslint.config.js' }],
    },
  });
  assert.equal(result.finding.recommendation, 'review-removal');
  assert.equal(result.action?.confidence, 'review-required');
  assert.deepEqual(defaultCleanupActionIds([result.action]), []);
  assert.equal(resolveCleanupSelection([result.action], [result.action.id]).ok, true);
});

test('duplicate findings are typed as analysis-only and cannot carry actions', () => {
  const finding = buildDuplicateCleanupFinding({
    findingId: 'duplicate:shared',
    packageName: 'shared',
    versions: ['2.0.0', '1.0.0', '2.0.0'],
  });
  assert.equal(finding.executable, false);
  assert.equal(finding.recommendation, 'analysis-only');
  assert.deepEqual(finding.relatedActionIds, []);
  assert.deepEqual(finding.evidence[0], {
    kind: 'duplicate-versions',
    versions: ['1.0.0', '2.0.0'],
    excessVersionCount: 1,
  });
});

test('a duplicate finding rejects fewer than two distinct versions', () => {
  assert.throws(
    () => buildDuplicateCleanupFinding({ findingId: 'duplicate:x', packageName: 'x', versions: ['1.0.0', '1.0.0'] }),
    /at least two distinct versions/
  );
});

test('used deprecated packages require remediation and never gain an automatic replacement action', () => {
  const finding = buildDeprecatedCleanupFinding({
    findingId: 'deprecated:request',
    packageName: 'request',
    message: 'This package is deprecated. Use fetch instead.',
    directUsage: 'used',
    suggestedReplacement: 'fetch',
  });
  assert.equal(finding.recommendation, 'remediation-required');
  assert.equal(finding.confidence, 'review-required');
  assert.deepEqual(finding.relatedActionIds, []);
});

test('a deprecated finding inherits, but never upgrades, a separately justified removal confidence', () => {
  const finding = buildDeprecatedCleanupFinding({
    findingId: 'deprecated:legacy-tool',
    packageName: 'legacy-tool',
    message: 'This package is deprecated.',
    directUsage: 'not-found',
    relatedRemovalAction: { id: 'remove:legacy-tool', confidence: 'review-required' },
  });
  assert.equal(finding.recommendation, 'remove-if-unused');
  assert.equal(finding.confidence, 'review-required');
  assert.deepEqual(finding.relatedActionIds, ['remove:legacy-tool']);
});

test('canonical action ranking and the 150-action cap are shared by defaults and selection', () => {
  const actions = Array.from({ length: MAX_SMART_CLEANUP_ACTIONS + 2 }, (_, index) =>
    action(`action:${index}`, `package-${String(index).padStart(3, '0')}`, index === 0 ? 'review-required' : 'low-risk')
  ).reverse();
  const batch = canonicalCleanupActionBatch(actions);
  assert.equal(batch.actions.length, 150);
  assert.equal(batch.overflowCount, 2);
  assert.ok(batch.actions.every((entry, index, all) => index === 0 || all[index - 1].packageName <= entry.packageName || all[index - 1].confidence === 'low-risk'));

  const defaults = defaultCleanupActionIds(actions);
  assert.equal(defaults.length, 150, 'the review action sorts after low-risk actions and falls outside the capped batch');

  const overflow = actions.find((entry) => !batch.actions.some((candidate) => candidate.id === entry.id));
  assert.ok(overflow);
  assert.deepEqual(resolveCleanupSelection(actions, [overflow.id]), {
    ok: false,
    code: 'UNKNOWN_ACTION_ID',
    actionId: overflow.id,
  });

  const summary = summarizeCleanup([], actions);
  assert.equal(summary.executableActions, 150);
  assert.equal(summary.actionOverflow, 2);
});

test('duplicate action ids fail closed even when one duplicate is beyond the executable cap', () => {
  const actions = Array.from({ length: MAX_SMART_CLEANUP_ACTIONS + 1 }, (_, index) =>
    action(`action:${index}`, `package-${String(index).padStart(3, '0')}`)
  );
  actions[MAX_SMART_CLEANUP_ACTIONS].id = actions[0].id;
  assert.deepEqual(resolveCleanupSelection(actions, []), {
    ok: false,
    code: 'DUPLICATE_ACTION_ID',
    actionId: actions[0].id,
  });
});

test('selection fails closed for duplicate plan ids, repeated requested ids, and forged ids', () => {
  const duplicatePlan = [action('same', 'a'), action('same', 'b')];
  assert.deepEqual(resolveCleanupSelection(duplicatePlan, []), {
    ok: false,
    code: 'DUPLICATE_ACTION_ID',
    actionId: 'same',
  });
  assert.deepEqual(resolveCleanupSelection([action('one', 'a')], ['one', 'one']), {
    ok: false,
    code: 'DUPLICATE_REQUESTED_ID',
    actionId: 'one',
  });
  assert.deepEqual(resolveCleanupSelection([action('one', 'a')], ['forged']), {
    ok: false,
    code: 'UNKNOWN_ACTION_ID',
    actionId: 'forged',
  });
});

test('findings and summary are deterministic and duplicate counts remain informational', () => {
  const removable = removal();
  const deprecated = buildDeprecatedCleanupFinding({
    findingId: 'deprecated:z',
    packageName: 'z',
    message: 'deprecated',
    directUsage: 'used',
  });
  const duplicate = buildDuplicateCleanupFinding({
    findingId: 'duplicate:a',
    packageName: 'a',
    versions: ['1.0.0', '2.0.0', '3.0.0'],
  });
  const findings = [duplicate, deprecated, removable.finding];
  assert.deepEqual(rankCleanupFindings(findings).map((finding) => finding.kind), [
    'unused',
    'deprecated',
    'duplicate-version',
  ]);
  const summary = summarizeCleanup(findings, [removable.action]);
  assert.deepEqual(summary, {
    opportunities: 3,
    unused: 1,
    deprecated: 1,
    duplicateVersionGroups: 1,
    duplicateExcessVersions: 2,
    executableActions: 1,
    actionOverflow: 0,
    defaultSelectedActions: 1,
    reviewRequiredActions: 0,
    blockedFindings: 0,
    unknownFindings: 0,
  });
  assert.equal(cleanupSummaryHeadline(summary), '3 cleanup opportunities · 1 recommended removal · 1 duplicate-version group');
});

test('completion headline uses only verified improvements and preserves regressions separately', () => {
  const report = buildCleanupReport({
    generatedAt: '2026-08-29T00:00:00.000Z',
    metrics: {
      directDependencies: { before: 10, after: 8 },
      deprecatedDirectDependencies: { before: null, after: null, unavailableReason: 'Registry unavailable.' },
      duplicateVersionGroups: { before: 3, after: 3 },
      vulnerabilities: { before: 1, after: 2 },
    },
    actions: [{ actionId: 'a', packageName: 'left-pad', status: 'completed' }],
  });
  assert.equal(report.headline, '2 direct dependencies removed · 1 vulnerability introduced');
  assert.equal(report.metrics.vulnerabilities.status, 'verified');
  assert.equal(report.metrics.vulnerabilities.regressedBy, 1);
  assert.equal(report.metrics.deprecatedDirectDependencies.status, 'unavailable');
});
