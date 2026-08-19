import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  hygieneFilterCounts,
  hygieneFilterPredicate,
  rowMatchesHygieneFilter,
} from '../out/host/hygieneFilter.js';

function row(name) {
  return { name, dev: false };
}

const findings = [
  {
    packageName: 'unused-direct',
    kind: 'likely-unused',
    confidence: 'high',
    severity: 'warning',
    summary: 'unused-direct appears unused',
    evidence: { kind: 'likely-unused', reason: 'No references.', scannedFileCount: 10, truncated: false },
  },
  {
    packageName: 'shared-transitive',
    kind: 'duplicate-version',
    severity: 'attention',
    summary: '2 versions are installed',
    evidence: {
      kind: 'duplicate-version',
      versions: [
        { version: '1.0.0', direct: null, paths: [['root-a', 'shared-transitive']], totalPaths: 1, truncated: false },
        { version: '2.0.0', direct: null, paths: [['root-b', 'shared-transitive']], totalPaths: 1, truncated: false },
      ],
    },
  },
  {
    packageName: 'own-duplicate',
    kind: 'duplicate-version',
    severity: 'attention',
    summary: '2 versions are installed',
    evidence: {
      kind: 'duplicate-version',
      versions: [
        { version: '1.0.0', direct: { classification: 'prod' }, paths: [], totalPaths: 0, truncated: false },
        { version: '2.0.0', direct: null, paths: [['other', 'own-duplicate']], totalPaths: 1, truncated: false },
      ],
    },
  },
];

test('likely-unused matches only the direct dependency named by the usage finding', () => {
  assert.equal(rowMatchesHygieneFilter(row('unused-direct'), 'likely-unused', findings), true);
  assert.equal(rowMatchesHygieneFilter(row('root-a'), 'likely-unused', findings), false);
});

test('duplicate filter matches direct roots that introduce a transitive duplicate', () => {
  assert.equal(rowMatchesHygieneFilter(row('root-a'), 'duplicate-version', findings), true);
  assert.equal(rowMatchesHygieneFilter(row('root-b'), 'duplicate-version', findings), true);
  assert.equal(rowMatchesHygieneFilter(row('unrelated'), 'duplicate-version', findings), false);
});

test('duplicate filter also matches a direct package whose own name has multiple versions', () => {
  assert.equal(rowMatchesHygieneFilter(row('own-duplicate'), 'duplicate-version', findings), true);
});

test('all matches without findings and counts are per direct row, not per finding', () => {
  const rows = [row('unused-direct'), row('root-a'), row('root-b'), row('own-duplicate'), row('clean')];
  assert.equal(hygieneFilterPredicate('all', [])(row('clean')), true);
  assert.deepEqual(hygieneFilterCounts(rows, findings), {
    'likely-unused': 1,
    'duplicate-version': 3,
  });
});
