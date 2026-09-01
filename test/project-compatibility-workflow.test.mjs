import assert from 'node:assert/strict';
import test from 'node:test';
import { runProjectCompatibilityWorkflow } from '../out/host/projectCompatibility/projectCompatibilityWorkflow.js';
import { TargetPackageSurfaceCache, targetPackageSurfaceCacheKey } from '../out/host/projectCompatibility/targetPackageInspector.js';
import { NOOP_PERFORMANCE_RECORDER, PerformanceSession } from '../out/core/performance/measurement.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

const identity = { packageName: 'fixture', currentVersion: '1.0.0', targetVersion: '2.0.0', requestId: 'workflow-test' };
const manifest = { scripts: {}, declaredDependencies: { fixture: '^1' }, projectNodeRange: '>=20' };
const evidence = { ...manifest, imports: [{ specifier: 'fixture', kind: 'import', filePath: 'src/index.ts', line: 1, column: 1, snippet: 'import "fixture"' }],
  ruleFiles: [], scannedFileCount: 1, truncated: false, evidenceFingerprint: 'source-a' };
const surface = { packageName: 'fixture', version: '2.0.0', files: ['index.js', 'package.json'] };
const registry = 'https://registry.npmjs.org/';
const key = targetPackageSurfaceCacheKey({ registry, packageName: identity.packageName, version: identity.targetVersion });
const metadata = (version, extra = {}) => ({ name: 'fixture', version, dependencies: {}, optionalDependencies: {},
  peerDependencies: {}, peerDependenciesMeta: {}, main: 'index.js', ...extra });

function input(extra = {}) {
  return { identity, sourceFingerprint: (value) => `snapshot:${value}`, manifest, evidence: Promise.resolve(evidence),
    graph: { root: '/fixture', packageManager: 'npm', lockfileVersion: 3, nodes: new Map() },
    metadataProvider: { getPackageVersionMetadata: async (_, version) => metadata(version) },
    registry, surfaceCache: new TargetPackageSurfaceCache(), inspect: async () => surface,
    packageManagerIdle: Promise.resolve(), performance: NOOP_PERFORMANCE_RECORDER,
    signal: new AbortController().signal, onResult: () => {}, ...extra };
}

test('known exports complete source checks without waiting for dependency resolution or inspecting files', { timeout: 2000 }, async () => {
  const updates = [];
  const result = await runProjectCompatibilityWorkflow(input({
    metadataProvider: { getPackageVersionMetadata: async (_, version) => metadata(version, { exports: './index.js' }) },
    packageManagerIdle: deferred().promise,
    inspect: async () => { assert.fail('known exports need no archive'); },
    onResult: (analysis) => updates.push(analysis),
  }));
  assert.equal(updates.length, 2);
  assert.equal(result.analysis.analyzers.find((a) => a.analyzerId === 'import-compatibility').status, 'complete');
  assert.equal(result.analysis.identity.sourceFingerprint, 'snapshot:source-a');
  assert.equal(result.evidence, evidence);
});

test('metadata starts alongside source reading and medium findings do not wait for the resolver lane', { timeout: 2000 }, async () => {
  const source = deferred();
  const idle = deferred();
  const medium = deferred();
  const calls = [];
  let inspections = 0;
  const withScripts = { ...manifest, scripts: { lint: 'fixture-lint' } };
  const work = runProjectCompatibilityWorkflow(input({
    manifest: withScripts, evidence: source.promise, packageManagerIdle: idle.promise,
    metadataProvider: { getPackageVersionMetadata: async (_, version) => {
      calls.push(version);
      return metadata(version, version === '1.0.0' ? { bin: { 'fixture-lint': 'lint.js' } } : {});
    } },
    inspect: async () => { inspections++; return surface; },
    onResult: (analysis) => {
      if (analysis.analyzers.find((a) => a.analyzerId === 'package-script-compatibility')?.status === 'complete') medium.resolve(analysis);
    },
  }));
  assert.deepEqual(calls, ['2.0.0', '1.0.0'], 'metadata reads start before source is available');
  source.resolve({ ...evidence, ...withScripts });
  const intermediate = await medium.promise;
  assert.ok(intermediate.findings.some((finding) => finding.category === 'script'));
  assert.equal(inspections, 0, 'archive process must wait for the resolver');
  idle.resolve();
  const result = await work;
  assert.equal(inspections, 1);
  assert.ok(result.analysis.findings.some((finding) => finding.category === 'script'));
});

