import assert from 'node:assert/strict';
import test from 'node:test';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  TargetPackageInspector,
  TargetPackageSurfaceCache,
  NodeTargetPackagePackRunner,
  buildTargetPackagePackArgs,
  parseTargetPackagePackOutput,
  targetPackageSurfaceCacheKey,
} from '../out/host/projectCompatibility/targetPackageInspector.js';

const keyFor = (surface, registry = 'https://registry.npmjs.org/') =>
  targetPackageSurfaceCacheKey({ registry, packageName: surface.packageName, version: surface.version });

test('target surface cache reuses exact targets independently of source and evicts the least recently used', () => {
  const cache = new TargetPackageSurfaceCache({ maxEntries: 2 });
  const first = { packageName: 'next', version: '15.5.24', files: ['dist/index.js'] };
  const second = { packageName: 'react', version: '19.1.1', files: ['index.js'] };
  const third = { packageName: 'next', version: '16.0.0', files: ['dist/index.js'] };
  assert.equal(cache.get(keyFor(first)), undefined);
  cache.set(keyFor(first), first);
  cache.set(keyFor(second), second);
  assert.deepEqual(cache.get(keyFor(first)), first, 're-reading source does not change a published target inventory');
  cache.set(keyFor(third), third);
  assert.equal(cache.get(keyFor(second)), undefined, 'least recently used, not first inserted, is evicted');
  assert.deepEqual(cache.get(keyFor(first)), first);
  assert.deepEqual(cache.get(keyFor(third)), third);
  assert.equal(cache.get(keyFor({ ...first, version: '15.5.23' })), undefined);
  assert.equal(cache.get(keyFor(first, 'https://private.example.test/')), undefined);
});

test('target surface keys canonicalize registry URLs but preserve exact package/version/registry identity', () => {
  const identity = { packageName: '@scope/pkg', version: '1.2.3' };
  assert.equal(keyFor(identity, 'https://REGISTRY.npmjs.org:443'), keyFor(identity));
  assert.notEqual(keyFor(identity, 'https://registry.npmjs.org/mirror'), keyFor(identity));
  assert.throws(() => keyFor(identity, 'http://registry.npmjs.org'), /HTTPS/);
  assert.throws(() => keyFor({ ...identity, version: 'latest' }), /identity/);
});

test('target surface cache bounds TTL without extending it on reads and copies mutable inventory arrays', () => {
  let now = 0;
  const cache = new TargetPackageSurfaceCache({ ttlMs: 100, now: () => now });
  const surface = { packageName: 'next', version: '15.5.24', files: ['dist/index.js'] };
  const key = keyFor(surface);
  cache.set(key, surface);
  surface.files.push('not-published.js');
  now = 99;
  const hit = cache.get(key);
  assert.deepEqual(hit.files, ['dist/index.js']);
  hit.files.push('also-not-published.js');
  assert.deepEqual(cache.get(key).files, ['dist/index.js']);
  now = 100;
  assert.equal(cache.get(key), undefined);
});

test('target surface cache bounds memory, rejects mismatched identity and does not retain invalid inventories', () => {
  const first = { packageName: 'next', version: '15.5.24', files: ['index.js'] };
  const second = { packageName: 'react', version: '19.1.1', files: ['index.js'] };
  const cache = new TargetPackageSurfaceCache({ maxBytes: 600 });
  cache.set(keyFor(first), first);
  assert.deepEqual(cache.get(keyFor(first)), first);
  cache.set(keyFor(second), second);
  assert.equal(cache.get(keyFor(first)), undefined, 'byte budget evicts before count limit');
  assert.deepEqual(cache.get(keyFor(second)), second);
  const oversized = { ...first, files: ['a'.repeat(1000)] };
  cache.set(keyFor(oversized), oversized);
  assert.equal(cache.get(keyFor(oversized)), undefined);
  assert.deepEqual(cache.get(keyFor(second)), second, 'oversized entry does not evict useful entries');
  assert.throws(() => cache.set(keyFor(first), second), /identity/);
  const invalid = { ...first, files: ['../escape.js'] };
  cache.set(keyFor(invalid), invalid);
  assert.equal(cache.get(keyFor(invalid)), undefined);
  const disabled = new TargetPackageSurfaceCache({ maxEntries: 0 });
  disabled.set(keyFor(first), first);
  assert.equal(disabled.get(keyFor(first)), undefined);
});

