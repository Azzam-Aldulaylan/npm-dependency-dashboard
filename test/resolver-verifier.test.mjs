import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildDedupeMaterializationArgs,
  buildResolverArgs,
  buildTransitiveRemediationMaterializationArgs,
  IsolatedResolverVerifier,
} from '../out/host/resolverVerifier.js';

const proposal = {
  requested: { packageName: 'react', currentVersion: '18.0.0', targetVersion: '19.0.0', classification: 'prod' },
  changes: [{ packageName: 'react', currentVersion: '18.0.0', targetVersion: '19.0.0', classification: 'prod' }],
};

test('npm resolver argv is fixed, script-free, lockfile-free, and policy-aware', () => {
  assert.deepEqual(buildResolverArgs('npm', 'https://registry.npmjs.org', { strictPeerDeps: true, legacyPeerDeps: false }), [
    'install', '--dry-run', '--ignore-scripts', '--package-lock=false', '--audit=false', '--fund=false', '--json',
    '--registry=https://registry.npmjs.org', '--strict-peer-deps',
  ]);
});

test('pnpm resolver argv confines writes to temp and never enables lifecycle scripts', () => {
  assert.deepEqual(buildResolverArgs('pnpm', 'https://registry.npmjs.org', { strictPeerDeps: false, legacyPeerDeps: false }), [
    'install', '--ignore-scripts', '--lockfile=false', '--reporter=silent', '--registry=https://registry.npmjs.org',
  ]);
});

test('isolated dedupe argv is lockfile-only and script-free for npm and pnpm', () => {
  const policy = { strictPeerDeps: false, legacyPeerDeps: false };
  assert.deepEqual(buildDedupeMaterializationArgs('npm', 'https://registry.npmjs.org', policy), [
    'dedupe', '--package-lock-only', '--ignore-scripts', '--audit=false', '--fund=false', '--json',
    '--registry=https://registry.npmjs.org',
  ]);
  assert.deepEqual(buildDedupeMaterializationArgs('pnpm', 'https://registry.npmjs.org', policy), [
    'dedupe', '--lockfile-only', '--ignore-scripts', '--reporter=silent', '--registry=https://registry.npmjs.org',
  ]);
});

test('combined cleanup simulation reconciles the staged manifest before dedupe', async () => {
  const calls = [];
  const manifestText = JSON.stringify({ dependencies: { a: '^1.0.0' } });
  const lockfileText = JSON.stringify({
    lockfileVersion: 3,
    packages: { '': { dependencies: { a: '^1.0.0' } }, 'node_modules/a': { version: '1.0.0' } },
  });
  const verifier = new IsolatedResolverVerifier({
    packageManager: 'npm',
    packageManagerVersion: '10.0.0',
    invocation: { executable: '/trusted/node', prefixArgs: ['/trusted/npm-cli.js'] },
    manifestText,
    lockfile: { name: 'package-lock.json', text: lockfileText },
    registry: 'https://registry.npmjs.org',
    policy: { strictPeerDeps: false, legacyPeerDeps: false },
    runner: {
      async run(_invocation, args) {
        calls.push(args);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    },
  });

  const result = await verifier.materializeCleanupGraph(manifestText, true);
  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], 'install');
  assert.equal(calls[1][0], 'dedupe');
  assert.equal(calls.every((args) => args.includes('--ignore-scripts')), true);
});

