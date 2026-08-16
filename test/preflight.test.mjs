import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  analyzeCompatibility,
  CompatibilityCancelledError,
  InvalidUpgradeProposalError,
} from '../out/core/compatibility/preflight.js';

const emptyMetadata = (name, version, peers = {}, peerMeta = {}) => ({
  name,
  version,
  dependencies: {},
  optionalDependencies: {},
  peerDependencies: peers,
  peerDependenciesMeta: peerMeta,
});

function metadataProvider(entries = {}) {
  const calls = [];
  return {
    calls,
    async getPackageVersionMetadata(name, version, signal) {
      calls.push({ name, version, signal });
      const entry = entries[`${name}@${version}`];
      if (entry instanceof Error) throw entry;
      return entry ?? emptyMetadata(name, version);
    },
  };
}

function edge(name, requestedRange, kind, targetNodeId, optional = false) {
  return { name, requestedRange, kind, targetNodeId, optional };
}

function node(name, version, options = {}) {
  return {
    name,
    version,
    range: options.range ?? '',
    dev: false,
    direct: options.direct ?? false,
    path: options.path ?? `node_modules/${name}`,
    deps: (options.edges ?? [])
      .filter((candidate) => candidate.kind !== 'peer')
      .map((candidate) => candidate.name),
    edges: options.edges ?? [],
  };
}

function graph(entries, lockfileVersion = 3) {
  return {
    root: '/project',
    packageManager: 'npm',
    lockfileVersion,
    nodes: new Map(entries),
  };
}

function change(packageName, currentVersion, targetVersion) {
  return { packageName, currentVersion, targetVersion, classification: 'prod' };
}

function proposal(requested, extras = []) {
  return { requested, changes: [requested, ...extras] };
}

const defaultPolicy = { strictPeerDeps: false, legacyPeerDeps: false };

test('a proposed version satisfying an existing peer range is compatible', async () => {
  const reactId = 'node_modules/react';
  const libraryId = 'node_modules/library';
  const inputGraph = graph([
    [reactId, node('react', '18.2.0', { direct: true, path: reactId })],
    [
      libraryId,
      node('library', '4.0.0', {
        direct: true,
        path: libraryId,
        edges: [edge('react', '^18.0.0', 'peer', reactId)],
      }),
    ],
  ]);
  const requested = change('react', '18.2.0', '18.3.0');

  const result = await analyzeCompatibility({
    graph: inputGraph,
    proposal: proposal(requested),
    metadataProvider: metadataProvider(),
    policy: defaultPolicy,
  });

  assert.equal(result.status, 'compatible');
  assert.equal(result.completeness, 'complete');
  assert.equal(result.findings.find((finding) => finding.kind === 'peer-compatible').observedVersion, '18.3.0');
});

test('an incompatible existing peer produces a conflict with the required range and owner', async () => {
  const reactId = 'node_modules/react';
  const libraryId = 'node_modules/library';
  const inputGraph = graph([
    [reactId, node('react', '18.2.0', { direct: true, path: reactId })],
    [
      libraryId,
      node('library', '4.0.0', {
        direct: true,
        path: libraryId,
        edges: [edge('react', '^18', 'peer', reactId)],
      }),
    ],
  ]);

  const result = await analyzeCompatibility({
    graph: inputGraph,
    proposal: proposal(change('react', '18.2.0', '19.0.0')),
    metadataProvider: metadataProvider(),
    policy: defaultPolicy,
  });
  const conflict = result.findings.find((finding) => finding.kind === 'peer-incompatible');

  assert.equal(result.status, 'conflict');
  assert.equal(conflict.subject.name, 'library');
  assert.equal(conflict.requirement.range, '^18');
  assert.equal(conflict.observedVersion, '19.0.0');
  assert.deepEqual(conflict.relation.packageNames, ['library']);
});

