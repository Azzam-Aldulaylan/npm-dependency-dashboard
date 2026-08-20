/**
 * All/Production/Dev filtering — pure, no React/DOM involved.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { dependencyTypeFilterCounts, dependencyTypeFilterPredicate } from '../out/host/dependencyTypeFilter.js';

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

test('dependencyTypeFilterCounts tallies whatever rows it is given, never applying its own filter', () => {
  const rows = [row(false), row(false), row(true)];
  assert.deepEqual(dependencyTypeFilterCounts(rows), { all: 3, prod: 2, dev: 1 });
  assert.deepEqual(dependencyTypeFilterCounts([]), { all: 0, prod: 0, dev: 0 });
  // Faceting is the caller's job: passing an already-narrowed subset (e.g.
  // only rows matching another active filter) is what makes these counts
  // move together with that other filter.
  assert.deepEqual(dependencyTypeFilterCounts([row(true)]), { all: 1, prod: 0, dev: 1 });
});
