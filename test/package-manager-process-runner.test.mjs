import assert from 'node:assert/strict';
import test from 'node:test';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { NodeResolverProcessRunner, IsolatedResolverVerifier } from '../out/host/resolverVerifier.js';
import { analyzeCompatibility } from '../out/core/compatibility/preflight.js';

const invocation = { executable: process.execPath, prefixArgs: [] };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readyFile(filename) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      const text = await readFile(filename, 'utf8');
      if (text.length > 0) return text;
    } catch (cause) {
      if (cause.code !== 'ENOENT') throw cause;
    }
    await pause(10);
  }
  assert.fail(`child did not become ready: ${filename}`);
}

test('resolver runner retains bounded diagnostic tails without imposing the pack output policy', async () => {
  const runner = new NodeResolverProcessRunner();
  const result = await runner.run(invocation, ['-e',
    'process.stdout.write("x".repeat(100000)+"stdout end");process.stderr.write("y".repeat(100000)+"stderr end");',
  ], tmpdir());
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.length, 32768);
  assert.equal(result.stderr.length, 32768);
  assert.ok(result.stdout.endsWith('stdout end'));
  assert.ok(result.stderr.endsWith('stderr end'));
});

test('resolver runner has no default deadline and only caller opt-in creates TimeoutError', async () => {
  const normal = new NodeResolverProcessRunner();
  assert.equal((await normal.run(invocation, ['-e', 'setTimeout(()=>process.stdout.write("done"),80)'], tmpdir())).stdout, 'done');
  const bounded = new NodeResolverProcessRunner({ timeoutMs: 50, terminationGraceMs: 20 });
  await assert.rejects(bounded.run(invocation, ['-e', 'setInterval(()=>{},1000)'], tmpdir()), { name: 'TimeoutError' });
});

test('resolver pre-cancellation prevents even attempting to spawn an unavailable executable', async () => {
  const runner = new NodeResolverProcessRunner();
  await assert.rejects(runner.run({ executable: 'not-a-package-manager-command', prefixArgs: [] }, [], tmpdir(), AbortSignal.abort()),
    { name: 'AbortError' });
});

test('resolver cancellation forcibly terminates a SIGTERM-ignoring child before rejecting', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'dependency-dashboard-resolver-process-'));
  const controller = new AbortController();
  const runner = new NodeResolverProcessRunner({ timeoutMs: 5000, terminationGraceMs: 50 });
  const pending = runner.run(invocation, ['-e',
    'process.on("SIGTERM",()=>{});require("node:fs").writeFileSync("pid",String(process.pid));setInterval(()=>{},1000)',
  ], directory, controller.signal);
  const rejection = assert.rejects(pending, { name: 'AbortError' });
  try {
    const pid = Number(await readyFile(path.join(directory, 'pid')));
    controller.abort();
    await rejection;
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally {
    controller.abort();
    await Promise.allSettled([pending, rejection]);
    await rm(directory, { recursive: true, force: true });
  }
});

test('resolver cancellation also stops a descendant holding the inherited output pipe', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'dependency-dashboard-resolver-tree-'));
  const controller = new AbortController();
  const runner = new NodeResolverProcessRunner({ timeoutMs: 5000, terminationGraceMs: 50 });
  const descendant = 'process.on("SIGTERM",()=>{});require("node:fs").writeFileSync("descendant",String(process.pid));setInterval(()=>{},1000)';
  const leader = `require("node:child_process").spawn(process.execPath,["-e",${JSON.stringify(descendant)}],{stdio:["ignore",1,2]});` +
    'require("node:fs").writeFileSync("pid",String(process.pid));setInterval(()=>{},1000)';
  const pending = runner.run(invocation, ['-e', leader], directory, controller.signal);
  const rejection = assert.rejects(pending, { name: 'AbortError' });
  try {
    const leaderPid = Number(await readyFile(path.join(directory, 'pid')));
    await readyFile(path.join(directory, 'descendant'));
    controller.abort();
    await rejection;
    assert.throws(() => process.kill(leaderPid, 0), { code: 'ESRCH' });
    // Returning proves all inherited stdout/stderr handles closed, including
    // the descendant's. A child-only kill would leave this promise hanging.
  } finally {
    controller.abort();
    await Promise.allSettled([pending, rejection]);
    await rm(directory, { recursive: true, force: true });
  }
});

test('isolated resolver cleanup happens after cancelled child closure', async () => {
  let directory;
  let pid;
  const controller = new AbortController();
  const runner = new NodeResolverProcessRunner({ timeoutMs: 5000, terminationGraceMs: 50 });
  const requested = { packageName: 'react', currentVersion: '18.0.0', targetVersion: '19.0.0', classification: 'prod' };
  let ready;
  const running = new Promise((resolve) => { ready = resolve; });
  const verifier = new IsolatedResolverVerifier({
    packageManager: 'npm', packageManagerVersion: '10.0.0', invocation,
    manifestText: JSON.stringify({ dependencies: { react: '^18.0.0' } }),
    registry: 'https://registry.npmjs.org/', policy: { strictPeerDeps: false, legacyPeerDeps: false },
    runner: { async run(executable, _args, cwd, signal) {
      directory = cwd;
      const pending = runner.run(executable, ['-e',
        'process.on("SIGTERM",()=>{});require("node:fs").writeFileSync("pid",String(process.pid));setInterval(()=>{},1000)',
      ], cwd, signal);
      void pending.catch(() => undefined);
      pid = Number(await readyFile(path.join(cwd, 'pid')));
      ready();
      try { return await pending; }
      finally {
        assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
        await access(path.join(cwd, 'package.json'));
      }
    } },
  });
  const pending = verifier.verify({ requested, changes: [requested] }, controller.signal);
  const rejection = assert.rejects(pending, { name: 'AbortError' });
  await running;
  controller.abort();
  await rejection;
  await assert.rejects(access(directory), { code: 'ENOENT' });
});

test('bounded resolver timeout remains unknown in compatibility preflight, never conflict or compatible', async () => {
  const runner = new NodeResolverProcessRunner({ timeoutMs: 50, terminationGraceMs: 20 });
  const requested = { packageName: 'react', currentVersion: '18.0.0', targetVersion: '19.0.0', classification: 'prod' };
  const result = await analyzeCompatibility({
    graph: { root: '/project', packageManager: 'npm', lockfileVersion: 3, nodes: new Map([
      ['node_modules/react', { name: 'react', version: '18.0.0', range: '^18.0.0', dev: false, direct: true,
        path: 'node_modules/react', deps: [], edges: [] }],
    ]) },
    proposal: { requested, changes: [requested] },
    policy: { strictPeerDeps: false, legacyPeerDeps: false },
    metadataProvider: { async getPackageVersionMetadata(name, version) {
      return { name, version, dependencies: {}, optionalDependencies: {}, peerDependencies: {}, peerDependenciesMeta: {} };
    } },
    resolverVerifier: { async verify() {
      await runner.run(invocation, ['-e', 'setInterval(()=>{},1000)'], tmpdir());
      assert.fail('timeout cannot produce resolver success');
    } },
  });
  assert.equal(result.status, 'unknown');
  assert.equal(result.resolverVerification.status, 'unknown');
  assert.equal(result.resolverVerification.code, 'RESOLVER_TIMEOUT');
});
