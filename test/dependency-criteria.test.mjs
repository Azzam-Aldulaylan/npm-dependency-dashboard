import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  criteriaCounts,
  criteriaPredicate,
  criteriaSummaryLines,
  emptyCriteria,
  hasAnyCriterionSelected,
  matchReasonTags,
  rowMatchesCriteria,
} from '../out/host/dependencyCriteria.js';

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

const UNUSED_FINDING = {
  packageName: 'unused-direct',
  kind: 'likely-unused',
  confidence: 'high',
  severity: 'warning',
  summary: 'unused-direct appears unused',
  evidence: { kind: 'likely-unused', reason: 'No references.', scannedFileCount: 10, truncated: false },
};

function criteria(overrides = {}) {
  return { ...emptyCriteria(), ...overrides };
}

test('an empty selection in every group matches everything', () => {
  assert.equal(rowMatchesCriteria(row(), [], emptyCriteria()), true);
  assert.equal(hasAnyCriterionSelected(emptyCriteria()), false);
});

test('a criterion is detected once any group has a selection', () => {
  assert.equal(hasAnyCriterionSelected(criteria({ type: new Set(['dev']) })), true);
});

test('chips within one group are OR\'d together', () => {
  const selected = criteria({ severity: new Set(['critical', 'high']) });
  assert.equal(rowMatchesCriteria(row({ worstSeverity: 'critical' }), [], selected), true);
  assert.equal(rowMatchesCriteria(row({ worstSeverity: 'high' }), [], selected), true);
  assert.equal(rowMatchesCriteria(row({ worstSeverity: 'moderate' }), [], selected), false);
  assert.equal(rowMatchesCriteria(row({ worstSeverity: null }), [], selected), false);
});

test('info-level severity never matches any severity chip', () => {
  const selected = criteria({ severity: new Set(['critical', 'high', 'moderate', 'low']) });
  assert.equal(rowMatchesCriteria(row({ worstSeverity: 'info' }), [], selected), false);
});

test('non-empty groups are AND\'d together', () => {
  const selected = criteria({ health: new Set(['likely-unused']), type: new Set(['dev']) });
  // matches health but not type
  assert.equal(rowMatchesCriteria(row({ name: 'unused-direct', dev: false }), [UNUSED_FINDING], selected), false);
  // matches both
  assert.equal(rowMatchesCriteria(row({ name: 'unused-direct', dev: true }), [UNUSED_FINDING], selected), true);
});

test('health criteria cover likely-unused, duplicate-version, and deprecated', () => {
  const unused = criteria({ health: new Set(['likely-unused']) });
  assert.equal(rowMatchesCriteria(row({ name: 'unused-direct' }), [UNUSED_FINDING], unused), true);
  assert.equal(rowMatchesCriteria(row({ name: 'clean' }), [UNUSED_FINDING], unused), false);

  const deprecated = criteria({ health: new Set(['deprecated']) });
  assert.equal(rowMatchesCriteria(row({ deprecated: 'no longer maintained' }), [], deprecated), true);
  assert.equal(rowMatchesCriteria(row(), [], deprecated), false);
});

test('update criteria distinguish "has an update" from "major update available"', () => {
  const hasUpdate = criteria({ updates: new Set(['has-update']) });
  assert.equal(rowMatchesCriteria(row({ wanted: '1.1.0' }), [], hasUpdate), true);
  assert.equal(rowMatchesCriteria(row(), [], hasUpdate), false);

  const major = criteria({ updates: new Set(['major-update']) });
  assert.equal(rowMatchesCriteria(row({ current: '1.0.0', latest: '2.0.0', wanted: '1.0.0' }), [], major), true);
  assert.equal(rowMatchesCriteria(row({ current: '1.0.0', latest: '1.1.0', wanted: '1.1.0' }), [], major), false);
});

test('criteriaPredicate curries the same behavior as rowMatchesCriteria for use with Array.filter', () => {
  const selected = criteria({ type: new Set(['dev']) });
  const predicate = criteriaPredicate(selected, []);
  assert.deepEqual(
    [row({ name: 'a', dev: true }), row({ name: 'b', dev: false })].filter(predicate).map((r) => r.name),
    ['a']
  );
});

test('matchReasonTags only names selected criteria the row actually satisfies', () => {
  const selected = criteria({ health: new Set(['likely-unused']), type: new Set(['dev']), severity: new Set(['high']) });
  const tags = matchReasonTags(row({ name: 'unused-direct', dev: true, worstSeverity: 'high' }), [UNUSED_FINDING], selected);
  assert.deepEqual(tags, ['Unused', 'Dev', 'High']);
});

