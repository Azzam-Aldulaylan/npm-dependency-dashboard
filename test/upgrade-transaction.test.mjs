import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runUpgradeTransaction } from '../out/host/upgradeTransaction.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function present(text) {
  return { exists: true, contents: encoder.encode(text) };
}

const missing = () => ({ exists: false });

function clone(state) {
  return state.exists
    ? { exists: true, contents: Uint8Array.from(state.contents) }
    : { exists: false };
}

function statesEqual(left, right) {
  if (left.exists !== right.exists) return false;
  if (!left.exists || !right.exists) return true;
  return Buffer.from(left.contents).equals(Buffer.from(right.contents));
}

class MemoryFiles {
  constructor(entries) {
    this.states = new Map(Object.entries(entries).map(([path, state]) => [path, clone(state)]));
    this.readFailures = new Map();
    this.casFailures = new Map();
    this.casCalls = [];
    this.onRead = undefined;
  }

  async read(path) {
    this.onRead?.(path);
    const failure = this.readFailures.get(path);
    if (failure !== undefined) throw failure;
    return clone(this.states.get(path) ?? missing());
  }

  async compareAndSwap(path, expected, replacement) {
    this.casCalls.push({ path, expected: clone(expected), replacement: clone(replacement) });
    const failure = this.casFailures.get(path);
    if (failure !== undefined) throw failure;
    const current = this.states.get(path) ?? missing();
    if (!statesEqual(current, expected)) return 'conflict';
    this.states.set(path, clone(replacement));
    return 'restored';
  }

  set(path, state) {
    this.states.set(path, clone(state));
  }

  text(path) {
    const state = this.states.get(path) ?? missing();
    return state.exists ? decoder.decode(state.contents) : null;
  }
}

function successfulInstall(run) {
  return {
    execute: async () => {
      await run();
      return { status: 'succeeded', exitCode: 0 };
    },
  };
}

function passedVerification(run = () => {}) {
  return {
    verify: async () => {
      await run();
      return { status: 'passed', checks: [{ id: 'typecheck', status: 'passed' }] };
    },
  };
}

function failedVerification(run = () => {}) {
  return {
    verify: async () => {
      await run();
      return {
        status: 'failed',
        checks: [{ id: 'test', status: 'failed', message: 'tests failed' }],
        message: 'One verification check failed.',
      };
    },
  };
}

const manifestPath = '/workspace/package.json';
const lockfilePath = '/workspace/package-lock.json';

test('successful install and successful verification keep upgraded files and report verified separately', async () => {
  const files = new MemoryFiles({
    [manifestPath]: present('{"dependencies":{"react":"^18.0.0"}}'),
    [lockfilePath]: present('lock-before'),
  });

  const result = await runUpgradeTransaction({
    allowlistedPaths: [manifestPath, lockfilePath],
    files,
    install: successfulInstall(() => {
      files.set(manifestPath, present('{"dependencies":{"react":"^19.0.0"}}'));
      files.set(lockfilePath, present('lock-after'));
    }),
    verifier: passedVerification(),
  });

  assert.equal(result.completion, 'kept');
  assert.equal(result.reason, 'verified');
  assert.equal(result.install.status, 'succeeded');
  assert.equal(result.verification.status, 'passed');
  assert.deepEqual(result.rollback, { status: 'not-needed' });
  assert.equal(files.text(manifestPath), '{"dependencies":{"react":"^19.0.0"}}');
  assert.equal(files.text(lockfilePath), 'lock-after');
  assert.equal(files.casCalls.length, 0);
});

test('install success without a verifier is kept but is explicitly not reported as verified', async () => {
  const files = new MemoryFiles({ [manifestPath]: present('before') });

  const result = await runUpgradeTransaction({
    allowlistedPaths: [manifestPath],
    files,
    install: successfulInstall(() => files.set(manifestPath, present('after'))),
  });

  assert.equal(result.completion, 'kept');
  assert.equal(result.reason, 'verification-not-configured');
  assert.deepEqual(result.verification, { status: 'not-run', reason: 'not-configured' });
});

test('a failed verification can be explicitly kept without rollback', async () => {
  const files = new MemoryFiles({ [manifestPath]: present('before') });

  const result = await runUpgradeTransaction({
    allowlistedPaths: [manifestPath],
    files,
    install: successfulInstall(() => files.set(manifestPath, present('after'))),
    verifier: failedVerification(),
    verificationFailureDecider: {
      decide: async () => 'keep',
    },
  });

  assert.equal(result.completion, 'kept');
  assert.equal(result.reason, 'verification-failed');
  assert.equal(result.retentionDecision, 'keep');
  assert.equal(result.verification.status, 'failed');
  assert.equal(files.text(manifestPath), 'after');
  assert.equal(files.casCalls.length, 0);
});

