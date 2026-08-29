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

import { MAX_BULK_REMOVE_CHANGES } from '../out/core/upgrade/validate.js';
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
  flaggedVersion: '3.1.3',
  patchedVersion: { status: 'unknown' },
};

const CLEAN_ROW = {
  name: 'clean-pkg',
  description: 'A clean fixture package.',
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

const VULNERABLE_ROW = {
  name: 'glob',
  current: '7.0.0',
  wanted: null,
  latest: null,
  dev: true,
  optional: false,
  range: '^7.0.0',
  deprecated: 'no longer supported',
  unresolvable: 'no-lockfile',
  advisories: [ATTRIBUTED],
  worstSeverity: 'high',
  upgradeTo: '9.0.0',
  upgradeReason: 'security-fix',
};

const PROJECT = { label: 'app', manifestPath: 'package.json' };

const DATA = {
  rows: [CLEAN_ROW, VULNERABLE_ROW],
  availability: { updates: 'complete', advisories: 'complete', unavailableUpdatePackages: [] },
  generatedAt: '2026-08-01T12:00:00.000Z',
  project: PROJECT,
  canChangeProject: false,
  hygieneFindings: [],
  extensionVersion: '0.0.1',
  builtAt: '2026-08-01T09:00:00.000Z',
};

const MINIMAL_PROJECT_COMPATIBILITY = {
  identity: {
    packageName: 'react-toastify',
    currentVersion: '10.0.6',
    targetVersion: '11.1.0',
    requestId: 'req-1',
    sourceFingerprint: 'source-1',
  },
  analyzers: [],
  findings: [],
  startedAt: '2026-08-01T09:00:00.000Z',
  completedAt: '2026-08-01T09:00:01.000Z',
};

const PROJECT_COMPATIBILITY_FINDING = {
  id: 'next:15.5.24:removed-import',
  category: 'import',
  confidence: 'confirmed',
  packageName: 'react-toastify',
  targetVersion: '11.1.0',
  title: 'Import compatibility issue',
  explanation: 'The imported subpath is not published by the selected target.',
  migrationHint: 'Use a public package entry point.',
  evidence: [{
    kind: 'source-reference',
    filePath: 'src/example.ts',
    line: 4,
    column: 18,
    snippet: `import x from 'react-toastify/private';`,
    specifier: 'react-toastify/private',
    usageId: 'host-usage-1',
    referenceIndex: 0,
  }],
  source: 'generic',
  ruleId: 'target-package-file-missing',
};

const STRUCTURED_PROJECT_COMPATIBILITY = {
  ...MINIMAL_PROJECT_COMPATIBILITY,
  analyzers: [{
    analyzerId: 'import-compatibility',
    status: 'complete',
    findings: [PROJECT_COMPATIBILITY_FINDING],
    durationMs: 1.25,
  }],
  findings: [PROJECT_COMPATIBILITY_FINDING],
};

const MINIMAL_ANALYSIS = {
  analysisId: 'abc123',
  analyzedAt: '2026-08-01T09:00:00.000Z',
  expiresAt: '2026-08-01T11:00:00.000Z',
  package: 'react-toastify',
  currentVersion: '10.0.6',
  targetVersion: '11.1.0',
  classification: 'prod',
  majorUpdate: true,
  changes: [{
    packageName: 'react-toastify',
    currentVersion: '10.0.6',
    targetVersion: '11.1.0',
    classification: 'prod',
    majorUpdate: true,
  }],
  compatibility: { status: 'compatible', completeness: 'complete', findings: [] },
  projectCompatibility: MINIMAL_PROJECT_COMPATIBILITY,
  security: null,
  smartPlan: null,
  verification: { configured: false },
  files: { manifestPath: '/app/package.json', lockfilePath: '/app/package-lock.json', rollbackAvailable: true },
};

// The `overview` UpgradeAnalysisPartialSection carries the same fields as
// MINIMAL_ANALYSIS's own equivalents, minus analysisId/analyzedAt/package/
// compatibility/security/smartPlan — those are never part of the Stage-0
// partial (see UpgradeAnalysisPartialSection's own doc).
const OVERVIEW_SECTION_FIELDS = {
  currentVersion: MINIMAL_ANALYSIS.currentVersion,
  targetVersion: MINIMAL_ANALYSIS.targetVersion,
  classification: MINIMAL_ANALYSIS.classification,
  majorUpdate: MINIMAL_ANALYSIS.majorUpdate,
  changes: MINIMAL_ANALYSIS.changes,
  verification: MINIMAL_ANALYSIS.verification,
  files: MINIMAL_ANALYSIS.files,
};

// ------------------------------------------------- webview -> host

test('every payload-free webview-to-host message is accepted', () => {
  assert.equal(isWebviewToHostMessage({ type: 'ready' }), true);
  assert.equal(isWebviewToHostMessage({ type: 'refresh' }), true);
  assert.equal(isWebviewToHostMessage({ type: 'change-project' }), true);
});

test('change-project carries no payload — extra keys are rejected, not ignored', () => {
  // Same closed-shape rule as every other message: the webview can only ever
  // ask to open the picker, never smuggle a path or an id alongside the ask.
  assert.equal(isWebviewToHostMessage({ type: 'change-project', path: '/etc/passwd' }), false);
  assert.equal(isWebviewToHostMessage({ type: 'change-project', id: 'anything' }), false);
  assert.equal(isWebviewToHostMessage({ type: 'change-project', manifestPath: 'package.json' }), false);
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

test('upgrade target option requests require a package and correlation id', () => {
  assert.equal(
    isWebviewToHostMessage({ type: 'load-upgrade-targets', package: 'react', requestId: 'targets-1' }),
    true
  );
  assert.equal(isWebviewToHostMessage({ type: 'load-upgrade-targets', package: 'react' }), false);
  assert.equal(
    isWebviewToHostMessage({ type: 'load-upgrade-targets', package: 'react', requestId: '', target: '19.0.0' }),
    false
  );
});

// ------------------------------------------------- upgrade requests

test('a well-formed upgrade request is accepted', () => {
  assert.equal(
    isWebviewToHostMessage({ type: 'upgrade', package: 'left-pad', target: '2.0.0', requestId: 'req-1' }),
    true
  );
});

test('a well-formed bulk upgrade requires a bounded, unique list of exact package targets', () => {
  assert.equal(
    isWebviewToHostMessage({
      type: 'bulk-upgrade',
      requestId: 'req-1',
      changes: [
        { package: 'alpha', target: '1.1.0' },
        { package: 'beta', target: '2.0.0' },
      ],
    }),
    true
  );
  assert.equal(isWebviewToHostMessage({ type: 'bulk-upgrade', requestId: 'req-1', changes: [] }), false);
  assert.equal(
    isWebviewToHostMessage({
      type: 'bulk-upgrade',
      requestId: 'req-1',
      changes: [
        { package: 'alpha', target: '1.1.0' },
        { package: 'alpha', target: '1.2.0' },
      ],
    }),
    false
  );
  assert.equal(
    isWebviewToHostMessage({
      type: 'bulk-upgrade',
      requestId: 'req-1',
      changes: [{ package: 'alpha', target: '1.1.0', args: '--force' }],
    }),
    false
  );
});

test('an upgrade request missing package, target, or requestId is rejected', () => {
  assert.equal(isWebviewToHostMessage({ type: 'upgrade' }), false);
  assert.equal(isWebviewToHostMessage({ type: 'upgrade', package: 'left-pad', requestId: 'req-1' }), false);
  assert.equal(isWebviewToHostMessage({ type: 'upgrade', target: '2.0.0', requestId: 'req-1' }), false);
  assert.equal(isWebviewToHostMessage({ type: 'upgrade', package: 'left-pad', target: '2.0.0' }), false);
  assert.equal(
    isWebviewToHostMessage({ type: 'upgrade', package: 'left-pad', target: '2.0.0', requestId: '' }),
    false
  );
});

test('an upgrade request with extra keys is rejected, not partially trusted', () => {
  assert.equal(
    isWebviewToHostMessage({
      type: 'upgrade',
      package: 'left-pad',
      target: '2.0.0',
      requestId: 'req-1',
      dev: false, // a webview-supplied classification must never be accepted
    }),
    false
  );
});

test('an upgrade request with the wrong value types is rejected', () => {
  for (const value of [
    { type: 'upgrade', package: 42, target: '2.0.0', requestId: 'req-1' },
    { type: 'upgrade', package: 'left-pad', target: null, requestId: 'req-1' },
    { type: 'upgrade', package: '', target: '2.0.0', requestId: 'req-1' },
    { type: 'upgrade', package: 'left-pad', target: '', requestId: 'req-1' },
    { type: 'upgrade', package: ['left-pad'], target: '2.0.0', requestId: 'req-1' },
  ]) {
    assert.equal(isWebviewToHostMessage(value), false, `${JSON.stringify(value)} accepted`);
  }
});

// -------------------------------------------------- webview -> host: open-advisory

test('a well-formed open-advisory request is accepted, with either a numeric or string id', () => {
  assert.equal(
    isWebviewToHostMessage({ type: 'open-advisory', package: 'minimatch', advisoryId: 1096549, path: ['minimatch'] }),
    true
  );
  assert.equal(
    isWebviewToHostMessage({
      type: 'open-advisory',
      package: 'minimatch',
      advisoryId: 'GHSA-xxxx',
      path: ['a', 'minimatch'],
    }),
    true
  );
  assert.equal(
    isWebviewToHostMessage({
      type: 'open-advisory',
      package: 'minimatch',
      advisoryId: 1096549,
      path: ['minimatch'],
      reference: 'CVE-2026-67213',
    }),
    true
  );
});

test('an open-advisory request never carries a URL — extra keys are rejected outright', () => {
  assert.equal(
    isWebviewToHostMessage({
      type: 'open-advisory',
      package: 'minimatch',
      advisoryId: 1,
      path: ['minimatch'],
      url: 'https://evil.example.com',
    }),
    false
  );
});

test('an open-advisory reference is bounded and must be a non-empty string', () => {
  for (const reference of ['', 42, 'x'.repeat(65)]) {
    assert.equal(
      isWebviewToHostMessage({
        type: 'open-advisory',
        package: 'minimatch',
        advisoryId: 1,
        path: ['minimatch'],
        reference,
      }),
      false
    );
  }
});

test('an open-advisory request missing any required field is rejected', () => {
  assert.equal(isWebviewToHostMessage({ type: 'open-advisory' }), false);
  assert.equal(isWebviewToHostMessage({ type: 'open-advisory', package: 'minimatch' }), false);
  assert.equal(isWebviewToHostMessage({ type: 'open-advisory', package: 'minimatch', advisoryId: 1 }), false);
  assert.equal(
    isWebviewToHostMessage({ type: 'open-advisory', advisoryId: 1, path: ['minimatch'] }),
    false
  );
});

test('an open-advisory request with the wrong value types is rejected', () => {
  for (const value of [
    { type: 'open-advisory', package: '', advisoryId: 1, path: ['minimatch'] },
    { type: 'open-advisory', package: 'minimatch', advisoryId: null, path: ['minimatch'] },
    { type: 'open-advisory', package: 'minimatch', advisoryId: '', path: ['minimatch'] },
    { type: 'open-advisory', package: 'minimatch', advisoryId: 1, path: [] },
    { type: 'open-advisory', package: 'minimatch', advisoryId: 1, path: 'minimatch' },
    { type: 'open-advisory', package: 'minimatch', advisoryId: 1, path: [1, 2] },
  ]) {
    assert.equal(isWebviewToHostMessage(value), false, `${JSON.stringify(value)} accepted`);
  }
});

// --------------------------------- webview -> host: confirm/cancel/use-smart-plan/configure-verification

test('a well-formed confirm-upgrade / use-smart-plan request is accepted', () => {
  assert.equal(isWebviewToHostMessage({ type: 'confirm-upgrade', analysisId: 'abc123' }), true);
  assert.equal(isWebviewToHostMessage({ type: 'use-smart-plan', analysisId: 'abc123' }), true);
});

test('retry-upgrade-enrichment accepts only a host-issued-looking non-empty correlation id', () => {
  assert.equal(isWebviewToHostMessage({ type: 'retry-upgrade-enrichment', refreshId: 'refresh-1' }), true);
  assert.equal(isWebviewToHostMessage({ type: 'retry-upgrade-enrichment', refreshId: '' }), false);
  assert.equal(isWebviewToHostMessage({ type: 'retry-upgrade-enrichment' }), false);
  assert.equal(isWebviewToHostMessage({ type: 'retry-upgrade-enrichment', refreshId: 'refresh-1', package: 'react' }), false);
});

test('confirm-upgrade / use-smart-plan reject a missing, empty, or null analysisId', () => {
  for (const type of ['confirm-upgrade', 'use-smart-plan']) {
    assert.equal(isWebviewToHostMessage({ type }), false);
    assert.equal(isWebviewToHostMessage({ type, analysisId: '' }), false);
    assert.equal(isWebviewToHostMessage({ type, analysisId: null }), false);
    assert.equal(isWebviewToHostMessage({ type, analysisId: 42 }), false);
  }
});

test('confirm-upgrade / use-smart-plan reject extra keys — the webview never sends plan contents or a target alongside the id', () => {
  assert.equal(
    isWebviewToHostMessage({ type: 'confirm-upgrade', analysisId: 'abc123', target: '11.1.0' }),
    false
  );
  assert.equal(
    isWebviewToHostMessage({ type: 'use-smart-plan', analysisId: 'abc123', changes: [] }),
    false
  );
});

test('cancel-upgrade accepts a real analysisId, and also accepts null for "still loading, no id issued yet"', () => {
  assert.equal(isWebviewToHostMessage({ type: 'cancel-upgrade', analysisId: 'abc123' }), true);
  assert.equal(isWebviewToHostMessage({ type: 'cancel-upgrade', analysisId: null }), true);
});

test('cancel-upgrade rejects a missing analysisId key, an empty string, and extra keys', () => {
  assert.equal(isWebviewToHostMessage({ type: 'cancel-upgrade' }), false);
  assert.equal(isWebviewToHostMessage({ type: 'cancel-upgrade', analysisId: '' }), false);
  assert.equal(
    isWebviewToHostMessage({ type: 'cancel-upgrade', analysisId: null, reason: 'user closed modal' }),
    false
  );
});

test('configure-verification carries no payload — extra keys are rejected', () => {
  assert.equal(isWebviewToHostMessage({ type: 'configure-verification' }), true);
  assert.equal(isWebviewToHostMessage({ type: 'configure-verification', scriptName: 'test' }), false);
});

// ------------------------------------------------- host -> webview

test('every host-to-webview variant is accepted', () => {
  assert.equal(isHostToWebviewMessage({ status: 'loading' }), true);
  assert.equal(isHostToWebviewMessage({ status: 'scan-progress', stage: 'versions', completed: 4, total: 10 }), true);
  assert.equal(isHostToWebviewMessage({ status: 'empty', data: { ...DATA, rows: [] } }), true);
  assert.equal(isHostToWebviewMessage({ status: 'ready', data: DATA }), true);
  assert.equal(isHostToWebviewMessage({ status: 'stale', data: DATA }), true);
  assert.equal(isHostToWebviewMessage({ status: 'partial-error', data: DATA }), true);
  assert.equal(
    isHostToWebviewMessage({ status: 'fatal-error', error: { code: 'ENOENT', message: 'nope' } }),
    true
  );
  assert.equal(
    isHostToWebviewMessage({ status: 'upgrade-analyzing', package: 'react-toastify', phase: 'compatibility', requestId: 'req-1' }),
    true
  );
  assert.equal(
    isHostToWebviewMessage({ status: 'upgrade-analyzing', package: 'react-toastify', phase: 'smart-plan', requestId: 'req-1' }),
    true
  );
  assert.equal(
    isHostToWebviewMessage({ status: 'upgrade-analyzing', package: 'react-toastify', phase: 'project-compatibility', requestId: 'req-1' }),
    true
  );
  assert.equal(
    isHostToWebviewMessage({ status: 'upgrade-analysis', analysis: MINIMAL_ANALYSIS, requestId: 'req-1' }),
    true
  );
  assert.equal(
    isHostToWebviewMessage({
      status: 'upgrade-analysis-partial',
      requestId: 'req-1',
      package: 'react-toastify',
      section: { kind: 'overview', ...OVERVIEW_SECTION_FIELDS },
    }),
    true
  );
  assert.equal(isHostToWebviewMessage({ status: 'upgrade-analysis-stale', analysisId: 'abc123' }), true);
  assert.equal(isHostToWebviewMessage({
    status: 'upgrade-result',
    result: {
      package: 'react',
      refreshId: 'refresh-1',
      install: 'succeeded',
      application: 'applied',
      verification: 'passed',
      refreshingDerivedData: true,
      changes: [{
        packageName: 'react', previousVersion: '18.3.1', requestedVersion: '19.0.0',
        currentVersion: '19.0.0', declaredRange: '^19.0.0', classification: 'prod',
      }],
    },
  }), true);
  assert.equal(isHostToWebviewMessage({
    status: 'upgrade-result',
    result: {
      package: 'react', refreshId: 'refresh-1', install: 'succeeded', application: 'applied', verification: 'passed',
      refreshingDerivedData: true, changes: [], untrusted: true,
    },
  }), false);
  assert.equal(isHostToWebviewMessage({
    status: 'upgrade-result',
    result: {
      package: 'react', refreshId: 'refresh-1', install: 'succeeded', application: 'unconfirmed', verification: 'not-configured',
      refreshingDerivedData: true, changes: [],
    },
  }), false);
  assert.equal(isHostToWebviewMessage({
    status: 'upgrade-enrichment-result', refreshId: 'refresh-1', package: 'react', outcome: 'succeeded',
  }), true);
  assert.equal(isHostToWebviewMessage({
    status: 'upgrade-enrichment-result', refreshId: 'refresh-1', package: 'react', outcome: 'failed',
    error: { code: 'NETWORK', message: 'offline' },
  }), true);
  assert.equal(isHostToWebviewMessage({
    status: 'upgrade-enrichment-result', refreshId: 'refresh-1', package: 'react', outcome: 'failed',
  }), false);
  assert.equal(isHostToWebviewMessage({
    status: 'upgrade-enrichment-result', refreshId: 'refresh-1', package: 'react', outcome: 'succeeded',
    error: { code: 'NETWORK', message: 'must be absent' },
  }), false);
});

test('scan progress accepts real stage/count data and rejects fake or inconsistent progress', () => {
  assert.equal(isHostToWebviewMessage({ status: 'scan-progress', stage: 'advisories' }), true);
  assert.equal(isHostToWebviewMessage({ status: 'scan-progress', stage: 'made-up', completed: 1, total: 2 }), false);
  assert.equal(isHostToWebviewMessage({ status: 'scan-progress', stage: 'versions', completed: 3, total: 2 }), false);
  assert.equal(isHostToWebviewMessage({ status: 'scan-progress', stage: 'versions', percent: 50 }), false);
});

test('upgrade target option messages validate channels, labels, and recommendation integrity', () => {
  const targets = {
    recommendedVersion: '18.3.1',
    options: [
      { version: '18.3.1', channel: 'stable', labels: ['recommended', 'lts'] },
      { version: '19.0.0', channel: 'stable', labels: ['latest'] },
      { version: '20.0.0-beta.1', channel: 'prerelease', labels: [] },
    ],
    truncated: true,
  };
  assert.equal(
    isHostToWebviewMessage({ status: 'upgrade-targets-loading', package: 'react', requestId: 'targets-1' }),
    true
  );
  assert.equal(
    isHostToWebviewMessage({ status: 'upgrade-targets', package: 'react', requestId: 'targets-1', targets }),
    true
  );
  assert.equal(
    isHostToWebviewMessage({
      status: 'upgrade-targets',
      package: 'react',
      requestId: 'targets-1',
      targets: { ...targets, options: [{ version: '19.0.0', channel: 'nightly', labels: [] }] },
    }),
    false
  );
  assert.equal(
    isHostToWebviewMessage({
      status: 'upgrade-targets',
      package: 'react',
      requestId: 'targets-1',
      targets: { ...targets, recommendedVersion: '99.0.0' },
    }),
    false
  );
  assert.equal(
    isHostToWebviewMessage({
      status: 'upgrade-targets-error',
      package: 'react',
      requestId: 'targets-1',
      error: { code: 'NETWORK', message: 'offline' },
    }),
    true
  );
});

// ----------------------------------------- host -> webview: upgrade-analyzing

test('upgrade-analyzing rejects an unrecognized phase, a missing package, and extra keys', () => {
  assert.equal(
    isHostToWebviewMessage({ status: 'upgrade-analyzing', package: 'x', phase: 'metadata' }),
    false
  );
  assert.equal(isHostToWebviewMessage({ status: 'upgrade-analyzing', phase: 'compatibility' }), false);
  assert.equal(
    isHostToWebviewMessage({ status: 'upgrade-analyzing', package: 'x', phase: 'compatibility', percent: 50 }),
    false
  );
});

// ------------------------------------------ host -> webview: upgrade-analysis

test('upgrade-analysis rejects a missing or malformed analysis payload', () => {
  assert.equal(isHostToWebviewMessage({ status: 'upgrade-analysis' }), false);
  assert.equal(isHostToWebviewMessage({ status: 'upgrade-analysis', analysis: null }), false);
  assert.equal(isHostToWebviewMessage({ status: 'upgrade-analysis', analysis: {} }), false);
});

test('upgrade-analysis requires a valid host expiry after analyzedAt', () => {
  assert.equal(isHostToWebviewMessage({
    status: 'upgrade-analysis', requestId: 'req-1', analysis: { ...MINIMAL_ANALYSIS, expiresAt: 'not-a-date' },
  }), false);
  assert.equal(isHostToWebviewMessage({
    status: 'upgrade-analysis', requestId: 'req-1', analysis: { ...MINIMAL_ANALYSIS, expiresAt: '1' },
  }), false);
  assert.equal(isHostToWebviewMessage({
    status: 'upgrade-analysis', requestId: 'req-1', analysis: { ...MINIMAL_ANALYSIS, expiresAt: MINIMAL_ANALYSIS.analyzedAt },
  }), false);
  const { expiresAt: _expiresAt, ...withoutExpiry } = MINIMAL_ANALYSIS;
  assert.equal(isHostToWebviewMessage({ status: 'upgrade-analysis', requestId: 'req-1', analysis: withoutExpiry }), false);
});

test('upgrade-analysis rejects extra top-level keys on the analysis payload', () => {
  assert.equal(
    isHostToWebviewMessage({
      status: 'upgrade-analysis',
      requestId: 'req-1',
      analysis: { ...MINIMAL_ANALYSIS, extra: true },
    }),
    false
  );
});

test('upgrade-analysis rejects a missing required top-level field', () => {
  const { analysisId, ...withoutId } = MINIMAL_ANALYSIS;
  assert.equal(isHostToWebviewMessage({ status: 'upgrade-analysis', analysis: withoutId }), false);
});

test('upgrade-analysis rejects an unknown compatibility status or classification', () => {
  assert.equal(
    isHostToWebviewMessage({
      status: 'upgrade-analysis',
      requestId: 'req-1',
      analysis: { ...MINIMAL_ANALYSIS, compatibility: { ...MINIMAL_ANALYSIS.compatibility, status: 'ok' } },
    }),
    false
  );
  assert.equal(
    isHostToWebviewMessage({
      status: 'upgrade-analysis',
      requestId: 'req-1',
      analysis: { ...MINIMAL_ANALYSIS, classification: 'peer' },
    }),
    false
  );
});

test('upgrade-analysis accepts one structurally valid compatibility finding, and rejects one with an unknown kind', () => {
  const finding = {
    id: '["peer-incompatible","some-library","react-toastify","10.0.6"]',
    kind: 'peer-incompatible',
    status: 'conflict',
    source: 'static',
    subject: { name: 'some-library', version: '4.2.0', nodeId: 'node_modules/some-library' },
    requirement: { name: 'react-toastify', range: '^10.0.0', optional: false },
    observedVersion: '11.1.0',
    relation: { kind: 'direct', nodeIds: ['node_modules/some-library'], packageNames: ['some-library'] },
    explanation: 'some-library@4.2.0 requires react-toastify@^10.0.0, but the proposal resolves 11.1.0.',
  };
  assert.equal(
    isHostToWebviewMessage({
      status: 'upgrade-analysis',
      requestId: 'req-1',
      analysis: { ...MINIMAL_ANALYSIS, compatibility: { ...MINIMAL_ANALYSIS.compatibility, findings: [finding] } },
    }),
    true
  );
  assert.equal(
    isHostToWebviewMessage({
      status: 'upgrade-analysis',
      requestId: 'req-1',
      analysis: {
        ...MINIMAL_ANALYSIS,
        compatibility: { ...MINIMAL_ANALYSIS.compatibility, findings: [{ ...finding, kind: 'not-a-real-kind' }] },
      },
    }),
    false
  );
});

test('upgrade-analysis accepts structured project findings with only a host-issued navigation tuple', () => {
  assert.equal(isHostToWebviewMessage({
    status: 'upgrade-analysis',
    requestId: 'req-1',
    analysis: { ...MINIMAL_ANALYSIS, projectCompatibility: STRUCTURED_PROJECT_COMPATIBILITY },
  }), true);

  const evidence = PROJECT_COMPATIBILITY_FINDING.evidence[0];
  for (const malformedEvidence of [
    { ...evidence, usageId: undefined },
    { ...evidence, referenceIndex: undefined },
    { ...evidence, referenceIndex: -1 },
    { ...evidence, url: 'https://untrusted.example/open' },
  ]) {
    const finding = { ...PROJECT_COMPATIBILITY_FINDING, evidence: [malformedEvidence] };
    const projectCompatibility = {
      ...STRUCTURED_PROJECT_COMPATIBILITY,
      findings: [finding],
      analyzers: [{ ...STRUCTURED_PROJECT_COMPATIBILITY.analyzers[0], findings: [finding] }],
    };
    assert.equal(isHostToWebviewMessage({
      status: 'upgrade-analysis', requestId: 'req-1',
      analysis: { ...MINIMAL_ANALYSIS, projectCompatibility },
    }), false, `${JSON.stringify(malformedEvidence)} accepted`);
  }
});

test('project compatibility protocol rejects malformed confidence, analyzer state, target identity, and timestamps', () => {
  const malformedFinding = { ...PROJECT_COMPATIBILITY_FINDING, confidence: 'high' };
  const cases = [
    {
      ...STRUCTURED_PROJECT_COMPATIBILITY,
      findings: [malformedFinding],
      analyzers: [{ ...STRUCTURED_PROJECT_COMPATIBILITY.analyzers[0], findings: [malformedFinding] }],
    },
    {
      ...STRUCTURED_PROJECT_COMPATIBILITY,
      analyzers: [{ ...STRUCTURED_PROJECT_COMPATIBILITY.analyzers[0], status: 'compatible' }],
    },
    {
      ...STRUCTURED_PROJECT_COMPATIBILITY,
      analyzers: [{ ...STRUCTURED_PROJECT_COMPATIBILITY.analyzers[0], durationMs: -1 }],
    },
    {
      ...STRUCTURED_PROJECT_COMPATIBILITY,
      findings: [{ ...PROJECT_COMPATIBILITY_FINDING, targetVersion: '12.0.0' }],
    },
    {
      ...STRUCTURED_PROJECT_COMPATIBILITY,
      startedAt: 'not-a-date',
    },
    {
      ...STRUCTURED_PROJECT_COMPATIBILITY,
      startedAt: '2026-08-01T09:00:02.000Z',
      completedAt: '2026-08-01T09:00:01.000Z',
    },
  ];
  for (const projectCompatibility of cases) {
    assert.equal(isHostToWebviewMessage({
      status: 'upgrade-analysis', requestId: 'req-1',
      analysis: { ...MINIMAL_ANALYSIS, projectCompatibility },
    }), false, `${JSON.stringify(projectCompatibility)} accepted`);
  }
});

test('final project compatibility identity is correlated to the containing analysis and request', () => {
  const identityCases = [
    { packageName: 'other-package' },
    { currentVersion: '10.0.7' },
    { targetVersion: '12.0.0' },
    { requestId: 'superseded-request' },
  ];
  for (const identityOverride of identityCases) {
    const projectCompatibility = {
      ...MINIMAL_PROJECT_COMPATIBILITY,
      identity: { ...MINIMAL_PROJECT_COMPATIBILITY.identity, ...identityOverride },
    };
    assert.equal(isHostToWebviewMessage({
      status: 'upgrade-analysis', requestId: 'req-1',
      analysis: { ...MINIMAL_ANALYSIS, projectCompatibility },
    }), false, `${JSON.stringify(identityOverride)} escaped final-result correlation`);
  }
});

test('upgrade-analysis accepts a well-formed security outcome, and rejects one with a malformed remaining vulnerability', () => {
  const security = {
    status: 'remains',
    resolvedAdvisories: [],
    remaining: [
      {
        advisory: {
          id: 1,
          severity: 'high',
          title: 't',
          url: 'https://example.invalid',
          vulnerableVersions: '<4.0.0',
        },
        flaggedPackage: 'form-data',
        path: ['axios', 'form-data'],
        status: 'remains',
        resolvedVersion: '3.5.0',
        patchedVersion: { status: 'known', version: '4.0.0' },
      },
    ],
  };
  assert.equal(
    isHostToWebviewMessage({ status: 'upgrade-analysis', requestId: 'req-1', analysis: { ...MINIMAL_ANALYSIS, security } }),
    true
  );
  const malformed = {
    ...security,
    remaining: [{ ...security.remaining[0], status: 'still-vulnerable' }], // not a real status
  };
  assert.equal(
    isHostToWebviewMessage({ status: 'upgrade-analysis', requestId: 'req-1', analysis: { ...MINIMAL_ANALYSIS, security: malformed } }),
    false
  );
});

test('upgrade-analysis accepts graph-proven vulnerability context and rejects malformed path/remediation claims', () => {
  const remaining = {
    advisory: {
      id: 'GHSA-context', severity: 'high', title: 'Nested issue',
      url: 'https://example.invalid/GHSA-context', vulnerableVersions: '<3.3.8',
    },
    flaggedPackage: 'nanoid',
    path: ['next', 'postcss', 'nanoid'],
    status: 'remains',
    resolvedVersion: '3.3.7',
    patchedVersion: { status: 'known', version: '3.3.8' },
  };
  const context = {
    advisory: remaining.advisory,
    flaggedPackage: 'nanoid',
    flaggedVersion: '3.3.7',
    patchedVersion: { status: 'known', version: '3.3.8' },
    primaryPath: { nodes: [
      { packageName: 'next', version: '14.2.35' },
      { packageName: 'postcss', version: '8.4.0' },
      { packageName: 'nanoid', version: '3.3.7' },
    ] },
    paths: [
      { nodes: [
        { packageName: 'next', version: '14.2.35' },
        { packageName: 'postcss', version: '8.4.0' },
        { packageName: 'nanoid', version: '3.3.7' },
      ] },
      { nodes: [
        { packageName: 'storybook', version: '8.0.0' },
        { packageName: 'nanoid', version: '3.3.7' },
      ] },
    ],
    directRoots: [
      { packageName: 'next', version: '14.2.35', pathCount: 1 },
      { packageName: 'storybook', version: '8.0.0', pathCount: 1 },
    ],
    provenResolution: {
      directDependencyChanges: [{ packageName: 'next', fromVersion: '14.2.35', targetVersion: '15.5.24' }],
    },
  };
  const security = { status: 'remains', resolvedAdvisories: [], remaining: [remaining], contexts: [context] };
  assert.equal(isHostToWebviewMessage({
    status: 'upgrade-analysis', requestId: 'req-1', analysis: { ...MINIMAL_ANALYSIS, security },
  }), true);
  assert.equal(isHostToWebviewMessage({
    status: 'upgrade-analysis', requestId: 'req-1',
    analysis: {
      ...MINIMAL_ANALYSIS,
      security: { ...security, contexts: [{ ...context, pathsTruncated: true }] },
    },
  }), true);
  assert.notEqual(context.patchedVersion.version, context.provenResolution.directDependencyChanges[0].targetVersion,
    'the accepted shape keeps the transitive patch distinct from a proven direct dependency target');

  for (const malformedContext of [
    { ...context, primaryPath: { nodes: [] } },
    { ...context, paths: [] },
    { ...context, directRoots: [{ ...context.directRoots[0], pathCount: 0 }] },
    { ...context, provenResolution: { directDependencyChanges: [] } },
    { ...context, pathsTruncated: 'yes' },
    { ...context, openUrl: 'https://untrusted.example' },
  ]) {
    assert.equal(isHostToWebviewMessage({
      status: 'upgrade-analysis', requestId: 'req-1',
      analysis: { ...MINIMAL_ANALYSIS, security: { ...security, contexts: [malformedContext] } },
    }), false, `${JSON.stringify(malformedContext)} accepted`);
  }
});

test('upgrade-analysis accepts a well-formed smart plan, and rejects one with a missing field on a change', () => {
  const smartPlan = {
    changes: [{ packageName: 'some-library', currentVersion: '4.2.0', targetVersion: '5.0.0' }],
    reasonFindingIds: ['["peer-incompatible","some-library","react-toastify","10.0.6"]'],
  };
  assert.equal(
    isHostToWebviewMessage({ status: 'upgrade-analysis', requestId: 'req-1', analysis: { ...MINIMAL_ANALYSIS, smartPlan } }),
    true
  );
  const malformed = { ...smartPlan, changes: [{ packageName: 'some-library', targetVersion: '5.0.0' }] };
  assert.equal(
    isHostToWebviewMessage({ status: 'upgrade-analysis', requestId: 'req-1', analysis: { ...MINIMAL_ANALYSIS, smartPlan: malformed } }),
    false
  );
});

test('upgrade-analysis accepts the configured verification shape with script names, and rejects one missing scriptNames', () => {
  assert.equal(
    isHostToWebviewMessage({
      status: 'upgrade-analysis',
      requestId: 'req-1',
      analysis: { ...MINIMAL_ANALYSIS, verification: { configured: true, scriptNames: ['test'] } },
    }),
    true
  );
  assert.equal(
    isHostToWebviewMessage({
      status: 'upgrade-analysis',
      requestId: 'req-1',
      analysis: { ...MINIMAL_ANALYSIS, verification: { configured: true } },
    }),
    false
  );
});

// ------------------------------------ host -> webview: upgrade-analysis-partial

test('upgrade-analysis-partial accepts a well-formed section of every kind', () => {
  assert.equal(
    isHostToWebviewMessage({
      status: 'upgrade-analysis-partial',
      requestId: 'req-1',
      package: 'react-toastify',
      section: { kind: 'overview', ...OVERVIEW_SECTION_FIELDS },
    }),
    true
  );
  assert.equal(
    isHostToWebviewMessage({
      status: 'upgrade-analysis-partial',
      requestId: 'req-1',
      package: 'react-toastify',
      section: { kind: 'compatibility', compatibility: MINIMAL_ANALYSIS.compatibility },
    }),
    true
  );
  assert.equal(
    isHostToWebviewMessage({
      status: 'upgrade-analysis-partial',
      requestId: 'req-1',
      package: 'react-toastify',
      section: { kind: 'project-compatibility', projectCompatibility: MINIMAL_PROJECT_COMPATIBILITY },
    }),
    true
  );
  assert.equal(
    isHostToWebviewMessage({
      status: 'upgrade-analysis-partial',
      requestId: 'req-1',
      package: 'react-toastify',
      section: { kind: 'security', security: null },
    }),
    true
  );
  assert.equal(
    isHostToWebviewMessage({
      status: 'upgrade-analysis-partial',
      requestId: 'req-1',
      package: 'react-toastify',
      section: { kind: 'smart-plan', smartPlan: null },
    }),
    true
  );
});

test('project compatibility partials cannot cross request or package identity boundaries', () => {
  const message = {
    status: 'upgrade-analysis-partial',
    requestId: 'req-1',
    package: 'react-toastify',
    section: { kind: 'project-compatibility', projectCompatibility: MINIMAL_PROJECT_COMPATIBILITY },
  };
  assert.equal(isHostToWebviewMessage(message), true);
  assert.equal(isHostToWebviewMessage({ ...message, requestId: 'req-2' }), false);
  assert.equal(isHostToWebviewMessage({ ...message, package: 'other-package' }), false);
  assert.equal(isHostToWebviewMessage({
    ...message,
    section: {
      kind: 'project-compatibility',
      projectCompatibility: {
        ...MINIMAL_PROJECT_COMPATIBILITY,
        identity: { ...MINIMAL_PROJECT_COMPATIBILITY.identity, sourceFingerprint: '' },
      },
    },
  }), false);
});

test('upgrade-analysis-partial rejects a missing requestId/package, an unknown section kind, and extra top-level keys', () => {
  const overview = { status: 'upgrade-analysis-partial', requestId: 'req-1', package: 'x', section: { kind: 'overview', ...OVERVIEW_SECTION_FIELDS } };
  assert.equal(isHostToWebviewMessage({ ...overview, requestId: undefined }), false);
  assert.equal(isHostToWebviewMessage({ ...overview, package: undefined }), false);
  assert.equal(
    isHostToWebviewMessage({ ...overview, section: { kind: 'not-a-real-kind' } }),
    false
  );
  assert.equal(isHostToWebviewMessage({ ...overview, extra: true }), false);
});

test('upgrade-analysis-partial rejects a section object with an extra or missing field for its own kind', () => {
  assert.equal(
    isHostToWebviewMessage({
      status: 'upgrade-analysis-partial',
      requestId: 'req-1',
      package: 'x',
      section: { kind: 'security', security: null, extra: true },
    }),
    false
  );
  assert.equal(
    isHostToWebviewMessage({
      status: 'upgrade-analysis-partial',
      requestId: 'req-1',
      package: 'x',
      section: { kind: 'compatibility' },
    }),
    false
  );
});

// -------------------------------------- host -> webview: upgrade-analysis-stale

test('upgrade-analysis-stale accepts a bare analysisId and rejects a missing one or extra keys', () => {
  assert.equal(isHostToWebviewMessage({ status: 'upgrade-analysis-stale', analysisId: 'abc123' }), true);
  assert.equal(isHostToWebviewMessage({ status: 'upgrade-analysis-stale' }), false);
  assert.equal(isHostToWebviewMessage({ status: 'upgrade-analysis-stale', analysisId: '' }), false);
  assert.equal(
    isHostToWebviewMessage({ status: 'upgrade-analysis-stale', analysisId: 'abc123', package: 'x' }),
    false
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
        availability: { updates: 'complete', advisories: 'unavailable', unavailableUpdatePackages: [] },
        advisoriesError: { code: 'REGISTRY_5XX', message: 'server error 503' },
        auditUnavailable: true,
      },
    }),
    true
  );
  assert.equal(
    isHostToWebviewMessage({
      status: 'ready',
      data: { ...DATA, rows: [{ ...CLEAN_ROW, description: 42 }] },
    }),
    false
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
    { ...DATA, availability: undefined },
    { ...DATA, availability: { updates: 'partial', advisories: 'complete', unavailableUpdatePackages: [] } },
    { ...DATA, availability: { updates: 'complete', advisories: 'complete', unavailableUpdatePackages: ['clean-pkg'] } },
    { ...DATA, availability: { updates: 'complete', advisories: 'unavailable', unavailableUpdatePackages: [] } },
    { ...DATA, availability: { updates: 'unknown', advisories: 'complete', unavailableUpdatePackages: [] } },
    { ...DATA, project: undefined },
    { ...DATA, project: null },
    { ...DATA, project: { label: 'app' } },
    { ...DATA, project: { label: 'app', manifestPath: 'package.json', extra: 1 } },
    { ...DATA, project: { label: 1, manifestPath: 'package.json' } },
    { ...DATA, canChangeProject: undefined },
    { ...DATA, canChangeProject: 'true' },
    { ...DATA, extensionVersion: undefined },
    { ...DATA, extensionVersion: 1 },
    { ...DATA, builtAt: undefined },
    { ...DATA, builtAt: 0 },
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
    { ...CLEAN_ROW, optional: undefined },
    { ...CLEAN_ROW, optional: 'false' },
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
    { ...ATTRIBUTED, flaggedVersion: 42 },
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

test('bounded CVE and GHSA aliases are accepted while malformed advisory identifiers are rejected', () => {
  const valid = {
    ...ATTRIBUTED,
    advisory: {
      ...ADVISORY,
      identifiers: [
        { type: 'CVE', value: 'CVE-2026-67213' },
        { type: 'GHSA', value: 'GHSA-2V37-7H3G-55P8' },
      ],
    },
  };
  assert.equal(isHostToWebviewMessage({
    status: 'ready',
    data: { ...DATA, rows: [{ ...CLEAN_ROW, advisories: [valid], worstSeverity: 'high' }] },
  }), true);

  for (const identifiers of [
    [{ type: 'CVE', value: 42 }],
    [{ type: 'NVD', value: 'CVE-2026-67213' }],
    [{ type: 'CVE', value: 'GHSA-2V37-7H3G-55P8' }],
    [{ type: 'GHSA', value: 'CVE-2026-67213' }],
    Array.from({ length: 17 }, (_, index) => ({ type: 'CVE', value: `CVE-2026-${1000 + index}` })),
  ]) {
    const malformed = { ...ATTRIBUTED, advisory: { ...ADVISORY, identifiers } };
    assert.equal(isHostToWebviewMessage({
      status: 'ready',
      data: { ...DATA, rows: [{ ...CLEAN_ROW, advisories: [malformed], worstSeverity: 'high' }] },
    }), false);
  }
});

// ---------------------------------------------- webview -> host: analyze-remediation

test('a well-formed analyze-remediation request is accepted', () => {
  assert.equal(isWebviewToHostMessage({ type: 'analyze-remediation', package: 'sockjs-client' }), true);
});

test('analyze-remediation never carries anything beyond a package name — no path, version, or plan', () => {
  assert.equal(isWebviewToHostMessage({ type: 'analyze-remediation' }), false);
  assert.equal(isWebviewToHostMessage({ type: 'analyze-remediation', package: '' }), false);
  assert.equal(isWebviewToHostMessage({ type: 'analyze-remediation', package: 42 }), false);
  assert.equal(
    isWebviewToHostMessage({ type: 'analyze-remediation', package: 'sockjs-client', path: ['sockjs-client'] }),
    false
  );
  assert.equal(
    isWebviewToHostMessage({ type: 'analyze-remediation', package: 'sockjs-client', target: '1.0.0' }),
    false
  );
});

test('batch remediation accepts a bounded unique package list and a payload-free cancel', () => {
  assert.equal(isWebviewToHostMessage({ type: 'analyze-remediations', packages: ['alpha', 'beta'] }), true);
  assert.equal(isWebviewToHostMessage({ type: 'analyze-remediations', packages: [] }), false);
  assert.equal(isWebviewToHostMessage({ type: 'analyze-remediations', packages: ['alpha', 'alpha'] }), false);
  assert.equal(isWebviewToHostMessage({ type: 'analyze-remediations', packages: ['alpha'], target: '2.0.0' }), false);
  assert.equal(isWebviewToHostMessage({ type: 'cancel-remediation-analysis' }), true);
  assert.equal(isWebviewToHostMessage({ type: 'cancel-remediation-analysis', package: 'alpha' }), false);
});

// --------------------------------------- host -> webview: remediation-analyzing/result/error

test('remediation-analyzing is accepted with just a package name, and rejects a missing/empty one', () => {
  assert.equal(isHostToWebviewMessage({ status: 'remediation-analyzing', package: 'sockjs-client' }), true);
  assert.equal(isHostToWebviewMessage({ status: 'remediation-analyzing' }), false);
  assert.equal(isHostToWebviewMessage({ status: 'remediation-analyzing', package: '' }), false);
  assert.equal(
    isHostToWebviewMessage({ status: 'remediation-analyzing', package: 'sockjs-client', extra: true }),
    false
  );
});

test('remediation-error mirrors upgrade-error\'s shape', () => {
  assert.equal(
    isHostToWebviewMessage({
      status: 'remediation-error',
      package: 'sockjs-client',
      error: { code: 'STALE_SOURCE', message: 'Project dependency files changed. Refresh and try again.' },
    }),
    true
  );
  assert.equal(
    isHostToWebviewMessage({ status: 'remediation-error', package: 'sockjs-client' }),
    false
  );
  assert.equal(
    isHostToWebviewMessage({
      status: 'remediation-error',
      package: 'sockjs-client',
      error: { code: 'STALE_SOURCE' }, // missing message
    }),
    false
  );
});

test('batch remediation progress and completion require consistent real counts', () => {
  assert.equal(
    isHostToWebviewMessage({ status: 'remediation-batch-progress', completed: 1, total: 3, current: 'beta' }),
    true
  );
  assert.equal(
    isHostToWebviewMessage({ status: 'remediation-batch-complete', completed: 2, total: 3, cancelled: true }),
    true
  );
  assert.equal(
    isHostToWebviewMessage({ status: 'remediation-batch-progress', completed: 4, total: 3, current: null }),
    false
  );
  assert.equal(
    isHostToWebviewMessage({ status: 'remediation-batch-error', error: { code: 'X', message: 'Y' } }),
    true
  );
});

test('remediation-result accepts a well-formed remediation outcome for each status', () => {
  const security = {
    status: 'remains',
    resolvedAdvisories: [],
    remaining: [
      {
        advisory: { id: 1, severity: 'high', title: 't', url: 'https://example.invalid', vulnerableVersions: '<4.0.0' },
        flaggedPackage: 'websocket-driver',
        path: ['sockjs-client', 'faye-websocket', 'websocket-driver'],
        status: 'remains',
        resolvedVersion: '0.7.4',
        patchedVersion: { status: 'known', version: '0.7.5' },
      },
    ],
  };
  for (const status of ['resolved', 'remains', 'unknown']) {
    assert.equal(
      isHostToWebviewMessage({
        status: 'remediation-result',
        package: 'sockjs-client',
        result: { status, security },
      }),
      true,
      `status ${status} rejected`
    );
  }
});

test('remediation-result rejects an invalid outcome status or a malformed security outcome', () => {
  const security = { status: 'resolved', resolvedAdvisories: [], remaining: [] };
  assert.equal(
    isHostToWebviewMessage({
      status: 'remediation-result',
      package: 'sockjs-client',
      result: { status: 'not-a-real-status', security },
    }),
    false
  );
  assert.equal(
    isHostToWebviewMessage({
      status: 'remediation-result',
      package: 'sockjs-client',
      result: { status: 'resolved', security: { ...security, status: 'not-a-real-status' } },
    }),
    false
  );
  assert.equal(
    isHostToWebviewMessage({ status: 'remediation-result', package: 'sockjs-client' }),
    false
  );
});

// ---------------------------------------------- webview -> host: usage analysis

test('a well-formed where-used request is accepted', () => {
  assert.equal(isWebviewToHostMessage({ type: 'where-used', package: 'sockjs-client' }), true);
  assert.equal(isWebviewToHostMessage({ type: 'reanalyze-usage', package: 'sockjs-client' }), true);
});

test('where-used requires a non-empty package name and no extra keys', () => {
  assert.equal(isWebviewToHostMessage({ type: 'where-used' }), false);
  assert.equal(isWebviewToHostMessage({ type: 'where-used', package: '' }), false);
  assert.equal(isWebviewToHostMessage({ type: 'where-used', package: 'x', extra: 1 }), false);
  assert.equal(isWebviewToHostMessage({ type: 'reanalyze-usage', package: '' }), false);
  assert.equal(isWebviewToHostMessage({ type: 'reanalyze-usage', package: 'x', root: '/tmp/forged' }), false);
});

test('analyze-cleanup and cancel-usage-analysis carry no payload', () => {
  assert.equal(isWebviewToHostMessage({ type: 'analyze-cleanup' }), true);
  assert.equal(isWebviewToHostMessage({ type: 'cancel-usage-analysis' }), true);
  assert.equal(isWebviewToHostMessage({ type: 'analyze-cleanup', extra: 1 }), false);
});

test('a well-formed open-usage-reference request is accepted', () => {
  assert.equal(isWebviewToHostMessage({ type: 'open-usage-reference', usageId: 'abc', referenceIndex: 0 }), true);
});

test('open-usage-reference rejects a negative, non-integer, missing, or forged-shape index/id', () => {
  const bad = [
    { type: 'open-usage-reference', usageId: 'abc', referenceIndex: -1 },
    { type: 'open-usage-reference', usageId: 'abc', referenceIndex: 1.5 },
    { type: 'open-usage-reference', usageId: 'abc' },
    { type: 'open-usage-reference', usageId: '', referenceIndex: 0 },
    { type: 'open-usage-reference', usageId: 'abc', referenceIndex: '0' },
    { type: 'open-usage-reference', usageId: 'abc', referenceIndex: 0, path: '/etc/passwd' },
  ];
  for (const value of bad) {
    assert.equal(isWebviewToHostMessage(value), false, `${JSON.stringify(value)} accepted`);
  }
});

// ---------------------------------------------- host -> webview: usage analysis

const USAGE_REFERENCE = { filePath: 'src/app.ts', line: 4, column: 1, snippet: `import x from 'foo';`, kind: 'import' };

test('usage-analyzing, usage-result, and usage-error are accepted', () => {
  assert.equal(isHostToWebviewMessage({ status: 'usage-analyzing', package: 'foo' }), true);
  assert.equal(
    isHostToWebviewMessage({
      status: 'usage-result',
      package: 'foo',
      analysis: {
        usageId: 'abc',
        result: { packageName: 'foo', references: [USAGE_REFERENCE], truncated: false, scannedFileCount: 12, scannedAt: '2026-08-01T00:00:00.000Z' },
        cacheExpiresAt: '2026-08-01T00:10:00.000Z',
        fromCache: false,
      },
    }),
    true
  );
  assert.equal(isHostToWebviewMessage({ status: 'usage-error', package: 'foo', error: { code: 'X', message: 'Y' } }), true);
});

test('a script/config reference (no meaningful line) is accepted with line 0', () => {
  const scriptReference = { filePath: 'package.json', line: 0, column: 0, snippet: '"lint": "eslint ."', kind: 'script', context: 'lint' };
  assert.equal(
    isHostToWebviewMessage({
      status: 'usage-result',
      package: 'eslint',
      analysis: {
        usageId: 'abc',
        result: { packageName: 'eslint', references: [scriptReference], truncated: false, scannedFileCount: 1, scannedAt: '2026-08-01T00:00:00.000Z' },
        cacheExpiresAt: '2026-08-01T00:10:00.000Z',
        fromCache: true,
      },
    }),
    true
  );
});

test('an unrecognized reference kind is rejected', () => {
  assert.equal(
    isHostToWebviewMessage({
      status: 'usage-result',
      package: 'foo',
      analysis: {
        usageId: 'abc',
        result: {
          packageName: 'foo',
          references: [{ ...USAGE_REFERENCE, kind: 'not-a-real-kind' }],
          truncated: false,
          scannedFileCount: 1,
          scannedAt: '2026-08-01T00:00:00.000Z',
        },
        cacheExpiresAt: '2026-08-01T00:10:00.000Z',
        fromCache: false,
      },
    }),
    false
  );
});

test('cleanup-analyzing, cleanup-result, and cleanup-error are accepted', () => {
  assert.equal(isHostToWebviewMessage({ status: 'cleanup-analyzing', scanned: 3, total: 10 }), true);
  assert.equal(
    isHostToWebviewMessage({
      status: 'cleanup-result',
      findings: [
        {
          packageName: 'left-pad',
          kind: 'likely-unused',
          confidence: 'high',
          severity: 'warning',
          summary: 'left-pad appears unused',
          evidence: { kind: 'likely-unused', reason: 'no references found', scannedFileCount: 42, truncated: false },
        },
      ],
      analyzedAt: '2026-08-01T00:00:00.000Z',
      cacheExpiresAt: '2026-08-01T00:10:00.000Z',
    }),
    true
  );
  assert.equal(isHostToWebviewMessage({ status: 'cleanup-error', error: { code: 'X', message: 'Y' } }), true);
});

test('DashboardData with a well-formed hygieneFindings entry is accepted', () => {
  const data = {
    ...DATA,
    hygieneFindings: [
      {
        packageName: 'left-pad',
        kind: 'deprecated',
        confidence: 'high',
        severity: 'attention',
        summary: 'left-pad is deprecated',
        evidence: { kind: 'deprecated', message: 'no longer maintained', suggestedReplacement: 'left-pad-2' },
      },
    ],
  };
  assert.equal(isHostToWebviewMessage({ status: 'ready', data }), true);
});

test('DashboardData missing hygieneFindings entirely is rejected', () => {
  const { hygieneFindings, ...withoutHygieneFindings } = DATA;
  assert.equal(isHostToWebviewMessage({ status: 'ready', data: withoutHygieneFindings }), false);
});

test('a cleanup-result finding of an unrecognized kind is rejected', () => {
  assert.equal(
    isHostToWebviewMessage({
      status: 'cleanup-result',
      findings: [{ packageName: 'x', kind: 'not-a-real-kind', severity: 'warning', summary: 's', evidence: { kind: 'likely-unused', reason: 'r', scannedFileCount: 1, truncated: false } }],
      analyzedAt: '2026-08-01T00:00:00.000Z',
      cacheExpiresAt: '2026-08-01T00:10:00.000Z',
    }),
    false
  );
});

// ---------------------------------------------- webview -> host: bulk-remove/confirm-remove/cancel-remove

test('a well-formed bulk-remove request requires a bounded, unique list of package names', () => {
  assert.equal(
    isWebviewToHostMessage({ type: 'bulk-remove', changes: [{ package: 'alpha' }, { package: 'beta' }] }),
    true
  );
  assert.equal(isWebviewToHostMessage({ type: 'bulk-remove', changes: [] }), false);
  assert.equal(
    isWebviewToHostMessage({ type: 'bulk-remove', changes: [{ package: 'alpha' }, { package: 'alpha' }] }),
    false
  );
  assert.equal(
    isWebviewToHostMessage({ type: 'bulk-remove', changes: [{ package: 'alpha', target: '2.0.0' }] }),
    false
  );
});

test('confirm-remove and cancel-remove mirror confirm-upgrade / cancel-upgrade\'s analysisId discipline', () => {
  assert.equal(isWebviewToHostMessage({ type: 'confirm-remove', analysisId: 'abc123' }), true);
  assert.equal(isWebviewToHostMessage({ type: 'confirm-remove', analysisId: '' }), false);
  assert.equal(isWebviewToHostMessage({ type: 'confirm-remove', analysisId: 'abc123', changes: [] }), false);
  assert.equal(isWebviewToHostMessage({ type: 'cancel-remove', analysisId: 'abc123' }), true);
  assert.equal(isWebviewToHostMessage({ type: 'cancel-remove', analysisId: null }), true);
  assert.equal(isWebviewToHostMessage({ type: 'cancel-remove' }), false);
});

// -------------------------------------- host -> webview: remove-analyzing/remove-analysis/remove-error

const MINIMAL_REMOVE_ANALYSIS = {
  analysisId: 'abc123',
  package: 'left-pad',
  changes: [{ packageName: 'left-pad', classification: 'prod', stillRequiredBy: [] }],
  verification: { configured: false },
  files: { manifestPath: '/app/package.json', lockfilePath: '/app/package-lock.json', rollbackAvailable: true },
};

test('remove-analyzing is accepted with just a package name, and rejects a missing/empty one', () => {
  assert.equal(isHostToWebviewMessage({ status: 'remove-analyzing', package: 'left-pad' }), true);
  assert.equal(isHostToWebviewMessage({ status: 'remove-analyzing' }), false);
  assert.equal(isHostToWebviewMessage({ status: 'remove-analyzing', package: '' }), false);
});

test('a well-formed remove-analysis is accepted', () => {
  assert.equal(isHostToWebviewMessage({ status: 'remove-analysis', analysis: MINIMAL_REMOVE_ANALYSIS }), true);
});

test('remove-analysis rejects a missing payload, extra top-level keys, and a missing required field', () => {
  assert.equal(isHostToWebviewMessage({ status: 'remove-analysis' }), false);
  assert.equal(isHostToWebviewMessage({ status: 'remove-analysis', analysis: {} }), false);
  assert.equal(
    isHostToWebviewMessage({ status: 'remove-analysis', analysis: { ...MINIMAL_REMOVE_ANALYSIS, extra: true } }),
    false
  );
  const { analysisId, ...withoutId } = MINIMAL_REMOVE_ANALYSIS;
  assert.equal(isHostToWebviewMessage({ status: 'remove-analysis', analysis: withoutId }), false);
});

test('remove-analysis accepts multiple changes with stillRequiredBy warnings, and rejects an unknown classification', () => {
  assert.equal(
    isHostToWebviewMessage({
      status: 'remove-analysis',
      analysis: {
        ...MINIMAL_REMOVE_ANALYSIS,
        changes: [
          { packageName: 'left-pad', classification: 'prod', stillRequiredBy: [] },
          { packageName: 'unused-dep', classification: 'dev', stillRequiredBy: ['some-tool'] },
        ],
      },
    }),
    true
  );
  assert.equal(
    isHostToWebviewMessage({
      status: 'remove-analysis',
      analysis: {
        ...MINIMAL_REMOVE_ANALYSIS,
        changes: [{ packageName: 'left-pad', classification: 'peer', stillRequiredBy: [] }],
      },
    }),
    false
  );
});

test('remove-analysis accepts configured verification scripts, and rejects a malformed verification shape', () => {
  assert.equal(
    isHostToWebviewMessage({
      status: 'remove-analysis',
      analysis: { ...MINIMAL_REMOVE_ANALYSIS, verification: { configured: true, scriptNames: ['test'] } },
    }),
    true
  );
  assert.equal(
    isHostToWebviewMessage({
      status: 'remove-analysis',
      analysis: { ...MINIMAL_REMOVE_ANALYSIS, verification: { configured: true } },
    }),
    false
  );
});

test('remove-error mirrors upgrade-error\'s shape', () => {
  assert.equal(
    isHostToWebviewMessage({
      status: 'remove-error',
      package: 'left-pad',
      error: { code: 'STALE_SOURCE', message: 'Project dependency files changed. Refresh and try again.' },
    }),
    true
  );
  assert.equal(isHostToWebviewMessage({ status: 'remove-error', package: 'left-pad' }), false);
});

// ---------------------------------------------- webview -> host / host -> webview: removal-impact preview

test('a well-formed analyze-removal-impact request is accepted', () => {
  assert.equal(isWebviewToHostMessage({ type: 'analyze-removal-impact', requestId: 'impact-1', packages: ['left-pad'] }), true);
  assert.equal(isWebviewToHostMessage({ type: 'analyze-removal-impact', requestId: 'impact-2', packages: ['axios', 'left-pad'] }), true);
  assert.equal(isWebviewToHostMessage({ type: 'cancel-removal-impact', requestId: 'impact-2' }), true);
  assert.equal(isWebviewToHostMessage({ type: 'cancel-removal-impact', requestId: '' }), false);
});

test('analyze-removal-impact rejects an empty, oversized, duplicate, or forged-shape package list', () => {
  const bad = [
    { type: 'analyze-removal-impact', requestId: 'impact-1', packages: [] },
    { type: 'analyze-removal-impact', requestId: 'impact-1', packages: Array.from({ length: MAX_BULK_REMOVE_CHANGES + 1 }, (_, i) => `pkg-${i}`) },
    { type: 'analyze-removal-impact', requestId: 'impact-1', packages: ['left-pad', 'left-pad'] },
    { type: 'analyze-removal-impact', requestId: 'impact-1', packages: ['left-pad', 'axios'] },
    { type: 'analyze-removal-impact', requestId: 'impact-1', packages: ['left-pad', ''] },
    { type: 'analyze-removal-impact', requestId: 'impact-1', packages: ['left-pad', 7] },
    { type: 'analyze-removal-impact' },
    { type: 'analyze-removal-impact', requestId: '', packages: ['left-pad'] },
    { type: 'analyze-removal-impact', requestId: 'impact-1', packages: ['left-pad'], extra: 1 },
  ];
  for (const value of bad) {
    assert.equal(isWebviewToHostMessage(value), false, `${JSON.stringify(value)} accepted`);
  }
});

const LOW_RISK_ASSESSMENT = { status: 'low-risk', evidence: [] };
const REVIEW_ASSESSMENT = {
  status: 'review',
  evidence: [{ kind: 'source-reference', summary: 'Used in 3 files' }],
};
const BLOCKED_ASSESSMENT = {
  status: 'blocked',
  evidence: [{ kind: 'peer-requirement', summary: 'package-x requires this package as a peer dependency' }],
};

test('removal-impact-analyzing, removal-impact-result, and removal-impact-error are accepted', () => {
  assert.equal(isHostToWebviewMessage({ status: 'removal-impact-analyzing', requestId: 'impact-1', packages: ['axios', 'left-pad', 'react'], scanned: 4, total: 12 }), true);
  assert.equal(
    isHostToWebviewMessage({
      status: 'removal-impact-result',
      requestId: 'impact-1',
      packages: ['axios', 'left-pad', 'react'],
      assessments: [
        { packageName: 'left-pad', assessment: LOW_RISK_ASSESSMENT, usageId: 'abc' },
        { packageName: 'axios', assessment: REVIEW_ASSESSMENT, usageId: 'def' },
        { packageName: 'react', assessment: BLOCKED_ASSESSMENT, usageId: 'ghi' },
      ],
      generatedAt: '2026-08-01T00:00:00.000Z',
    }),
    true
  );
  assert.equal(isHostToWebviewMessage({ status: 'removal-impact-error', requestId: 'impact-1', packages: ['left-pad'], error: { code: 'X', message: 'Y' } }), true);
});

test('removal-impact-result rejects an unknown assessment status, a malformed evidence kind, or a missing usageId', () => {
  const bad = [
    { status: 'removal-impact-result', requestId: 'impact-1', packages: ['x'], assessments: [{ packageName: 'x', assessment: { status: 'safe', evidence: [] }, usageId: 'a' }], generatedAt: 't' },
    {
      status: 'removal-impact-result',
      requestId: 'impact-1',
      packages: ['x'],
      assessments: [{ packageName: 'x', assessment: { status: 'review', evidence: [{ kind: 'shell-command', summary: 's' }] }, usageId: 'a' }],
      generatedAt: 't',
    },
    { status: 'removal-impact-result', requestId: 'impact-1', packages: ['x'], assessments: [{ packageName: 'x', assessment: LOW_RISK_ASSESSMENT }], generatedAt: 't' },
    { status: 'removal-impact-result', requestId: 'impact-1', packages: ['x'], assessments: [{ packageName: 'x', assessment: LOW_RISK_ASSESSMENT, usageId: '' }], generatedAt: 't' },
  ];
  for (const value of bad) {
    assert.equal(isHostToWebviewMessage(value), false, `${JSON.stringify(value)} accepted`);
  }
});

test('every removal-impact response requires one exact correlated package set', () => {
  assert.equal(isHostToWebviewMessage({ status: 'removal-impact-analyzing', packages: ['x'], scanned: 0, total: 1 }), false);
  assert.equal(
    isHostToWebviewMessage({
      status: 'removal-impact-result',
      requestId: 'impact-1',
      packages: ['x', 'y'],
      assessments: [{ packageName: 'x', assessment: LOW_RISK_ASSESSMENT, usageId: 'a' }],
      generatedAt: 't',
    }),
    false
  );
  assert.equal(
    isHostToWebviewMessage({
      status: 'removal-impact-result',
      requestId: 'impact-1',
      packages: ['x', 'y'],
      assessments: [
        { packageName: 'x', assessment: LOW_RISK_ASSESSMENT, usageId: 'a' },
        { packageName: 'x', assessment: LOW_RISK_ASSESSMENT, usageId: 'b' },
      ],
      generatedAt: 't',
    }),
    false
  );
  assert.equal(
    isHostToWebviewMessage({
      status: 'removal-impact-result',
      requestId: 'impact-1',
      packages: ['x'],
      assessments: [{ packageName: 'y', assessment: LOW_RISK_ASSESSMENT, usageId: 'a' }],
      generatedAt: 't',
    }),
    false
  );
  assert.equal(isHostToWebviewMessage({ status: 'removal-impact-error', requestId: 'impact-1', error: { code: 'X', message: 'Y' } }), false);
});
