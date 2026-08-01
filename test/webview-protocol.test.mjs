/**
 * The postMessage validation boundary.
 *
 * Both guards are the only thing standing between a message arriving on the
 * channel and the UI (or the pipeline) acting on it, so the interesting cases
 * here are the rejections: a payload that is *nearly* right must not be
 * partially trusted.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isHostToWebviewMessage,
  isWebviewToHostMessage,
} from '../out/host/webviewProtocol.js';

const ADVISORY = {
  id: 1096549,
  severity: 'high',
  title: 'minimatch ReDoS vulnerability',
  url: 'https://github.com/advisories/GHSA-f8q6-p94x-37v3',
  vulnerableVersions: '<=3.1.3',
};

const ATTRIBUTED = {
  advisory: ADVISORY,
  flaggedPackage: 'minimatch',
  path: ['glob', 'minimatch'],
};

const CLEAN_ROW = {
  name: 'clean-pkg',
  current: '1.0.0',
  wanted: '1.0.1',
  latest: '1.0.1',
  dev: false,
  advisories: [],
  worstSeverity: null,
  upgradeTo: null,
};

const VULNERABLE_ROW = {
  name: 'glob',
  current: '7.0.0',
  wanted: null,
  latest: null,
  dev: true,
  deprecated: 'no longer supported',
  unresolvable: 'no-lockfile',
  advisories: [ATTRIBUTED],
  worstSeverity: 'high',
  upgradeTo: '9.0.0',
};

const DATA = {
  rows: [CLEAN_ROW, VULNERABLE_ROW],
  generatedAt: '2026-08-01T12:00:00.000Z',
};

// ------------------------------------------------- webview -> host

test('both webview-to-host messages are accepted', () => {
  assert.equal(isWebviewToHostMessage({ type: 'ready' }), true);
  assert.equal(isWebviewToHostMessage({ type: 'refresh' }), true);
});

test('a non-object is never a webview-to-host message', () => {
  for (const value of [null, undefined, 'ready', 42, true, [], [{ type: 'ready' }]]) {
    assert.equal(isWebviewToHostMessage(value), false, `${JSON.stringify(value ?? null)} accepted`);
  }
});

test('an unknown or mistyped discriminant is rejected', () => {
  for (const value of [{}, { type: 'upgrade' }, { type: '' }, { type: 1 }, { type: null }]) {
    assert.equal(isWebviewToHostMessage(value), false, `${JSON.stringify(value)} accepted`);
  }
});

test('extra keys on the envelope are rejected, not ignored', () => {
  // The envelope is a closed shape. An unrecognized key means the message did
  // not come from the other half of this protocol.
  assert.equal(isWebviewToHostMessage({ type: 'refresh', packageName: 'lodash' }), false);
  assert.equal(isWebviewToHostMessage({ type: 'ready', __proto__: {} }), true);
});

// ------------------------------------------------- upgrade requests

test('a well-formed upgrade request is accepted', () => {
  assert.equal(isWebviewToHostMessage({ type: 'upgrade', package: 'left-pad', target: '2.0.0' }), true);
});

test('an upgrade request missing package or target is rejected', () => {
  assert.equal(isWebviewToHostMessage({ type: 'upgrade' }), false);
  assert.equal(isWebviewToHostMessage({ type: 'upgrade', package: 'left-pad' }), false);
  assert.equal(isWebviewToHostMessage({ type: 'upgrade', target: '2.0.0' }), false);
});

test('an upgrade request with extra keys is rejected, not partially trusted', () => {
  assert.equal(
    isWebviewToHostMessage({
      type: 'upgrade',
      package: 'left-pad',
      target: '2.0.0',
      dev: false, // a webview-supplied classification must never be accepted
    }),
    false
  );
});

test('an upgrade request with the wrong value types is rejected', () => {
  for (const value of [
    { type: 'upgrade', package: 42, target: '2.0.0' },
    { type: 'upgrade', package: 'left-pad', target: null },
    { type: 'upgrade', package: '', target: '2.0.0' },
    { type: 'upgrade', package: 'left-pad', target: '' },
    { type: 'upgrade', package: ['left-pad'], target: '2.0.0' },
  ]) {
    assert.equal(isWebviewToHostMessage(value), false, `${JSON.stringify(value)} accepted`);
  }
});

// ------------------------------------------------- host -> webview

test('every host-to-webview variant is accepted', () => {
  assert.equal(isHostToWebviewMessage({ status: 'loading' }), true);
  assert.equal(isHostToWebviewMessage({ status: 'empty', data: { ...DATA, rows: [] } }), true);
  assert.equal(isHostToWebviewMessage({ status: 'ready', data: DATA }), true);
  assert.equal(isHostToWebviewMessage({ status: 'stale', data: DATA }), true);
  assert.equal(isHostToWebviewMessage({ status: 'partial-error', data: DATA }), true);
  assert.equal(
    isHostToWebviewMessage({ status: 'fatal-error', error: { code: 'ENOENT', message: 'nope' } }),
    true
  );
});

test('an upgrade-error message is accepted, and never carries the table data', () => {
  assert.equal(
    isHostToWebviewMessage({
      status: 'upgrade-error',
      package: 'left-pad',
      error: { code: 'STALE_TARGET', message: 'The available upgrade changed.' },
    }),
    true
  );
  // Deliberately does not carry `data` — the point of this message is that
  // the existing table is untouched.
  assert.equal(
    isHostToWebviewMessage({
      status: 'upgrade-error',
      package: 'left-pad',
      error: { code: 'X', message: 'Y' },
      data: DATA,
    }),
    false
  );
});

test('a malformed upgrade-error message is rejected', () => {
  const bad = [
    { status: 'upgrade-error' },
    { status: 'upgrade-error', package: 'left-pad' },
    { status: 'upgrade-error', error: { code: 'X', message: 'Y' } },
    { status: 'upgrade-error', package: '', error: { code: 'X', message: 'Y' } },
    { status: 'upgrade-error', package: 1, error: { code: 'X', message: 'Y' } },
    { status: 'upgrade-error', package: 'left-pad', error: 'boom' },
  ];
  for (const value of bad) {
    assert.equal(isHostToWebviewMessage(value), false, `${JSON.stringify(value)} accepted`);
  }
});

test('the optional data fields are accepted when present and correct', () => {
  assert.equal(
    isHostToWebviewMessage({
      status: 'partial-error',
      data: {
        ...DATA,
        advisoriesError: { code: 'REGISTRY_5XX', message: 'server error 503' },
        auditUnavailable: true,
      },
    }),
    true
  );
});

test('a non-object is never a host-to-webview message', () => {
  for (const value of [null, undefined, 'loading', 0, [], [{ status: 'loading' }]]) {
    assert.equal(isHostToWebviewMessage(value), false, `${JSON.stringify(value ?? null)} accepted`);
  }
});

test('an unknown status is rejected', () => {
  for (const status of ['', 'done', 'error', 'LOADING', 7, null]) {
    assert.equal(isHostToWebviewMessage({ status }), false, `${String(status)} accepted`);
  }
});

test('a variant carrying the wrong payload is rejected', () => {
  // loading carries nothing, fatal-error carries an error, the rest carry data.
  assert.equal(isHostToWebviewMessage({ status: 'loading', data: DATA }), false);
  assert.equal(isHostToWebviewMessage({ status: 'ready' }), false);
  assert.equal(isHostToWebviewMessage({ status: 'ready', error: { code: 'x', message: 'y' } }), false);
  assert.equal(isHostToWebviewMessage({ status: 'fatal-error' }), false);
  assert.equal(isHostToWebviewMessage({ status: 'fatal-error', data: DATA }), false);
  assert.equal(isHostToWebviewMessage({ status: 'ready', data: DATA, extra: 1 }), false);
});

test('a malformed error payload is rejected', () => {
  for (const error of [null, {}, 'boom', { code: 'X' }, { message: 'y' }, { code: 1, message: 'y' }]) {
    assert.equal(
      isHostToWebviewMessage({ status: 'fatal-error', error }),
      false,
      `${JSON.stringify(error ?? null)} accepted`
    );
  }
});

test('a malformed DashboardData shell is rejected', () => {
  const bad = [
    null,
    'data',
    {},
    { rows: [] },
    { generatedAt: '2026-08-01T12:00:00.000Z' },
    { rows: {}, generatedAt: '2026-08-01T12:00:00.000Z' },
    { rows: [], generatedAt: 0 },
    { ...DATA, advisoriesError: null },
    { ...DATA, advisoriesError: { code: 'X' } },
    { ...DATA, auditUnavailable: 'yes' },
  ];
  for (const data of bad) {
    assert.equal(
      isHostToWebviewMessage({ status: 'ready', data }),
      false,
      `${JSON.stringify(data ?? null)} accepted`
    );
  }
});

test('one malformed row rejects the whole message', () => {
  // Partially trusting a batch would mean rendering a table where some rows
  // are not the shape the components expect.
  const bad = [
    { ...CLEAN_ROW, name: 42 },
    { ...CLEAN_ROW, current: undefined },
    { ...CLEAN_ROW, dev: 'false' },
    { ...CLEAN_ROW, worstSeverity: 'severe' },
    { ...CLEAN_ROW, upgradeTo: 1 },
    { ...CLEAN_ROW, advisories: undefined },
    { ...CLEAN_ROW, advisories: {} },
    { ...CLEAN_ROW, deprecated: null },
    { ...CLEAN_ROW, unresolvable: 'symlink' },
    { ...CLEAN_ROW, unresolvable: null },
  ];
  for (const row of bad) {
    assert.equal(
      isHostToWebviewMessage({ status: 'ready', data: { ...DATA, rows: [CLEAN_ROW, row] } }),
      false,
      `${JSON.stringify(row)} accepted`
    );
  }
});

test('a malformed advisory rejects the whole message', () => {
  const bad = [
    'GHSA-1234',
    { ...ATTRIBUTED, flaggedPackage: undefined },
    { ...ATTRIBUTED, path: 'glob → minimatch' },
    { ...ATTRIBUTED, path: ['glob', 7] },
    { ...ATTRIBUTED, advisory: { ...ADVISORY, id: null } },
    { ...ATTRIBUTED, advisory: { ...ADVISORY, severity: 'catastrophic' } },
    { ...ATTRIBUTED, advisory: { ...ADVISORY, url: undefined } },
    { ...ATTRIBUTED, advisory: { ...ADVISORY, vulnerableVersions: 3 } },
  ];
  for (const advisory of bad) {
    const rows = [{ ...CLEAN_ROW, advisories: [advisory], worstSeverity: 'high' }];
    assert.equal(
      isHostToWebviewMessage({ status: 'ready', data: { ...DATA, rows } }),
      false,
      `${JSON.stringify(advisory)} accepted`
    );
  }
});

test('a string id is accepted alongside a numeric one', () => {
  const rows = [
    {
      ...CLEAN_ROW,
      advisories: [{ ...ATTRIBUTED, advisory: { ...ADVISORY, id: 'GHSA-f8q6-p94x-37v3' } }],
      worstSeverity: 'high',
    },
  ];
  assert.equal(isHostToWebviewMessage({ status: 'ready', data: { ...DATA, rows } }), true);
});