test('failed verification rolls back exact pre-existing bytes and removes a transaction-created lockfile', async () => {
  // Whitespace and the unrelated custom field are deliberate: rollback is an
  // exact byte restoration, not a package.json reconstruction.
  const originalManifest = '{\n  "custom": true,\n  "dependencies": { "react": "^18" }\n}\n';
  const files = new MemoryFiles({
    [manifestPath]: present(originalManifest),
    [lockfilePath]: missing(),
  });

  const result = await runUpgradeTransaction({
    // A duplicate allowlisted path is harmless and snapshots/restores once.
    allowlistedPaths: [manifestPath, lockfilePath, manifestPath],
    files,
    install: successfulInstall(() => {
      files.set(manifestPath, present('{"dependencies":{"react":"^19"}}\n'));
      files.set(lockfilePath, present('new lockfile'));
    }),
    verifier: failedVerification(),
  });

  assert.equal(result.completion, 'rolled-back');
  assert.equal(result.reason, 'verification-failed');
  assert.equal(result.rollback.status, 'succeeded');
  assert.deepEqual(result.snapshot, {
    status: 'succeeded',
    paths: [manifestPath, lockfilePath],
  });
  assert.equal(files.text(manifestPath), originalManifest, 'pre-existing user content is restored byte-for-byte');
  assert.equal(files.text(lockfilePath), null, 'a lockfile created by this transaction is removed');
  assert.equal(files.casCalls.length, 2);
});

test('rollback restores allowlisted dependency files but never restores node_modules state', async () => {
  const nodeModulesMarker = '/workspace/node_modules/.dependency-dashboard-state';
  const files = new MemoryFiles({
    [manifestPath]: present('manifest-before'),
    [lockfilePath]: present('lock-before'),
    [nodeModulesMarker]: present('installed-before'),
  });

  const result = await runUpgradeTransaction({
    allowlistedPaths: [manifestPath, lockfilePath],
    files,
    install: successfulInstall(() => {
      files.set(manifestPath, present('manifest-after'));
      files.set(lockfilePath, present('lock-after'));
      files.set(nodeModulesMarker, present('installed-after'));
    }),
    verifier: failedVerification(),
  });

  assert.equal(result.completion, 'rolled-back');
  assert.equal(files.text(manifestPath), 'manifest-before');
  assert.equal(files.text(lockfilePath), 'lock-before');
  assert.equal(files.text(nodeModulesMarker), 'installed-after');
  assert.equal(
    files.casCalls.some(({ path }) => path === nodeModulesMarker),
    false,
    'node_modules is outside the transaction allowlist and must never be a rollback target'
  );
});

test('a failed install is assumed potentially mutating and is rolled back', async () => {
  const files = new MemoryFiles({ [manifestPath]: present('before') });
  const install = {
    execute: async () => {
      files.set(manifestPath, present('partially-written'));
      return { status: 'failed', code: 'INSTALL_FAILED', message: 'exit 1', exitCode: 1 };
    },
  };

  const result = await runUpgradeTransaction({
    allowlistedPaths: [manifestPath],
    files,
    install,
    verifier: passedVerification(),
  });

  assert.equal(result.completion, 'rolled-back');
  assert.equal(result.reason, 'install-failed');
  assert.equal(result.install.status, 'failed');
  assert.deepEqual(result.verification, { status: 'not-run', reason: 'install-failed' });
  assert.equal(result.rollback.status, 'succeeded');
  assert.equal(files.text(manifestPath), 'before');
});

test('rollback failures are structured per file and leave completion incomplete', async () => {
  const files = new MemoryFiles({
    [manifestPath]: present('manifest-before'),
    [lockfilePath]: present('lock-before'),
  });
  files.casFailures.set(lockfilePath, new Error('permission denied'));

  const result = await runUpgradeTransaction({
    allowlistedPaths: [manifestPath, lockfilePath],
    files,
    install: successfulInstall(() => {
      files.set(manifestPath, present('manifest-after'));
      files.set(lockfilePath, present('lock-after'));
    }),
    verifier: failedVerification(),
  });

  assert.equal(result.completion, 'incomplete');
  assert.equal(result.rollback.status, 'failed');
  assert.deepEqual(
    result.rollback.files.map(({ path, status }) => ({ path, status })),
    [
      { path: manifestPath, status: 'restored' },
      { path: lockfilePath, status: 'failed' },
    ]
  );
  assert.equal(files.text(manifestPath), 'manifest-before');
  assert.equal(files.text(lockfilePath), 'lock-after');
});

