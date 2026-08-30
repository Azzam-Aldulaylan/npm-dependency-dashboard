/**
 * The trust boundary for "open advisory source" (Problem 4): the webview
 * only ever names an advisory (package/advisoryId/path), never a URL — this
 * is what actually resolves that name against the host's own last-trusted
 * scan and decides whether the stored URL is safe to open externally.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isSafeAdvisoryUrl, resolveTrustedAdvisoryUrl } from '../out/core/advisories/resolve.js';

function attributedAdvisory(overrides = {}) {
  return {
    advisory: {
      id: 1096549,
      severity: 'high',
      title: 'minimatch ReDoS vulnerability',
      url: 'https://github.com/advisories/GHSA-f8q6-p94x-37v3',
      vulnerableVersions: '<=3.1.3',
    },
    flaggedPackage: 'minimatch',
    path: ['minimatch'],
    ...overrides,
  };
}

function row(overrides = {}) {
  return {
    name: 'minimatch',
    current: '3.0.4',
    wanted: '3.1.5',
    latest: '3.1.5',
    dev: false,
    range: '^3.0.0',
    advisories: [attributedAdvisory()],
    worstSeverity: 'high',
    upgradeTo: '3.1.5',
    upgradeReason: 'security-fix',
    ...overrides,
  };
}

// -------------------------------------------------------------- isSafeAdvisoryUrl

test('a well-formed https URL is safe', () => {
  assert.equal(isSafeAdvisoryUrl('https://github.com/advisories/GHSA-xxxx'), true);
});

test('an http URL is refused — only https is ever opened', () => {
  assert.equal(isSafeAdvisoryUrl('http://example.com/advisory'), false);
});

test('a javascript: URL is refused', () => {
  assert.equal(isSafeAdvisoryUrl('javascript:alert(1)'), false);
});

test('a file: URL is refused', () => {
  assert.equal(isSafeAdvisoryUrl('file:///etc/passwd'), false);
});

test('a malformed string is refused, not thrown', () => {
  assert.equal(isSafeAdvisoryUrl('not a url at all'), false);
  assert.equal(isSafeAdvisoryUrl(''), false);
});

// -------------------------------------------------------- resolveTrustedAdvisoryUrl

test('a valid, trusted advisory resolves to its own https URL', () => {
  const url = resolveTrustedAdvisoryUrl([row()], {
    package: 'minimatch',
    advisoryId: 1096549,
    path: ['minimatch'],
  });
  assert.equal(url, 'https://github.com/advisories/GHSA-f8q6-p94x-37v3');
});

test('a trusted CVE badge resolves to its NVD vulnerability detail', () => {
  const cveRow = row({
    advisories: [attributedAdvisory({
      advisory: {
        ...attributedAdvisory().advisory,
        identifiers: [{ type: 'CVE', value: 'CVE-2026-67213' }],
      },
    })],
  });
  assert.equal(
    resolveTrustedAdvisoryUrl([cveRow], {
      package: 'minimatch',
      advisoryId: 1096549,
      path: ['minimatch'],
      reference: 'CVE-2026-67213',
    }),
    'https://nvd.nist.gov/vuln/detail/CVE-2026-67213'
  );
});

test('a trusted GHSA badge resolves to its GitHub Advisory Database record', () => {
  assert.equal(
    resolveTrustedAdvisoryUrl([row()], {
      package: 'minimatch',
      advisoryId: 1096549,
      path: ['minimatch'],
      reference: 'GHSA-F8Q6-P94X-37V3',
    }),
    'https://github.com/advisories/GHSA-F8Q6-P94X-37V3'
  );
});

test('an internal npm source id cannot be opened as a visible identifier', () => {
  assert.equal(
    resolveTrustedAdvisoryUrl([row()], {
      package: 'minimatch',
      advisoryId: 1096549,
      path: ['minimatch'],
      reference: 'npm:1096549',
    }),
    null
  );
});

test('an ID that does not belong to the trusted advisory cannot be opened', () => {
  assert.equal(
    resolveTrustedAdvisoryUrl([row()], {
      package: 'minimatch',
      advisoryId: 1096549,
      path: ['minimatch'],
      reference: 'CVE-2026-99999',
    }),
    null
  );
});

test('an unknown package name resolves to nothing', () => {
  const url = resolveTrustedAdvisoryUrl([row()], {
    package: 'does-not-exist',
    advisoryId: 1096549,
    path: ['minimatch'],
  });
  assert.equal(url, null);
});

test('a package that exists, but with an advisory id not present in the trusted scan, resolves to nothing', () => {
  const url = resolveTrustedAdvisoryUrl([row()], {
    package: 'minimatch',
    advisoryId: 999999,
    path: ['minimatch'],
  });
  assert.equal(url, null);
});

test('a matching id but a different path resolves to nothing — path disambiguates like the UI key does', () => {
  const url = resolveTrustedAdvisoryUrl([row()], {
    package: 'minimatch',
    advisoryId: 1096549,
    path: ['some-other-dep', 'minimatch'],
  });
  assert.equal(url, null);
});

test('a row whose stored advisory URL is itself unsafe (non-https) never resolves, even for a real, matching advisory', () => {
  const hostileRow = row({
    advisories: [attributedAdvisory({ advisory: { ...attributedAdvisory().advisory, url: 'javascript:alert(1)' } })],
  });
  const url = resolveTrustedAdvisoryUrl([hostileRow], {
    package: 'minimatch',
    advisoryId: 1096549,
    path: ['minimatch'],
  });
  assert.equal(url, null, 'a forged/corrupted stored URL is refused just like any other unsafe URL');
});

test('a package with multiple advisories resolves each one independently by its own id/path', () => {
  const first = attributedAdvisory({
    advisory: { id: 1, severity: 'critical', title: 'first', url: 'https://example.com/first', vulnerableVersions: '<1' },
    path: ['pkg'],
  });
  const second = attributedAdvisory({
    advisory: { id: 2, severity: 'moderate', title: 'second', url: 'https://example.com/second', vulnerableVersions: '<2' },
    path: ['pkg', 'nested'],
    flaggedPackage: 'nested',
  });
  const multiRow = row({ name: 'pkg', advisories: [first, second] });

  assert.equal(
    resolveTrustedAdvisoryUrl([multiRow], { package: 'pkg', advisoryId: 1, path: ['pkg'] }),
    'https://example.com/first'
  );
  assert.equal(
    resolveTrustedAdvisoryUrl([multiRow], { package: 'pkg', advisoryId: 2, path: ['pkg', 'nested'] }),
    'https://example.com/second'
  );
});

test('the webview cannot inject an arbitrary URL — the resolved value always comes from the trusted row, never the request', () => {
  // The request shape has no `url` field at all; even if a compromised or
  // buggy webview somehow attached one, resolveTrustedAdvisoryUrl never
  // reads anything but package/advisoryId/path from it.
  const forgedRequest = {
    package: 'minimatch',
    advisoryId: 1096549,
    path: ['minimatch'],
    url: 'https://evil.example.com',
  };
  const url = resolveTrustedAdvisoryUrl([row()], forgedRequest);
  assert.equal(url, 'https://github.com/advisories/GHSA-f8q6-p94x-37v3', "the row's own URL, never the forged one");
});
