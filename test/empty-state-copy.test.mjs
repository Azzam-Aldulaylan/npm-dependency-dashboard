/**
 * The empty-table headline for a card/type-filter combination with zero
 * matches (no search involved) — pure, no React/DOM involved.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { filterEmptyStateTitle } from '../out/host/emptyStateCopy.js';

test('a clean "Updates" filter reads as a positive result, not a dead end', () => {
  assert.equal(filterEmptyStateTitle('updates', 'all'), 'Everything is up to date');
});

test('a clean "Vulnerabilities" filter reads as a positive result', () => {
  assert.equal(filterEmptyStateTitle('vulnerabilities', 'all'), 'No vulnerable dependencies');
});

test('a clean "Needs Attention" filter reads as a positive result', () => {
  assert.equal(filterEmptyStateTitle('attention', 'all'), 'Nothing needs attention');
});

test('"all" narrowed to zero by the type filter names the type, not a generic message', () => {
  assert.equal(filterEmptyStateTitle('all', 'prod'), 'No production dependencies');
  assert.equal(filterEmptyStateTitle('all', 'dev'), 'No dev dependencies');
});

test('"all" with no type filter narrowing falls back to a generic message', () => {
  assert.equal(filterEmptyStateTitle('all', 'all'), 'No dependencies match this filter');
});

test('a non-"all" card combined with a type filter still uses the card wording', () => {
  assert.equal(filterEmptyStateTitle('vulnerabilities', 'dev'), 'No vulnerable dependencies');
});

test('hygiene filters take precedence and explain whether usage analysis has run', () => {
  assert.equal(
    filterEmptyStateTitle('all', 'all', 'likely-unused', false),
    'Analyze cleanup to find likely-unused dependencies'
  );
  assert.equal(filterEmptyStateTitle('all', 'all', 'likely-unused', true), 'No likely-unused dependencies');
  assert.equal(
    filterEmptyStateTitle('all', 'all', 'duplicate-version', true),
    'No dependencies introduce duplicate versions'
  );
});