test('compare-and-swap rollback preserves a concurrent edit made after install', async () => {
  const files = new MemoryFiles({
    [manifestPath]: present('before'),
    [lockfilePath]: present('lock-before'),
  });

  const result = await runUpgradeTransaction({
    allowlistedPaths: [manifestPath, lockfilePath],
    files,
    install: successfulInstall(() => {
      files.set(manifestPath, present('installed'));
      files.set(lockfilePath, present('lock-installed'));
    }),
    verifier: failedVerification(() => {
      // Expected post-install state has already been captured. This edit is
      // not owned by the install and must never be overwritten by rollback.
      files.set(manifestPath, present('developer concurrent edit'));
    }),
  });

  assert.equal(result.completion, 'incomplete');
  assert.equal(result.rollback.status, 'conflict');
  assert.deepEqual(
    result.rollback.files.map(({ path, status }) => ({ path, status })),
    [
      { path: manifestPath, status: 'conflict' },
      { path: lockfilePath, status: 'restored' },
    ]
  );
  assert.equal(files.text(manifestPath), 'developer concurrent edit');
  assert.equal(files.text(lockfilePath), 'lock-before');
});

test('snapshot failure stops before execution and reports the exact failing allowlisted path', async () => {
  const files = new MemoryFiles({ [manifestPath]: present('before') });
  files.readFailures.set(lockfilePath, new Error('read denied'));
  let executed = false;

  const result = await runUpgradeTransaction({
    allowlistedPaths: [manifestPath, lockfilePath],
    files,
    install: successfulInstall(() => {
      executed = true;
    }),
  });

  assert.equal(result.completion, 'not-started');
  assert.equal(result.reason, 'snapshot-failed');
  assert.deepEqual(result.snapshot, { status: 'failed', path: lockfilePath, message: 'read denied' });
  assert.equal(result.install.status, 'not-run');
  assert.equal(executed, false);
});

test('cancellation before snapshot performs no filesystem or executor work', async () => {
  const abort = new AbortController();
  abort.abort();
  const files = new MemoryFiles({ [manifestPath]: present('before') });
  let reads = 0;
  let executes = 0;
  files.onRead = () => {
    reads += 1;
  };

  const result = await runUpgradeTransaction({
    allowlistedPaths: [manifestPath],
    files,
    install: successfulInstall(() => {
      executes += 1;
    }),
    signal: abort.signal,
  });

  assert.equal(result.completion, 'not-started');
  assert.equal(result.reason, 'cancelled');
  assert.equal(result.snapshot.status, 'not-run');
  assert.equal(reads, 0);
  assert.equal(executes, 0);
});

test('cancellation while snapshotting waits for the read boundary and never starts install', async () => {
  const abort = new AbortController();
  const files = new MemoryFiles({ [manifestPath]: present('before') });
  let executes = 0;
  files.onRead = () => abort.abort();

  const result = await runUpgradeTransaction({
    allowlistedPaths: [manifestPath],
    files,
    install: successfulInstall(() => {
      executes += 1;
    }),
    signal: abort.signal,
  });

  assert.equal(result.completion, 'not-started');
  assert.equal(result.reason, 'cancelled');
  assert.equal(result.snapshot.status, 'succeeded');
  assert.equal(executes, 0);
  assert.equal(files.casCalls.length, 0);
});

test('cancellation during install does not interrupt mutation; it waits, then rolls back', async () => {
  const abort = new AbortController();
  const files = new MemoryFiles({ [manifestPath]: present('before') });
  let finishInstall;
  let installStarted = false;
  const heldInstall = new Promise((resolve) => {
    finishInstall = resolve;
  });
  const install = {
    execute: async () => {
      installStarted = true;
      files.set(manifestPath, present('after'));
      await heldInstall;
      return { status: 'succeeded', exitCode: 0 };
    },
  };

  const pending = runUpgradeTransaction({
    allowlistedPaths: [manifestPath],
    files,
    install,
    verifier: passedVerification(),
    signal: abort.signal,
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(installStarted, true);
  abort.abort();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(files.casCalls.length, 0, 'rollback cannot race the still-running installer');

  finishInstall();
  const result = await pending;
  assert.equal(result.completion, 'rolled-back');
  assert.equal(result.reason, 'cancelled');
  assert.deepEqual(result.verification, { status: 'not-run', reason: 'cancelled' });
  assert.equal(files.text(manifestPath), 'before');
});

test('cancellation during verification waits for verification before rollback', async () => {
  const abort = new AbortController();
  const files = new MemoryFiles({ [manifestPath]: present('before') });
  let finishVerification;
  const heldVerification = new Promise((resolve) => {
    finishVerification = resolve;
  });
  const verifier = {
    verify: async () => {
      await heldVerification;
      return { status: 'passed', checks: [{ id: 'build', status: 'passed' }] };
    },
  };

  const pending = runUpgradeTransaction({
    allowlistedPaths: [manifestPath],
    files,
    install: successfulInstall(() => files.set(manifestPath, present('after'))),
    verifier,
    signal: abort.signal,
  });

  await new Promise((resolve) => setImmediate(resolve));
  abort.abort();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(files.casCalls.length, 0, 'rollback cannot race the still-running verifier');

  finishVerification();
  const result = await pending;
  assert.equal(result.completion, 'rolled-back');
  assert.equal(result.reason, 'cancelled');
  assert.equal(result.verification.status, 'passed');
  assert.equal(files.text(manifestPath), 'before');
});
