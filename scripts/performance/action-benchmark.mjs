import { performance } from 'node:perf_hooks';

import { analyzeCompatibility } from '../../out/core/compatibility/preflight.js';
import { planSmartUpgrade } from '../../out/core/upgrade/smartPlan.js';
import { SharedPromise } from '../../out/core/async/sharedPromise.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
    deps: (options.edges ?? []).filter((candidate) => candidate.kind !== 'peer').map((candidate) => candidate.name),
    edges: options.edges ?? [],
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

function change(packageName, currentVersion, targetVersion) {
  return { packageName, currentVersion, targetVersion, classification: 'prod' };
}

const policy = { strictPeerDeps: true, legacyPeerDeps: false };

async function benchmarkPreflightOverlap() {
  const target = change('react', '18.2.0', '19.0.0');
  const graph = {
    root: '/fixture',
    packageManager: 'npm',
    lockfileVersion: 3,
    nodes: new Map([['node_modules/react', node('react', '18.2.0')]]),
  };
  let metadataCalls = 0;
  let resolverCalls = 0;
  const started = performance.now();
  await analyzeCompatibility({
    graph,
    proposal: { requested: target, changes: [target] },
    metadataProvider: {
      async getPackageVersionMetadata(name, version) {
        metadataCalls += 1;
        await wait(120);
        return metadata(name, version);
      },
    },
    resolverVerifier: {
      async verify() {
        resolverCalls += 1;
        await wait(300);
        return {
          status: 'compatible',
          packageManager: 'npm',
          packageManagerVersion: '10.9.8',
          code: 'RESOLVED',
          explanation: 'Controlled resolver result.',
        };
      },
    },
    policy,
  });
  return { durationMs: performance.now() - started, metadataCalls, resolverCalls };
}

async function benchmarkSmartPlan() {
  const reactId = 'node_modules/react';
  const rendererId = 'node_modules/renderer';
  const pluginId = 'node_modules/plugin';
  const graph = {
    root: '/fixture',
    packageManager: 'npm',
    lockfileVersion: 3,
    nodes: new Map([
      [reactId, node('react', '18.0.0')],
      [rendererId, node('renderer', '4.0.0', { edges: [edge('react', '^18', 'peer', reactId)] })],
      [pluginId, node('plugin', '2.0.0', { edges: [edge('react', '^18', 'peer', reactId)] })],
    ]),
  };
  const requested = change('react', '18.0.0', '19.0.0');
  const metadataByKey = {
    'renderer@5.0.0': metadata('renderer', '5.0.0', { react: '^19' }),
    'plugin@3.0.0': metadata('plugin', '3.0.0', { react: '^19' }),
  };
  const provider = {
    async getPackageVersionMetadata(name, version) {
      await wait(5);
      return metadataByKey[`${name}@${version}`] ?? metadata(name, version);
    },
  };
  const initial = await analyzeCompatibility({
    graph,
    proposal: { requested, changes: [requested] },
    metadataProvider: provider,
    policy,
  });
  let resolverCalls = 0;
  const started = performance.now();
  const result = await planSmartUpgrade({
    graph,
    initialAnalysis: initial,
    upgradeableDirectDependencies: [
      { packageName: 'renderer', currentVersion: '4.0.0', classification: 'prod' },
      { packageName: 'plugin', currentVersion: '2.0.0', classification: 'prod' },
    ],
    candidateProvider: {
      async getStableVersionCandidates(name) {
        return { versions: [name === 'renderer' ? '5.0.0' : '3.0.0'], complete: true };
      },
    },
    metadataProvider: provider,
    resolverVerifier: {
      async verify() {
        resolverCalls += 1;
        await wait(80);
        return {
          status: 'compatible',
          packageManager: 'npm',
          packageManagerVersion: '10.9.8',
          code: 'RESOLVED',
          explanation: 'Controlled resolver result.',
        };
      },
    },
    policy,
  });
  return {
    durationMs: performance.now() - started,
    outcome: result.outcome,
    compatibilityChecks: result.statistics.compatibilityChecks,
    resolverCalls,
  };
}

async function benchmarkRemediationBatch() {
  const packages = Array.from({ length: 10 }, (_, index) => `pkg-${index}`);
  let baselineCalls = 0;
  let started = performance.now();
  for (const _packageName of packages) {
    baselineCalls += 1;
    await wait(50);
  }
  const baselineMs = performance.now() - started;

  const shared = new SharedPromise();
  let sharedCalls = 0;
  started = performance.now();
  for (const _packageName of packages) {
    await shared.get(async () => {
      sharedCalls += 1;
      await wait(50);
      return { graph: 'fresh' };
    });
  }
  return { baselineMs, sharedMs: performance.now() - started, baselineCalls, sharedCalls };
}

const preflight = await benchmarkPreflightOverlap();
const smartPlan = await benchmarkSmartPlan();
const remediation = await benchmarkRemediationBatch();

console.log('Dependency action deterministic benchmark');
console.log(`preflight metadata + resolver  ${preflight.durationMs.toFixed(1)} ms  metadata=${preflight.metadataCalls} resolver=${preflight.resolverCalls}`);
console.log(`smart-plan search              ${smartPlan.durationMs.toFixed(1)} ms  checks=${smartPlan.compatibilityChecks} resolver=${smartPlan.resolverCalls} outcome=${smartPlan.outcome}`);
console.log(`bulk remediation (10)          ${remediation.baselineMs.toFixed(1)} -> ${remediation.sharedMs.toFixed(1)} ms  resolver=${remediation.baselineCalls}->${remediation.sharedCalls}`);
