import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { attributeAdvisories } from '../out/core/advisories/attribution.js';
import { buildDependencyGraph } from '../out/core/lockfile/build.js';
import { resolveDependency } from '../out/core/lockfile/parse.js';
import { buildPnpmGraph, UnsupportedPnpmLockfileError } from '../out/core/lockfile/pnpm.js';
import { parseManifest } from '../out/core/manifest/parse.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(join(here, 'fixtures', name), 'utf8');

const manifest = parseManifest(JSON.stringify({
  name: 'app',
  packageManager: 'pnpm@10.0.0',
  dependencies: {
    react: '^19.0.0',
    'peer-user': '^5.0.0',
    'missing-peer': '^1.0.0',
    'optional-peer': '^1.0.0',
  },
  optionalDependencies: { 'optional-root': '^2.0.0' },
  devDependencies: { typescript: '^5.4.0' },
}));

test('pnpm v9 selects direct dependencies from the requested importer', () => {
  const graph = buildPnpmGraph({ root: '/repo', manifest, lockfileText: fixture('pnpm-lock-v9.yaml') });
  assert.equal(graph.packageManager, 'pnpm');
  assert.equal(graph.lockfileVersion, '9.0');
  const direct = [...graph.nodes.values()].filter((node) => node.direct);
  assert.deepEqual(direct.map((node) => node.name).sort(), [
    'missing-peer', 'optional-peer', 'optional-root', 'peer-user', 'react', 'typescript',
  ]);
  assert.equal(direct.find((node) => node.name === 'typescript').dev, true);
  assert.equal(direct.find((node) => node.name === 'optional-root').dev, false);
});

test('pnpm snapshot references become explicit normalized runtime and optional edges', () => {
  const graph = buildPnpmGraph({ root: '/repo', manifest, lockfileText: fixture('pnpm-lock-v9.yaml') });
  const peerUser = [...graph.nodes.values()].find((node) => node.name === 'peer-user');
  const runtime = peerUser.edges.find((edge) => edge.name === 'runtime-helper');
  const optional = peerUser.edges.find((edge) => edge.name === 'optional-helper');
  assert.equal(runtime.kind, 'runtime');
  assert.equal(resolveDependency(graph, peerUser.path, runtime.name).version, '1.0.0');
  assert.equal(optional.kind, 'optional');
  assert.equal(optional.optional, true);
  assert.equal(resolveDependency(graph, peerUser.path, optional.name).version, '2.0.0');
});

test('pnpm peer contexts resolve compatible peers and preserve missing/optional peers', () => {
  const graph = buildPnpmGraph({ root: '/repo', manifest, lockfileText: fixture('pnpm-lock-v9.yaml') });
  const byName = (name) => [...graph.nodes.values()].find((node) => node.name === name);
  const reactPeer = byName('peer-user').edges.find((edge) => edge.kind === 'peer');
  assert.equal(reactPeer.requestedRange, '^18.0.0 || ^19.0.0');
  assert.equal(resolveDependency(graph, byName('peer-user').path, 'react', ['peer']).version, '19.0.0');
  const missing = byName('missing-peer').edges.find((edge) => edge.kind === 'peer');
  assert.equal(missing.targetNodeId, null);
  assert.equal(missing.optional, false);
  const optional = byName('optional-peer').edges.find((edge) => edge.kind === 'peer');
  assert.equal(optional.targetNodeId, null);
  assert.equal(optional.optional, true);
});

test('pnpm member importer resolves registry packages and preserves workspace links', () => {
  const memberManifest = parseManifest(JSON.stringify({
    name: '@ws/app',
    dependencies: { '@ws/lib': 'workspace:*', lodash: '^4.17.0' },
  }));
  const graph = buildPnpmGraph({
    root: '/repo/packages/app',
    manifest: memberManifest,
    lockfileText: fixture('pnpm-lock-v9-workspace.yaml'),
    importerId: 'packages/app',
  });
  const direct = [...graph.nodes.values()].filter((node) => node.direct);
  assert.equal(direct.find((node) => node.name === 'lodash').version, '4.17.21');
  const workspace = direct.find((node) => node.name === '@ws/lib');
  assert.equal(workspace.version, null);
  assert.equal(workspace.unresolvable, 'workspace-link');
});

test('normalized advisory attribution works over pnpm explicit edges', () => {
  const graph = buildPnpmGraph({ root: '/repo', manifest, lockfileText: fixture('pnpm-lock-v9.yaml') });
  const attributed = attributeAdvisories(graph, new Map([['runtime-helper', [{
    id: 1,
    severity: 'high',
    title: 'fixture advisory',
    url: 'https://example.test/advisory',
    vulnerableVersions: '1.0.0',
  }]]]));
  assert.deepEqual(attributed.get('peer-user')?.[0]?.path, ['peer-user', 'runtime-helper']);
});

test('the manager facade dispatches to pnpm and unsupported formats fail loudly', () => {
  const graph = buildDependencyGraph({
    root: '/repo', manifest, lockfileText: fixture('pnpm-lock-v9.yaml'), packageManager: 'pnpm',
  });
  assert.equal(graph.packageManager, 'pnpm');
  assert.throws(
    () => buildPnpmGraph({ root: '/repo', manifest, lockfileText: 'lockfileVersion: "8.0"' }),
    UnsupportedPnpmLockfileError,
  );
});
