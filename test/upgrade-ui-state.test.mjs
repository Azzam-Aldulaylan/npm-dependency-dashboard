/**
 * The webview's optimistic "which package is upgrading" state transitions —
 * pure, no React/DOM involved. See upgrade-action.test.mjs for why this repo
 * tests presentation logic this way instead of rendering components.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyUpgradeResultLocalFacts,
  manageRemovalReplacesUpgradeReview,
  targetChangeInvalidatesManageAnalysis,
  upgradeAnalysisMessageMatchesRequest,
  upgradeAnalysisRequestIsAllowed,
  upgradeErrorClearsActiveState,
  upgradeErrorIsUserVisible,
} from '../out/host/upgradeUiState.js';

test('post-upgrade local facts replace current/range/classification without inventing derived data', () => {
  const oldAdvisory = { id: 1 };
  const data = {
    rows: [{
      name: 'react', current: '18.3.1', range: '^18.3.1', dev: false, optional: false,
      wanted: '18.3.1', latest: '19.0.0', advisories: [oldAdvisory], worstSeverity: 'high', upgradeTo: '19.0.0', upgradeReason: 'update',
    }],
    availability: { updates: 'complete', advisories: 'complete', unavailableUpdatePackages: [] },
    generatedAt: '2026-01-01T00:00:00.000Z', project: { label: 'app', manifestPath: 'package.json' }, canChangeProject: false,
    hygieneFindings: [], extensionVersion: '0.0.1', builtAt: '2026-01-01T00:00:00.000Z',
  };
  const patched = applyUpgradeResultLocalFacts(data, {
    package: 'react', install: 'succeeded', application: 'applied', verification: 'not-configured', refreshingDerivedData: true,
    changes: [{ packageName: 'react', previousVersion: '18.3.1', requestedVersion: '19.0.0', currentVersion: '19.0.0', declaredRange: '^19.0.0', classification: 'dev' }],
  });

  assert.equal(patched.rows[0].current, '19.0.0');
  assert.equal(patched.rows[0].range, '^19.0.0');
  assert.equal(patched.rows[0].dev, true);
  assert.equal(patched.rows[0].optional, false);
  assert.equal(patched.rows[0].advisories, data.rows[0].advisories);
});

// ---------------------------------------------------------- starting analysis

test('an upgrade analysis can start only when no analysis is already active', () => {
  assert.equal(upgradeAnalysisRequestIsAllowed(null), true);
  assert.equal(upgradeAnalysisRequestIsAllowed('react'), false);
});

test('progressive results from a superseded target request are ignored', () => {
  assert.equal(upgradeAnalysisMessageMatchesRequest('target-b', 'target-a'), false);
  assert.equal(upgradeAnalysisMessageMatchesRequest(null, 'target-a'), false);
  assert.equal(upgradeAnalysisMessageMatchesRequest('target-b', 'target-b'), true);
});

test('changing target invalidates only the same Manage analysis', () => {
  assert.equal(
    targetChangeInvalidatesManageAnalysis('react', '18.3.1', '19.0.0', 'react', 'manage-dependency'),
    true
  );
  assert.equal(
    targetChangeInvalidatesManageAnalysis('react', '18.3.1', '18.3.1', 'react', 'manage-dependency'),
    false
  );
  assert.equal(targetChangeInvalidatesManageAnalysis('react', '18.3.1', '19.0.0', 'react', 'dashboard'), false);
  assert.equal(
    targetChangeInvalidatesManageAnalysis('react', '18.3.1', '19.0.0', 'lodash', 'manage-dependency'),
    false
  );
});

test('starting removal replaces only the same package embedded upgrade review', () => {
  assert.equal(manageRemovalReplacesUpgradeReview('react', 'react', 'manage-dependency'), true);
  assert.equal(manageRemovalReplacesUpgradeReview('react', null, 'manage-dependency'), false);
  assert.equal(manageRemovalReplacesUpgradeReview('react', 'lodash', 'manage-dependency'), false);
  assert.equal(manageRemovalReplacesUpgradeReview('react', 'react', 'dashboard'), false);
  assert.equal(manageRemovalReplacesUpgradeReview('react', 'react', null), false);
});

// ------------------------------------------------------- clearing active state

test('UPGRADE_IN_PROGRESS does not clear the active state — it is about a different, rejected request', () => {
  assert.equal(upgradeErrorClearsActiveState('UPGRADE_IN_PROGRESS'), false);
});

test('a real terminal outcome clears the active state', () => {
  for (const code of [
    'TASK_FAILED',
    'NPM_NOT_FOUND',
    'UNTRUSTED_WORKSPACE',
    'TASK_START_FAILED',
    'DISPOSED',
    'STALE_TARGET',
    'NO_ELIGIBLE_UPGRADE',
    'UNKNOWN_PACKAGE',
    'NO_SCAN_RESULT',
    'NOT_DECLARED',
    'UNSAFE_IDENTIFIER',
    'ROLLBACK_CONFLICT',
    'ROLLBACK_FAILED',
    'MANIFEST_STAGE_FAILED',
  ]) {
    assert.equal(upgradeErrorClearsActiveState(code), true, `${code} should clear active state`);
  }
});

test('cancellation before task start clears the active state', () => {
  assert.equal(upgradeErrorClearsActiveState('CANCELLED'), true);
});

// ------------------------------------------------------------ banner visibility

test('CANCELLED and UPGRADE_IN_PROGRESS are quiet — no banner', () => {
  assert.equal(upgradeErrorIsUserVisible('CANCELLED'), false);
  assert.equal(upgradeErrorIsUserVisible('UPGRADE_IN_PROGRESS'), false);
});

test('every other code is user-visible', () => {
  for (const code of [
    'TASK_FAILED',
    'NPM_NOT_FOUND',
    'UNTRUSTED_WORKSPACE',
    'STALE_TARGET',
    'ROLLBACK_CONFLICT',
    'ROLLBACK_FAILED',
    'MANIFEST_STAGE_FAILED',
  ]) {
    assert.equal(upgradeErrorIsUserVisible(code), true, `${code} should be visible`);
  }
});
