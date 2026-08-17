/**
 * All/Production/Dev filtering — pure, no React/DOM involved.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { dependencyTypeFilterPredicate } from '../out/host/dependencyTypeFilter.js';

function row(dev) {
  return { name: 'pkg', dev };
}

test('"all" matches both prod and dev rows', () => {
  const predicate = dependencyTypeFilterPredicate('all');
  assert.equal(predicate(row(false)), true);
  assert.equal(predicate(row(true)), true);
});

test('"prod" matches only non-dev rows', () => {
  const predicate = dependencyTypeFilterPredicate('prod');
  assert.equal(predicate(row(false)), true);
  assert.equal(predicate(row(true)), false);
});

test('"dev" matches only dev rows', () => {
  const predicate = dependencyTypeFilterPredicate('dev');
  assert.equal(predicate(row(false)), false);
  assert.equal(predicate(row(true)), true);
});
