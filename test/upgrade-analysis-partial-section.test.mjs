/**
 * applyPartialSection / markPhaseLoading — the pure client-side state
 * machine the progressive Upgrade review UI drives from streamed
 * `UpgradeAnalysisPartialSection` messages. See src/host/upgradeAnalysisSections.ts.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyPartialSection,
  markPhaseLoading,
  WAITING_UPGRADE_ANALYSIS_SECTIONS,
} from '../out/host/upgradeAnalysisSections.js';

const OVERVIEW = {
  kind: 'overview',
  currentVersion: '10.0.6',
  targetVersion: '11.1.0',
  classification: 'prod',
  majorUpdate: true,
  changes: [{ packageName: 'react-toastify', currentVersion: '10.0.6', targetVersion: '11.1.0', classification: 'prod', majorUpdate: true }],
  verification: { configured: false },
  files: { manifestPath: '/app/package.json', lockfilePath: '/app/package-lock.json', rollbackAvailable: true },
};

const COMPATIBLE = { kind: 'compatibility', compatibility: { status: 'compatible', completeness: 'complete', findings: [] } };
const CONFLICT = { kind: 'compatibility', compatibility: { status: 'conflict', completeness: 'complete', findings: [] } };

test('a fresh attempt starts every section waiting', () => {
  assert.deepEqual(WAITING_UPGRADE_ANALYSIS_SECTIONS, {
    overview: { status: 'waiting' },
    compatibility: { status: 'waiting' },
    projectCompatibility: { status: 'waiting' },
    security: { status: 'waiting' },
    smartPlan: { status: 'waiting' },
  });
});

test('overview settles to complete with its own value, leaving every other section untouched', () => {
  const next = applyPartialSection(WAITING_UPGRADE_ANALYSIS_SECTIONS, OVERVIEW);
  assert.deepEqual(next.overview, {
    status: 'complete',
    value: {
      currentVersion: '10.0.6',
      targetVersion: '11.1.0',
      classification: 'prod',
      majorUpdate: true,
      changes: OVERVIEW.changes,
      verification: OVERVIEW.verification,
      files: OVERVIEW.files,
    },
  });
  assert.deepEqual(next.compatibility, { status: 'waiting' });
  assert.deepEqual(next.projectCompatibility, { status: 'waiting' });
  assert.deepEqual(next.security, { status: 'waiting' });
  assert.deepEqual(next.smartPlan, { status: 'waiting' });
});

test('a non-conflict compatibility result settles smartPlan to not-applicable in the same update', () => {
  const next = applyPartialSection(WAITING_UPGRADE_ANALYSIS_SECTIONS, COMPATIBLE);
  assert.deepEqual(next.compatibility, { status: 'complete', value: COMPATIBLE.compatibility });
  assert.deepEqual(next.smartPlan, { status: 'not-applicable' });
});

test('a conflict compatibility result leaves smartPlan waiting for its own partial', () => {
  const next = applyPartialSection(WAITING_UPGRADE_ANALYSIS_SECTIONS, CONFLICT);
  assert.deepEqual(next.compatibility, { status: 'complete', value: CONFLICT.compatibility });
  assert.deepEqual(next.smartPlan, { status: 'waiting' });
});

test('a smart-plan partial with a null plan still settles the section to complete, not stuck loading', () => {
  const afterConflict = applyPartialSection(WAITING_UPGRADE_ANALYSIS_SECTIONS, CONFLICT);
  const next = applyPartialSection(afterConflict, { kind: 'smart-plan', smartPlan: null });
  assert.deepEqual(next.smartPlan, { status: 'complete', value: null });
});

test('a real smart-plan partial settles the section to complete with its own value', () => {
  const smartPlan = { changes: [{ packageName: 'x', currentVersion: '1.0.0', targetVersion: '2.0.0' }], reasonFindingIds: [] };
  const afterConflict = applyPartialSection(WAITING_UPGRADE_ANALYSIS_SECTIONS, CONFLICT);
  const next = applyPartialSection(afterConflict, { kind: 'smart-plan', smartPlan });
  assert.deepEqual(next.smartPlan, { status: 'complete', value: smartPlan });
});

test('security settles to complete even with a null value — no advisories to evaluate is a real, resolved answer', () => {
  const next = applyPartialSection(WAITING_UPGRADE_ANALYSIS_SECTIONS, { kind: 'security', security: null });
  assert.deepEqual(next.security, { status: 'complete', value: null });
});

test('an already-complete smartPlan is never regressed by a late, out-of-order compatibility partial', () => {
  const afterConflict = applyPartialSection(WAITING_UPGRADE_ANALYSIS_SECTIONS, CONFLICT);
  const afterPlan = applyPartialSection(afterConflict, { kind: 'smart-plan', smartPlan: null });
  // A duplicate/out-of-order compatibility partial (should never happen host-side,
  // but the client-side reducer must not corrupt state if it did) must not
  // clobber the smartPlan section that already settled.
  const next = applyPartialSection(afterPlan, COMPATIBLE);
  assert.deepEqual(next.smartPlan, { status: 'complete', value: null });
});

test('markPhaseLoading moves only the named, still-waiting section to loading', () => {
  const next = markPhaseLoading(WAITING_UPGRADE_ANALYSIS_SECTIONS, 'compatibility');
  assert.deepEqual(next.compatibility, { status: 'loading' });
  assert.deepEqual(next.smartPlan, { status: 'waiting' });
});

test('project compatibility can load and settle repeatedly as medium and deep analyzers arrive', () => {
  const loading = markPhaseLoading(WAITING_UPGRADE_ANALYSIS_SECTIONS, 'project-compatibility');
  assert.deepEqual(loading.projectCompatibility, { status: 'loading' });
  const mediumFinding = {
    id: 'next:15.5.24:config',
    category: 'config',
    confidence: 'confirmed',
    packageName: 'next',
    targetVersion: '15.5.24',
    title: 'Configuration migration required',
    explanation: 'The selected target renamed this configuration key.',
    evidence: [],
    source: 'framework-rule',
  };
  const medium = {
    identity: { packageName: 'next', currentVersion: '14.2.35', targetVersion: '15.5.24', requestId: 'req-1', sourceFingerprint: 'source-1' },
    findings: [mediumFinding],
    analyzers: [{ analyzerId: 'next-migration-rules', status: 'complete', findings: [mediumFinding] }],
    startedAt: '2026-08-26T10:00:00.000Z',
    completedAt: '2026-08-26T10:00:00.010Z',
  };
  const mediumState = applyPartialSection(loading, { kind: 'project-compatibility', projectCompatibility: medium });
  assert.equal(mediumState.projectCompatibility.value.analyzers.length, 1);
  assert.deepEqual(mediumState.projectCompatibility.value.findings, [mediumFinding],
    'medium findings are immediately inspectable before deep import resolution settles');
  const importFinding = {
    ...mediumFinding,
    id: 'next:15.5.24:import',
    category: 'import',
    title: 'Import compatibility issue',
    explanation: 'The imported target file is absent.',
    source: 'generic',
  };
  const deep = {
    ...medium,
    findings: [mediumFinding, importFinding],
    analyzers: [
      ...medium.analyzers,
      { analyzerId: 'import-compatibility', status: 'complete', findings: [importFinding] },
    ],
    completedAt: '2026-08-26T10:00:00.020Z',
  };
  const deepState = applyPartialSection(mediumState, { kind: 'project-compatibility', projectCompatibility: deep });
  assert.deepEqual(deepState.projectCompatibility, { status: 'complete', value: deep });
  assert.equal(deepState.projectCompatibility.value.findings.filter((finding) => finding.id === mediumFinding.id).length, 1,
    'the repeated partial replaces the settled value instead of duplicating medium findings');
});

test('markPhaseLoading is a no-op once the section has already settled', () => {
  const settled = applyPartialSection(WAITING_UPGRADE_ANALYSIS_SECTIONS, COMPATIBLE);
  const next = markPhaseLoading(settled, 'compatibility');
  assert.deepEqual(next.compatibility, { status: 'complete', value: COMPATIBLE.compatibility });
});
