/**
 * resolveAnalysisForExecution — the pure security-boundary decision behind
 * confirm-upgrade/use-smart-plan, extracted from UpgradeAssistantCoordinator
 * (which imports `vscode` and so has no unit test outside the extension
 * host — see that module's own header) specifically so this decision does.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveAnalysisForExecution } from '../out/host/upgradeAnalysisLookup.js';

function summary(overrides) {
  return {
    id: 'real-analysis-id',
    compatibilityStatus: 'compatible',
    hasSmartPlan: false,
    expiresAt: 1_000_000,
    ...overrides,
  };
}

const BASE = { requestedAnalysisId: 'real-analysis-id', now: 500_000, wantsSmartPlan: false };

test('a matching, unexpired, non-conflicting analysis is accepted', () => {
  const result = resolveAnalysisForExecution({ ...BASE, stored: summary() });
  assert.deepEqual(result, { ok: true });
});

test('no stored analysis at all is rejected as stale', () => {
  const result = resolveAnalysisForExecution({ ...BASE, stored: undefined });
  assert.deepEqual(result, { ok: false, reason: 'STALE_ANALYSIS' });
});

test('a forged analysis id — one that does not match what is actually stored — is rejected as stale', () => {
  const result = resolveAnalysisForExecution({
    ...BASE,
    stored: summary({ id: 'the-real-one' }),
    requestedAnalysisId: 'forged-id',
  });
  assert.deepEqual(result, { ok: false, reason: 'STALE_ANALYSIS' });
});

test('an expired analysis is rejected as stale even with the correct id', () => {
  const result = resolveAnalysisForExecution({
    ...BASE,
    stored: summary({ expiresAt: 100 }),
    now: 200,
  });
  assert.deepEqual(result, { ok: false, reason: 'STALE_ANALYSIS' });
});

test('exactly at the expiry instant is already expired (not expired is a strict now < expiresAt)', () => {
  const result = resolveAnalysisForExecution({
    ...BASE,
    stored: summary({ expiresAt: 500_000 }),
    now: 500_000,
  });
  assert.deepEqual(result, { ok: false, reason: 'STALE_ANALYSIS' });
});

test('confirm-upgrade on a real conflict analysis is rejected — a plain upgrade is never offered for a conflict', () => {
  const result = resolveAnalysisForExecution({
    ...BASE,
    stored: summary({ compatibilityStatus: 'conflict', hasSmartPlan: true }),
    wantsSmartPlan: false,
  });
  assert.deepEqual(result, { ok: false, reason: 'PREFLIGHT_CONFLICT' });
});

test('confirm-upgrade on a warning-status analysis is accepted', () => {
  const result = resolveAnalysisForExecution({
    ...BASE,
    stored: summary({ compatibilityStatus: 'warning' }),
    wantsSmartPlan: false,
  });
  assert.deepEqual(result, { ok: true });
});

test('use-smart-plan against an analysis that never offered one is rejected — a plan can never be confirmed that was not actually offered', () => {
  const result = resolveAnalysisForExecution({
    ...BASE,
    stored: summary({ compatibilityStatus: 'conflict', hasSmartPlan: false }),
    wantsSmartPlan: true,
  });
  assert.deepEqual(result, { ok: false, reason: 'NO_SMART_PLAN' });
});

test('use-smart-plan against an analysis with a real offered plan is accepted, even though the base status is conflict', () => {
  const result = resolveAnalysisForExecution({
    ...BASE,
    stored: summary({ compatibilityStatus: 'conflict', hasSmartPlan: true }),
    wantsSmartPlan: true,
  });
  assert.deepEqual(result, { ok: true });
});

test('a stale/forged id is rejected before the smart-plan/conflict checks ever run', () => {
  // hasSmartPlan: false AND wantsSmartPlan: true would independently reject
  // as NO_SMART_PLAN — the id mismatch must win, confirming staleness is
  // checked first, not derived from which specific field looks wrong.
  const result = resolveAnalysisForExecution({
    ...BASE,
    stored: summary({ id: 'a-different-id', hasSmartPlan: false }),
    wantsSmartPlan: true,
  });
  assert.deepEqual(result, { ok: false, reason: 'STALE_ANALYSIS' });
});
