import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { buildStagedManifest, buildStagedManifestForRemoval } from '../../out/core/upgrade/stagedManifest.js';
import { createNodeUpgradeTransactionFileAdapter } from '../../out/host/nodeUpgradeTransactionFiles.js';
import { runUpgradeTransaction } from '../../out/host/upgradeTransaction.js';

import {
  createRealProjectFixture,
  FIXTURE_BASELINE_VERSION,
  FIXTURE_DEPENDENCY,
  FIXTURE_TARGET_VERSION,
  installArgs,
  runCommand,
  runPackageManager,
} from './real-project-fixtures.mjs';

async function exactFiles(fixture) {
  return {
    manifest: await readFile(fixture.manifestPath),
    lockfile: await readFile(fixture.lockfilePath),
  };
}

async function installExecutor(packageManager, root) {
  try {
    const result = await runPackageManager(packageManager, installArgs(packageManager), root);
    return { status: 'succeeded', exitCode: result.exitCode };
  } catch (cause) {
    return { status: 'failed', code: 'PACKAGE_MANAGER_FAILED', message: cause instanceof Error ? cause.message : String(cause) };
  }
}

async function verifyFixture(root, expectedVersion, shouldExist = true) {
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const declared = manifest.dependencies?.[FIXTURE_DEPENDENCY];
  if (shouldExist ? declared !== expectedVersion : declared !== undefined) {
    return {
      status: 'failed',
      checks: [{ id: 'manifest', status: 'failed', message: `Unexpected declaration: ${String(declared)}` }],
    };
  }
  if (shouldExist) {
    const installed = JSON.parse(
      await readFile(path.join(root, 'node_modules', FIXTURE_DEPENDENCY, 'package.json'), 'utf8')
    );
    if (installed.version !== expectedVersion) {
      return {
        status: 'failed',
        checks: [{ id: 'installed-version', status: 'failed', message: `Installed ${installed.version}` }],
      };
    }
    const command = process.execPath;
    const verification = await runCommand(command, ['verify.mjs'], { cwd: root, allowFailure: true });
    if (verification.exitCode !== 0) {
      return {
        status: 'failed',
        checks: [{ id: 'fixture-script', status: 'failed', message: verification.stderr || verification.stdout }],
      };
    }
  }
  return { status: 'passed', checks: [{ id: 'real-project', status: 'passed' }] };
}

async function resetFixture(fixture) {
  await writeFile(fixture.manifestPath, fixture.baselineManifest);
  await runPackageManager(fixture.packageManager, installArgs(fixture.packageManager), fixture.root);
  const current = await exactFiles(fixture);
  assert.deepEqual(current.manifest, fixture.baselineManifest);
}

