import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';

const stateSource = readFileSync(join(process.cwd(), 'webview/src/smartCleanupState.ts'), 'utf8');
const stateJavaScript = ts.transpileModule(stateSource, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ES2022,
  },
}).outputText;
const state = await import(`data:text/javascript;base64,${Buffer.from(stateJavaScript).toString('base64')}`);

function recommendation(index, confidence) {
  return {
    id: `action-${index}`,
    kind: 'remove-direct-dependency',
    packageName: `package-${index}`,
    dependencyType: 'production',
    confidence,
    rationale: 'Test evidence.',
    evidence: ['No project usage found.'],
  };
}

function plan(requestId, recommendations) {
  return {
    planId: `plan-${requestId}`,
    requestId,
    projectName: 'fixture',
    generatedAt: '2026-08-29T00:00:00.000Z',
    recommendations,
    deprecated: [],
    duplicates: [],
    security: [],
  };
}

function analyzing(requestId = 'request-1') {
  return state.smartCleanupReducer(state.createSmartCleanupState('fixture'), {
    type: 'analysis-started',
    projectName: 'fixture',
    requestId,
    steps: [],
  });
}

test('ready plans select only the first 150 safe direct-removal actions', () => {
  const recommendations = [
    ...Array.from({ length: 151 }, (_, index) => recommendation(index, 'safe')),
    recommendation(151, 'review'),
    recommendation(152, 'blocked'),
    recommendation(153, 'unknown'),
  ];
  const ready = state.smartCleanupReducer(analyzing(), {
    type: 'analysis-ready',
    requestId: 'request-1',
    plan: plan('request-1', recommendations),
  });

  assert.equal(ready.phase, 'ready');
  assert.equal(ready.selectedActionIds.size, state.SMART_CLEANUP_MAX_ACTIONS);
  assert.equal(ready.selectedActionIds.has('action-149'), true);
  assert.equal(ready.selectedActionIds.has('action-150'), false);
  assert.equal(ready.selectedActionIds.has('action-151'), false);
});

test('review-required actions are explicit opt-ins while blocked and unknown actions stay unselectable', () => {
  const ready = state.smartCleanupReducer(analyzing(), {
    type: 'analysis-ready',
    requestId: 'request-1',
    plan: plan('request-1', [
      recommendation(0, 'safe'),
      recommendation(1, 'review'),
      recommendation(2, 'blocked'),
      recommendation(3, 'unknown'),
    ]),
  });

  const blockedBeforeReview = state.smartCleanupReducer(ready, { type: 'toggle-reviewed-action', actionId: 'action-1' });
  assert.equal(blockedBeforeReview.selectedActionIds.has('action-1'), false);

  const reviewed = state.smartCleanupReducer(ready, { type: 'review-action', actionId: 'action-1' });
  assert.equal(reviewed.selectedActionIds.has('action-1'), false);
  assert.equal(reviewed.reviewedActionIds.has('action-1'), true);

  const included = state.smartCleanupReducer(reviewed, { type: 'toggle-reviewed-action', actionId: 'action-1' });
  assert.equal(included.selectedActionIds.has('action-1'), true);

  const blocked = state.smartCleanupReducer(included, { type: 'toggle-safe-action', actionId: 'action-2' });
  const unknown = state.smartCleanupReducer(blocked, { type: 'toggle-safe-action', actionId: 'action-3' });
  assert.deepEqual([...unknown.selectedActionIds], [...included.selectedActionIds]);
});

test('late results are ignored and stale evidence clears mutation authority', () => {
  const current = analyzing('current-request');
  const afterLateResult = state.smartCleanupReducer(current, {
    type: 'analysis-ready',
    requestId: 'old-request',
    plan: plan('old-request', [recommendation(0, 'safe')]),
  });
  assert.equal(afterLateResult, current);

  const ready = state.smartCleanupReducer(current, {
    type: 'analysis-ready',
    requestId: 'current-request',
    plan: plan('current-request', [recommendation(0, 'safe')]),
  });
  const stale = state.smartCleanupReducer(ready, { type: 'source-stale', message: 'Analyze again.' });
  assert.equal(stale.phase, 'stale');
  assert.equal(stale.selectedActionIds.size, 0);
});