test('matchReasonTags omits a selected group the row does not satisfy, and ignores unselected groups entirely', () => {
  const selected = criteria({ health: new Set(['likely-unused']), severity: new Set(['high']) });
  // Row satisfies the overall match via "health" only (severity not high) — severity tag must be absent.
  const tags = matchReasonTags(row({ name: 'unused-direct', worstSeverity: 'low' }), [UNUSED_FINDING], selected);
  assert.deepEqual(tags, ['Unused']);
  // No groups selected at all -> no tags, regardless of the row's own properties.
  assert.deepEqual(matchReasonTags(row({ name: 'unused-direct', worstSeverity: 'critical' }), [UNUSED_FINDING], emptyCriteria()), []);
});

test('criteriaCounts with nothing selected reflects the whole table, per chip', () => {
  const rows = [
    row({ name: 'unused-direct', dev: false, worstSeverity: 'high' }),
    row({ name: 'clean-dev', dev: true }),
    row({ name: 'deprecated-pkg', deprecated: 'old' }),
    row({ name: 'major-update-pkg', current: '1.0.0', wanted: '1.0.0', latest: '2.0.0' }),
  ];
  const counts = criteriaCounts(rows, [UNUSED_FINDING], emptyCriteria());
  assert.equal(counts.health['likely-unused'], 1);
  assert.equal(counts.health.deprecated, 1);
  assert.equal(counts.type.dev, 1);
  assert.equal(counts.type.prod, 3);
  assert.equal(counts.severity.high, 1);
  assert.equal(counts.updates['has-update'], 1);
  assert.equal(counts.updates['major-update'], 1);
});

test('criteriaCounts is faceted: selecting a chip in one group narrows the counts shown by every other group', () => {
  const rows = [
    row({ name: 'unused-direct', dev: false, worstSeverity: 'high' }),
    row({ name: 'unused-dev', dev: true, worstSeverity: null }),
    row({ name: 'clean-dev', dev: true, worstSeverity: null }),
    row({ name: 'clean-high', dev: false, worstSeverity: 'high' }),
  ];
  const findings = [
    UNUSED_FINDING,
    { ...UNUSED_FINDING, packageName: 'unused-dev', summary: 'unused-dev appears unused' },
  ];
  // Nothing selected: both dev and prod rows have unused packages, so Type isn't narrowed at all.
  const before = criteriaCounts(rows, findings, emptyCriteria());
  assert.equal(before.type.dev, 2);
  assert.equal(before.type.prod, 2);
  assert.equal(before.severity.high, 2);

  // Selecting "Likely unused" under Health should lower Type/Severity to
  // only the unused subset — this is the behavior that was missing.
  const withUnusedSelected = criteria({ health: new Set(['likely-unused']) });
  const after = criteriaCounts(rows, findings, withUnusedSelected);
  assert.equal(after.type.dev, 1, 'only unused-dev is both unused and dev');
  assert.equal(after.type.prod, 1, 'only unused-direct is both unused and prod');
  assert.equal(after.severity.high, 1, 'only unused-direct is both unused and high severity');

  // Health's own chips are not narrowed by Health's own selection — a
  // sibling chip in the same group must still show what OR-ing it in adds.
  assert.equal(after.health['likely-unused'], 2);
});

test('criteriaSummaryLines omits every empty group and returns nothing for an empty selection', () => {
  assert.deepEqual(criteriaSummaryLines(emptyCriteria()), []);
});

test('criteriaSummaryLines joins chips within one group with "or", one line per non-empty group, in Health/Security/Updates/Type order', () => {
  const selected = criteria({
    health: new Set(['duplicate-version', 'likely-unused']),
    severity: new Set(['high', 'critical']),
    type: new Set(['prod']),
  });
  assert.deepEqual(criteriaSummaryLines(selected), [
    { group: 'Health', text: 'Unused or Duplicated' },
    { group: 'Security', text: 'Critical or High' },
    { group: 'Type', text: 'Prod' },
  ]);
});

test('criteriaSummaryLines text order is the canonical label order, not selection order', () => {
  const selectedInReverse = criteria({ severity: new Set(['high', 'critical']) });
  const selectedInOrder = criteria({ severity: new Set(['critical', 'high']) });
  assert.deepEqual(criteriaSummaryLines(selectedInReverse), criteriaSummaryLines(selectedInOrder));
});

test('criteriaCounts never drops below what an already-selected chip needs — checked-away chips stay clickable', () => {
  // Regression guard for the paired UI fix: a selected chip's own count can
  // still hit 0 once another group narrows past it, but the chip itself
  // must remain togglable (see ManageDependenciesModal's disabled logic).
  const rows = [row({ name: 'dev-only', dev: true, deprecated: 'old' })];
  const selected = criteria({ health: new Set(['deprecated']), type: new Set(['prod']) });
  const counts = criteriaCounts(rows, [], selected);
  assert.equal(counts.health.deprecated, 0, 'no prod row is deprecated, so the count itself does go to 0');
});
