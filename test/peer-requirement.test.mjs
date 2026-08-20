/**
 * peerRequirementsFor — which currently-installed packages declare a
 * candidate-for-removal package as their own peer dependency, i.e. expect
 * the project root to keep providing it. See src/core/upgrade/peerRequirement.ts.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { peerRequirementsFor } from '../out/core/upgrade/peerRequirement.js';

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
    node({ name: 'react', path: 'node_modules/react' }),
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
    node({ name: 'react', path: 'node_modules/react' }),
    node({
      name: 'some-plugin',
      path: 'node_modules/some-plugin',
      edges: [{ name: 'react', requestedRange: '^18.0.0', kind: 'peer', targetNodeId: null, optional: true }],
    }),
  ]);
  const result = peerRequirementsFor(graph, 'react', new Set());
  assert.deepEqual(result, [{ requiredBy: 'some-plugin', range: '^18.0.0', optional: true }]);
});

test('a peer requirement from a package that is also being removed is excluded', () => {
  const graph = graphOf([
    node({ name: 'react', path: 'node_modules/react' }),
    node({
      name: 'some-plugin',
      path: 'node_modules/some-plugin',
      edges: [{ name: 'react', requestedRange: '^18.0.0', kind: 'peer', targetNodeId: null, optional: false }],
    }),
  ]);
  const result = peerRequirementsFor(graph, 'react', new Set(['some-plugin']));
  assert.deepEqual(result, []);
});

test('a plain runtime edge is never mistaken for a peer requirement', () => {
  const graph = graphOf([
    node({ name: 'react', path: 'node_modules/react' }),
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
    node({ name: 'react', path: 'node_modules/react' }),
    node({
      name: 'zeta-plugin',
      path: 'node_modules/zeta-plugin',
      edges: [{ name: 'react', requestedRange: '*', kind: 'peer', targetNodeId: null, optional: false }],
    }),
    node({
      name: 'alpha-plugin',
      path: 'node_modules/alpha-plugin',
      edges: [{ name: 'react', requestedRange: '*', kind: 'peer', targetNodeId: null, optional: false }],
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
      edges: [{ name: 'react', requestedRange: '*', kind: 'peer', targetNodeId: null, optional: false }],
    }),
  ]);
  assert.deepEqual(peerRequirementsFor(graph, 'react', new Set()), []);
});

test('no matching peer edges anywhere returns an empty list', () => {
  const graph = graphOf([node({ name: 'react', path: 'node_modules/react' })]);
  assert.deepEqual(peerRequirementsFor(graph, 'react', new Set()), []);
});
