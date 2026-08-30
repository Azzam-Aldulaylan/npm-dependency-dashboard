import assert from 'node:assert/strict';
import test from 'node:test';

import { compareProposedGraphSecurityImpact } from '../out/host/proposedGraphSecurityImpact.js';

function edge(name, targetNodeId) {
  return { name, requestedRange: '*', kind: 'runtime', targetNodeId, optional: false };
}

function node(name, path, { version = '1.0.0', direct = false, edges = [] } = {}) {
  return {
    name,
    version,
    range: direct ? '*' : '',
    dev: false,
    direct,
    path,
    deps: edges.map((entry) => entry.name),
    edges,
  };
}

function graph(nodes) {
  return {
    root: '/project',
    packageManager: 'npm',
    lockfileVersion: 3,
    nodes: new Map(nodes.map((entry) => [entry.path, entry])),
  };
}

function advisory(id, title, vulnerableVersions, identifiers = []) {
  return {
    id,
    severity: 'high',
    title,
    url: `https://github.com/advisories/${identifiers.find((entry) => entry.type === 'GHSA')?.value ?? `npm-${id}`}`,
    vulnerableVersions,
    identifiers,
  };
}

function snapshot(dependencyGraph, advisoriesByName, availability = 'complete') {
  return { graph: dependencyGraph, advisoriesByName: new Map(advisoriesByName), advisories: availability };
}

test('compares fixed, remaining, and introduced identities without counting dependency paths', () => {
  const beforeShared = 'node_modules/shared';
  const beforeOld = 'node_modules/root-a/node_modules/old-only';
  const before = graph([
    node('root-a', 'node_modules/root-a', {
      direct: true,
      edges: [edge('shared', beforeShared), edge('old-only', beforeOld)],
    }),
    node('root-b', 'node_modules/root-b', {
      direct: true,
      edges: [edge('shared', beforeShared)],
    }),
    node('shared', beforeShared, { version: '1.0.0' }),
    node('old-only', beforeOld, { version: '1.0.0' }),
  ]);

  const afterShared = 'node_modules/shared';
  const afterNew = 'node_modules/root-a/node_modules/new-only';
  const after = graph([
    node('root-a', 'node_modules/root-a', {
      direct: true,
      edges: [edge('shared', afterShared), edge('new-only', afterNew)],
    }),
    node('root-b', 'node_modules/root-b', {
      direct: true,
      edges: [edge('shared', afterShared)],
    }),
    node('shared', afterShared, { version: '2.0.0' }),
    node('new-only', afterNew, { version: '1.0.0' }),
  ]);

  const sharedBefore = advisory(10, 'Shared issue', '<3', [
    { type: 'GHSA', value: 'GHSA-AAAA-BBBB-CCCC' },
    { type: 'CVE', value: 'CVE-2026-10000' },
  ]);
  // Different source id and less enrichment still match through the public CVE.
  const sharedAfter = advisory(999, 'Shared issue renamed', '<3', [
    { type: 'CVE', value: 'CVE-2026-10000' },
  ]);
  const result = compareProposedGraphSecurityImpact(
    snapshot(before, [
      ['shared', [sharedBefore]],
      ['old-only', [advisory(20, 'Old issue', '*')]],
    ]),
    snapshot(after, [
      ['shared', [sharedAfter]],
      ['new-only', [advisory(30, 'New issue', '*')]],
    ])
  );

  assert.equal(result.status, 'complete');
  assert.equal(result.beforeOccurrenceCount, 2);
  assert.equal(result.afterOccurrenceCount, 2);
  assert.deepEqual(result.fixed.map((entry) => entry.flaggedPackage), ['old-only']);
  assert.deepEqual(result.introduced.map((entry) => entry.flaggedPackage), ['new-only']);
  assert.equal(result.remaining.length, 1);
  assert.equal(result.remaining[0].identity, 'CVE-2026-10000');
  assert.deepEqual(result.remaining[0].beforeVersions, ['1.0.0']);
  assert.deepEqual(result.remaining[0].afterVersions, ['2.0.0']);
  assert.deepEqual(result.remaining[0].beforePaths, [
    ['root-a', 'shared'],
    ['root-b', 'shared'],
  ]);
});

test('counts separately affected installed versions but still groups one advisory identity', () => {
  const dependencyGraph = graph([
    node('root-a', 'node_modules/root-a', {
      direct: true,
      edges: [edge('shared', 'node_modules/root-a/node_modules/shared')],
    }),
    node('root-b', 'node_modules/root-b', {
      direct: true,
      edges: [edge('shared', 'node_modules/root-b/node_modules/shared')],
    }),
    node('shared', 'node_modules/root-a/node_modules/shared', { version: '1.0.0' }),
    node('shared', 'node_modules/root-b/node_modules/shared', { version: '2.0.0' }),
  ]);
  const issue = advisory(40, 'Two vulnerable copies', '<3');
  const result = compareProposedGraphSecurityImpact(
    snapshot(dependencyGraph, [['shared', [issue]]]),
    snapshot(dependencyGraph, [['shared', [issue]]])
  );

  assert.equal(result.status, 'complete');
  assert.equal(result.beforeOccurrenceCount, 2);
  assert.equal(result.afterOccurrenceCount, 2);
  assert.equal(result.remaining.length, 1);
  assert.deepEqual(result.remaining[0].beforeVersions, ['1.0.0', '2.0.0']);
});

test('unreachable lockfile nodes do not become project vulnerability occurrences', () => {
  const dependencyGraph = graph([
    node('root', 'node_modules/root', { direct: true }),
    node('orphan', 'node_modules/orphan', { version: '1.0.0' }),
  ]);
  const issue = advisory(50, 'Orphan issue', '*');
  const result = compareProposedGraphSecurityImpact(
    snapshot(dependencyGraph, [['orphan', [issue]]]),
    snapshot(dependencyGraph, [['orphan', [issue]]])
  );

  assert.equal(result.status, 'complete');
  assert.equal(result.beforeOccurrenceCount, 0);
  assert.equal(result.afterOccurrenceCount, 0);
  assert.deepEqual(result.remaining, []);
});

test('incomplete advisory data and malformed ranges never produce a misleading complete result', () => {
  const dependencyGraph = graph([node('root', 'node_modules/root', { direct: true })]);
  assert.deepEqual(
    compareProposedGraphSecurityImpact(
      snapshot(dependencyGraph, [], 'unavailable'),
      snapshot(dependencyGraph, [], 'complete')
    ),
    { status: 'unavailable', reason: 'before-advisories-unavailable' }
  );

  const malformed = advisory(60, 'Malformed source range', 'not a range');
  assert.deepEqual(
    compareProposedGraphSecurityImpact(
      snapshot(dependencyGraph, [['root', [malformed]]]),
      snapshot(dependencyGraph, [['root', [malformed]]])
    ),
    { status: 'unavailable', reason: 'invalid-advisory-range' }
  );
});
