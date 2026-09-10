/**
 * Table sorting — both manual column sort and each summary card's
 * intelligent default order. Pure, no React/DOM involved.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  nextColumnSortState,
  columnSortComparator,
  cardDefaultComparator,
  resolveSortComparator,
  sortRows,
} from '../out/host/tableSort.js';
import { paginate } from '../out/host/pagination.js';

/** The dashboard's own initial sortState (see App.tsx) — every "default sort" test below exercises exactly this value, not a stand-in. */
const INITIAL_SORT_STATE = { column: 'vulnerabilities', direction: 'desc' };

function row(overrides = {}) {
  return {
    name: 'pkg',
    current: '1.0.0',
    wanted: '1.0.0',
    latest: '1.0.0',
    dev: false,
    range: '^1.0.0',
    advisories: [],
    worstSeverity: null,
    upgradeTo: null,
    ...overrides,
  };
}

const names = (rows) => rows.map((r) => r.name);

// ------------------------------------------------------- nextColumnSortState

test('clicking a fresh column starts it ascending', () => {
  assert.deepEqual(nextColumnSortState(null, 'package'), { column: 'package', direction: 'asc' });
});

test('clicking the active ascending column flips it to descending', () => {
  const state = { column: 'package', direction: 'asc' };
  assert.deepEqual(nextColumnSortState(state, 'package'), { column: 'package', direction: 'desc' });
});

test('clicking the active descending column clears back to the card default', () => {
  const state = { column: 'package', direction: 'desc' };
  assert.equal(nextColumnSortState(state, 'package'), null);
});

test('clicking a different column always restarts at ascending', () => {
  const state = { column: 'package', direction: 'desc' };
  assert.deepEqual(nextColumnSortState(state, 'current'), { column: 'current', direction: 'asc' });
});

// -------------------------------------------------------- columnSortComparator

test('package column sorts alphabetically', () => {
  const rows = [row({ name: 'zebra' }), row({ name: 'apple' }), row({ name: 'mango' })];
  assert.deepEqual(names(sortRows(rows, { column: 'package', direction: 'asc' }, 'all')), [
    'apple',
    'mango',
    'zebra',
  ]);
  assert.deepEqual(names(sortRows(rows, { column: 'package', direction: 'desc' }, 'all')), [
    'zebra',
    'mango',
    'apple',
  ]);
});

test('current column sorts by semver, invalid/missing versions always last', () => {
  const rows = [
    row({ name: 'mid', current: '1.5.0' }),
    row({ name: 'unresolved', current: null }),
    row({ name: 'low', current: '1.0.0' }),
    row({ name: 'high', current: '2.0.0' }),
  ];
  assert.deepEqual(names(sortRows(rows, { column: 'current', direction: 'asc' }, 'all')), [
    'low',
    'mid',
    'high',
    'unresolved',
  ]);
  assert.deepEqual(names(sortRows(rows, { column: 'current', direction: 'desc' }, 'all')), [
    'high',
    'mid',
    'low',
    'unresolved',
  ]);
});

test('available column sorts by latest (falling back to wanted), missing values last', () => {
  const rows = [
    row({ name: 'no-update', latest: '1.0.0', wanted: '1.0.0' }),
    row({ name: 'big-jump', latest: '5.0.0', wanted: '1.0.0' }),
    row({ name: 'unresolved', latest: null, wanted: null }),
  ];
  assert.deepEqual(names(sortRows(rows, { column: 'available', direction: 'desc' }, 'all')), [
    'big-jump',
    'no-update',
    'unresolved',
  ]);
});

test('vulnerabilities column sorts by severity rank', () => {
  const rows = [
    row({ name: 'safe' }),
    row({ name: 'crit', worstSeverity: 'critical' }),
    row({ name: 'low', worstSeverity: 'low' }),
  ];
  assert.deepEqual(names(sortRows(rows, { column: 'vulnerabilities', direction: 'desc' }, 'all')), [
    'crit',
    'low',
    'safe',
  ]);
});

