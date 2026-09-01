/** Controlled scheduler/cache benchmark, not a live registry or full Extension Host benchmark. */
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { runProjectCompatibilityWorkflow } from '../../out/host/projectCompatibility/projectCompatibilityWorkflow.js';
import { TargetPackageSurfaceCache } from '../../out/host/projectCompatibility/targetPackageInspector.js';
import { NOOP_PERFORMANCE_RECORDER } from '../../out/core/performance/measurement.js';

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const registry = 'https://registry.npmjs.org/';
const manifest = { scripts: { lint: 'fixture-lint' }, declaredDependencies: { fixture: '^1' }, projectNodeRange: '>=20' };
const evidence = { ...manifest, imports: [{ specifier: 'fixture', kind: 'import', filePath: 'src/index.ts', line: 1, column: 1, snippet: 'import "fixture"' }],
  ruleFiles: [], scannedFileCount: 1, truncated: false, evidenceFingerprint: 'fixture-source' };

async function sample(cache, targetVersion = '2.0.0') {
  const start = performance.now();
  let firstMs, mediumMs, packCalls = 0, peakProcesses = 0, processes = 1;
  peakProcesses = processes;
  // The two resolver stages form one serial subprocess lane. The measured
  // workflow receives the same idle seam as the real coordinator.
  const resolverLane = delay(120).then(() => delay(80)).then(() => { processes--; });
  const work = await runProjectCompatibilityWorkflow({
    identity: { packageName: 'fixture', currentVersion: '1.0.0', targetVersion, requestId: 'benchmark' },
    sourceFingerprint: value => value, manifest,
    evidence: delay(10).then(() => evidence),
    graph: { root: '/fixture', packageManager: 'npm', lockfileVersion: 3, nodes: new Map() },
    metadataProvider: { async getPackageVersionMetadata(name, version) {
      await delay(version === '1.0.0' ? 40 : 20);
      return { name, version, dependencies: {}, optionalDependencies: {}, peerDependencies: {}, peerDependenciesMeta: {},
        main: 'index.js', ...(version === '1.0.0' ? { bin: { 'fixture-lint': 'lint.js' } } : {}) };
    } },
    registry, surfaceCache: cache, packageManagerIdle: resolverLane,
    inspect: async (packageName, version) => {
      packCalls++; processes++; peakProcesses = Math.max(peakProcesses, processes);
      await delay(80); processes--;
      return { packageName, version, files: ['index.js', 'package.json'] };
    },
    performance: NOOP_PERFORMANCE_RECORDER, signal: new AbortController().signal,
    onResult: value => {
      firstMs ??= performance.now() - start;
      if (value.analyzers.find(a => a.analyzerId === 'package-script-compatibility')?.status === 'complete') {
        mediumMs ??= performance.now() - start;
      }
    },
  });
  const fullSourceMs = performance.now() - start;
  await resolverLane;
  assert.equal(work.analysis.analyzers.find(a => a.analyzerId === 'import-compatibility').status, 'complete');
  assert.equal(peakProcesses, 1, 'inventory never overlaps resolver subprocesses');
  return { firstMs, mediumMs, fullSourceMs, packCalls, peakProcesses };
}

const rounds = [];
for (let i = 0; i < 5; i++) {
  const cache = new TargetPackageSurfaceCache();
  const cold = await sample(cache);
  const warm = await sample(cache);
  const otherTarget = await sample(cache, '3.0.0');
  const returnedTarget = await sample(cache);
  assert.equal(cold.packCalls, 1);
  assert.equal(warm.packCalls, 0);
  assert.equal(otherTarget.packCalls, 1);
  assert.equal(returnedTarget.packCalls, 0);
  rounds.push({ cold, warm, returnedTarget });
}
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
console.log('Controlled project compatibility workflow — 5 runs per scenario');
console.log('Injected delays: source 10ms, target metadata 20ms, current metadata 40ms, resolver lane 200ms, archive 80ms.');
for (const mode of ['cold', 'warm', 'returnedTarget']) {
  const values = rounds.map(r => r[mode]);
  console.log(`${mode.padEnd(15)} first=${median(values.map(v => v.firstMs)).toFixed(1)}ms medium=${median(values.map(v => v.mediumMs)).toFixed(1)}ms source-complete=${median(values.map(v => v.fullSourceMs)).toFixed(1)}ms archive-calls=${values[0].packCalls} peak-processes=${values[0].peakProcesses}`);
}
console.log('Earlier scheduling gated medium checks behind compatibility resolution; current medium checks do not wait for that 120ms stage.');
console.log('These are controlled workflow timings, not total upgrade duration or real-network performance claims.');
