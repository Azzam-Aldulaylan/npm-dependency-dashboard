/**
 * buildUpgradeAnalysisPresentation — assembles the one wire payload the
 * Upgrade Analysis modal renders from. Structured fields (findings, security
 * outcome, smart-plan changes) are passed through untouched; this file
 * covers the fields the function itself actually computes or branches on.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildUpgradeAnalysisChanges,
  buildUpgradeAnalysisFiles,
  buildUpgradeAnalysisPresentation,
  buildUpgradeAnalysisVerification,
} from '../out/host/upgradeAnalysisPresentation.js';

function baseOptions(overrides) {
  return {
    analysisId: 'abc123',
    analyzedAt: '2026-08-26T12:00:00.000Z',
    expiresAt: '2026-08-26T14:00:00.000Z',
    packageName: 'react-toastify',
    currentVersion: '10.0.6',
    targetVersion: '11.1.0',
    classification: 'prod',
    compatibility: { status: 'compatible', completeness: 'complete', findings: [] },
    security: null,
    smartPlan: null,
    verificationScriptNames: [],
    manifestPath: '/app/package.json',
    lockfilePath: '/app/package-lock.json',
    ...overrides,
  };
}

test('a major-version change is detected and reflected in majorUpdate', () => {
  const result = buildUpgradeAnalysisPresentation(baseOptions());
  assert.equal(result.majorUpdate, true);
});

test('a non-major change reports majorUpdate: false', () => {
  const result = buildUpgradeAnalysisPresentation(
    baseOptions({ currentVersion: '10.0.6', targetVersion: '10.1.0' })
  );
  assert.equal(result.majorUpdate, false);
});

test('no verification script names produces the not-configured shape', () => {
  const result = buildUpgradeAnalysisPresentation(baseOptions({ verificationScriptNames: [] }));
  assert.deepEqual(result.verification, { configured: false });
});

test('verification script names produce the configured shape with names preserved', () => {
  const result = buildUpgradeAnalysisPresentation(baseOptions({ verificationScriptNames: ['test', 'build'] }));
  assert.deepEqual(result.verification, { configured: true, scriptNames: ['test', 'build'] });
});

test('files always report rollback as available — every execution path this feeds guarantees the compare-and-swap restore applies', () => {
  const result = buildUpgradeAnalysisPresentation(baseOptions());
  assert.deepEqual(result.files, {
    manifestPath: '/app/package.json',
    lockfilePath: '/app/package-lock.json',
    rollbackAvailable: true,
  });
});

test('compatibility, security, and smartPlan are passed through structurally unchanged', () => {
  const compatibility = {
    status: 'warning',
    completeness: 'partial',
    findings: [
      {
        id: '["major-version-change","react-toastify","10.0.6","11.1.0"]',
        kind: 'major-version-change',
        status: 'warning',
        source: 'static',
        subject: { name: 'react-toastify', version: '11.1.0', nodeId: null },
        relation: { kind: 'direct', nodeIds: [], packageNames: ['react-toastify'] },
        explanation: 'react-toastify changes major version from 10.0.6 to 11.1.0.',
      },
    ],
  };
  const security = {
    status: 'resolved',
    resolvedAdvisories: [],
    remaining: [],
  };
  const smartPlan = { changes: [{ packageName: 'x', currentVersion: '1.0.0', targetVersion: '2.0.0' }], reasonFindingIds: [] };

  const result = buildUpgradeAnalysisPresentation(baseOptions({ compatibility, security, smartPlan }));

  assert.deepEqual(result.compatibility, compatibility);
  assert.deepEqual(result.security, security);
  assert.deepEqual(result.smartPlan, smartPlan);
});

test('analysisId, package, and version fields pass through unchanged', () => {
  const result = buildUpgradeAnalysisPresentation(baseOptions());
  assert.equal(result.analysisId, 'abc123');
  assert.equal(result.package, 'react-toastify');
  assert.equal(result.currentVersion, '10.0.6');
  assert.equal(result.targetVersion, '11.1.0');
  assert.equal(result.classification, 'prod');
  assert.deepEqual(result.changes, [{
    packageName: 'react-toastify',
    currentVersion: '10.0.6',
    targetVersion: '11.1.0',
    classification: 'prod',
    majorUpdate: true,
  }]);
});

test('coordinated changes are preserved and each computes its own major-update flag', () => {
  const result = buildUpgradeAnalysisPresentation(baseOptions({
    changes: [
      { packageName: 'react-toastify', currentVersion: '10.0.6', targetVersion: '11.1.0', classification: 'prod' },
      { packageName: 'typescript', currentVersion: '5.8.0', targetVersion: '5.9.0', classification: 'dev' },
    ],
  }));
  assert.deepEqual(result.changes.map(({ packageName, majorUpdate }) => ({ packageName, majorUpdate })), [
    { packageName: 'react-toastify', majorUpdate: true },
    { packageName: 'typescript', majorUpdate: false },
  ]);
});

test('analyzedAt passes through unchanged — the timestamp the coordinator computed once at final assembly', () => {
  const result = buildUpgradeAnalysisPresentation(baseOptions({ analyzedAt: '2026-08-26T09:15:00.000Z' }));
  assert.equal(result.analyzedAt, '2026-08-26T09:15:00.000Z');
});

test('expiresAt passes through unchanged from the exact stored-analysis deadline', () => {
  const result = buildUpgradeAnalysisPresentation(baseOptions({ expiresAt: '2026-08-26T13:59:59.000Z' }));
  assert.equal(result.expiresAt, '2026-08-26T13:59:59.000Z');
});

test('buildUpgradeAnalysisChanges produces the exact same shape buildUpgradeAnalysisPresentation embeds — the Stage-0 overview partial and the final object can never diverge', () => {
  const options = {
    packageName: 'react-toastify',
    currentVersion: '10.0.6',
    targetVersion: '11.1.0',
    classification: 'prod',
  };
  const standalone = buildUpgradeAnalysisChanges(options);
  const embedded = buildUpgradeAnalysisPresentation(baseOptions(options)).changes;
  assert.deepEqual(standalone, embedded);
});

test('buildUpgradeAnalysisVerification matches buildUpgradeAnalysisPresentation.verification for both the configured and not-configured cases', () => {
  assert.deepEqual(buildUpgradeAnalysisVerification([]), { configured: false });
  assert.deepEqual(buildUpgradeAnalysisVerification(['test', 'build']), { configured: true, scriptNames: ['test', 'build'] });
});

test('buildUpgradeAnalysisFiles matches buildUpgradeAnalysisPresentation.files, including the always-true rollback guarantee', () => {
  assert.deepEqual(buildUpgradeAnalysisFiles('/app/package.json', '/app/package-lock.json'), {
    manifestPath: '/app/package.json',
    lockfilePath: '/app/package-lock.json',
    rollbackAvailable: true,
  });
});
