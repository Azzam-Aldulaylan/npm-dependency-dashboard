/**
 * The composed "what would clicking Action actually do" decision — pure.
 * See src/core/upgrade/candidate.ts's own header for why this is a
 * deliberately separate question from resolveUpgradeTarget (aggregate.ts),
 * which stays exclusively about security remediation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { generalUpdateTarget, resolveUpgradeCandidate } from '../out/core/upgrade/candidate.js';

// ------------------------------------------------------- generalUpdateTarget

test('a healthy package with a patch update offers the patch as the target', () => {
  assert.equal(generalUpdateTarget('1.2.3', '1.2.4', '1.2.4'), '1.2.4');
});

test('a healthy package with a minor update offers the minor as the target', () => {
  assert.equal(generalUpdateTarget('1.2.3', '1.3.0', '1.3.0'), '1.3.0');
});

test('a healthy package with a major update outside the declared range offers Latest', () => {
  assert.equal(generalUpdateTarget('1.2.3', '1.2.3', '2.0.0'), '2.0.0');
});

test('an in-range Wanted bump is offered even when Latest matches Current', () => {
  // A rare shape (Latest == Current but Wanted has moved), still a real update.
  assert.equal(generalUpdateTarget('1.0.0', '1.1.0', '1.0.0'), '1.1.0');
});

test('a package already at Wanted and Latest has no general update', () => {
  assert.equal(generalUpdateTarget('1.2.3', '1.2.3', '1.2.3'), null);
});

test('no resolved installed version means no general update, regardless of Wanted/Latest', () => {
  assert.equal(generalUpdateTarget(null, '2.0.0', '2.0.0'), null);
});

test('the downgrade trap: a Latest not actually ahead of Current is refused', () => {
  assert.equal(generalUpdateTarget('2.0.0', '2.0.0', '1.9.0'), null);
});

// ---------------------------------------------------- resolveUpgradeCandidate

test('a healthy package with only a general update gets reason "update"', () => {
  const candidate = resolveUpgradeCandidate({
    securityTarget: null,
    current: '1.0.0',
    wanted: '1.2.0',
    latest: '1.2.0',
  });
  assert.deepEqual(candidate, { target: '1.2.0', reason: 'update' });
});

test('a vulnerable package with a verified fix gets reason "security-fix", using the fix target', () => {
  const candidate = resolveUpgradeCandidate({
    securityTarget: '1.0.1',
    current: '1.0.0',
    wanted: '1.5.0',
    latest: '2.0.0',
  });
  assert.deepEqual(candidate, { target: '1.0.1', reason: 'security-fix' });
});

test('security remediation wins over a general update when both exist', () => {
  const candidate = resolveUpgradeCandidate({
    securityTarget: '1.0.5',
    current: '1.0.0',
    wanted: '1.2.0',
    latest: '1.2.0',
  });
  assert.equal(candidate.reason, 'security-fix');
  assert.equal(candidate.target, '1.0.5');
});

test('a package already at latest, with no advisory fix either, has no candidate', () => {
  const candidate = resolveUpgradeCandidate({
    securityTarget: null,
    current: '1.2.0',
    wanted: '1.2.0',
    latest: '1.2.0',
  });
  assert.equal(candidate, null);
});

test('an unresolvable dependency (no installed version) never gets a candidate', () => {
  const candidate = resolveUpgradeCandidate({
    securityTarget: null,
    current: null,
    wanted: '2.0.0',
    latest: '2.0.0',
  });
  assert.equal(candidate, null);
});

test('a vulnerable package with no verified fix falls through to its own general update', () => {
  // The security path found nothing to vouch for (fixAvailable: false, or the
  // self-computed check came up empty) — the row can still take a general
  // update; it just is not being promised to fix that specific advisory.
  const candidate = resolveUpgradeCandidate({
    securityTarget: null,
    current: '1.0.0',
    wanted: '1.1.0',
    latest: '1.1.0',
  });
  assert.deepEqual(candidate, { target: '1.1.0', reason: 'update' });
});