test('warm exact-target inventory completes without waiting for resolver, but source findings are recalculated', { timeout: 2000 }, async () => {
  const cache = new TargetPackageSurfaceCache();
  cache.set(key, surface);
  const changed = { ...evidence, evidenceFingerprint: 'source-b', imports: [{ ...evidence.imports[0], specifier: 'fixture/missing' }] };
  const result = await runProjectCompatibilityWorkflow(input({
    surfaceCache: cache, evidence: Promise.resolve(changed), packageManagerIdle: deferred().promise,
    inspect: async () => { assert.fail('cached exact target must not download again'); },
  }));
  assert.equal(result.analysis.identity.sourceFingerprint, 'snapshot:source-b');
  assert.ok(result.analysis.findings.some((finding) => finding.confidence === 'confirmed' && finding.category === 'import'));
});

test('metadata failure remains unavailable and never inspects or claims compatible', async () => {
  const result = await runProjectCompatibilityWorkflow(input({
    metadataProvider: { getPackageVersionMetadata: async () => { throw Error('network'); } },
    inspect: async () => { assert.fail('identity metadata unavailable'); },
  }));
  for (const id of ['runtime-compatibility', 'import-compatibility']) {
    assert.equal(result.analysis.analyzers.find((a) => a.analyzerId === id).status, 'unavailable');
  }
});

test('timed-out inventory retains other checks, records failed timing, and a retry is not poisoned', async () => {
  const cache = new TargetPackageSurfaceCache();
  const session = new PerformanceSession('workflow', { enabled: true, output: () => {} });
  const failed = await runProjectCompatibilityWorkflow(input({ surfaceCache: cache, performance: session,
    inspect: async () => { throw new DOMException('bounded inventory', 'TimeoutError'); },
  }));
  assert.equal(failed.analysis.analyzers.find((a) => a.analyzerId === 'import-compatibility').unavailableReason, 'target-package-inventory-timeout');
  assert.equal(failed.analysis.analyzers.find((a) => a.analyzerId === 'project-source-scan').status, 'complete');
  assert.equal(cache.get(key), undefined);
  assert.equal(session.finish().measurements.find((m) => m.operation.endsWith('target package inventory')).metadata.completed, false);
  let retried = 0;
  const result = await runProjectCompatibilityWorkflow(input({ surfaceCache: cache, inspect: async () => { retried++; return surface; } }));
  assert.equal(retried, 1);
  assert.equal(result.analysis.analyzers.find((a) => a.analyzerId === 'import-compatibility').status, 'complete');
});

test('cancellation while queued never starts an archive process or posts another result', { timeout: 2000 }, async () => {
  const abort = new AbortController();
  const first = deferred();
  let updates = 0;
  const work = runProjectCompatibilityWorkflow(input({ signal: abort.signal, packageManagerIdle: deferred().promise,
    inspect: async () => { assert.fail('cancelled queued work must not run'); },
    onResult: () => { updates++; first.resolve(); },
  }));
  await first.promise;
  abort.abort();
  await assert.rejects(work, { name: 'AbortError' });
  assert.equal(updates, 1);
});

test('running inventory cancellation waits for child cleanup and never caches its late success', { timeout: 2000 }, async () => {
  const abort = new AbortController();
  const started = deferred();
  const reaped = deferred();
  const cache = new TargetPackageSurfaceCache();
  let finished = false;
  const work = runProjectCompatibilityWorkflow(input({ signal: abort.signal, surfaceCache: cache,
    inspect: async () => { started.resolve(); await reaped.promise; return surface; },
  }));
  const observed = work.then(() => { finished = true; }, () => { finished = true; });
  await started.promise;
  abort.abort();
  await Promise.resolve();
  assert.equal(finished, false, 'reservation cannot release ahead of process cleanup');
  reaped.resolve();
  await assert.rejects(work, { name: 'AbortError' });
  await observed;
  assert.equal(cache.get(key), undefined);
});

test('already cancelled workflows do not start metadata or inventory work', async () => {
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(runProjectCompatibilityWorkflow(input({ signal: abort.signal,
    metadataProvider: { getPackageVersionMetadata: async () => { assert.fail('cancelled'); } },
  })), { name: 'AbortError' });
});
