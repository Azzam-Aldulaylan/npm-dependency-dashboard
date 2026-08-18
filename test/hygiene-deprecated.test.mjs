/**
 * Deprecated-package detection — reuses row.deprecated (already populated
 * from the registry's /latest fetch), never a separate lookup.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { detectDeprecatedFindings, extractSuggestedReplacement } from '../out/core/hygiene/deprecated.js';

function row(overrides) {
  return {
    name: 'left-pad',
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

test('a deprecated row with a message produces a high-confidence finding', () => {
  const findings = detectDeprecatedFindings([row({ deprecated: 'This package is no longer maintained.' })]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].packageName, 'left-pad');
  assert.equal(findings[0].kind, 'deprecated');
  assert.equal(findings[0].confidence, 'high');
  assert.equal(findings[0].severity, 'attention');
  assert.equal(findings[0].evidence.kind, 'deprecated');
  assert.equal(findings[0].evidence.message, 'This package is no longer maintained.');
});

test('a non-deprecated row produces no finding', () => {
  assert.deepEqual(detectDeprecatedFindings([row({})]), []);
});

test('missing deprecation metadata (field entirely absent) produces no finding', () => {
  const withoutField = row({});
  delete withoutField.deprecated;
  assert.deepEqual(detectDeprecatedFindings([withoutField]), []);
});

test('a scoped package name is preserved as-is', () => {
  const findings = detectDeprecatedFindings([
    row({ name: '@babel/polyfill', deprecated: 'This package has been deprecated.' }),
  ]);
  assert.equal(findings[0].packageName, '@babel/polyfill');
});

test('a deprecated package that also carries a vulnerability still produces its own deprecated finding', () => {
  const advisory = {
    advisory: {
      id: 1,
      severity: 'high',
      title: 'fixture advisory',
      url: 'https://example.com',
      vulnerableVersions: '<1.0.0',
    },
    flaggedPackage: 'left-pad',
    path: ['left-pad'],
    patchedVersion: { status: 'unknown' },
  };
  const findings = detectDeprecatedFindings([
    row({ deprecated: 'Deprecated.', advisories: [advisory], worstSeverity: 'high' }),
  ]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, 'deprecated');
});

test('a deprecated package that also has an available update still produces its own deprecated finding', () => {
  const findings = detectDeprecatedFindings([
    row({ deprecated: 'Deprecated.', latest: '2.0.0', upgradeTo: '2.0.0', upgradeReason: 'update' }),
  ]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].evidence.suggestedReplacement, undefined);
});

// -------------------------------------------------- suggested replacement

test('an explicit "use X instead" phrasing extracts a valid replacement package name', () => {
  assert.equal(extractSuggestedReplacement('This module has moved. Use left-pad-2 instead.'), 'left-pad-2');
});

test('a scoped replacement package name is extracted', () => {
  assert.equal(extractSuggestedReplacement('Please use @babel/core instead.'), '@babel/core');
});

test('"renamed to X" and "replaced by X" phrasings are both recognized', () => {
  assert.equal(extractSuggestedReplacement('renamed to new-name'), 'new-name');
  assert.equal(extractSuggestedReplacement('replaced by other-package'), 'other-package');
});

test('free-form prose with no explicit phrasing extracts no replacement', () => {
  assert.equal(extractSuggestedReplacement('This package is no longer maintained by the author.'), undefined);
});

test('a candidate that is not a syntactically valid npm package name is rejected', () => {
  assert.equal(extractSuggestedReplacement('use THIS/is not valid instead'), undefined);
});

test('detectDeprecatedFindings surfaces a high-confidence suggested replacement in evidence', () => {
  const findings = detectDeprecatedFindings([row({ deprecated: 'Use is-array-2 instead.' })]);
  assert.equal(findings[0].evidence.suggestedReplacement, 'is-array-2');
});
