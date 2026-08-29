/**
 * Fixture style matches graph-paths-why-installed.test.mjs — hand-built
 * graphs, since stillRequiredBy is a thin wrapper around whyInstalled's own
 * path output.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { stillRequiredBy } from '../out/core/upgrade/removeImpact.js';
import { buildWhyInstalledIndex } from '../out/core/hygiene/whyInstalled.js';

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

function declared(name, { dev = false, optional = false } = {}) {
  return { name, range: '^1.0.0', dev, optional };
}

test('a package with no other dependents is not still required by anything', () => {
  const graph = graphOf([node('left-pad', 'node_modules/left-pad', { version: '1.0.0', direct: true })]);
  assert.deepEqual(stillRequiredBy(graph, [declared('left-pad')], 'left-pad', new Set(['left-pad'])), []);
});

test('a transitively-depended-on package reports the direct dependency that still needs it', () => {
  const graph = graphOf([
    node('app-a', 'node_modules/app-a', { version: '1.0.0', direct: true, edges: [edge('shared', 'node_modules/app-a/node_modules/shared')] }),
    node('shared', 'node_modules/app-a/node_modules/shared', { version: '1.0.0' }),
  ]);
  const result = stillRequiredBy(graph, [declared('app-a')], 'shared', new Set(['shared']));
  assert.deepEqual(result, ['app-a']);
});

test('a dependent that is also being removed in the same batch is excluded', () => {
  const graph = graphOf([
    node('app-a', 'node_modules/app-a', { version: '1.0.0', direct: true, edges: [edge('shared', 'node_modules/app-a/node_modules/shared')] }),
    node('shared', 'node_modules/app-a/node_modules/shared', { version: '1.0.0' }),
  ]);
  const result = stillRequiredBy(graph, [declared('app-a')], 'shared', new Set(['shared', 'app-a']));
  assert.deepEqual(result, []);
});

test('multiple dependents are deduplicated and sorted', () => {
  const graph = graphOf([
    node('app-b', 'node_modules/app-b', { version: '1.0.0', direct: true, edges: [edge('shared', 'node_modules/app-b/node_modules/shared')] }),
    node('app-a', 'node_modules/app-a', { version: '1.0.0', direct: true, edges: [edge('shared', 'node_modules/app-a/node_modules/shared')] }),
    node('shared', 'node_modules/app-a/node_modules/shared', { version: '1.0.0' }),
    node('shared', 'node_modules/app-b/node_modules/shared', { version: '1.0.0' }),
  ]);
  const result = stillRequiredBy(graph, [declared('app-a'), declared('app-b')], 'shared', new Set());
  assert.deepEqual(result, ['app-a', 'app-b']);
});

test('a prebuilt why-installed index is reusable across a removal batch', () => {
  const graph = graphOf([
    node('app-a', 'node_modules/app-a', { version: '1.0.0', direct: true, edges: [edge('shared', 'node_modules/shared')] }),
    node('app-b', 'node_modules/app-b', { version: '1.0.0', direct: true }),
    node('shared', 'node_modules/shared', { version: '1.0.0' }),
  ]);
  const declaredDeps = [declared('app-a'), declared('app-b')];
  const index = buildWhyInstalledIndex(graph);
  assert.deepEqual(stillRequiredBy(graph, declaredDeps, 'shared', new Set(), index), ['app-a']);
  assert.deepEqual(stillRequiredBy(graph, declaredDeps, 'app-b', new Set(), index), []);
});
