import { test } from 'node:test';
import assert from 'node:assert/strict';

import { manageRemovalReadyPackage } from '../out/host/manageRemovalFlow.js';

test('a matching completed impact scan starts the pending Manage removal', () => {
  const result = manageRemovalReadyPackage('lodash', {
    phase: 'done',
    assessments: new Map([['lodash', {}]]),
  });
  assert.equal(result, 'lodash');
});

test('an impact scan that is still running never starts destructive preflight', () => {
  assert.equal(manageRemovalReadyPackage('lodash', { phase: 'analyzing' }), null);
});

test('an errored or unknown scan never starts destructive preflight', () => {
  assert.equal(manageRemovalReadyPackage('lodash', { phase: 'error' }), null);
  assert.equal(manageRemovalReadyPackage('lodash', { phase: 'idle' }), null);
});

test('a completed result for another package cannot start a stale pending removal', () => {
  const result = manageRemovalReadyPackage('lodash', {
    phase: 'done',
    assessments: new Map([['axios', {}]]),
  });
  assert.equal(result, null);
});

test('a completed impact result does nothing when no Manage removal is pending', () => {
  const result = manageRemovalReadyPackage(null, {
    phase: 'done',
    assessments: new Map([['lodash', {}]]),
  });
  assert.equal(result, null);
});
