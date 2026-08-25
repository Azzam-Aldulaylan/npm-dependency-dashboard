/**
 * The webview's optimistic "which package is upgrading" state transitions —
 * pure, no React/DOM involved. See upgrade-action.test.mjs for why this repo
 * tests presentation logic this way instead of rendering components.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  manageRemovalReplacesUpgradeReview,
  upgradeAnalysisRequestIsAllowed,
  upgradeErrorClearsActiveState,
  upgradeErrorIsUserVisible,
} from '../out/host/upgradeUiState.js';

// ---------------------------------------------------------- starting analysis

test('an upgrade analysis can start only when no analysis is already active', () => {
  assert.equal(upgradeAnalysisRequestIsAllowed(null), true);
  assert.equal(upgradeAnalysisRequestIsAllowed('react'), false);
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
