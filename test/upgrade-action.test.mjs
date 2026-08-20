/**
 * The Action column's full display decision — pure, no React/DOM involved,
 * so this is a plain unit test rather than a component-rendering one (this
 * repo has no jsdom/testing-library set up; see PackageTable.tsx for where
 * this feeds into the actual cell).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { hasEligibleTransitiveFix, resolveActionState, UPGRADE_TOOLTIP } from '../out/host/upgradeAction.js';

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
    upgradeReason: null,
    ...overrides,
  };
}

// ------------------------------------------------------------ security-fix

test('a verified security fix is clearly labeled as an upgrade review', () => {
  const state = resolveActionState(
    row({ current: '1.0.0', worstSeverity: 'high', upgradeTo: '1.0.1', upgradeReason: 'security-fix' })
  );
  assert.equal(state.kind, 'security-fix');
  assert.equal(state.target, '1.0.1');
  assert.equal(state.label, 'Review upgrade');
  assert.match(state.tooltip, /1\.0\.1/);
  assert.match(state.tooltip, /vulnerability/i);
});

// ------------------------------------------------------------------ update

test('a healthy patch update opens a clearly labeled upgrade review', () => {
  const state = resolveActionState(
    row({ current: '1.2.3', wanted: '1.2.4', latest: '1.2.4', upgradeTo: '1.2.4', upgradeReason: 'update' })
  );
  assert.equal(state.kind, 'update');
  assert.equal(state.updateKind, 'patch');
  assert.equal(state.label, 'Review upgrade');
  assert.equal(state.tooltip, UPGRADE_TOOLTIP);
});

test('a healthy minor update opens the same upgrade review', () => {
  const state = resolveActionState(
    row({ current: '1.2.3', wanted: '1.3.0', latest: '1.3.0', upgradeTo: '1.3.0', upgradeReason: 'update' })
  );
  assert.equal(state.kind, 'update');
  assert.equal(state.updateKind, 'minor');
  assert.equal(state.label, 'Review upgrade');
});

test('a healthy major update uses the same review action while retaining its major-upgrade warning', () => {
  const state = resolveActionState(
    row({ current: '1.2.3', wanted: '1.2.3', latest: '2.0.0', upgradeTo: '2.0.0', upgradeReason: 'update' })
  );
  assert.equal(state.kind, 'update');
  assert.equal(state.updateKind, 'major');
  assert.equal(state.label, 'Review upgrade');
  assert.match(state.tooltip, /major/i);
  assert.ok(state.tooltip.includes(UPGRADE_TOOLTIP), 'still explains the preflight/confirmation flow');
});

// ---------------------------------------------------------------- up to date

test('a package already at Wanted and Latest, with no vulnerability, reads as up to date', () => {
  const state = resolveActionState(row({ current: '1.2.3', wanted: '1.2.3', latest: '1.2.3' }));
  assert.equal(state.kind, 'up-to-date');
});

// ----------------------------------------------------------------- unavailable

test('no resolved installed version explains itself via the unresolvable reason', () => {
  const state = resolveActionState(
    row({ current: null, wanted: null, latest: null, unresolvable: 'workspace-link' })
  );
  assert.equal(state.kind, 'unavailable');
  assert.match(state.tooltip, /workspace/i);
});

test('missing version data (Wanted and Latest both null) explains itself', () => {
  const state = resolveActionState(row({ current: '1.0.0', wanted: null, latest: null }));
  assert.equal(state.kind, 'unavailable');
  assert.match(state.tooltip, /version information/i);
});

test('every unavailable state carries a non-empty, human-readable tooltip', () => {
  const cases = [
    row({ current: null, unresolvable: 'file' }),
    row({ current: null, unresolvable: 'git' }),
    row({ current: null, unresolvable: 'alias' }),
    row({ current: null, unresolvable: 'tarball' }),
    row({ current: null, unresolvable: 'no-lockfile' }),
  ];
  for (const r of cases) {
    const state = resolveActionState(r);
    assert.equal(state.kind, 'unavailable');
    assert.ok(state.tooltip.length > 10, `expected an explanatory tooltip for ${JSON.stringify(r)}`);
  }
});

// ------------------------------------------------ transitive vulnerabilities

function advisory(overrides = {}) {
  return {
    advisory: { id: 1, severity: 'high', title: 'Example', url: 'https://example.com', vulnerableVersions: '<2.0.0' },
    flaggedPackage: 'flagged-pkg',
    path: ['pkg', 'intermediate', 'flagged-pkg'],
    patchedVersion: { status: 'known', version: '2.0.0' },
    ...overrides,
  };
}

test('a direct-package vulnerability with no advisories at all (nothing transitive) reads as no-direct-fix, never Unavailable', () => {
  const state = resolveActionState(row({ current: '1.0.0', worstSeverity: 'critical', advisories: [] }));
  assert.equal(state.kind, 'no-direct-fix');
  assert.match(state.tooltip, /no newer published version/i);
});

test('a vulnerability whose every advisory is direct (path length 1) reads as no-direct-fix — never "Analyze remediation"', () => {
  const state = resolveActionState(
    row({ current: '1.0.0', worstSeverity: 'high', advisories: [advisory({ path: ['pkg'] })] })
  );
  assert.equal(state.kind, 'no-direct-fix');
});

test('a transitive vulnerability with no analysis yet offers a distinct transitive-fix check', () => {
  const state = resolveActionState(row({ current: '1.0.0', worstSeverity: 'high', advisories: [advisory()] }));
  assert.equal(state.kind, 'transitive-remediation');
  assert.equal(state.label, 'Check transitive fix');
  assert.match(state.tooltip, /flagged-pkg/);
});

test('an in-flight remediation analysis reads as analyzing, not clickable', () => {
  const state = resolveActionState(
    row({ current: '1.0.0', worstSeverity: 'high', advisories: [advisory()] }),
    { phase: 'analyzing' }
  );
  assert.equal(state.kind, 'remediation-analyzing');
});

test('a resolved remediation result reads as remediation-resolved, naming the flagged package', () => {
  const state = resolveActionState(
    row({ current: '1.0.0', worstSeverity: 'high', advisories: [advisory()] }),
    { phase: 'done', status: 'resolved' }
  );
  assert.equal(state.kind, 'remediation-resolved');
  assert.match(state.tooltip, /flagged-pkg/);
});

test('a "remains" remediation result reads as no-direct-fix, explaining the dependency path', () => {
  const state = resolveActionState(
    row({ current: '1.0.0', worstSeverity: 'high', advisories: [advisory()] }),
    { phase: 'done', status: 'remains' }
  );
  assert.equal(state.kind, 'no-direct-fix');
  assert.match(state.tooltip, /pkg → intermediate → flagged-pkg/);
});

test('an "unknown" remediation result reads as remediation-unknown', () => {
  const state = resolveActionState(
    row({ current: '1.0.0', worstSeverity: 'high', advisories: [advisory()] }),
    { phase: 'done', status: 'unknown' }
  );
  assert.equal(state.kind, 'remediation-unknown');
});

// ------------------------------------------------------- hasEligibleTransitiveFix
// The Manage dependency modal's own gate for whether to render the "Check
// transitive fixes" card — must exactly match every case resolveActionState
// itself would reach a transitive-remediation/remediation-* branch through.

test('a row with a transitive vulnerability and no direct upgrade target is eligible', () => {
  const r = row({ current: '1.0.0', worstSeverity: 'high', advisories: [advisory()] });
  assert.equal(hasEligibleTransitiveFix(r), true);
});

test('a row with an available direct upgrade target is never eligible, even with transitive advisories', () => {
  const r = row({
    current: '1.0.0',
    worstSeverity: 'high',
    advisories: [advisory()],
    upgradeTo: '1.0.1',
    upgradeReason: 'security-fix',
  });
  assert.equal(hasEligibleTransitiveFix(r), false);
});

test('a row with no resolved installed version is never eligible', () => {
  const r = row({ current: null, worstSeverity: 'high', advisories: [advisory()], unresolvable: 'no-lockfile' });
  assert.equal(hasEligibleTransitiveFix(r), false);
});

test('a row with no known vulnerability is never eligible', () => {
  const r = row({ current: '1.0.0', worstSeverity: null, advisories: [] });
  assert.equal(hasEligibleTransitiveFix(r), false);
});

test('a row whose every advisory is direct (path length 1) is never eligible', () => {
  const r = row({ current: '1.0.0', worstSeverity: 'high', advisories: [advisory({ path: ['pkg'] })] });
  assert.equal(hasEligibleTransitiveFix(r), false);
});

test('a row with a mix of direct and transitive advisories is eligible', () => {
  const r = row({
    current: '1.0.0',
    worstSeverity: 'high',
    advisories: [advisory({ path: ['pkg'] }), advisory({ path: ['pkg', 'intermediate', 'flagged-pkg'] })],
  });
  assert.equal(hasEligibleTransitiveFix(r), true);
});