test('an absent optional peer is explicit compatible evidence, not a missing-peer conflict', async () => {
  const pluginId = 'node_modules/plugin';
  const provider = metadataProvider({
    'plugin@1.1.0': emptyMetadata(
      'plugin',
      '1.1.0',
      { host: '^2' },
      { host: { optional: true } }
    ),
  });

  const result = await analyzeCompatibility({
    graph: graph([[pluginId, node('plugin', '1.0.0', { direct: true, path: pluginId })]]),
    proposal: proposal(change('plugin', '1.0.0', '1.1.0')),
    metadataProvider: provider,
    policy: defaultPolicy,
  });

  assert.equal(result.status, 'compatible');
  assert.equal(result.findings.find((finding) => finding.kind === 'optional-peer-missing').status, 'compatible');
});

test('a required missing peer is warning by default and conflict under strict-peer-deps', async () => {
  const pluginId = 'node_modules/plugin';
  const provider = metadataProvider({
    'plugin@1.1.0': emptyMetadata('plugin', '1.1.0', { host: '^2' }),
  });
  const base = {
    graph: graph([[pluginId, node('plugin', '1.0.0', { direct: true, path: pluginId })]]),
    proposal: proposal(change('plugin', '1.0.0', '1.1.0')),
    metadataProvider: provider,
  };

  const ordinary = await analyzeCompatibility({ ...base, policy: defaultPolicy });
  const strict = await analyzeCompatibility({
    ...base,
    policy: { strictPeerDeps: true, legacyPeerDeps: false },
  });

  assert.equal(ordinary.status, 'warning');
  assert.equal(strict.status, 'conflict');
  assert.equal(strict.findings.find((finding) => finding.kind === 'peer-missing').requirement.name, 'host');
});

test('legacy-peer-deps downgrades an incompatible peer to a warning', async () => {
  const reactId = 'node_modules/react';
  const libraryId = 'node_modules/library';
  const inputGraph = graph([
    [reactId, node('react', '18.0.0', { direct: true, path: reactId })],
    [libraryId, node('library', '4.0.0', {
      direct: true,
      path: libraryId,
      edges: [edge('react', '^18', 'peer', reactId)],
    })],
  ]);

  const result = await analyzeCompatibility({
    graph: inputGraph,
    proposal: proposal(change('react', '18.0.0', '19.0.0')),
    metadataProvider: metadataProvider(),
    policy: { strictPeerDeps: true, legacyPeerDeps: true },
  });

  assert.equal(result.status, 'warning');
  assert.equal(result.findings.find((finding) => finding.kind === 'peer-incompatible').status, 'warning');
});

test('conflicting ranges from multiple packages retain both explainable findings', async () => {
  const reactId = 'node_modules/react';
  const inputGraph = graph([
    [reactId, node('react', '18.0.0', { direct: true, path: reactId })],
    ['node_modules/old', node('old', '1.0.0', {
      direct: true,
      path: 'node_modules/old',
      edges: [edge('react', '^18', 'peer', reactId)],
    })],
    ['node_modules/new', node('new', '1.0.0', {
      direct: true,
      path: 'node_modules/new',
      edges: [edge('react', '^19', 'peer', reactId)],
    })],
  ]);

  const result = await analyzeCompatibility({
    graph: inputGraph,
    proposal: proposal(change('react', '18.0.0', '19.0.0')),
    metadataProvider: metadataProvider(),
    policy: defaultPolicy,
  });
  const peerFindings = result.findings.filter((finding) => finding.requirement?.name === 'react');

  assert.equal(peerFindings.length, 2);
  assert.deepEqual(peerFindings.map((finding) => finding.subject.name).sort(), ['new', 'old']);
  assert.equal(result.status, 'conflict');
});

test('a transitive peer owner carries the shortest direct-to-owner relationship path', async () => {
  const reactId = 'node_modules/react';
  const appId = 'node_modules/app';
  const pluginId = 'node_modules/app/node_modules/plugin';
  const inputGraph = graph([
    [reactId, node('react', '18.0.0', { direct: true, path: reactId })],
    [appId, node('app', '2.0.0', {
      direct: true,
      path: appId,
      edges: [edge('plugin', '^1', 'runtime', pluginId)],
    })],
    [pluginId, node('plugin', '1.0.0', {
      path: pluginId,
      edges: [edge('react', '^18', 'peer', reactId)],
    })],
  ]);

  const result = await analyzeCompatibility({
    graph: inputGraph,
    proposal: proposal(change('react', '18.0.0', '19.0.0')),
    metadataProvider: metadataProvider(),
    policy: defaultPolicy,
  });
  const finding = result.findings.find((candidate) => candidate.subject.name === 'plugin');

  assert.equal(finding.relation.kind, 'transitive');
  assert.deepEqual(finding.relation.packageNames, ['app', 'plugin']);
});