test('target package pack arguments are fixed, script-free, and exact-version scoped', () => {
  assert.deepEqual(
    buildTargetPackagePackArgs({
      packageName: '@scope/pkg',
      version: '2.3.4',
      registry: 'https://registry.example.test/npm',
      destination: '/safe/temp',
    }),
    [
      'pack',
      '@scope/pkg@2.3.4',
      '--json',
      '--ignore-scripts',
      '--pack-destination',
      '/safe/temp',
      '--registry=https://registry.example.test/npm',
    ]
  );
});

test('target package inventory validates identity and normalizes safe paths', () => {
  const surface = parseTargetPackagePackOutput(
    JSON.stringify([
      {
        name: 'next',
        version: '15.5.24',
        files: [
          { path: 'dist/client/public.js' },
          { path: './dist/client/public.js' },
          { path: 'dist\\private\\internal.js' },
          { path: '../escape.js' },
        ],
      },
    ]),
    { packageName: 'next', version: '15.5.24' }
  );
  assert.deepEqual(surface.files, ['dist/client/public.js', 'dist/private/internal.js']);
});

test('target package inspector always cleans up and rejects a failed pack', async () => {
  let invoked = false;
  let temporaryRoot;
  const inspector = new TargetPackageInspector(
    { executable: '/node', prefixArgs: ['/npm-cli.js'], version: '10.0.0' },
    'https://registry.npmjs.org/',
    {
      async run(_invocation, args, cwd) {
        invoked = true;
        temporaryRoot = cwd;
        assert.equal(args[0], 'pack');
        assert.match(cwd, /dependency-dashboard-target-package-/);
        return { exitCode: 1, stdout: '', stderr: 'failure' };
      },
    }
  );
  await assert.rejects(() => inspector.inspect('next', '15.5.24'), /could not be materialized/);
  assert.equal(invoked, true);
  await assert.rejects(access(temporaryRoot), { code: 'ENOENT' });
});

test('target package inspection propagates cancellation to in-flight materialization', async () => {
  let observedSignal;
  let started;
  const running = new Promise((resolve) => { started = resolve; });
  const inspector = new TargetPackageInspector(
    { executable: '/node', prefixArgs: ['/npm-cli.js'], version: '10.0.0' },
    'https://registry.npmjs.org/',
    {
      async run(_invocation, _args, _cwd, signal) {
        observedSignal = signal;
        started();
        await new Promise((resolve, reject) => {
          const abort = () => {
            const error = new Error('cancelled');
            error.name = 'AbortError';
            reject(error);
          };
          if (signal?.aborted) abort();
          else signal?.addEventListener('abort', abort, { once: true });
        });
      },
    }
  );
  const controller = new AbortController();
  const pending = inspector.inspect('next', '15.5.24', controller.signal);
  await running;
  controller.abort();
  await assert.rejects(pending, (error) => error?.name === 'AbortError');
  assert.equal(observedSignal, controller.signal);
  assert.equal(observedSignal.aborted, true);
});

test('target package inspector validates successful output and removes its temporary directory', async () => {
  let temporaryRoot;
  const inspector = new TargetPackageInspector(
    { executable: process.execPath, prefixArgs: [] }, 'https://registry.npmjs.org/',
    { async run(_invocation, _args, cwd) {
      temporaryRoot = cwd;
      return { exitCode: 0, stderr: '', stdout: JSON.stringify([
        { name: 'next', version: '15.5.24', files: [{ path: 'package.json' }] },
      ]) };
    } }
  );
  assert.deepEqual(await inspector.inspect('next', '15.5.24'), {
    packageName: 'next', version: '15.5.24', files: ['package.json'],
  });
  await assert.rejects(access(temporaryRoot), { code: 'ENOENT' });
});

test('pre-cancelled target inspection never starts its runner', async () => {
  const inspector = new TargetPackageInspector(
    { executable: process.execPath, prefixArgs: [] }, 'https://registry.npmjs.org/',
    { async run() { assert.fail('cancelled inspection must not run npm'); } }
  );
  await assert.rejects(inspector.inspect('next', '15.5.24', AbortSignal.abort()), { name: 'AbortError' });
});

