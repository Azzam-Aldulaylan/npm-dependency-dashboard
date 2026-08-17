/**
 * attachPatchedVersions / distinctFlaggedPackages — wires
 * resolveFirstPatchedVersion onto already-attributed advisories from a
 * caller-supplied packument lookup. See advisories/attribution.ts for why
 * every AttributedAdvisory starts with `patchedVersion: { status: 'unknown' }`
 * before this runs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { attachPatchedVersions, distinctFlaggedPackages } from '../out/core/advisories/remediation.js';

function entry(overrides) {
  return {
    advisory: {
      id: 1,
      severity: 'high',
      title: 't',
      url: 'https://example.invalid',
      vulnerableVersions: '<4.0.0',
    },
    flaggedPackage: 'form-data',
    path: ['axios', 'form-data'],
    patchedVersion: { status: 'unknown' },
    ...overrides,
  };
}

test('distinctFlaggedPackages collects every unique flagged package across all roots', () => {
  const map = new Map([
    ['axios', [entry({ flaggedPackage: 'form-data' })]],
    ['other-root', [entry({ flaggedPackage: 'form-data' }), entry({ flaggedPackage: 'minimatch' })]],
  ]);
  const names = distinctFlaggedPackages(map);
  assert.deepEqual([...names].sort(), ['form-data', 'minimatch']);
});

test('distinctFlaggedPackages on an empty map is empty', () => {
  assert.deepEqual([...distinctFlaggedPackages(new Map())], []);
});

test('attachPatchedVersions fills in a known patched version from the supplied packument', () => {
  const map = new Map([['axios', [entry()]]]);
  const packuments = new Map([['form-data', ['3.0.0', '3.5.0', '4.0.0']]]);
  const result = attachPatchedVersions(map, packuments);
  assert.deepEqual(result.get('axios')[0].patchedVersion, { status: 'known', version: '4.0.0' });
});

test('a flagged package missing from the packument map resolves to unknown, not none', () => {
  const map = new Map([['axios', [entry()]]]);
  const result = attachPatchedVersions(map, new Map());
  assert.deepEqual(result.get('axios')[0].patchedVersion, { status: 'unknown' });
});

test('attachPatchedVersions preserves every other field on the entry unchanged', () => {
  const original = entry();
  const map = new Map([['axios', [original]]]);
  const result = attachPatchedVersions(map, new Map([['form-data', ['4.0.0']]]));
  const [attached] = result.get('axios');
  assert.deepEqual(attached.advisory, original.advisory);
  assert.equal(attached.flaggedPackage, original.flaggedPackage);
  assert.deepEqual(attached.path, original.path);
});

test('multiple advisories on the same package each resolve independently by their own range', () => {
  const map = new Map([
    [
      'axios',
      [
        entry({ advisory: { id: 1, severity: 'high', title: 'a', url: 'https://x', vulnerableVersions: '<3.5.0' } }),
        entry({ advisory: { id: 2, severity: 'critical', title: 'b', url: 'https://x', vulnerableVersions: '<3.9.0' } }),
      ],
    ],
  ]);
  const packuments = new Map([['form-data', ['3.0.0', '3.5.0', '3.9.0', '4.0.0']]]);
  const result = attachPatchedVersions(map, packuments);
  const [first, second] = result.get('axios');
  assert.deepEqual(first.patchedVersion, { status: 'known', version: '3.5.0' });
  assert.deepEqual(second.patchedVersion, { status: 'known', version: '3.9.0' });
});
