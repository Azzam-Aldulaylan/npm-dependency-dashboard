/**
 * Summary-card derivations — pure, no React/DOM involved. See
 * upgrade-action.test.mjs for why this repo tests presentation logic this
 * way instead of rendering components.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  rowHasUpdate,
  rowIsMajorUpdate,
  rowHasVulnerability,
  rowNeedsAttention,
  summaryFilterPredicate,
  summaryMetrics,
  updatesCardSubtitle,
  vulnerabilitiesCardSubtitle,
  attentionCardSubtitle,
} from '../out/host/summaryMetrics.js';

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

// -------------------------------------------------------------- rowHasUpdate

test('no update when wanted and latest match current', () => {
  assert.equal(rowHasUpdate(row()), false);
});

test('an update is detected when wanted differs from current', () => {
  assert.equal(rowHasUpdate(row({ wanted: '1.1.0', latest: '1.1.0' })), true);
});

test('an update is detected when only latest differs (out-of-range major)', () => {
  assert.equal(rowHasUpdate(row({ wanted: '1.0.0', latest: '2.0.0' })), true);
});

test('a row with no resolved current version never counts as having an update', () => {
  assert.equal(rowHasUpdate(row({ current: null, wanted: '1.1.0', latest: '1.1.0' })), false);
});

// ----------------------------------------------------------- rowIsMajorUpdate

test('a same-major update is not a major update', () => {
  assert.equal(rowIsMajorUpdate(row({ wanted: '1.1.0', latest: '1.1.0' })), false);
});

test('a crossed major boundary is a major update', () => {
  assert.equal(rowIsMajorUpdate(row({ current: '1.0.0', wanted: '1.0.0', latest: '2.0.0' })), true);
});

test('an invalid current version never throws and is not a major update', () => {
  assert.equal(rowIsMajorUpdate(row({ current: 'not-a-version', latest: '2.0.0' })), false);
});

// ------------------------------------------------------- rowHasVulnerability

test('a row with a worst severity is vulnerable', () => {
  assert.equal(rowHasVulnerability(row({ worstSeverity: 'low' })), true);
});

test('a row with no worst severity is not vulnerable', () => {
  assert.equal(rowHasVulnerability(row()), false);
});

// ---------------------------------------------------------- rowNeedsAttention

test('critical and high severities need attention; moderate/low/info do not on their own', () => {
  assert.equal(rowNeedsAttention(row({ worstSeverity: 'critical' })), true);
  assert.equal(rowNeedsAttention(row({ worstSeverity: 'high' })), true);
  assert.equal(rowNeedsAttention(row({ worstSeverity: 'moderate' })), false);
  assert.equal(rowNeedsAttention(row({ worstSeverity: 'low' })), false);
  assert.equal(rowNeedsAttention(row({ worstSeverity: 'info' })), false);
});

test('a fully healthy package (no advisories, not deprecated) never needs attention', () => {
  assert.equal(rowNeedsAttention(row()), false);
});

test('a deprecated package needs attention regardless of severity', () => {
  assert.equal(rowNeedsAttention(row({ deprecated: 'use foo instead' })), true);
});

// ------------------------------------------------------- summaryFilterPredicate

test('the "all" filter matches every row', () => {
  const predicate = summaryFilterPredicate('all');
  assert.equal(predicate(row({ worstSeverity: 'critical' })), true);
  assert.equal(predicate(row()), true);
});

test('each named filter delegates to its matching row predicate', () => {
  assert.equal(summaryFilterPredicate('updates')(row({ wanted: '1.1.0', latest: '1.1.0' })), true);
  assert.equal(summaryFilterPredicate('vulnerabilities')(row({ worstSeverity: 'low' })), true);
  assert.equal(summaryFilterPredicate('attention')(row({ worstSeverity: 'critical' })), true);
});

// -------------------------------------------------------------- summaryMetrics

test('an empty row set is all zeros', () => {
  assert.deepEqual(summaryMetrics([]), {
    total: 0,
    updatesAvailable: 0,
    majorUpdates: 0,
    vulnerable: 0,
    criticalVulnerabilities: 0,
    highVulnerabilities: 0,
    moderateVulnerabilities: 0,
    lowVulnerabilities: 0,
    infoVulnerabilities: 0,
    needsAttention: 0,
    deprecatedCount: 0,
  });
});

test('counts are tallied across a mixed row set', () => {
  const rows = [
    row({ name: 'clean' }),
    row({ name: 'minor-update', wanted: '1.1.0', latest: '1.1.0' }),
    row({ name: 'major-update', wanted: '1.0.0', latest: '2.0.0' }),
    row({ name: 'critical-vuln', worstSeverity: 'critical' }),
    row({ name: 'high-vuln', worstSeverity: 'high' }),
    row({ name: 'moderate-vuln', worstSeverity: 'moderate' }),
    row({ name: 'low-vuln', worstSeverity: 'low' }),
    row({ name: 'deprecated-pkg', deprecated: 'no longer maintained' }),
  ];

  assert.deepEqual(summaryMetrics(rows), {
    total: 8,
    updatesAvailable: 2,
    majorUpdates: 1,
    vulnerable: 4,
    criticalVulnerabilities: 1,
    highVulnerabilities: 1,
    moderateVulnerabilities: 1,
    lowVulnerabilities: 1,
    infoVulnerabilities: 0,
    needsAttention: 3, // critical, high, deprecated
    deprecatedCount: 1,
  });
});

// --------------------------------------------------------- card subtitles

test('updates subtitle: up to date when nothing is outdated', () => {
  assert.equal(updatesCardSubtitle(summaryMetrics([])), 'Up to date');
});

test('updates subtitle: major count takes priority when any major update exists', () => {
  const rows = [row({ current: '1.0.0', wanted: '1.0.0', latest: '2.0.0' })];
  assert.equal(updatesCardSubtitle(summaryMetrics(rows)), '1 major');
});

test('updates subtitle: falls back to a percentage when no update is major', () => {
  const rows = [
    row({ wanted: '1.1.0', latest: '1.1.0' }),
    row({ name: 'other' }),
    row({ name: 'other2' }),
    row({ name: 'other3' }),
  ];
  assert.equal(updatesCardSubtitle(summaryMetrics(rows)), '25% of dependencies');
});

test('vulnerabilities subtitle: clean set says so', () => {
  assert.equal(vulnerabilitiesCardSubtitle(summaryMetrics([])), 'No known vulnerabilities');
});

test('vulnerabilities subtitle: includes every nonzero severity, highest first', () => {
  const rows = [
    row({ name: 'a', worstSeverity: 'critical' }),
    row({ name: 'b', worstSeverity: 'high' }),
    row({ name: 'c', worstSeverity: 'high' }),
    row({ name: 'd', worstSeverity: 'moderate' }),
    row({ name: 'e', worstSeverity: 'low' }),
    row({ name: 'f', worstSeverity: 'info' }),
  ];
  assert.equal(
    vulnerabilitiesCardSubtitle(summaryMetrics(rows)),
    '1 critical · 2 high · 1 moderate · 1 low · 1 info'
  );
});

test('vulnerabilities subtitle: omits zero tiers without hiding moderate or low', () => {
  const rows = [
    row({ name: 'a', worstSeverity: 'moderate' }),
    row({ name: 'b', worstSeverity: 'low' }),
  ];
  assert.equal(vulnerabilitiesCardSubtitle(summaryMetrics(rows)), '1 moderate · 1 low');
});

test('attention subtitle: nothing to report on a clean set', () => {
  assert.equal(attentionCardSubtitle(summaryMetrics([])), 'Nothing needs attention');
});

test('attention subtitle: combines urgent and deprecated counts, worded distinctly from the Vulnerabilities card', () => {
  const rows = [
    row({ name: 'a', worstSeverity: 'critical' }),
    row({ name: 'b', deprecated: 'old' }),
    row({ name: 'c', deprecated: 'old' }),
  ];
  assert.equal(attentionCardSubtitle(summaryMetrics(rows)), '1 urgent · 2 deprecated');
});