test('major upgrades are marked as warnings without being called safe', async () => {
  const reactId = 'node_modules/react';
  const result = await analyzeCompatibility({
    graph: graph([[reactId, node('react', '18.0.0', { direct: true, path: reactId })]]),
    proposal: proposal(change('react', '18.0.0', '19.0.0')),
    metadataProvider: metadataProvider(),
    policy: defaultPolicy,
  });

  assert.equal(result.status, 'warning');
  assert.equal(result.findings.find((finding) => finding.kind === 'major-version-change').status, 'warning');
});

test('metadata failure degrades to unknown and keeps normal dashboard work out of scope', async () => {
  const provider = metadataProvider({ 'react@18.3.0': new Error('offline') });
  const reactId = 'node_modules/react';
  const result = await analyzeCompatibility({
    graph: graph([[reactId, node('react', '18.2.0', { direct: true, path: reactId })]]),
    proposal: proposal(change('react', '18.2.0', '18.3.0')),
    metadataProvider: provider,
    policy: defaultPolicy,
  });

  assert.equal(provider.calls.length, 1, 'only the exact proposed version was requested');
  assert.equal(result.status, 'unknown');
  assert.equal(result.completeness, 'partial');
  assert.equal(result.findings.find((finding) => finding.kind === 'metadata-unavailable').explanation.includes('offline'), false);
});

test('v1/incomplete peer metadata is reported as unknown rather than compatible', async () => {
  const pkgId = 'node_modules/pkg';
  const result = await analyzeCompatibility({
    graph: graph([[pkgId, node('pkg', '1.0.0', { direct: true, path: pkgId })]], 1),
    proposal: proposal(change('pkg', '1.0.0', '1.1.0')),
    metadataProvider: metadataProvider(),
    policy: defaultPolicy,
  });
  assert.equal(result.status, 'unknown');
  assert.equal(result.completeness, 'partial');
  assert.ok(result.findings.some((finding) => finding.kind === 'graph-metadata-incomplete'));
});

test('resolver verification is retained as separate evidence and can report authoritative conflict', async () => {
  const pkgId = 'node_modules/pkg';
  const result = await analyzeCompatibility({
    graph: graph([[pkgId, node('pkg', '1.0.0', { direct: true, path: pkgId })]]),
    proposal: proposal(change('pkg', '1.0.0', '1.1.0')),
    metadataProvider: metadataProvider(),
    policy: defaultPolicy,
    resolverVerifier: {
      async verify() {
        return {
          status: 'conflict',
          packageManager: 'npm',
          packageManagerVersion: '11.0.0',
          code: 'ERESOLVE',
          explanation: 'npm could not resolve the proposed tree.',
        };
      },
    },
  });
  assert.equal(result.status, 'conflict');
  assert.equal(result.resolverVerification.code, 'ERESOLVE');
});

test('cancellation propagates distinctly instead of becoming unknown', async () => {
  const pkgId = 'node_modules/pkg';
  const controller = new AbortController();
  const provider = {
    async getPackageVersionMetadata() {
      controller.abort();
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    },
  };

  await assert.rejects(
    () => analyzeCompatibility({
      graph: graph([[pkgId, node('pkg', '1.0.0', { direct: true, path: pkgId })]]),
      proposal: proposal(change('pkg', '1.0.0', '1.1.0')),
      metadataProvider: provider,
      policy: defaultPolicy,
      signal: controller.signal,
    }),
    CompatibilityCancelledError
  );
});

test('invalid identifiers and non-upgrades are rejected before metadata I/O', async () => {
  const provider = metadataProvider();
  const bad = change('pkg;echo bad', '1.0.0', '1.1.0');
  await assert.rejects(
    () => analyzeCompatibility({
      graph: graph([]),
      proposal: proposal(bad),
      metadataProvider: provider,
      policy: defaultPolicy,
    }),
    InvalidUpgradeProposalError
  );
  assert.equal(provider.calls.length, 0);
});
