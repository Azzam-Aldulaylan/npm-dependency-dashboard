import { test } from 'node:test';
import assert from 'node:assert/strict';

import { analyzeCompatibility } from '../out/core/compatibility/preflight.js';
import { planSmartUpgrade } from '../out/core/upgrade/smartPlan.js';

const defaultPolicy = { strictPeerDeps: true, legacyPeerDeps: false };

function edge(name, requestedRange, kind, targetNodeId, optional = false) {
  return { name, requestedRange, kind, targetNodeId, optional };
}

function node(name, version, options = {}) {
  return {
    name,
    version,
    range: options.range ?? `^${version}`,
    dev: false,
    direct: options.direct ?? true,
    path: options.path ?? `node_modules/${name}`,
    deps: (options.edges ?? [])
      .filter((candidate) => candidate.kind !== 'peer')
      .map((candidate) => candidate.name),
    edges: options.edges ?? [],
  };
}

function graph(entries) {
  return {
    root: '/project',
    packageManager: 'npm',
    lockfileVersion: 3,
    nodes: new Map(entries),
  };
}

function metadata(name, version, peers = {}) {
  return {
    name,
    version,
    dependencies: {},
    optionalDependencies: {},
    peerDependencies: peers,
    peerDependenciesMeta: {},
  };
}

function metadataProvider(entries = {}) {
  return {
    async getPackageVersionMetadata(name, version) {
      const value = entries[`${name}@${version}`];
      if (value instanceof Error) throw value;
      return value ?? metadata(name, version);
    },
  };
}

function candidateProvider(entries = {}) {
  const calls = [];
  return {
    calls,
    async getStableVersionCandidates(name) {
      calls.push(name);
      const value = entries[name];
      if (value instanceof Error) throw value;
      return value ?? { versions: [], complete: true };
    },
  };
}

function change(packageName, currentVersion, targetVersion) {
  return { packageName, currentVersion, targetVersion, classification: 'prod' };
}

function upgradeable(packageName, currentVersion) {
  return { packageName, currentVersion, classification: 'prod' };
}

async function initialAnalysis(inputGraph, requested, provider) {
  return analyzeCompatibility({
    graph: inputGraph,
    proposal: { requested, changes: [requested] },
    metadataProvider: provider,
    policy: defaultPolicy,
  });
}

test('finds a simple dependent upgrade and preserves the blocker finding as its reason', async () => {
  const reactId = 'node_modules/react';
  const libraryId = 'node_modules/library';
  const inputGraph = graph([
    [reactId, node('react', '18.2.0')],
    [libraryId, node('library', '4.0.0', {
      edges: [edge('react', '^18', 'peer', reactId)],
    })],
    ['node_modules/unrelated', node('unrelated', '1.0.0')],
  ]);
  const requested = change('react', '18.2.0', '19.0.0');
  const provider = metadataProvider({
    'library@5.0.0': metadata('library', '5.0.0', { react: '^18 || ^19' }),
  });
  const initial = await initialAnalysis(inputGraph, requested, provider);
  const blockerId = initial.findings.find((finding) => finding.kind === 'peer-incompatible').id;
  const candidates = candidateProvider({
    library: { versions: ['5.0.0'], complete: true },
    unrelated: { versions: ['2.0.0'], complete: true },
  });

  const result = await planSmartUpgrade({
    graph: inputGraph,
    initialAnalysis: initial,
    upgradeableDirectDependencies: [
      upgradeable('library', '4.0.0'),
      upgradeable('unrelated', '1.0.0'),
    ],
    candidateProvider: candidates,
    metadataProvider: provider,
    policy: defaultPolicy,
  });

  assert.equal(result.outcome, 'found');
  assert.deepEqual(candidates.calls, ['library'], 'candidate metadata stays lazy and blocker-driven');
  assert.deepEqual(
    result.plan.proposal.changes.map((entry) => `${entry.packageName}@${entry.targetVersion}`).sort(),
    ['library@5.0.0', 'react@19.0.0']
  );
  const libraryChange = result.plan.changes.find((entry) => entry.change.packageName === 'library');
  assert.deepEqual(libraryChange.reason, {
    kind: 'compatibility-findings',
    findingIds: [blockerId],
  });
  const libraryGroup = result.plan.groups.find((group) => group.changes[0].change.packageName === 'library');
  const reactGroup = result.plan.groups.find((group) => group.changes[0].change.packageName === 'react');
  assert.deepEqual(libraryGroup.mustPrecedeGroupIds, [reactGroup.id]);
});

test('coordinates multiple related direct dependency upgrades', async () => {
  const reactId = 'node_modules/react';
  const rendererId = 'node_modules/renderer';
  const pluginId = 'node_modules/plugin';
  const inputGraph = graph([
    [reactId, node('react', '18.0.0')],
    [rendererId, node('renderer', '4.0.0', {
      edges: [edge('react', '^18', 'peer', reactId)],
    })],
    [pluginId, node('plugin', '2.0.0', {
      edges: [edge('react', '^18', 'peer', reactId)],
    })],
  ]);
  const requested = change('react', '18.0.0', '19.0.0');
  const provider = metadataProvider({
    'renderer@5.0.0': metadata('renderer', '5.0.0', { react: '^19' }),
    'plugin@3.0.0': metadata('plugin', '3.0.0', { react: '^19' }),
  });
  const initial = await initialAnalysis(inputGraph, requested, provider);

  const result = await planSmartUpgrade({
    graph: inputGraph,
    initialAnalysis: initial,
    upgradeableDirectDependencies: [
      upgradeable('renderer', '4.0.0'),
      upgradeable('plugin', '2.0.0'),
    ],
    candidateProvider: candidateProvider({
      renderer: { versions: ['5.0.0'], complete: true },
      plugin: { versions: ['3.0.0'], complete: true },
    }),
    metadataProvider: provider,
    policy: defaultPolicy,
  });

  assert.equal(result.outcome, 'found');
  assert.deepEqual(
    result.plan.proposal.changes.map((entry) => entry.packageName).sort(),
    ['plugin', 'react', 'renderer']
  );
  assert.equal(result.statistics.compatibilityChecks, 3);
});

