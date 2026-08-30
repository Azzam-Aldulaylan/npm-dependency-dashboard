import assert from 'node:assert/strict';
import test from 'node:test';

import { cleanupGraphSignature } from '../../../out/core/cleanup/graphSignature.js';

function node(name, version, edges = []) {
  return {
    name,
    version,
    range: `^${version}`,
    dev: false,
    direct: name === 'app',
    path: `node_modules/${name}`,
    deps: edges.map((edge) => edge.name),
    edges,
  };
}

function edge(name, targetNodeId, kind = 'runtime') {
  return {
    name,
    requestedRange: '^1.0.0',
    kind,
    targetNodeId,
    optional: false,
  };
}

function graph(entries) {
  return {
    root: '/different-each-time',
    packageManager: 'npm',
    lockfileVersion: 3,
    nodes: new Map(entries),
  };
}

test('cleanup graph signature is stable across map and edge insertion order', () => {
  const first = graph([
    ['node_modules/app', node('app', '1.0.0', [edge('peer', 'node_modules/peer', 'peer'), edge('lib', 'node_modules/lib')])],
    ['node_modules/lib', node('lib', '1.0.0')],
    ['node_modules/peer', node('peer', '1.0.0')],
  ]);
  const reordered = graph([
    ['node_modules/peer', node('peer', '1.0.0')],
    ['node_modules/app', node('app', '1.0.0', [edge('lib', 'node_modules/lib'), edge('peer', 'node_modules/peer', 'peer')])],
    ['node_modules/lib', node('lib', '1.0.0')],
  ]);

  assert.equal(cleanupGraphSignature(first), cleanupGraphSignature(reordered));
});

test('cleanup graph signature detects topology changes with an equal version inventory', () => {
  const reviewed = graph([
    ['node_modules/app', node('app', '1.0.0', [edge('lib', 'node_modules/lib')])],
    ['node_modules/lib', node('lib', '1.0.0')],
    ['node_modules/other/lib', { ...node('lib', '1.0.0'), path: 'node_modules/other/lib' }],
  ]);
  const applied = graph([
    ['node_modules/app', node('app', '1.0.0', [edge('lib', 'node_modules/other/lib')])],
    ['node_modules/lib', node('lib', '1.0.0')],
    ['node_modules/other/lib', { ...node('lib', '1.0.0'), path: 'node_modules/other/lib' }],
  ]);

  assert.notEqual(cleanupGraphSignature(reviewed), cleanupGraphSignature(applied));
});
