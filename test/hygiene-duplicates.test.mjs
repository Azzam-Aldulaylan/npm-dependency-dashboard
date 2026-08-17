/**
 * Duplicate-version detection — grouping graph nodes by package name into
 * distinct resolved versions (see hygiene/duplicates.ts, built on the same
 * whyInstalled grouping "Why installed" itself uses).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { detectDuplicateVersionFindings } from '../out/core/hygiene/duplicates.js';
import { buildGraph } from '../out/core/lockfile/parse.js';
import { buildPnpmGraph } from '../out/core/lockfile/pnpm.js';
import { parseManifest } from '../out/core/manifest/parse.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(join(here, 'fixtures', name), 'utf8');

function node(name, path, { version = null, direct = false, edges = [] } = {}) {
  return { name, version, range: '', dev: false, direct, path, deps: edges.map((e) => e.name), edges };
}
function edge(name, targetNodeId) {
  return { name, requestedRange: '', kind: 'runtime', targetNodeId, optional: false };
}
function graphOf(nodes) {
  const map = new Map();
  for (const n of nodes) map.set(n.path, n);
  return { root: '/app', packageManager: 'npm', lockfileVersion: 3, nodes: map };
}
function declared(name) {
  return { name, range: '^1.0.0', dev: false, optional: false };
}

test('the same version installed at multiple paths is not a duplicate', () => {
  const shared = { version: '1.0.0' };
  const graph = graphOf([
    node('app-a', 'node_modules/app-a', { version: '1.0.0', direct: true, edges: [edge('shared', 'node_modules/app-a/node_modules/shared')] }),
    node('app-b', 'node_modules/app-b', { version: '1.0.0', direct: true, edges: [edge('shared', 'node_modules/app-b/node_modules/shared')] }),
    node('shared', 'node_modules/app-a/node_modules/shared', shared),
    node('shared', 'node_modules/app-b/node_modules/shared', shared),
  ]);
  const findings = detectDuplicateVersionFindings(graph, [declared('app-a'), declared('app-b')]);
  assert.deepEqual(findings, []);
});

test('two distinct resolved versions of the same package produce one duplicate-version finding', () => {
  const graph = graphOf([
    node('app-a', 'node_modules/app-a', { version: '1.0.0', direct: true, edges: [edge('shared', 'node_modules/app-a/node_modules/shared')] }),
    node('app-b', 'node_modules/app-b', { version: '1.0.0', direct: true, edges: [edge('shared', 'node_modules/app-b/node_modules/shared')] }),
    node('shared', 'node_modules/app-a/node_modules/shared', { version: '1.0.0' }),
    node('shared', 'node_modules/app-b/node_modules/shared', { version: '2.0.0' }),
  ]);
  const findings = detectDuplicateVersionFindings(graph, [declared('app-a'), declared('app-b')]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].packageName, 'shared');
  assert.equal(findings[0].kind, 'duplicate-version');
  assert.equal(findings[0].evidence.kind, 'duplicate-version');
  assert.deepEqual(
    findings[0].evidence.versions.map((v) => v.version),
    ['1.0.0', '2.0.0']
  );
});

test('three distinct versions produce one grouped finding carrying all three', () => {
  const graph = graphOf([
    node('app-a', 'node_modules/app-a', { version: '1.0.0', direct: true, edges: [edge('shared', 'node_modules/app-a/node_modules/shared')] }),
    node('app-b', 'node_modules/app-b', { version: '1.0.0', direct: true, edges: [edge('shared', 'node_modules/app-b/node_modules/shared')] }),
    node('app-c', 'node_modules/app-c', { version: '1.0.0', direct: true, edges: [edge('shared', 'node_modules/app-c/node_modules/shared')] }),
    node('shared', 'node_modules/app-a/node_modules/shared', { version: '1.0.0' }),
    node('shared', 'node_modules/app-b/node_modules/shared', { version: '2.0.0' }),
    node('shared', 'node_modules/app-c/node_modules/shared', { version: '3.0.0' }),
  ]);
  const findings = detectDuplicateVersionFindings(graph, [declared('app-a'), declared('app-b'), declared('app-c')]);
  assert.equal(findings.length, 1);
  assert.deepEqual(
    findings[0].evidence.versions.map((v) => v.version),
    ['1.0.0', '2.0.0', '3.0.0']
  );
});

// -------------------------------------------------------------- npm fixture

test('npm fixture: lock-v1.json resolves js-tokens at two distinct versions via two different direct dependencies', () => {
  const manifest = parseManifest(
    JSON.stringify({
      name: 'app',
      dependencies: { react: '^18.2.0', 'legacy-thing': '^1.0.0' },
      devDependencies: { typescript: '^5.4.0' },
    })
  );
  const graph = buildGraph({ root: '/app', manifest, lockfileText: fixture('lock-v1.json') });
  const findings = detectDuplicateVersionFindings(graph, manifest.dependencies);
  const jsTokens = findings.find((f) => f.packageName === 'js-tokens');
  assert.ok(jsTokens, 'expected a duplicate-version finding for js-tokens');
  assert.deepEqual(
    jsTokens.evidence.versions.map((v) => v.version),
    ['3.0.2', '4.0.0']
  );
  const v302 = jsTokens.evidence.versions.find((v) => v.version === '3.0.2');
  assert.deepEqual(v302.paths, [['legacy-thing', 'js-tokens']]);
  const v400 = jsTokens.evidence.versions.find((v) => v.version === '4.0.0');
  assert.deepEqual(v400.paths, [['react', 'loose-envify', 'js-tokens']]);
});

// ------------------------------------------------------------- pnpm fixture

const PNPM_DUPLICATE_LOCKFILE = `
lockfileVersion: '9.0'

importers:
  .:
    dependencies:
      pkg-a:
        specifier: ^1.0.0
        version: 1.0.0
      pkg-b:
        specifier: ^1.0.0
        version: 1.0.0

packages:
  pkg-a@1.0.0: {}
  pkg-b@1.0.0: {}
  shared@1.0.0: {}
  shared@2.0.0: {}

snapshots:
  pkg-a@1.0.0:
    dependencies:
      shared: 1.0.0
  pkg-b@1.0.0:
    dependencies:
      shared: 2.0.0
  shared@1.0.0: {}
  shared@2.0.0: {}
`;

test('pnpm fixture: two direct dependencies pulling different versions of a shared transitive package', () => {
  const manifest = parseManifest(
    JSON.stringify({ name: 'app', packageManager: 'pnpm@9.0.0', dependencies: { 'pkg-a': '^1.0.0', 'pkg-b': '^1.0.0' } })
  );
  const graph = buildPnpmGraph({ root: '/app', manifest, lockfileText: PNPM_DUPLICATE_LOCKFILE });
  const findings = detectDuplicateVersionFindings(graph, manifest.dependencies);
  const shared = findings.find((f) => f.packageName === 'shared');
  assert.ok(shared, 'expected a duplicate-version finding for shared');
  assert.deepEqual(
    shared.evidence.versions.map((v) => v.version),
    ['1.0.0', '2.0.0']
  );
  assert.deepEqual(shared.evidence.versions[0].paths, [['pkg-a', 'shared']]);
  assert.deepEqual(shared.evidence.versions[1].paths, [['pkg-b', 'shared']]);
});