test('reports impossible only after exhaustive complete candidates still conflict', async () => {
  const reactId = 'node_modules/react';
  const libraryId = 'node_modules/library';
  const inputGraph = graph([
    [reactId, node('react', '18.0.0')],
    [libraryId, node('library', '4.0.0', {
      edges: [edge('react', '^18', 'peer', reactId)],
    })],
  ]);
  const requested = change('react', '18.0.0', '19.0.0');
  const provider = metadataProvider({
    'library@4.1.0': metadata('library', '4.1.0', { react: '^18' }),
  });
  const initial = await initialAnalysis(inputGraph, requested, provider);

  const result = await planSmartUpgrade({
    graph: inputGraph,
    initialAnalysis: initial,
    upgradeableDirectDependencies: [upgradeable('library', '4.0.0')],
    candidateProvider: candidateProvider({
      library: { versions: ['4.1.0'], complete: true },
    }),
    metadataProvider: provider,
    policy: defaultPolicy,
  });

  assert.equal(result.outcome, 'impossible');
  assert.equal(result.statistics.statesAnalyzed, 2);
  assert.ok(result.blockerFindingIds.length >= 1);
});

test('mutual peer relationships are emitted as one cyclic coordinated group', async () => {
  const aId = 'node_modules/a';
  const bId = 'node_modules/b';
  const inputGraph = graph([
    [aId, node('a', '1.0.0', { edges: [edge('b', '^1', 'peer', bId)] })],
    [bId, node('b', '1.0.0', { edges: [edge('a', '^1', 'peer', aId)] })],
  ]);
  const requested = change('a', '1.0.0', '2.0.0');
  const provider = metadataProvider({
    'a@2.0.0': metadata('a', '2.0.0', { b: '^2' }),
    'b@2.0.0': metadata('b', '2.0.0', { a: '^2' }),
  });
  const initial = await initialAnalysis(inputGraph, requested, provider);

  const result = await planSmartUpgrade({
    graph: inputGraph,
    initialAnalysis: initial,
    upgradeableDirectDependencies: [upgradeable('b', '1.0.0')],
    candidateProvider: candidateProvider({ b: { versions: ['2.0.0'], complete: true } }),
    metadataProvider: provider,
    policy: defaultPolicy,
  });

  assert.equal(result.outcome, 'found');
  assert.equal(result.plan.groups.length, 1);
  assert.equal(result.plan.groups[0].cyclic, true);
  assert.deepEqual(
    result.plan.groups[0].changes.map((entry) => entry.change.packageName),
    ['a', 'b']
  );
});

test('returns limit-reached with deterministic statistics when the state bound stops search', async () => {
  const reactId = 'node_modules/react';
  const aId = 'node_modules/a';
  const bId = 'node_modules/b';
  const inputGraph = graph([
    [reactId, node('react', '18.0.0')],
    [aId, node('a', '1.0.0', { edges: [edge('react', '^18', 'peer', reactId)] })],
    [bId, node('b', '1.0.0', { edges: [edge('react', '^18', 'peer', reactId)] })],
  ]);
  const requested = change('react', '18.0.0', '19.0.0');
  const provider = metadataProvider({
    'a@2.0.0': metadata('a', '2.0.0', { react: '^19' }),
    'b@2.0.0': metadata('b', '2.0.0', { react: '^19' }),
  });
  const initial = await initialAnalysis(inputGraph, requested, provider);

  const result = await planSmartUpgrade({
    graph: inputGraph,
    initialAnalysis: initial,
    upgradeableDirectDependencies: [upgradeable('a', '1.0.0'), upgradeable('b', '1.0.0')],
    candidateProvider: candidateProvider({
      a: { versions: ['2.0.0'], complete: true },
      b: { versions: ['2.0.0'], complete: true },
    }),
    metadataProvider: provider,
    policy: defaultPolicy,
    bounds: { maxStates: 2 },
  });

  assert.equal(result.outcome, 'limit-reached');
  assert.equal(result.statistics.statesAnalyzed, 2);
  assert.equal(result.statistics.bounds.maxStates, 2);
});

test('partial candidate discovery produces unknown rather than impossible', async () => {
  const reactId = 'node_modules/react';
  const libraryId = 'node_modules/library';
  const inputGraph = graph([
    [reactId, node('react', '18.0.0')],
    [libraryId, node('library', '4.0.0', {
      edges: [edge('react', '^18', 'peer', reactId)],
    })],
  ]);
  const requested = change('react', '18.0.0', '19.0.0');
  const provider = metadataProvider();
  const initial = await initialAnalysis(inputGraph, requested, provider);

  const result = await planSmartUpgrade({
    graph: inputGraph,
    initialAnalysis: initial,
    upgradeableDirectDependencies: [upgradeable('library', '4.0.0')],
    candidateProvider: candidateProvider({ library: { versions: [], complete: false } }),
    metadataProvider: provider,
    policy: defaultPolicy,
  });

  assert.equal(result.outcome, 'unknown');
});
