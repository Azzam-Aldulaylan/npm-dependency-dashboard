/**
 * BuildPackageRowsResult -> wire shape.
 *
 * Two things matter here: which status a completed run maps to, and that a
 * live FetchError is flattened before it can reach postMessage.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FetchError } from '../out/core/registry/http.js';
import { toDashboardData, toHostToWebviewMessage } from '../out/host/dashboardData.js';
import { isHostToWebviewMessage } from '../out/host/webviewProtocol.js';

const ROW = {
  name: 'clean-pkg',
  current: '1.0.0',
  wanted: '1.0.1',
  latest: '1.0.1',
  dev: false,
  optional: false,
  range: '^1.0.0',
  advisories: [],
  worstSeverity: null,
  upgradeTo: null,
  upgradeReason: null,
};

const AT = '2026-08-01T12:00:00.000Z';
const PROJECT = { label: 'app', manifestPath: 'package.json' };
const CAN_CHANGE_PROJECT = false;
const BUILD_INFO = { extensionVersion: '0.0.1', builtAt: '2026-08-01T09:00:00.000Z' };
const COMPLETE_AVAILABILITY = { updates: 'complete', advisories: 'complete', unavailableUpdatePackages: [] };
const scan = (overrides = {}) => ({ rows: [ROW], availability: COMPLETE_AVAILABILITY, ...overrides });

// ------------------------------------------------------- toDashboardData

test('a clean result carries rows, project info, build info, and nothing else', () => {
  const data = toDashboardData(scan(), PROJECT, CAN_CHANGE_PROJECT, BUILD_INFO, AT);
  assert.deepEqual(data, {
    rows: [ROW],
    availability: COMPLETE_AVAILABILITY,
    generatedAt: AT,
    project: PROJECT,
    canChangeProject: CAN_CHANGE_PROJECT,
    hygieneFindings: [],
    extensionVersion: BUILD_INFO.extensionVersion,
    builtAt: BUILD_INFO.builtAt,
  });
});

test('a FetchError is flattened to a plain code/message pair', () => {
  // A FetchError does not survive structured cloning with its prototype, and
  // its internals are not the webview's business either.
  const error = new FetchError('REGISTRY_5XX', 'server error 503: https://registry.npmjs.org', 503);
  const data = toDashboardData(
    scan({
      availability: { updates: 'complete', advisories: 'unavailable', unavailableUpdatePackages: [] },
      advisoriesError: error,
    }),
    PROJECT,
    CAN_CHANGE_PROJECT,
    BUILD_INFO,
    AT
  );

  assert.deepEqual(data.advisoriesError, {
    code: 'REGISTRY_5XX',
    message: 'server error 503: https://registry.npmjs.org',
  });
  assert.equal(data.advisoriesError instanceof Error, false, 'no Error instance crosses the boundary');
  assert.deepEqual(Object.keys(data.advisoriesError), ['code', 'message'], 'status is not leaked');
  assert.deepEqual(JSON.parse(JSON.stringify(data)), data, 'the whole payload is JSON-safe');
});

test('auditUnavailable is copied only when actually true', () => {
  assert.equal(
    toDashboardData(scan({ auditUnavailable: true }), PROJECT, CAN_CHANGE_PROJECT, BUILD_INFO, AT)
      .auditUnavailable,
    true
  );
  assert.equal(
    toDashboardData(scan(), PROJECT, CAN_CHANGE_PROJECT, BUILD_INFO, AT).auditUnavailable,
    undefined
  );
});

test('generatedAt defaults to now when not supplied', () => {
  const before = Date.now();
  const { generatedAt } = toDashboardData(scan({ rows: [] }), PROJECT, CAN_CHANGE_PROJECT, BUILD_INFO);
  assert.ok(Date.parse(generatedAt) >= before, 'a fresh timestamp is stamped on');
});

test('project, canChangeProject, and buildInfo are carried through exactly as given', () => {
  const multiProject = { label: 'api — packages/api', manifestPath: 'packages/api/package.json' };
  const data = toDashboardData(scan(), multiProject, true, BUILD_INFO, AT);
  assert.deepEqual(data.project, multiProject);
  assert.equal(data.canChangeProject, true);
  assert.equal(data.extensionVersion, BUILD_INFO.extensionVersion);
  assert.equal(data.builtAt, BUILD_INFO.builtAt);
});

// -------------------------------------------------- toHostToWebviewMessage

const map = (result, options) => toHostToWebviewMessage(result, options, PROJECT, CAN_CHANGE_PROJECT, BUILD_INFO, AT);

test('a complete result is ready', () => {
  const message = map(scan(), { isEmpty: false, isStale: false });
  assert.equal(message.status, 'ready');
  assert.deepEqual(message.data.rows, [ROW]);
});

test('zero rows is empty, ahead of every other signal', () => {
  // An empty table has no degraded column to warn about.
  const message = map(
    scan({
      rows: [],
      availability: { updates: 'complete', advisories: 'unavailable', unavailableUpdatePackages: [] },
      advisoriesError: new FetchError('NETWORK', 'offline'),
      auditUnavailable: true,
    }),
    { isEmpty: true, isStale: true }
  );
  assert.equal(message.status, 'empty');
});

test('a stale replay outranks a partial-error banner', () => {
  // "This is old" changes how every column should be read, not just one.
  const message = map(
    scan({ auditUnavailable: true }),
    { isEmpty: false, isStale: true }
  );
  assert.equal(message.status, 'stale');
  assert.equal(message.data.auditUnavailable, true, 'the degraded flag still travels');
});

test('a failed advisory fetch is a partial error', () => {
  const message = map(
    scan({
      availability: { updates: 'complete', advisories: 'unavailable', unavailableUpdatePackages: [] },
      advisoriesError: new FetchError('RATE_LIMITED', 'rate limited', 429),
    }),
    { isEmpty: false, isStale: false }
  );
  assert.equal(message.status, 'partial-error');
  assert.equal(message.data.advisoriesError.code, 'RATE_LIMITED');
});

test('an unavailable audit is a partial error on its own', () => {
  const message = map(scan({ auditUnavailable: true }), { isEmpty: false, isStale: false });
  assert.equal(message.status, 'partial-error');
});

test('partial update resolution is a partial error even when advisories are complete', () => {
  const message = map(
    scan({
      availability: {
        updates: 'partial',
        advisories: 'complete',
        unavailableUpdatePackages: ['clean-pkg'],
      },
    }),
    { isEmpty: false, isStale: false }
  );
  assert.equal(message.status, 'partial-error');
  assert.deepEqual(message.data.availability.unavailableUpdatePackages, ['clean-pkg']);
});

test('every mapped message passes the guard the webview applies', () => {
  const results = [
    [scan(), { isEmpty: false, isStale: false }],
    [scan({ rows: [] }), { isEmpty: true, isStale: false }],
    [scan(), { isEmpty: false, isStale: true }],
    [scan({ auditUnavailable: true }), { isEmpty: false, isStale: false }],
    [
      scan({
        availability: { updates: 'complete', advisories: 'unavailable', unavailableUpdatePackages: [] },
        advisoriesError: new FetchError('NETWORK', 'offline'),
      }),
      { isEmpty: false, isStale: false },
    ],
  ];
  for (const [result, options] of results) {
    assert.equal(isHostToWebviewMessage(map(result, options)), true);
  }
});