test('real target runner handles success, nonzero exit and spawn failure', async () => {
  const runner = new NodeTargetPackagePackRunner();
  const invocation = { executable: process.execPath, prefixArgs: [] };
  assert.deepEqual(await runner.run(invocation, ['-e', 'process.stdout.write("ready");process.stderr.write("diagnostic")'], tmpdir()),
    { exitCode: 0, stdout: 'ready', stderr: 'diagnostic' });
  assert.equal((await runner.run(invocation, ['-e', 'process.exit(7)'], tmpdir())).exitCode, 7);
  await assert.rejects(runner.run({ executable: path.join(tmpdir(), 'dependency-dashboard-no-such-executable'), prefixArgs: [] }, [], tmpdir()),
    { code: 'ENOENT' });
});

async function assertChildStopped(pid) {
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'runner must not settle while the child is alive');
}

test('real runner timeout forcibly stops an uncooperative process before returning', async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'dependency-dashboard-runner-test-'));
  try {
    const runner = new NodeTargetPackagePackRunner({ timeoutMs: 1500, terminationGraceMs: 50 });
    const pending = runner.run({ executable: process.execPath, prefixArgs: [] }, ['-e',
      'require("node:fs").writeFileSync("pid",String(process.pid));process.on("SIGTERM",()=>{});setInterval(()=>{},1000)',
    ], temporaryRoot);
    await assert.rejects(pending, { name: 'TimeoutError' });
    await assertChildStopped(Number(await readFile(path.join(temporaryRoot, 'pid'), 'utf8')));
  } finally { await rm(temporaryRoot, { recursive: true, force: true }); }
});

test('real runner cancellation waits for process close and removes no directory prematurely', async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'dependency-dashboard-runner-test-'));
  try {
    const controller = new AbortController();
    const runner = new NodeTargetPackagePackRunner({ timeoutMs: 5000, terminationGraceMs: 50 });
    const pending = runner.run({ executable: process.execPath, prefixArgs: [] }, ['-e',
      'process.on("SIGTERM",()=>{});require("node:fs").writeFileSync("pid",String(process.pid));setInterval(()=>{},1000)',
    ], temporaryRoot, controller.signal);
    // Observe readiness without depending on process startup speed.
    const rejection = assert.rejects(pending, { name: 'AbortError' });
    let pid;
    const deadline = Date.now() + 3000;
    while (pid === undefined && Date.now() < deadline) {
      try { pid = Number(await readFile(path.join(temporaryRoot, 'pid'), 'utf8')); }
      catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
    }
    controller.abort();
    await rejection;
    assert.ok(pid, 'child reached readiness');
    await assertChildStopped(pid);
  } finally { await rm(temporaryRoot, { recursive: true, force: true }); }
});

test('real runner rejects oversized output and reaps the child before returning', async () => {
  const runner = new NodeTargetPackagePackRunner({ timeoutMs: 5000, terminationGraceMs: 50 });
  await assert.rejects(runner.run({ executable: process.execPath, prefixArgs: [] }, ['-e',
    'process.on("SIGTERM",()=>{});process.stdout.write(Buffer.alloc(9*1024*1024,97));setInterval(()=>{},1000)',
  ], tmpdir()), /exceeded the response limit/);
});

test('inspector timeout cleans temporary files only after the real child has terminated', async () => {
  let temporaryRoot;
  let pid;
  const runner = new NodeTargetPackagePackRunner({ timeoutMs: 1500, terminationGraceMs: 50 });
  const inspector = new TargetPackageInspector(
    { executable: process.execPath, prefixArgs: [] }, 'https://registry.npmjs.org/',
    { async run(invocation, _args, cwd, signal) {
      temporaryRoot = cwd;
      try {
        return await runner.run(invocation, ['-e',
          'require("node:fs").writeFileSync("pid",String(process.pid));process.on("SIGTERM",()=>{});setInterval(()=>{},1000)',
        ], cwd, signal);
      } finally {
        pid = Number(await readFile(path.join(cwd, 'pid'), 'utf8'));
        await assertChildStopped(pid);
      }
    } }
  );
  await assert.rejects(inspector.inspect('next', '15.5.24'), { name: 'TimeoutError' });
  assert.ok(pid);
  await assert.rejects(access(temporaryRoot), { code: 'ENOENT' });
});

test('target package inventory rejects mismatched published identity', () => {
  assert.throws(
    () =>
      parseTargetPackagePackOutput(
        JSON.stringify([{ name: 'other', version: '1.0.0', files: [] }]),
        { packageName: 'next', version: '15.5.24' }
      ),
    /identity did not match/
  );
});
