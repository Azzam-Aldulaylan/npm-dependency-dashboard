import { test } from 'node:test';
import assert from 'node:assert/strict';

import { deepestContainingRepository, stableGitHeadIdentity } from '../out/host/gitHeadState.js';

test('stable HEAD identity ignores status-only changes', () => {
  const head = { commit: 'abc', name: 'feature', upstream: { remote: 'origin', name: 'feature' } };
  assert.equal(stableGitHeadIdentity(head), stableGitHeadIdentity({ ...head }));
});

test('stable HEAD identity changes for commit and branch/ref changes', () => {
  assert.notEqual(stableGitHeadIdentity({ commit: 'abc', name: 'one' }), stableGitHeadIdentity({ commit: 'def', name: 'one' }));
  assert.notEqual(stableGitHeadIdentity({ commit: 'abc', name: 'one' }), stableGitHeadIdentity({ commit: 'abc', name: 'two' }));
});

test('the deepest containing repository owns a nested project', () => {
  const repositories = [
    { rootPath: '/work', value: 'outer' },
    { rootPath: '/work/packages/nested', value: 'nested' },
    { rootPath: '/elsewhere', value: 'other' },
  ];
  assert.equal(deepestContainingRepository(repositories, '/work/packages/nested/app/package.json'), 'nested');
  assert.equal(deepestContainingRepository(repositories, '/not-work/package.json'), undefined);
});

test('Git unavailable or a non-Git project cleanly yields no repository', () => {
  assert.equal(deepestContainingRepository([], '/work/package.json'), undefined);
  assert.equal(stableGitHeadIdentity(undefined), null);
});