test('vulnerabilities column, first click (desc), fully groups all six severity tiers from an interspersed input order, including info', () => {
  // Deliberately interspersed input order — safe and high rows alternate
  // with everything else, so a naive comparator that only partially orders
  // (e.g. string comparison) would leave "Safe / High / Safe" gaps instead
  // of a fully grouped result.
  const rows = [
    row({ name: 'safe-a' }),
    row({ name: 'high-a', worstSeverity: 'high' }),
    row({ name: 'info-a', worstSeverity: 'info' }),
    row({ name: 'safe-b' }),
    row({ name: 'critical-a', worstSeverity: 'critical' }),
    row({ name: 'high-b', worstSeverity: 'high' }),
    row({ name: 'moderate-a', worstSeverity: 'moderate' }),
    row({ name: 'low-a', worstSeverity: 'low' }),
    row({ name: 'critical-b', worstSeverity: 'critical' }),
    row({ name: 'safe-c' }),
    row({ name: 'moderate-b', worstSeverity: 'moderate' }),
    row({ name: 'low-b', worstSeverity: 'low' }),
    row({ name: 'info-b', worstSeverity: 'info' }),
  ];
  assert.deepEqual(names(sortRows(rows, { column: 'vulnerabilities', direction: 'desc' }, 'all')), [
    'critical-a',
    'critical-b',
    'high-a',
    'high-b',
    'moderate-a',
    'moderate-b',
    'low-a',
    'low-b',
    'info-a',
    'info-b',
    'safe-a',
    'safe-b',
    'safe-c',
  ]);
});

test('vulnerabilities column, second click (asc), reverses to lowest/safe first', () => {
  const rows = [
    row({ name: 'critical', worstSeverity: 'critical' }),
    row({ name: 'safe' }),
    row({ name: 'info', worstSeverity: 'info' }),
    row({ name: 'high', worstSeverity: 'high' }),
  ];
  assert.deepEqual(names(sortRows(rows, { column: 'vulnerabilities', direction: 'asc' }, 'all')), [
    'safe',
    'info',
    'high',
    'critical',
  ]);
});

test('type column groups prod before dev ascending', () => {
  const rows = [row({ name: 'devpkg', dev: true }), row({ name: 'prodpkg', dev: false })];
  assert.deepEqual(names(sortRows(rows, { column: 'type', direction: 'asc' }, 'all')), ['prodpkg', 'devpkg']);
});

test('ties within a manual sort break by package name', () => {
  const rows = [row({ name: 'b', worstSeverity: 'high' }), row({ name: 'a', worstSeverity: 'high' })];
  assert.deepEqual(names(sortRows(rows, { column: 'vulnerabilities', direction: 'desc' }, 'all')), ['a', 'b']);
});

// --------------------------------------------------------- cardDefaultComparator

test('the "all" card default ranks vulnerabilities from critical through safe', () => {
  const rows = [
    row({ name: 'safe' }),
    row({ name: 'low', worstSeverity: 'low' }),
    row({ name: 'critical', worstSeverity: 'critical' }),
    row({ name: 'moderate', worstSeverity: 'moderate' }),
    row({ name: 'high', worstSeverity: 'high' }),
  ];
  assert.deepEqual(names(rows.slice().sort(cardDefaultComparator('all'))), [
    'critical',
    'high',
    'moderate',
    'low',
    'safe',
  ]);
});

test('the "all" card default resolves equal severity rows by package name', () => {
  const rows = [
    row({ name: 'zebra', worstSeverity: 'high' }),
    row({ name: 'apple', worstSeverity: 'high' }),
  ];
  assert.deepEqual(names(rows.slice().sort(cardDefaultComparator('all'))), ['apple', 'zebra']);
});

test('the "updates" card default ranks major above minor above patch', () => {
  const rows = [
    row({ name: 'patch-only', current: '1.0.0', wanted: '1.0.1', latest: '1.0.1' }),
    row({ name: 'major-jump', current: '1.0.0', wanted: '1.0.0', latest: '2.0.0' }),
    row({ name: 'minor-bump', current: '1.0.0', wanted: '1.1.0', latest: '1.1.0' }),
    row({ name: 'no-update' }),
  ];
  assert.deepEqual(names(rows.slice().sort(cardDefaultComparator('updates'))), [
    'major-jump',
    'minor-bump',
    'patch-only',
    'no-update',
  ]);
});

