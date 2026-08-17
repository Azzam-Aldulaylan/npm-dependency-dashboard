/**
 * Attribution walks the S1 lockfile graph ourselves — not npm audit's
 * effects/via. lock-v3.json's shared js-tokens is the useful fixture here: it
 * is hoisted to 4.0.0 under react's subtree, but nested at 3.0.2 under
 * legacy-thing's, so an advisory scoped to "<4.0.0" must attribute to
 * legacy-thing only, while a broader "<5.0.0" advisory must attribute to both.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { buildGraph } from '../out/core/lockfile/parse.js';
import { parseManifest } from '../out/core/manifest/parse.js';
import { attributeAdvisories } from '../out/core/advisories/attribution.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(join(here, 'fixtures', name), 'utf8');

const APP_MANIFEST = parseManifest(
  JSON.stringify({
    name: 'app',
    dependencies: { react: '^18.2.0', 'legacy-thing': '^1.0.0' },
  })
);

function graph() {
  return buildGraph({ root: '/app', manifest: APP_MANIFEST, lockfileText: fixture('lock-v3.json') });
}

function advisory(overrides) {
  return {
    id: 1,
    severity: 'high',
    title: 't',
    url: 'https://example.invalid',
    vulnerableVersions: '<4.0.0',
    ...overrides,
  };
}

test('a version-scoped advisory attributes only to the direct dep whose subtree has the vulnerable version', () => {
  const byName = new Map([['js-tokens', [advisory({ vulnerableVersions: '<4.0.0' })]]]);
  const result = attributeAdvisories(graph(), byName);

  assert.equal(result.has('react'), false, 'react resolves js-tokens@4.0.0, which is clean');
  assert.equal(result.has('legacy-thing'), true);
  const [attributed] = result.get('legacy-thing');
  assert.equal(attributed.flaggedPackage, 'js-tokens');
  assert.deepEqual(attributed.path, ['legacy-thing', 'js-tokens']);
});

test('a broader advisory attributes to every direct dep whose subtree resolves a matching version', () => {
  const byName = new Map([['js-tokens', [advisory({ vulnerableVersions: '<5.0.0' })]]]);
  const result = attributeAdvisories(graph(), byName);

  assert.equal(result.has('react'), true);
  assert.equal(result.has('legacy-thing'), true);
  assert.deepEqual(result.get('react')[0].path, ['react', 'loose-envify', 'js-tokens']);
  assert.deepEqual(result.get('legacy-thing')[0].path, ['legacy-thing', 'js-tokens']);
});

test('an advisory against a direct dependency itself has a single-element path', () => {
  const byName = new Map([['react', [advisory({ vulnerableVersions: '<=18.2.0' })]]]);
  const result = attributeAdvisories(graph(), byName);

  assert.deepEqual(result.get('react'), [
    {
      advisory: byName.get('react')[0],
      flaggedPackage: 'react',
      path: ['react'],
      patchedVersion: { status: 'unknown' },
    },
  ]);
});

test('a direct dependency with nothing attributed is absent from the result', () => {
  const byName = new Map([['nonexistent-package', [advisory()]]]);
  const result = attributeAdvisories(graph(), byName);
  assert.equal(result.size, 0);
});

test('an unresolvable (linked/no-version) node is never treated as flagged', () => {
  const g = graph();
  const link = g.nodes.get('node_modules/react');
  link.version = null;
  link.unresolvable = 'workspace-link';
  const byName = new Map([['react', [advisory({ vulnerableVersions: '*' })]]]);
  const result = attributeAdvisories(g, byName);
  assert.equal(result.has('react'), false);
});