test('confirmation and protected execution states preserve the close safety boundary', () => {
  const ready = state.smartCleanupReducer(analyzing(), {
    type: 'analysis-ready',
    requestId: 'request-1',
    plan: plan('request-1', [recommendation(0, 'safe')]),
  });
  const confirming = state.smartCleanupReducer(ready, { type: 'show-confirmation' });
  const executing = state.smartCleanupReducer(confirming, {
    type: 'execution-started',
    total: 1,
    currentLabel: 'Removing package-0',
  });
  const rollingBack = state.smartCleanupReducer(executing, {
    type: 'rollback-started',
    message: 'Restoring files.',
  });

  assert.equal(confirming.phase, 'confirming');
  assert.equal(state.canCloseSmartCleanup(confirming), true);
  assert.equal(state.canCloseSmartCleanup(executing), false);
  assert.equal(state.canCloseSmartCleanup(rollingBack), false);
});

test('a final-check warning can keep one dependency and requires a new checked plan', () => {
  const ready = state.smartCleanupReducer(analyzing(), {
    type: 'analysis-ready',
    requestId: 'request-1',
    plan: plan('request-1', [recommendation(0, 'safe'), recommendation(1, 'safe')]),
  });
  const confirming = state.smartCleanupReducer(ready, { type: 'show-confirmation' });
  const revised = state.smartCleanupReducer(confirming, { type: 'keep-dependency', actionId: 'action-0' });

  assert.equal(revised.phase, 'confirming');
  assert.equal(revised.selectedActionIds.has('action-0'), false);
  assert.equal(revised.selectedActionIds.has('action-1'), true);

  const empty = state.smartCleanupReducer(revised, { type: 'keep-dependency', actionId: 'action-1' });
  assert.equal(empty.phase, 'ready');
  assert.equal(empty.selectedActionIds.size, 0);
});

test('a pre-mutation rejection returns to review without inventing rollback work', () => {
  const ready = state.smartCleanupReducer(analyzing(), {
    type: 'analysis-ready',
    requestId: 'request-1',
    plan: plan('request-1', [recommendation(0, 'safe')]),
  });
  const confirming = state.smartCleanupReducer(ready, { type: 'show-confirmation' });
  const rejected = state.smartCleanupReducer(confirming, {
    type: 'operation-rejected',
    message: 'The dependency is required as a peer. No cleanup changes were made.',
  });

  assert.equal(rejected.phase, 'ready');
  assert.equal(rejected.result, null);
  assert.equal(rejected.selectedActionIds.has('action-0'), true);
  assert.match(rejected.message, /No cleanup changes were made/);
});

test('a completed review is reusable only for the same fresh project snapshot', () => {
  const ready = state.smartCleanupReducer(analyzing(), {
    type: 'analysis-ready',
    requestId: 'request-1',
    plan: plan('request-1', [recommendation(0, 'safe')]),
  });
  const cache = {
    projectKey: 'workspace\0package.json',
    dashboardGeneratedAt: '2026-08-29T10:00:00.000Z',
    expiresAt: 10_000,
  };
  assert.equal(state.smartCleanupReviewIsReusable(ready, cache, {
    projectKey: cache.projectKey,
    dashboardGeneratedAt: cache.dashboardGeneratedAt,
  }, 9_999), true);
  assert.equal(state.smartCleanupReviewIsReusable(ready, cache, {
    projectKey: cache.projectKey,
    dashboardGeneratedAt: '2026-08-29T10:01:00.000Z',
  }, 9_999), false);
  assert.equal(state.smartCleanupReviewIsReusable(ready, cache, {
    projectKey: cache.projectKey,
    dashboardGeneratedAt: cache.dashboardGeneratedAt,
  }, 10_000), false);
  assert.equal(state.SMART_CLEANUP_REVIEW_CACHE_MS, 60 * 60_000);
});
