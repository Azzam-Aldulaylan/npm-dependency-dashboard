/**
 * The shared dependency-path utility (graph/paths.ts) and "Why is this
 * installed?" (hygiene/whyInstalled.ts) — hand-built graphs so every case
 * (a cycle, a wide fan-in, several equally-short parents) is exact and
 * deterministic to construct, independent of any one lockfile's shape.
 * Real npm/pnpm lockfile fixtures are covered separately in
 * hygiene-duplicates.test.mjs, which exercises the identical code path.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildInstallPathIndex, pathsToNodes } from '../out/core/graph/paths.js';
import { buildWhyInstalledIndex, whyInstalled } from '../out/core/hygiene/whyInstalled.js';

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

// --------------------------------------------------------------- direct

test('why installed: a direct production dependency needs no path', () => {
  const graph = graphOf([node('react', 'node_modules/react', { version: '18.0.0', direct: true })]);
  const result = whyInstalled(graph, [declared('react')], 'react');
  assert.equal(result.found, true);
  assert.deepEqual(result.declared, { classification: 'prod', version: '18.0.0' });
  assert.equal(result.versions.length, 1);
  assert.deepEqual(result.versions[0], { version: '18.0.0', direct: { classification: 'prod' }, paths: [], totalPaths: 0, truncated: false });
});

test('why installed: a direct development dependency is classified as dev', () => {
  const graph = graphOf([node('typescript', 'node_modules/typescript', { version: '5.4.0', direct: true })]);
  const result = whyInstalled(graph, [declared('typescript', { dev: true })], 'typescript');
  assert.deepEqual(result.declared, { classification: 'dev', version: '5.4.0' });
  assert.equal(result.versions[0].direct.classification, 'dev');
});

test('why installed: an unresolved direct dependency (no version) is still reported as declared', () => {
  const graph = graphOf([node('local-thing', 'node_modules/local-thing', { version: null, direct: true })]);
  const result = whyInstalled(graph, [declared('local-thing')], 'local-thing');
  assert.equal(result.found, true);
  assert.deepEqual(result.declared, { classification: 'prod', version: null });
  assert.deepEqual(result.versions, []);
});

// ---------------------------------------------------------- transitive

test('why installed: one transitive parent produces a single introducing path', () => {
  const graph = graphOf([
    node('app-a', 'node_modules/app-a', { version: '1.0.0', direct: true, edges: [edge('shared', 'node_modules/app-a/node_modules/shared')] }),
    node('shared', 'node_modules/app-a/node_modules/shared', { version: '1.0.0' }),
  ]);
  const result = whyInstalled(graph, [declared('app-a')], 'shared');
  assert.equal(result.declared, null);
  assert.equal(result.versions.length, 1);
  assert.deepEqual(result.versions[0].paths, [['app-a', 'shared']]);
  assert.equal(result.versions[0].totalPaths, 1);
});

test('why installed: multiple direct dependencies introducing the same version produce multiple paths', () => {
  const shared = node('shared', 'node_modules/shared', { version: '1.0.0' });
  const graph = graphOf([
    node('app-a', 'node_modules/app-a', { version: '1.0.0', direct: true, edges: [edge('shared', 'node_modules/shared')] }),
    node('app-b', 'node_modules/app-b', { version: '1.0.0', direct: true, edges: [edge('shared', 'node_modules/shared')] }),
    shared,
  ]);
  const result = whyInstalled(graph, [declared('app-a'), declared('app-b')], 'shared');
  assert.equal(result.versions.length, 1);
  assert.deepEqual(
    result.versions[0].paths.sort((a, b) => a.join().localeCompare(b.join())),
    [
      ['app-a', 'shared'],
      ['app-b', 'shared'],
    ]
  );
  assert.equal(result.versions[0].totalPaths, 2);
});

test('why installed: a package resolved at more than one version reports each version separately', () => {
  const graph = graphOf([
    node('app-a', 'node_modules/app-a', { version: '1.0.0', direct: true, edges: [edge('shared', 'node_modules/app-a/node_modules/shared')] }),
    node('app-b', 'node_modules/app-b', { version: '1.0.0', direct: true, edges: [edge('shared', 'node_modules/app-b/node_modules/shared')] }),
    node('shared', 'node_modules/app-a/node_modules/shared', { version: '1.0.0' }),
    node('shared', 'node_modules/app-b/node_modules/shared', { version: '2.0.0' }),
  ]);
  const result = whyInstalled(graph, [declared('app-a'), declared('app-b')], 'shared');
  assert.deepEqual(
    result.versions.map((v) => v.version),
    ['1.0.0', '2.0.0']
  );
  assert.deepEqual(result.versions[0].paths, [['app-a', 'shared']]);
  assert.deepEqual(result.versions[1].paths, [['app-b', 'shared']]);
});

// --------------------------------------------------------------- cycles

test('why installed: a cycle among transitive packages does not hang and yields the real shortest path', () => {
  // app -> x -> y -> x (back-edge). y is only reachable through x.
  const graph = graphOf([
    node('app', 'node_modules/app', { version: '1.0.0', direct: true, edges: [edge('x', 'node_modules/x')] }),
    node('x', 'node_modules/x', { version: '1.0.0', edges: [edge('y', 'node_modules/y')] }),
    node('y', 'node_modules/y', { version: '1.0.0', edges: [edge('x', 'node_modules/x')] }),
  ]);
  const result = whyInstalled(graph, [declared('app')], 'y');
  assert.equal(result.versions.length, 1);
  assert.deepEqual(result.versions[0].paths, [['app', 'x', 'y']]);
  assert.equal(result.versions[0].truncated, false);
});

// ------------------------------------------------------ bounded search

function fanInGraph(parentCount) {
  const nodes = [];
  const declaredDeps = [];
  for (let i = 0; i < parentCount; i += 1) {
    const name = `parent-${i}`;
    nodes.push(node(name, `node_modules/${name}`, { version: '1.0.0', direct: true, edges: [edge('target', 'node_modules/target')] }));
    declaredDeps.push(declared(name));
  }
  nodes.push(node('target', 'node_modules/target', { version: '1.0.0' }));
  return { graph: graphOf(nodes), declaredDeps };
}

test('why installed: path enumeration is capped at the default maxPaths, but totalPaths reports the real count', () => {
  const { graph, declaredDeps } = fanInGraph(8);
  const result = whyInstalled(graph, declaredDeps, 'target');
  assert.equal(result.versions[0].paths.length, 5); // default maxPaths
  assert.equal(result.versions[0].totalPaths, 8);
  assert.equal(result.versions[0].truncated, false);
});

test('why installed: a small maxExplored bound stops enumeration early and reports truncated', () => {
  const { graph, declaredDeps } = fanInGraph(8);
  const result = whyInstalled(graph, declaredDeps, 'target', { maxExplored: 3 });
  assert.ok(result.versions[0].totalPaths <= 3);
  assert.equal(result.versions[0].truncated, true);
});

test('a package name absent from the graph and not declared is reported as not found', () => {
  const graph = graphOf([node('react', 'node_modules/react', { version: '18.0.0', direct: true })]);
  const result = whyInstalled(graph, [declared('react')], 'nonexistent');
  assert.equal(result.found, false);
  assert.deepEqual(result.versions, []);
});

test('a reusable why-installed index avoids rescanning graph nodes for every batch candidate', () => {
  const graph = graphOf([
    node('app-a', 'node_modules/app-a', { version: '1.0.0', direct: true, edges: [edge('shared', 'node_modules/shared')] }),
    node('app-b', 'node_modules/app-b', { version: '1.0.0', direct: true }),
    node('shared', 'node_modules/shared', { version: '1.0.0' }),
  ]);
  const index = buildWhyInstalledIndex(graph);
  const originalValues = graph.nodes.values;
  graph.nodes.values = () => { throw new Error('batch queries must use the name index'); };
  try {
    assert.equal(whyInstalled(graph, [declared('app-a'), declared('app-b')], 'shared', {}, index).found, true);
    assert.equal(whyInstalled(graph, [declared('app-a'), declared('app-b')], 'app-b', {}, index).found, true);
  } finally {
    graph.nodes.values = originalValues;
  }
});

// --------------------------------------------------------- paths.ts API

test('buildInstallPathIndex + pathsToNodes: shortest distance ties keep every equally-short predecessor', () => {
  const graph = graphOf([
    node('app-a', 'node_modules/app-a', { version: '1.0.0', direct: true, edges: [edge('shared', 'node_modules/shared')] }),
    node('app-b', 'node_modules/app-b', { version: '1.0.0', direct: true, edges: [edge('shared', 'node_modules/shared')] }),
    node('shared', 'node_modules/shared', { version: '1.0.0' }),
  ]);
  const index = buildInstallPathIndex(graph);
  assert.equal(index.distance.get('node_modules/shared'), 1);
  assert.deepEqual([...(index.predecessors.get('node_modules/shared') ?? [])].sort(), ['node_modules/app-a', 'node_modules/app-b']);
  const result = pathsToNodes(graph, index, new Set(['node_modules/shared']));
  assert.equal(result.paths.length, 2);
});
