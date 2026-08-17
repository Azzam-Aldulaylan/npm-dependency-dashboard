/**
 * resolveRemediationRequest — the host-authoritative eligibility check
 * behind "Analyze remediation". The interesting cases are the rejections: a
 * webview can only ever name a package, so every other fact (whether it has
 * an upgrade target already, whether any of its advisories are transitive)
 * must come from the host's own last-trusted scan, never be assumed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveRemediationRequest } from '../out/core/advisories/remediationRequest.js';

function advisory(overrides = {}) {
  return {
    advisory: { id: 1, severity: 'high', title: 't', url: 'https://example.invalid', vulnerableVersions: '<2.0.0' },
    flaggedPackage: 'websocket-driver',
    path: ['sockjs-client', 'faye-websocket', 'websocket-driver'],
    patchedVersion: { status: 'known', version: '0.7.5' },
    ...overrides,
  };
}

function row(overrides = {}) {
  return {
    name: 'sockjs-client',
    current: '1.6.1',
    wanted: '1.6.1',
    latest: '1.6.1',
    dev: false,
    range: '^1.6.1',
    advisories: [],
    worstSeverity: null,
    upgradeTo: null,
    upgradeReason: null,
    ...overrides,
  };
}

test('a package not present in the last scan is rejected as UNKNOWN_PACKAGE — never treated as any other row', () => {
  const result = resolveRemediationRequest([row()], 'left-pad');
  assert.deepEqual(result, { ok: false, reason: 'UNKNOWN_PACKAGE' });
});

test('package name lookup is exact and case-sensitive — a near-miss is never silently matched to the real row', () => {
  const rows = [row({ name: 'sockjs-client', worstSeverity: 'high', advisories: [advisory()] })];
  assert.equal(resolveRemediationRequest(rows, 'Sockjs-Client').ok, false);
  assert.equal(resolveRemediationRequest(rows, 'sockjs-client ').ok, false);
});

test('a row that already has a normal upgrade target is rejected — it has a real Upgrade/Fix vulnerability button already', () => {
  const rows = [
    row({
      worstSeverity: 'high',
      advisories: [advisory()],
      upgradeTo: '1.7.0',
      upgradeReason: 'security-fix',
    }),
  ];
  const result = resolveRemediationRequest(rows, 'sockjs-client');
  assert.deepEqual(result, { ok: false, reason: 'NOT_TRANSITIVE_VULNERABILITY' });
});

test('a row with no resolved installed version is rejected — there is nothing to re-resolve from', () => {
  const rows = [row({ current: null, worstSeverity: 'high', advisories: [advisory({ path: ['sockjs-client'] })] })];
  const result = resolveRemediationRequest(rows, 'sockjs-client');
  assert.deepEqual(result, { ok: false, reason: 'NOT_TRANSITIVE_VULNERABILITY' });
});

test('a row whose every advisory is direct (path length 1) is rejected — no transitive dependency to re-resolve', () => {
  const rows = [row({ worstSeverity: 'high', advisories: [advisory({ path: ['sockjs-client'] })] })];
  const result = resolveRemediationRequest(rows, 'sockjs-client');
  assert.deepEqual(result, { ok: false, reason: 'NOT_TRANSITIVE_VULNERABILITY' });
});

test('a clean row with no advisories at all is rejected the same way as a direct-only one', () => {
  const rows = [row({ worstSeverity: null, advisories: [] })];
  const result = resolveRemediationRequest(rows, 'sockjs-client');
  assert.deepEqual(result, { ok: false, reason: 'NOT_TRANSITIVE_VULNERABILITY' });
});

test('a genuinely eligible transitive vulnerability is accepted, returning the trusted row and just its transitive advisories', () => {
  const direct = advisory({ path: ['sockjs-client'], advisory: { ...advisory().advisory, id: 2 } });
  const transitive = advisory();
  const rows = [row({ worstSeverity: 'high', advisories: [direct, transitive] })];
  const result = resolveRemediationRequest(rows, 'sockjs-client');
  assert.equal(result.ok, true);
  assert.equal(result.row.name, 'sockjs-client');
  assert.deepEqual(result.transitiveAdvisories, [transitive]);
});

test('the returned row is the exact trusted row instance, never reconstructed from the request', () => {
  const trusted = row({ worstSeverity: 'critical', advisories: [advisory()] });
  const rows = [row({ name: 'other-package' }), trusted];
  const result = resolveRemediationRequest(rows, 'sockjs-client');
  assert.equal(result.ok, true);
  assert.equal(result.row, trusted);
});
