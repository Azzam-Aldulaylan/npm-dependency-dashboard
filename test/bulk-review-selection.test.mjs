import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  canonicalPackageSelectionMatches,
  canonicalBulkReviewBatch,
  deselectNonLowRiskRows,
  selectedBulkReviewRows,
  toggleSafeBulkReviewSelection,
} from '../out/core/upgrade/bulkReviewSelection.js';

function assessments(statuses) {
  return new Map(
    Object.entries(statuses).map(([name, status]) => [name, { assessment: { status } }])
  );
}

test('the bulk selection control can never select a blocked or unknown row', () => {
  const rows = [{ name: 'low' }, { name: 'review' }, { name: 'blocked' }, { name: 'unknown' }];
  const impact = assessments({ low: 'low-risk', review: 'review', blocked: 'blocked', unknown: 'unknown' });
  const initiallyDeselected = new Set(rows.map((row) => row.name));

  const afterSelect = toggleSafeBulkReviewSelection(initiallyDeselected, rows, impact);
  assert.deepEqual([...afterSelect].sort(), ['blocked', 'review', 'unknown']);
  assert.deepEqual(selectedBulkReviewRows(rows, afterSelect, impact).map((row) => row.name), ['low']);

  // Even corrupt/stale checkbox state cannot leak a blocked row into a payload.
  assert.deepEqual(selectedBulkReviewRows(rows, new Set(), impact).map((row) => row.name), ['low', 'review']);
});

test('impact completion defaults to low-risk only, while review requires an individual opt-in', () => {
  const rows = [{ name: 'low' }, { name: 'review' }, { name: 'blocked' }, { name: 'unknown' }];
  const impact = assessments({ low: 'low-risk', review: 'review', blocked: 'blocked', unknown: 'unknown' });

  const defaultDeselection = deselectNonLowRiskRows(new Set(), rows, impact);
  assert.deepEqual([...defaultDeselection].sort(), ['blocked', 'review', 'unknown']);
  assert.deepEqual(selectedBulkReviewRows(rows, defaultDeselection, impact).map((row) => row.name), ['low']);

  const deliberateOverrides = new Set(defaultDeselection);
  deliberateOverrides.delete('review');
  deliberateOverrides.delete('blocked');
  deliberateOverrides.delete('unknown');
  assert.deepEqual(
    selectedBulkReviewRows(rows, deliberateOverrides, impact).map((row) => row.name),
    ['low', 'review'],
    'review can be opted in, but unknown and blocked stay excluded'
  );
});

test('packages missing from an older completed result remain selectable for a fresh analysis', () => {
  const rows = [{ name: 'old-low' }, { name: 'new-match' }];
  const impact = assessments({ 'old-low': 'low-risk' });
  const defaultDeselection = deselectNonLowRiskRows(new Set(), rows, impact);

  assert.deepEqual([...defaultDeselection], []);
  assert.deepEqual(selectedBulkReviewRows(rows, defaultDeselection, impact).map((row) => row.name), [
    'old-low',
    'new-match',
  ]);
});

test('one canonical first-150 batch excludes overflow from selection and payload derivation', () => {
  const rows = Array.from({ length: 153 }, (_, index) => ({ name: `package-${index}` }));
  const batch = canonicalBulkReviewBatch(rows);

  assert.equal(batch.totalCount, 153);
  assert.equal(batch.rows.length, 150);
  assert.equal(batch.overflowCount, 3);
  assert.equal(batch.rows.at(-1)?.name, 'package-149');
  assert.deepEqual(
    selectedBulkReviewRows(batch.rows, new Set(), undefined).map((row) => row.name),
    rows.slice(0, 150).map((row) => row.name)
  );
});

test('impact readiness correlation requires exact package-set equality', () => {
  assert.equal(canonicalPackageSelectionMatches(['b', 'a'], ['a', 'b']), true);
  assert.equal(canonicalPackageSelectionMatches(['a'], ['a', 'b']), false);
  assert.equal(canonicalPackageSelectionMatches(['a', 'a'], ['a', 'a']), false);
  assert.equal(canonicalPackageSelectionMatches(['a', 'b'], ['b', 'a']), false, 'analysis names must be canonical');
});