async function runManager(packageManager) {
  const fixture = await createRealProjectFixture(packageManager);
  const metrics = { packageManager, setupMs: fixture.setupDurationMs };
  try {
    const allowlistedPaths = [fixture.manifestPath, fixture.lockfilePath];
    const files = await createNodeUpgradeTransactionFileAdapter({
      workspaceRoot: fixture.root,
      allowlistedPaths,
    });

    const upgradeManifest = buildStagedManifest(fixture.baselineManifest.toString('utf8'), [{
      packageName: FIXTURE_DEPENDENCY,
      target: FIXTURE_TARGET_VERSION,
      classification: 'prod',
    }]);
    let started = performance.now();
    const upgrade = await runUpgradeTransaction({
      allowlistedPaths,
      files,
      manifestStage: {
        path: fixture.manifestPath,
        expectedContents: fixture.baselineManifest,
        contents: Buffer.from(upgradeManifest),
      },
      install: { execute: () => installExecutor(packageManager, fixture.root) },
      verifier: { verify: () => verifyFixture(fixture.root, FIXTURE_TARGET_VERSION) },
    });
    metrics.upgradeMs = performance.now() - started;
    assert.equal(upgrade.completion, 'kept');
    assert.equal(upgrade.reason, 'verified');
    await resetFixture(fixture);

    const removalSource = await readFile(fixture.manifestPath);
    const removalManifest = buildStagedManifestForRemoval(removalSource.toString('utf8'), [{
      packageName: FIXTURE_DEPENDENCY,
      classification: 'prod',
    }]);
    started = performance.now();
    const removal = await runUpgradeTransaction({
      allowlistedPaths,
      files,
      manifestStage: {
        path: fixture.manifestPath,
        expectedContents: removalSource,
        contents: Buffer.from(removalManifest),
      },
      install: { execute: () => installExecutor(packageManager, fixture.root) },
      verifier: { verify: () => verifyFixture(fixture.root, FIXTURE_BASELINE_VERSION, false) },
    });
    metrics.removalMs = performance.now() - started;
    assert.equal(removal.completion, 'kept');
    assert.equal(removal.reason, 'verified');
    await resetFixture(fixture);

    const rollbackBefore = await exactFiles(fixture);
    const rollbackManifest = buildStagedManifest(rollbackBefore.manifest.toString('utf8'), [{
      packageName: FIXTURE_DEPENDENCY,
      target: FIXTURE_TARGET_VERSION,
      classification: 'prod',
    }]);
    started = performance.now();
    const rolledBack = await runUpgradeTransaction({
      allowlistedPaths,
      files,
      manifestStage: {
        path: fixture.manifestPath,
        expectedContents: rollbackBefore.manifest,
        contents: Buffer.from(rollbackManifest),
      },
      install: { execute: () => installExecutor(packageManager, fixture.root) },
      verifier: {
        verify: async () => ({
          status: 'failed',
          checks: [{ id: 'intentional-fixture-failure', status: 'failed', message: 'Rollback probe.' }],
        }),
      },
      verificationFailureDecider: { decide: async () => 'rollback' },
    });
    metrics.rollbackMs = performance.now() - started;
    assert.equal(rolledBack.completion, 'rolled-back');
    assert.equal(rolledBack.rollback.status, 'succeeded');
    const rollbackAfter = await exactFiles(fixture);
    assert.deepEqual(rollbackAfter.manifest, rollbackBefore.manifest);
    assert.deepEqual(rollbackAfter.lockfile, rollbackBefore.lockfile);
    await resetFixture(fixture);

    const staleExpected = await readFile(fixture.manifestPath);
    const staleManifest = buildStagedManifest(staleExpected.toString('utf8'), [{
      packageName: FIXTURE_DEPENDENCY,
      target: FIXTURE_TARGET_VERSION,
      classification: 'prod',
    }]);
    const externalManifest = Buffer.from(`${staleExpected.toString('utf8').trimEnd()}\n\n`);
    await writeFile(fixture.manifestPath, externalManifest);
    let installCalled = false;
    const stale = await runUpgradeTransaction({
      allowlistedPaths,
      files,
      manifestStage: {
        path: fixture.manifestPath,
        expectedContents: staleExpected,
        contents: Buffer.from(staleManifest),
      },
      install: {
        execute: async () => {
          installCalled = true;
          return { status: 'succeeded' };
        },
      },
    });
    assert.equal(stale.completion, 'not-started');
    assert.equal(stale.reason, 'manifest-stage-failed');
    assert.equal(stale.manifestStage.status, 'failed');
    assert.equal(stale.manifestStage.code, 'CONFLICT');
    assert.equal(installCalled, false);
    assert.deepEqual(await readFile(fixture.manifestPath), externalManifest);

    for (const [name, duration] of Object.entries(metrics)) {
      if (name.endsWith('Ms')) assert.ok(duration < 120_000, `${packageManager} ${name} exceeded 120 seconds.`);
    }
    return metrics;
  } finally {
    await fixture.cleanup();
  }
}

const reports = [];
for (const packageManager of ['npm', 'pnpm']) reports.push(await runManager(packageManager));

console.log('Disposable real-project transaction results');
for (const report of reports) {
  console.log(
    `${report.packageManager}: setup ${report.setupMs.toFixed(0)} ms, upgrade ${report.upgradeMs.toFixed(0)} ms, ` +
    `removal ${report.removalMs.toFixed(0)} ms, rollback ${report.rollbackMs.toFixed(0)} ms`
  );
}