test('the "vulnerabilities" card default ranks critical, high, moderate, low, info, safe', () => {
  const rows = [
    row({ name: 'safe' }),
    row({ name: 'info', worstSeverity: 'info' }),
    row({ name: 'low', worstSeverity: 'low' }),
    row({ name: 'moderate', worstSeverity: 'moderate' }),
    row({ name: 'critical', worstSeverity: 'critical' }),
    row({ name: 'high', worstSeverity: 'high' }),
  ];
  assert.deepEqual(names(rows.slice().sort(cardDefaultComparator('vulnerabilities'))), [
    'critical',
    'high',
    'moderate',
    'low',
    'info',
    'safe',
  ]);
});

test('the "attention" card default ranks critical vuln, then high vuln, then deprecated-only', () => {
  const rows = [
    row({ name: 'deprecated-only', deprecated: 'old' }),
    row({ name: 'critical', worstSeverity: 'critical' }),
    row({ name: 'high', worstSeverity: 'high' }),
  ];
  assert.deepEqual(names(rows.slice().sort(cardDefaultComparator('attention'))), [
    'critical',
    'high',
    'deprecated-only',
  ]);
});

// ------------------------------------------------------- resolveSortComparator

test('a null sort state falls back to the card default', () => {
  const rows = [row({ name: 'safe' }), row({ name: 'critical', worstSeverity: 'critical' })];
  assert.deepEqual(names(sortRows(rows, null, 'all')), ['critical', 'safe']);
});

test('a manual sort state overrides the card default', () => {
  const rows = [row({ name: 'apple' }), row({ name: 'zebra' })];
  assert.deepEqual(names(sortRows(rows, { column: 'package', direction: 'desc' }, 'all')), ['zebra', 'apple']);
});

test('sortRows never mutates its input array', () => {
  const rows = [row({ name: 'zebra' }), row({ name: 'apple' })];
  const original = [...rows];
  sortRows(rows, { column: 'package', direction: 'asc' }, 'all');
  assert.deepEqual(rows, original);
});

// -------------------------------------------------- dashboard initial sort (default desc)

test('initial sort: the dashboard\'s own default state groups safe/high/moderate/critical/safe/low into severity order', () => {
  const rows = [
    row({ name: 'a' }), // safe
    row({ name: 'b', worstSeverity: 'high' }),
    row({ name: 'c', worstSeverity: 'moderate' }),
    row({ name: 'd', worstSeverity: 'critical' }),
    row({ name: 'e' }), // safe
    row({ name: 'f', worstSeverity: 'low' }),
  ];
  assert.deepEqual(names(sortRows(rows, INITIAL_SORT_STATE, 'all')), ['d', 'b', 'c', 'f', 'a', 'e']);
});

test('initial sort tie-break: two High packages resolve alphabetically, package name ascending', () => {
  const rows = [row({ name: 'z-package', worstSeverity: 'high' }), row({ name: 'a-package', worstSeverity: 'high' })];
  assert.deepEqual(names(sortRows(rows, INITIAL_SORT_STATE, 'all')), ['a-package', 'z-package']);
});

test('sorting happens before pagination: page 1 of a small page size still shows the worst-severity rows first, never a page sorted in isolation', () => {
  const rows = [
    row({ name: 'safe-a' }),
    row({ name: 'safe-b' }),
    row({ name: 'critical-a', worstSeverity: 'critical' }),
    row({ name: 'high-a', worstSeverity: 'high' }),
    row({ name: 'safe-c' }),
  ];
  const sorted = sortRows(rows, INITIAL_SORT_STATE, 'all');
  const page1 = paginate(sorted, 1, 2);
  const page2 = paginate(sorted, 2, 2);
  assert.deepEqual(page1.pageRows.map((r) => r.name), ['critical-a', 'high-a']);
  assert.deepEqual(page2.pageRows.map((r) => r.name), ['safe-a', 'safe-b']);
});

test('the user can still override the initial default with a manual column sort', () => {
  const rows = [row({ name: 'zebra' }), row({ name: 'apple', worstSeverity: 'critical' })];
  // Starting from the dashboard's own default state, a click on "Package"
  // (see nextColumnSortState) produces a fresh manual sort that no longer
  // reflects severity at all.
  const manual = nextColumnSortState(INITIAL_SORT_STATE, 'package');
  assert.deepEqual(manual, { column: 'package', direction: 'asc' });
  assert.deepEqual(names(sortRows(rows, manual, 'all')), ['apple', 'zebra']);
});