test('isolated verifier rewrites only its temporary manifest and reports resolver success', async () => {
  let observed;
  const verifier = new IsolatedResolverVerifier({
    packageManager: 'npm',
    packageManagerVersion: '10.0.0',
    invocation: { executable: '/trusted/node', prefixArgs: ['/trusted/npm-cli.js'] },
    manifestText: JSON.stringify({ dependencies: { react: '^18.0.0' } }),
    registry: 'https://registry.npmjs.org',
    policy: { strictPeerDeps: false, legacyPeerDeps: false },
    runner: {
      async run(invocation, args, cwd) {
        const { readFile } = await import('node:fs/promises');
        observed = { invocation, args, cwd, manifest: JSON.parse(await readFile(`${cwd}/package.json`, 'utf8')) };
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    },
  });
  const result = await verifier.verify(proposal);
  assert.equal(result.status, 'compatible');
  assert.equal(observed.manifest.dependencies.react, '19.0.0');
  assert.deepEqual(observed.invocation, { executable: '/trusted/node', prefixArgs: ['/trusted/npm-cli.js'] });
});

test('isolated verifier uses the same classified mixed manifest as real reconciliation', async () => {
  let observedManifest;
  const mixedProposal = {
    requested: proposal.requested,
    changes: [
      proposal.changes[0],
      { packageName: 'typescript', currentVersion: '5.0.0', targetVersion: '6.0.0', classification: 'dev' },
    ],
  };
  const verifier = new IsolatedResolverVerifier({
    packageManager: 'pnpm',
    packageManagerVersion: '10.0.0',
    invocation: { executable: '/trusted/node', prefixArgs: ['/trusted/pnpm.cjs'] },
    manifestText: JSON.stringify({
      dependencies: { react: '^18.0.0' },
      devDependencies: { typescript: '^5.0.0' },
    }),
    registry: 'https://registry.npmjs.org',
    policy: { strictPeerDeps: false, legacyPeerDeps: false },
    runner: {
      async run(_invocation, _args, cwd) {
        const { readFile } = await import('node:fs/promises');
        observedManifest = JSON.parse(await readFile(`${cwd}/package.json`, 'utf8'));
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    },
  });

  assert.equal((await verifier.verify(mixedProposal)).status, 'compatible');
  assert.equal(observedManifest.dependencies.react, '19.0.0');
  assert.equal(observedManifest.devDependencies.typescript, '6.0.0');
});

test('resolver preserves shadow declarations outside the authoritative classification', async () => {
  let observedManifest;
  const verifier = new IsolatedResolverVerifier({
    packageManager: 'npm', packageManagerVersion: '10.0.0',
    invocation: { executable: '/trusted/node', prefixArgs: ['/trusted/npm-cli.js'] },
    manifestText: JSON.stringify({
      dependencies: { react: '^18.0.0' },
      devDependencies: { react: '^17.0.0' },
    }),
    registry: 'https://registry.npmjs.org', policy: { strictPeerDeps: false, legacyPeerDeps: false },
    runner: {
      async run(_invocation, _args, cwd) {
        const { readFile } = await import('node:fs/promises');
        observedManifest = JSON.parse(await readFile(`${cwd}/package.json`, 'utf8'));
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    },
  });

  await verifier.verify(proposal);
  assert.equal(observedManifest.dependencies.react, '19.0.0');
  assert.equal(observedManifest.devDependencies.react, '^17.0.0');
});

test('peer resolver failures are conflicts and temporary paths are redacted and bounded', async () => {
  const verifier = new IsolatedResolverVerifier({
    packageManager: 'npm', packageManagerVersion: null,
    invocation: { executable: '/trusted/node', prefixArgs: ['/trusted/npm-cli.js'] },
    manifestText: JSON.stringify({ dependencies: { react: '18.0.0' } }),
    registry: 'https://registry.npmjs.org', policy: { strictPeerDeps: false, legacyPeerDeps: false },
    runner: { async run(_inv, _args, cwd) { return { exitCode: 1, stdout: '', stderr: `ERESOLVE peer dependency at ${cwd}\n${'x'.repeat(1000)}` }; } },
  });
  const result = await verifier.verify(proposal);
  assert.equal(result.status, 'conflict');
  assert.match(result.explanation, /<temporary-project>/);
  assert.ok(result.explanation.length <= 540);
});

test('non-peer process failures remain unknown rather than fabricated conflicts', async () => {
  const verifier = new IsolatedResolverVerifier({
    packageManager: 'npm', packageManagerVersion: null,
    invocation: { executable: '/trusted/node', prefixArgs: ['/trusted/npm-cli.js'] },
    manifestText: JSON.stringify({ dependencies: { react: '18.0.0' } }),
    registry: 'https://registry.npmjs.org', policy: { strictPeerDeps: false, legacyPeerDeps: false },
    runner: { async run() { return { exitCode: 1, stdout: '', stderr: 'network unavailable' }; } },
  });
  assert.equal((await verifier.verify(proposal)).status, 'unknown');
});

// -------------------------------------------- materializeResolvedGraph (transitive remediation)

test('materializeResolvedGraph with an empty changes proposal stages the manifest completely unchanged — the "fresh resolve, no version bump" analysis case', async () => {
  const manifestText = JSON.stringify({ dependencies: { 'sockjs-client': '^1.6.1' } }, null, 2);
  let observedManifestText;
  const verifier = new IsolatedResolverVerifier({
    packageManager: 'npm', packageManagerVersion: '10.0.0',
    invocation: { executable: '/trusted/node', prefixArgs: ['/trusted/npm-cli.js'] },
    manifestText,
    registry: 'https://registry.npmjs.org', policy: { strictPeerDeps: false, legacyPeerDeps: false },
    runner: {
      async run(_invocation, args, cwd) {
        const { readFile, writeFile } = await import('node:fs/promises');
        observedManifestText = await readFile(`${cwd}/package.json`, 'utf8');
        if (args.includes('--package-lock-only')) {
          await writeFile(
            `${cwd}/package-lock.json`,
            JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/sockjs-client': { version: '1.6.1' } } })
          );
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    },
  });

  const emptyProposal = {
    requested: { packageName: 'sockjs-client', currentVersion: '1.6.1', targetVersion: '1.6.1', classification: 'prod' },
    changes: [],
  };
  const result = await verifier.materializeResolvedGraph(emptyProposal);
  assert.equal(result.ok, true);
  // Byte-identical — buildStagedManifest (which always reformats/pins) was never invoked.
  assert.equal(observedManifestText, manifestText);
  assert.equal(result.graph.nodes.get('node_modules/sockjs-client').version, '1.6.1');
});

test('materializeResolvedGraph with real changes still stages the pinned manifest, same as verify()', async () => {
  let observedManifest;
  const verifier = new IsolatedResolverVerifier({
    packageManager: 'npm', packageManagerVersion: '10.0.0',
    invocation: { executable: '/trusted/node', prefixArgs: ['/trusted/npm-cli.js'] },
    manifestText: JSON.stringify({ dependencies: { react: '^18.0.0' } }),
    registry: 'https://registry.npmjs.org', policy: { strictPeerDeps: false, legacyPeerDeps: false },
    runner: {
      async run(_invocation, args, cwd) {
        const { readFile, writeFile } = await import('node:fs/promises');
        observedManifest = JSON.parse(await readFile(`${cwd}/package.json`, 'utf8'));
        if (args.includes('--package-lock-only')) {
          await writeFile(`${cwd}/package-lock.json`, JSON.stringify({ lockfileVersion: 3, packages: { '': {} } }));
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    },
  });

  const result = await verifier.materializeResolvedGraph(proposal);
  assert.equal(result.ok, true);
  assert.equal(observedManifest.dependencies.react, '19.0.0');
});

test('materializeResolvedGraph degrades to ok:false on a non-zero resolver exit — never a fabricated graph', async () => {
  const verifier = new IsolatedResolverVerifier({
    packageManager: 'npm', packageManagerVersion: null,
    invocation: { executable: '/trusted/node', prefixArgs: ['/trusted/npm-cli.js'] },
    manifestText: JSON.stringify({ dependencies: { react: '18.0.0' } }),
    registry: 'https://registry.npmjs.org', policy: { strictPeerDeps: false, legacyPeerDeps: false },
    runner: { async run() { return { exitCode: 1, stdout: '', stderr: 'ENETUNREACH' }; } },
  });
  const emptyProposal = {
    requested: { packageName: 'react', currentVersion: '18.0.0', targetVersion: '18.0.0', classification: 'prod' },
    changes: [],
  };
  const result = await verifier.materializeResolvedGraph(emptyProposal);
  assert.deepEqual(result, { ok: false });
});

test('materializeResolvedGraph degrades to ok:false when the resolver exits cleanly but writes no parseable lockfile', async () => {
  const verifier = new IsolatedResolverVerifier({
    packageManager: 'npm', packageManagerVersion: null,
    invocation: { executable: '/trusted/node', prefixArgs: ['/trusted/npm-cli.js'] },
    manifestText: JSON.stringify({ dependencies: { react: '18.0.0' } }),
    registry: 'https://registry.npmjs.org', policy: { strictPeerDeps: false, legacyPeerDeps: false },
    runner: { async run() { return { exitCode: 0, stdout: '', stderr: '' }; } }, // no lockfile ever written
  });
  const emptyProposal = {
    requested: { packageName: 'react', currentVersion: '18.0.0', targetVersion: '18.0.0', classification: 'prod' },
    changes: [],
  };
  const result = await verifier.materializeResolvedGraph(emptyProposal);
  assert.deepEqual(result, { ok: false });
});

test('targeted transitive remediation starts from the active lockfile and returns exact proposed bytes', async () => {
  const manifestText = JSON.stringify({ dependencies: { 'sockjs-client': '1.6.1' } });
  const currentLockfile = JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': { dependencies: { 'sockjs-client': '1.6.1' } },
      'node_modules/sockjs-client': { version: '1.6.1', dependencies: { 'faye-websocket': '^0.11.3' } },
      'node_modules/faye-websocket': { version: '0.11.3', dependencies: { 'websocket-driver': '>=0.5.1' } },
      'node_modules/websocket-driver': { version: '0.7.3' },
    },
  });
  const proposedLockfile = JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': { dependencies: { 'sockjs-client': '1.6.1' } },
      'node_modules/sockjs-client': { version: '1.6.1', dependencies: { 'faye-websocket': '^0.11.3' } },
      'node_modules/faye-websocket': { version: '0.11.3', dependencies: { 'websocket-driver': '>=0.5.1' } },
      'node_modules/websocket-driver': { version: '0.7.5' },
    },
  });
  let observedArgs;
  const verifier = new IsolatedResolverVerifier({
    packageManager: 'npm', packageManagerVersion: '11.0.0',
    invocation: { executable: '/trusted/node', prefixArgs: ['/trusted/npm-cli.js'] },
    manifestText,
    lockfile: { name: 'package-lock.json', text: currentLockfile },
    registry: 'https://registry.npmjs.org', policy: { strictPeerDeps: true, legacyPeerDeps: false },
    runner: {
      async run(_invocation, args, cwd) {
        const { writeFile } = await import('node:fs/promises');
        observedArgs = args;
        await writeFile(`${cwd}/package-lock.json`, proposedLockfile);
        return { exitCode: 0, stdout: '{}', stderr: '' };
      },
    },
  });

  const result = await verifier.materializeTransitiveRemediation(['websocket-driver']);
  assert.equal(result.ok, true);
  assert.equal(result.lockfileText, proposedLockfile);
  assert.equal(result.beforeGraph.nodes.get('node_modules/websocket-driver').version, '0.7.3');
  assert.equal(result.graph.nodes.get('node_modules/websocket-driver').version, '0.7.5');
  assert.deepEqual(observedArgs, buildTransitiveRemediationMaterializationArgs(
    'npm',
    ['websocket-driver'],
    'https://registry.npmjs.org',
    { strictPeerDeps: true, legacyPeerDeps: false }
  ));
});

test('targeted transitive remediation refuses a package-manager manifest mutation', async () => {
  const manifestText = JSON.stringify({ dependencies: { 'sockjs-client': '1.6.1' } });
  const lockfileText = JSON.stringify({
    lockfileVersion: 3,
    packages: { '': { dependencies: { 'sockjs-client': '1.6.1' } }, 'node_modules/sockjs-client': { version: '1.6.1' } },
  });
  const verifier = new IsolatedResolverVerifier({
    packageManager: 'npm', packageManagerVersion: '11.0.0',
    invocation: { executable: '/trusted/node', prefixArgs: ['/trusted/npm-cli.js'] },
    manifestText,
    lockfile: { name: 'package-lock.json', text: lockfileText },
    registry: 'https://registry.npmjs.org', policy: { strictPeerDeps: false, legacyPeerDeps: false },
    runner: {
      async run(_invocation, _args, cwd) {
        const { writeFile } = await import('node:fs/promises');
        await writeFile(`${cwd}/package.json`, JSON.stringify({ dependencies: { 'sockjs-client': '1.6.2' } }));
        return { exitCode: 0, stdout: '{}', stderr: '' };
      },
    },
  });

  const result = await verifier.materializeTransitiveRemediation(['websocket-driver']);
  assert.equal(result.ok, false);
  assert.match(result.reason, /unexpectedly changed package\.json/);
});
