import assert from 'node:assert/strict';
import test from 'node:test';

import { computeSourceFingerprint } from '../out/core/cache/sourceFingerprint.js';
import { planWorkspaceAnalysisFiles } from '../out/core/usage/workspaceAnalysisPlan.js';
import {
  ForegroundUsageOperationRegistry,
  USAGE_ANALYSIS_REUSE_MS,
  UsageAnalysisState,
  canJoinBackgroundUsageScan,
  shouldCancelUnderlyingUsageScan,
  usageScanFailureAudience,
  foregroundUsageBusyMessage,
} from '../out/host/usage/usageAnalysisState.js';

function fingerprint(manifestText = '{}') {
  return computeSourceFingerprint({ manifestText, lockfileText: null, lockfilePath: null });
}

function usage(packageName, overrides = {}) {
  return {
    packageName,
    references: [],
    truncated: false,
    scannedFileCount: 10,
    scannedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

test('workspace plan reads overlapping JS/TS configs once and remains sorted', () => {
  const plan = planWorkspaceAnalysisFiles(
    ['src/z.ts', 'vite.config.ts', 'src/a.ts'],
    ['vitest.config.json', '.eslintrc', 'vite.config.ts']
  );
  assert.deepEqual(plan, [
    { key: '.eslintrc', source: false, config: true },
    { key: 'src/a.ts', source: true, config: false },
    { key: 'src/z.ts', source: true, config: false },
    { key: 'vite.config.ts', source: true, config: true },
    { key: 'vitest.config.json', source: false, config: true },
  ]);
});

test('cleanup results satisfy removal reuse only when every package is complete and current', () => {
  let now = 1_000;
  const state = new UsageAnalysisState(600_000, () => now);
  const identity = state.identity('project-a', fingerprint());
  state.set('project-a', 'a', identity, usage('a'));
  state.set('project-a', 'b', identity, usage('b'));
  assert.deepEqual([...state.getComplete('project-a', ['a', 'b'], identity).keys()], ['a', 'b']);
  assert.equal(state.getComplete('project-a', ['a', 'missing'], identity), undefined);

  state.set('project-a', 'b', identity, usage('b', { truncated: true }));
  assert.equal(state.getComplete('project-a', ['a', 'b'], identity), undefined);

  now += 600_001;
  assert.equal(state.getComplete('project-a', ['a'], identity), undefined);
});

test('usage reuse is project-wide for one hour and expires atomically at the boundary', () => {
  let now = 5_000;
  const state = new UsageAnalysisState(USAGE_ANALYSIS_REUSE_MS, () => now);
  const projectA = state.identity('project-a', fingerprint('{"name":"a"}'));
  const projectB = state.identity('project-b', fingerprint('{"name":"b"}'));
  state.set('project-a', 'alpha', projectA, usage('alpha'));
  state.set('project-a', 'beta', projectA, usage('beta'));
  state.set('project-b', 'alpha', projectB, usage('alpha'));

  now += USAGE_ANALYSIS_REUSE_MS - 1;
  assert.deepEqual([...state.getComplete('project-a', ['alpha', 'beta'], projectA).keys()], ['alpha', 'beta']);
  assert.notEqual(state.get('project-b', 'alpha', projectB), undefined, 'another project keeps its own cache');

  now += 1;
  assert.equal(state.getComplete('project-a', ['alpha', 'beta'], projectA), undefined);
  assert.equal(state.get('project-b', 'alpha', projectB), undefined);
});

test('source invalidation is project-scoped and supersedes old publication identity', () => {
  const state = new UsageAnalysisState(600_000);
  const a0 = state.identity('project-a', fingerprint());
  const b0 = state.identity('project-b', fingerprint());
  state.set('project-a', 'a', a0, usage('a'));
  state.set('project-b', 'b', b0, usage('b'));

  assert.equal(state.invalidate('project-a'), 1);
  assert.equal(state.isCurrent('project-a', a0), false);
  assert.equal(state.get('project-a', 'a', a0), undefined);
  assert.notEqual(state.get('project-b', 'b', b0), undefined);
  assert.equal(state.identity('project-a', fingerprint()).generation, 1);
});

test('compatible foreground consumers join only current background cleanup coverage', () => {
  const state = new UsageAnalysisState(600_000);
  const current = state.identity('project-a', fingerprint());
  const base = {
    backgroundOwner: true,
    scanProjectId: 'project-a',
    requestedProjectId: 'project-a',
    scanIdentity: current,
    requestedIdentity: current,
    scannedPackages: new Set(['a', 'b', 'c']),
    requestedPackages: ['a', 'c'],
  };
  assert.equal(canJoinBackgroundUsageScan(base), true);
  assert.equal(canJoinBackgroundUsageScan({ ...base, backgroundOwner: false }), false);
  assert.equal(canJoinBackgroundUsageScan({ ...base, requestedProjectId: 'project-b' }), false);
  assert.equal(canJoinBackgroundUsageScan({ ...base, requestedPackages: ['missing'] }), false);
  assert.equal(canJoinBackgroundUsageScan({
    ...base,
    requestedIdentity: { ...current, generation: current.generation + 1 },
  }), false);
});

test('joined-consumer cancellation does not cancel shared background work', () => {
  assert.equal(shouldCancelUnderlyingUsageScan(false), false);
  assert.equal(shouldCancelUnderlyingUsageScan(true), true);
});

test('foreground cancellation is scoped to the one request-visible operation', () => {
  const registry = new ForegroundUsageOperationRegistry();
  const cancelled = [];
  const first = registry.claim({ name: 'first', ownsScan: false });
  assert.notEqual(first, undefined);
  assert.equal(registry.claim({ name: 'concurrent', ownsScan: false }), undefined);

  registry.cancel(first, (value) => cancelled.push(value.name));
  assert.equal(first.cancelled, true);
  assert.deepEqual(cancelled, ['first']);
  registry.release(first);

  const second = registry.claim({ name: 'second', ownsScan: true });
  assert.notEqual(second, undefined);
  registry.cancel(first, (value) => cancelled.push(value.name));
  assert.equal(second.cancelled, false, 'a stale consumer cannot cancel its successor');
  registry.cancelActive((value) => cancelled.push(value.name));
  assert.equal(second.cancelled, true);
  assert.deepEqual(cancelled, ['first', 'second']);
});

test('foreground claim failures produce the existing usage and removal protocol errors', () => {
  assert.deepEqual(foregroundUsageBusyMessage('usage', 'react'), {
    status: 'usage-error',
    package: 'react',
    error: {
      code: 'ANALYSIS_IN_PROGRESS',
      message: 'Another usage analysis is already in progress for this project.',
    },
  });
  assert.deepEqual(foregroundUsageBusyMessage('removal'), {
    status: 'removal-impact-error',
    error: {
      code: 'ANALYSIS_IN_PROGRESS',
      message: 'Another usage analysis is already in progress for this project.',
    },
  });
});

test('background failures are quiet except through a waiting foreground consumer', () => {
  assert.equal(usageScanFailureAudience({ backgroundOwner: true, foregroundWaiters: 0 }), 'quiet');
  assert.equal(usageScanFailureAudience({ backgroundOwner: true, foregroundWaiters: 1 }), 'foreground');
  assert.equal(usageScanFailureAudience({ backgroundOwner: false, foregroundWaiters: 1 }), 'owner');
});
