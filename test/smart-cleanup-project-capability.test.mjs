import assert from 'node:assert/strict';
import test from 'node:test';

import { smartCleanupProjectCapability } from '../out/host/smartCleanupProjectCapability.js';

function source(overrides = {}) {
  return {
    packageManager: 'npm',
    importerId: '.',
    lockfileName: 'package-lock.json',
    ...overrides,
  };
}

test('Smart Cleanup execution supports covered npm and pnpm root projects', () => {
  assert.deepEqual(smartCleanupProjectCapability(source()), { executionSupported: true });
  assert.deepEqual(
    smartCleanupProjectCapability(source({ packageManager: 'pnpm', lockfileName: 'pnpm-lock.yaml' })),
    { executionSupported: true }
  );
});

test('workspace members remain analysis-only', () => {
  const capability = smartCleanupProjectCapability(source({ importerId: 'packages/app' }));
  assert.equal(capability.executionSupported, false);
  assert.match(capability.reason, /workspace member/i);
});

test('lockfile-less and npm-shrinkwrap projects remain analysis-only', () => {
  const lockfileless = smartCleanupProjectCapability(source({ lockfileName: null }));
  assert.equal(lockfileless.executionSupported, false);
  assert.match(lockfileless.reason, /lockfile/i);

  const shrinkwrap = smartCleanupProjectCapability(source({ lockfileName: 'npm-shrinkwrap.json' }));
  assert.equal(shrinkwrap.executionSupported, false);
  assert.match(shrinkwrap.reason, /shrinkwrap/i);
});
