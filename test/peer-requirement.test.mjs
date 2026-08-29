/**
 * peerRequirementsFor — which currently-installed packages declare a
 * candidate-for-removal package as their own peer dependency, i.e. expect
 * the project root to keep providing it. See src/core/upgrade/peerRequirement.ts.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildPeerRequirementIndex, peerRequirementsFor } from '../out/core/upgrade/peerRequirement.js';

function node(overrides) {
  return {
    name: 'x',
    version: '1.0.0',
    range: '^1.0.0',
    dev: false,
    direct: false,
    path: 'node_modules/x',
    deps: [],
    edges: [],
    ...overrides,
  };
}

function graphOf(nodes) {
  return {
    root: '/app',
    packageManager: 'npm',
    lockfileVersion: 3,
    nodes: new Map(nodes.map((n) => [n.path, n])),
  };
}

test('a package declaring a required peer on the target is reported', () => {
  const graph = graphOf([
    node({ name: 'react', path: 'node_modules/react', direct: true }),
    node({
      name: 'some-plugin',
      path: 'node_modules/some-plugin',
      edges: [{ name: 'react', requestedRange: '^18.0.0', kind: 'peer', targetNodeId: 'node_modules/react', optional: false }],
    }),
  ]);
  const result = peerRequirementsFor(graph, 'react', new Set());
  assert.deepEqual(result, [{ requiredBy: 'some-plugin', range: '^18.0.0', optional: false }]);
});

test('an optional peer requirement is reported with optional: true', () => {
  const graph = graphOf([
    node({ name: 'react', path: 'node_modules/react', direct: true }),
    node({
      name: 'some-plugin',
      path: 'node_modules/some-plugin',
      edges: [{ name: 'react', requestedRange: '^18.0.0', kind: 'peer', targetNodeId: 'node_modules/react', optional: true }],
    }),
  ]);
  const result = peerRequirementsFor(graph, 'react', new Set());
  assert.deepEqual(result, [{ requiredBy: 'some-plugin', range: '^18.0.0', optional: true }]);
});

test('a peer requirement from a package that is also being removed is excluded', () => {
  const graph = graphOf([
    node({ name: 'react', path: 'node_modules/react', direct: true }),
    node({
      name: 'some-plugin',
      path: 'node_modules/some-plugin',
      direct: true,
      edges: [{ name: 'react', requestedRange: '^18.0.0', kind: 'peer', targetNodeId: 'node_modules/react', optional: false }],
    }),
  ]);
  const result = peerRequirementsFor(graph, 'react', new Set(['some-plugin']));
  assert.deepEqual(result, []);
});

test('a plain runtime edge is never mistaken for a peer requirement', () => {
  const graph = graphOf([
    node({ name: 'react', path: 'node_modules/react', direct: true }),
    node({
      name: 'some-consumer',
      path: 'node_modules/some-consumer',
      edges: [{ name: 'react', requestedRange: '^18.0.0', kind: 'runtime', targetNodeId: 'node_modules/react', optional: false }],
    }),
  ]);
  assert.deepEqual(peerRequirementsFor(graph, 'react', new Set()), []);
});

test('multiple distinct requiring packages are all reported, sorted', () => {
  const graph = graphOf([
    node({ name: 'react', path: 'node_modules/react', direct: true }),
    node({
      name: 'zeta-plugin',
      path: 'node_modules/zeta-plugin',
      edges: [{ name: 'react', requestedRange: '*', kind: 'peer', targetNodeId: 'node_modules/react', optional: false }],
    }),
    node({
      name: 'alpha-plugin',
      path: 'node_modules/alpha-plugin',
      edges: [{ name: 'react', requestedRange: '*', kind: 'peer', targetNodeId: 'node_modules/react', optional: false }],
    }),
  ]);
  const result = peerRequirementsFor(graph, 'react', new Set());
  assert.deepEqual(
    result.map((r) => r.requiredBy),
    ['alpha-plugin', 'zeta-plugin']
  );
});

test('a package cannot be its own peer requirement', () => {
  const graph = graphOf([
    node({
      name: 'react',
      path: 'node_modules/react',
      direct: true,
      edges: [{ name: 'react', requestedRange: '*', kind: 'peer', targetNodeId: null, optional: false }],
    }),
  ]);
  assert.deepEqual(peerRequirementsFor(graph, 'react', new Set()), []);
});

test('no matching peer edges anywhere returns an empty list', () => {
  const graph = graphOf([node({ name: 'react', path: 'node_modules/react', direct: true })]);
  assert.deepEqual(peerRequirementsFor(graph, 'react', new Set()), []);
});

test('an unresolved peer edge is not attributed to the direct target', () => {
  const graph = graphOf([
    node({ name: 'react', path: 'node_modules/react', direct: true }),
    node({
      name: 'some-plugin',
      path: 'node_modules/some-plugin',
      edges: [{ name: 'react', requestedRange: '^18.0.0', kind: 'peer', targetNodeId: null, optional: false }],
    }),
  ]);

  assert.deepEqual(peerRequirementsFor(graph, 'react', new Set()), []);
});

test('a same-named peer resolved to a nested copy does not block removal of the direct copy', () => {
  const graph = graphOf([
    node({ name: 'react', path: 'node_modules/react', direct: true }),
    node({ name: 'react', path: 'node_modules/some-plugin/node_modules/react' }),
    node({
      name: 'some-plugin',
      path: 'node_modules/some-plugin',
      edges: [{
        name: 'react',
        requestedRange: '^17.0.0',
        kind: 'peer',
        targetNodeId: 'node_modules/some-plugin/node_modules/react',
        optional: false,
      }],
    }),
  ]);

  assert.deepEqual(peerRequirementsFor(graph, 'react', new Set()), []);
});

test('a duplicate owner cannot hide a required edge to the direct target', () => {
  const graph = graphOf([
    node({ name: 'react', path: 'node_modules/react', direct: true }),
    node({ name: 'react', path: 'node_modules/plugin/node_modules/react' }),
    node({
      name: 'plugin',
      path: 'node_modules/first/node_modules/plugin',
      edges: [{
        name: 'react',
        requestedRange: '^17.0.0',
        kind: 'peer',
        targetNodeId: 'node_modules/plugin/node_modules/react',
        optional: false,
      }],
    }),
    node({
      name: 'plugin',
      path: 'node_modules/second/node_modules/plugin',
      edges: [{
        name: 'react',
        requestedRange: '^18.0.0',
        kind: 'peer',
        targetNodeId: 'node_modules/react',
        optional: true,
      }],
    }),
    node({
      name: 'plugin',
      path: 'node_modules/plugin',
      edges: [{
        name: 'react',
        requestedRange: '>=18',
        kind: 'peer',
        targetNodeId: 'node_modules/react',
        optional: false,
      }],
    }),
  ]);

  assert.deepEqual(peerRequirementsFor(graph, 'react', new Set()), [
    { requiredBy: 'plugin', range: '>=18', optional: false },
  ]);
});

test('alsoRemoving excludes the direct owner but not a transitive duplicate that remains installed', () => {
  const graph = graphOf([
    node({ name: 'react', path: 'node_modules/react', direct: true }),
    node({
      name: 'plugin',
      path: 'node_modules/plugin',
      direct: true,
      edges: [{
        name: 'react',
        requestedRange: '^17.0.0',
        kind: 'peer',
        targetNodeId: 'node_modules/react',
        optional: false,
      }],
    }),
    node({
      name: 'plugin',
      path: 'node_modules/consumer/node_modules/plugin',
      edges: [{
        name: 'react',
        requestedRange: '^18.0.0',
        kind: 'peer',
        targetNodeId: 'node_modules/react',
        optional: false,
      }],
    }),
  ]);

  assert.deepEqual(peerRequirementsFor(graph, 'react', new Set(['plugin'])), [
    { requiredBy: 'plugin', range: '^18.0.0', optional: false },
  ]);
});

test('duplicate owners with equally strong edges choose evidence deterministically', () => {
  const target = node({ name: 'react', path: 'node_modules/react', direct: true });
  const broad = node({
    name: 'plugin',
    path: 'node_modules/first/node_modules/plugin',
    edges: [{
      name: 'react',
      requestedRange: '>=18',
      kind: 'peer',
      targetNodeId: 'node_modules/react',
      optional: false,
    }],
  });
  const narrow = node({
    name: 'plugin',
    path: 'node_modules/plugin',
    edges: [{
      name: 'react',
      requestedRange: '^18.0.0',
      kind: 'peer',
      targetNodeId: 'node_modules/react',
      optional: false,
    }],
  });
  const expected = [{ requiredBy: 'plugin', range: '^18.0.0', optional: false }];

  assert.deepEqual(peerRequirementsFor(graphOf([target, broad, narrow]), 'react', new Set()), expected);
  assert.deepEqual(peerRequirementsFor(graphOf([target, narrow, broad]), 'react', new Set()), expected);
});

test('a reusable peer index avoids traversing graph nodes for every batch candidate', () => {
  const graph = graphOf([
    node({ name: 'react', path: 'node_modules/react', direct: true }),
    node({ name: 'vue', path: 'node_modules/vue', direct: true }),
    node({
      name: 'plugin',
      path: 'node_modules/plugin',
      edges: [
        { name: 'react', requestedRange: '^18', kind: 'peer', targetNodeId: 'node_modules/react', optional: false },
        { name: 'vue', requestedRange: '^3', kind: 'peer', targetNodeId: 'node_modules/vue', optional: true },
      ],
    }),
  ]);
  const index = buildPeerRequirementIndex(graph);
  const originalValues = graph.nodes.values;
  graph.nodes.values = () => { throw new Error('batch queries must use the peer index'); };
  try {
    assert.deepEqual(peerRequirementsFor(graph, 'react', new Set(), index), [
      { requiredBy: 'plugin', range: '^18', optional: false },
    ]);
    assert.deepEqual(peerRequirementsFor(graph, 'vue', new Set(), index), [
      { requiredBy: 'plugin', range: '^3', optional: true },
    ]);
  } finally {
    graph.nodes.values = originalValues;
  }
});
