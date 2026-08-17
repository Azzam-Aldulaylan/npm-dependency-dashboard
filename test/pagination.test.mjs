/**
 * Client-side pagination — pure, no React/DOM involved.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { paginate, compactPageNumbers } from '../out/host/pagination.js';

// ------------------------------------------------------------------ paginate

test('slices the requested page at the given size', () => {
  const rows = Array.from({ length: 30 }, (_, i) => i);
  const page = paginate(rows, 1, 10);
  assert.deepEqual(page.pageRows, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(page.totalPages, 3);
  assert.equal(page.currentPage, 1);
  assert.equal(page.totalRows, 30);
});

test('the last page holds the remainder', () => {
  const rows = Array.from({ length: 25 }, (_, i) => i);
  const page = paginate(rows, 3, 10);
  assert.deepEqual(page.pageRows, [20, 21, 22, 23, 24]);
  assert.equal(page.totalPages, 3);
});

test('a requested page beyond the end clamps to the last page', () => {
  const rows = Array.from({ length: 25 }, (_, i) => i);
  const page = paginate(rows, 99, 10);
  assert.equal(page.currentPage, 3);
  assert.deepEqual(page.pageRows, [20, 21, 22, 23, 24]);
});

test('a requested page below 1 clamps to page 1', () => {
  const rows = Array.from({ length: 25 }, (_, i) => i);
  const page = paginate(rows, 0, 10);
  assert.equal(page.currentPage, 1);
});

test('zero rows is a valid page 1 of 1, not an error', () => {
  const page = paginate([], 1, 25);
  assert.deepEqual(page.pageRows, []);
  assert.equal(page.totalPages, 1);
  assert.equal(page.currentPage, 1);
  assert.equal(page.totalRows, 0);
});

test('fewer rows than one page is still page 1 of 1', () => {
  const rows = [1, 2, 3];
  const page = paginate(rows, 1, 25);
  assert.equal(page.totalPages, 1);
  assert.deepEqual(page.pageRows, [1, 2, 3]);
});

// ------------------------------------------------------- compactPageNumbers

test('few pages renders every page number, no ellipsis', () => {
  assert.deepEqual(compactPageNumbers(1, 1), [1]);
  assert.deepEqual(compactPageNumbers(1, 5), [1, 2, 3, 4, 5]);
  assert.deepEqual(compactPageNumbers(3, 5), [1, 2, 3, 4, 5]);
});

test('many pages near the start collapses the tail into one ellipsis', () => {
  assert.deepEqual(compactPageNumbers(1, 12), [1, 2, 'ellipsis', 12]);
});

test('many pages near the end collapses the head into one ellipsis', () => {
  assert.deepEqual(compactPageNumbers(12, 12), [1, 'ellipsis', 11, 12]);
});

test('many pages in the middle collapses both sides', () => {
  assert.deepEqual(compactPageNumbers(6, 12), [1, 'ellipsis', 5, 6, 7, 'ellipsis', 12]);
});

test('never renders more than a handful of tokens for a large page count', () => {
  const tokens = compactPageNumbers(50, 200);
  assert.ok(tokens.length <= 7, `expected a compact token list, got ${tokens.length}`);
});
