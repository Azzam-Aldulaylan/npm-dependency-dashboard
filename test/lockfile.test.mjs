/**
 * Lockfile parsing across all three on-disk shapes.
 *
 * The failure mode these guard against is silent: a mis-parsed lockfile yields
 * a plausible-looking but wrong "current version", and the user acts on it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  buildGraph,
  nameFromPackageKey,
  resolveFrom,
  directNodes,
  UnsupportedLockfileError,
} from '../out/core/lockfile/parse.js';
import { parseManifest } from '../out/core/manifest/parse.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(join(here, 'fixtures', name), 'utf8');

const APP_MANIFEST = parseManifest(
  JSON.stringify({
    name: 'app',
    dependencies: { react: '^18.2.0', 'legacy-thing': '^1.0.0' },
    devDependencies: { typescript: '^5.4.0' },
  })
);

// ------------------------------------------------------------- key parsing

test('nameFromPackageKey handles plain, scoped, and nested keys', () => {
  assert.equal(nameFromPackageKey('node_modules/react'), 'react');
  assert.equal(nameFromPackageKey('node_modules/@scope/pkg'), '@scope/pkg');
  assert.equal(nameFromPackageKey('node_modules/a/node_modules/b'), 'b');
});

test('nameFromPackageKey returns null for the root and workspace members', () => {
  assert.equal(nameFromPackageKey(''), null);
  assert.equal(nameFromPackageKey('packages/app'), null);
});

// ------------------------------------------------------------------- v1

test('v1: nested dependencies tree resolves direct and transitive versions', () => {
  const graph = buildGraph({
    root: '/app',
    manifest: APP_MANIFEST,
    lockfileText: fixture('lock-v1.json'),
  });

  assert.equal(graph.lockfileVersion, 1);
  assert.equal(graph.nodes.get('node_modules/react').version, '18.2.0');
  assert.equal(graph.nodes.get('node_modules/js-tokens').version, '4.0.0');
  assert.equal(graph.nodes.get('node_modules/typescript').dev, true);
});

test('v1: a nested duplicate is kept as its own node, not collapsed', () => {
  const graph = buildGraph({
    root: '/app',
    manifest: APP_MANIFEST,
    lockfileText: fixture('lock-v1.json'),
  });

  // Both copies of js-tokens must survive — attribution depends on telling
  // 4.0.0 at the root apart from 3.0.2 under legacy-thing.
  assert.equal(graph.nodes.get('node_modules/js-tokens').version, '4.0.0');
  assert.equal(
    graph.nodes.get('node_modules/legacy-thing/node_modules/js-tokens').version,
    '3.0.2'
  );
});

test('v1: edges come from `requires`', () => {
  const graph = buildGraph({
    root: '/app',
    manifest: APP_MANIFEST,
    lockfileText: fixture('lock-v1.json'),
  });
  assert.deepEqual(graph.nodes.get('node_modules/react').deps, ['loose-envify']);
});

// ------------------------------------------------------------------- v2

test('v2: parses the `packages` map, not the legacy `dependencies` mirror', () => {
  const graph = buildGraph({
    root: '/app',
    manifest: APP_MANIFEST,
    lockfileText: fixture('lock-v2.json'),
  });

  assert.equal(graph.lockfileVersion, 2);
  assert.equal(graph.nodes.get('node_modules/react').version, '18.2.0');
  // `dependencies` (v1 mirror) uses `requires`; `packages` uses `dependencies`.
  // Getting the edge back proves the modern path was taken.
  assert.deepEqual(graph.nodes.get('node_modules/react').deps, ['loose-envify']);
});

// ------------------------------------------------------------------- v3

test('v3: flat packages map with a nested duplicate', () => {
  const graph = buildGraph({
    root: '/app',
    manifest: APP_MANIFEST,
    lockfileText: fixture('lock-v3.json'),
  });

  assert.equal(graph.lockfileVersion, 3);
  assert.equal(graph.nodes.get('node_modules/js-tokens').version, '4.0.0');
  assert.equal(
    graph.nodes.get('node_modules/legacy-thing/node_modules/js-tokens').version,
    '3.0.2'
  );
});

test('v3: direct dependencies are flagged and dev is carried through', () => {
  const graph = buildGraph({
    root: '/app',
    manifest: APP_MANIFEST,
    lockfileText: fixture('lock-v3.json'),
  });

  const names = directNodes(graph)
    .map((n) => n.name)
    .sort();
  assert.deepEqual(names, ['legacy-thing', 'react', 'typescript']);
  assert.equal(graph.nodes.get('node_modules/typescript').dev, true);
  assert.equal(graph.nodes.get('node_modules/react').dev, false);
  // The declared range is carried from the manifest, not the lockfile.
  assert.equal(graph.nodes.get('node_modules/react').range, '^18.2.0');
});

test('resolveFrom follows npm lookup: own node_modules first, then upward', () => {
  const graph = buildGraph({
    root: '/app',
    manifest: APP_MANIFEST,
    lockfileText: fixture('lock-v3.json'),
  });

  // legacy-thing has its own nested copy.
  assert.equal(
    resolveFrom(graph, 'node_modules/legacy-thing', 'js-tokens').version,
    '3.0.2'
  );
  // react does not, so it walks up to the hoisted one.
  assert.equal(resolveFrom(graph, 'node_modules/react', 'js-tokens').version, '4.0.0');
  assert.equal(resolveFrom(graph, 'node_modules/react', 'nonexistent'), null);
});

// ------------------------------------------------------- npm workspaces

test('workspaces: "link": true is tagged workspace-local, not errored', () => {
  const manifest = parseManifest(
    JSON.stringify({ name: 'monorepo', dependencies: { '@ws/app': '*' } })
  );
  const graph = buildGraph({
    root: '/monorepo',
    manifest,
    lockfileText: fixture('lock-v3-workspaces.json'),
  });

  const app = graph.nodes.get('node_modules/@ws/app');
  assert.equal(app.unresolvable, 'workspace-link');
  assert.equal(app.version, null, 'a linked package has no registry version');
});

test('workspaces: member directories are not dependency nodes', () => {
  const manifest = parseManifest(JSON.stringify({ name: 'monorepo' }));
  const graph = buildGraph({
    root: '/monorepo',
    manifest,
    lockfileText: fixture('lock-v3-workspaces.json'),
  });

  assert.equal(graph.nodes.has('packages/app'), false);
  assert.equal(graph.nodes.has('packages/lib'), false);
  // The real registry dependency still resolves normally.
  assert.equal(graph.nodes.get('node_modules/lodash').version, '4.17.21');
});

// ------------------------------------------------------------ edge cases

test('an unknown lockfileVersion fails loudly instead of being guessed', () => {
  assert.throws(
    () =>
      buildGraph({
        root: '/app',
        manifest: APP_MANIFEST,
        lockfileText: JSON.stringify({ lockfileVersion: 99, packages: {} }),
      }),
    UnsupportedLockfileError
  );
});

test('no lockfile: every declared dep still gets a row, tagged no-lockfile', () => {
  const graph = buildGraph({
    root: '/app',
    manifest: APP_MANIFEST,
    lockfileText: null,
  });

  assert.equal(graph.lockfileVersion, null);
  assert.equal(graph.nodes.size, 3);
  const react = graph.nodes.get('node_modules/react');
  assert.equal(react.version, null);
  assert.equal(react.range, '^18.2.0');
  assert.equal(react.unresolvable, 'no-lockfile');
});

test('no lockfile: a non-registry specifier keeps its more specific reason', () => {
  const manifest = parseManifest(
    JSON.stringify({ dependencies: { local: 'file:../local' } })
  );
  const graph = buildGraph({ root: '/app', manifest, lockfileText: null });
  assert.equal(graph.nodes.get('node_modules/local').unresolvable, 'file');
});

test('a declared dep missing from the lockfile still produces a row', () => {
  const manifest = parseManifest(
    JSON.stringify({ dependencies: { react: '^18.2.0', 'never-installed': '^1.0.0' } })
  );
  const graph = buildGraph({
    root: '/app',
    manifest,
    lockfileText: fixture('lock-v3.json'),
  });

  const missing = graph.nodes.get('node_modules/never-installed');
  assert.equal(missing.version, null);
  assert.equal(missing.direct, true);
});

test('__proto__ keys in a lockfile do not become nodes', () => {
  const manifest = parseManifest(JSON.stringify({ dependencies: {} }));
  const graph = buildGraph({
    root: '/app',
    manifest,
    lockfileText: JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': {},
        'node_modules/safe': { version: '1.0.0', dependencies: { __proto__: '1.0.0' } },
      },
    }),
  });

  assert.deepEqual(graph.nodes.get('node_modules/safe').deps, []);
  assert.equal({}.polluted, undefined);
});
