/**
 * DashboardController, end to end against a fake HttpClient.
 *
 * The cache/cancellation tests are the point of this file. The controller's
 * whole job is deciding what reaches the webview and when, so every assertion
 * is on the exact sequence of posted messages.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DashboardController } from '../out/host/dashboardController.js';
import { MemoryEtagStore } from '../out/core/registry/versions.js';

const REGISTRY = 'https://registry.npmjs.org';
const ROOT = '/tmp/project';

const MANIFEST = JSON.stringify({
  name: 'app',
  version: '1.0.0',
  dependencies: { 'clean-pkg': '^1.0.0' },
});

const LOCKFILE = JSON.stringify({
  name: 'app',
  lockfileVersion: 3,
  packages: {
    '': { name: 'app', version: '1.0.0', dependencies: { 'clean-pkg': '^1.0.0' } },
    'node_modules/clean-pkg': { version: '1.0.0' },
  },
});

const json = (body) => ({
  status: 200,
  headers: {},
  body: JSON.stringify(body),
  wireBytes: JSON.stringify(body).length,
});

function recordingSink() {
  const posted = [];
  return {
    posted,
    get statuses() {
      return posted.map((m) => m.status);
    },
    postMessage(message) {
      posted.push(message);
    },
  };
}

/**
 * Answers `/clean-pkg/latest` with a version that depends on which run asked.
 * Runs are told apart by AbortSignal identity — each run creates its own — so
 * a message can be traced back to the run that produced it.
 */
function generationalClient({ versions, delayMs = {} }) {
  const signals = [];
  const generationOf = (signal) => {
    const index = signals.indexOf(signal);
    if (index !== -1) return index;
    signals.push(signal);
    return signals.length - 1;
  };

  return {
    generations: signals,
    async get(url, options = {}) {
      const generation = generationOf(options.signal);
      await new Promise((resolve) => setTimeout(resolve, delayMs[generation] ?? 0));
      if (url !== `${REGISTRY}/clean-pkg/latest`) {
        return { status: 404, headers: {}, body: '', wireBytes: 0 };
      }
      return json({ version: versions[generation] ?? versions[versions.length - 1] });
    },
    async post(url, body, options = {}) {
      const generation = generationOf(options.signal);
      await new Promise((resolve) => setTimeout(resolve, delayMs[generation] ?? 0));
      return json({});
    },
  };
}

const staticClient = (version) => generationalClient({ versions: [version] });

const PROJECT_INFO = { label: 'app', manifestPath: 'package.json' };

function makeController(client, overrides = {}) {
  return new DashboardController({
    root: ROOT,
    manifestText: MANIFEST,
    lockfileText: LOCKFILE,
    registry: REGISTRY,
    httpClient: client,
    etagStore: new MemoryEtagStore(),
    projectInfo: PROJECT_INFO,
    canChangeProject: false,
    ...overrides,
  });
}

const latestOf = (message) => message.data.rows[0].latest;

// --------------------------------------------------------------- ready

test('handleReady with a cold cache posts loading, then the fresh result', async () => {
  const controller = makeController(staticClient('1.0.1'));
  const sink = recordingSink();

  await controller.handleReady(sink);

  // partial-error, not ready: no auditRunner was supplied, so the pipeline
  // reports the enrichment as unavailable.
  assert.deepEqual(sink.statuses, ['loading', 'partial-error']);
  assert.equal(latestOf(sink.posted[1]), '1.0.1');
  assert.equal(sink.posted[1].data.auditUnavailable, true);
});

test('handleReady with a warm cache replays it as stale, then posts fresh data', async () => {
  const controller = makeController(generationalClient({ versions: ['1.0.1', '1.0.2'] }));

  const priming = recordingSink();
  await controller.handleReady(priming);

  const sink = recordingSink();
  await controller.handleReady(sink);

  assert.deepEqual(sink.statuses, ['stale', 'partial-error']);
  assert.equal(latestOf(sink.posted[0]), '1.0.1', 'the replay is the cached run, not a new one');
  assert.equal(latestOf(sink.posted[1]), '1.0.2', 'a fresh run still follows the replay');
});

test('the replayed snapshot keeps the timestamp of the run that produced it', async () => {
  const controller = makeController(staticClient('1.0.1'));
  const priming = recordingSink();
  await controller.handleReady(priming);

  const sink = recordingSink();
  await controller.handleReady(sink);

  assert.equal(
    sink.posted[0].data.generatedAt,
    priming.posted[1].data.generatedAt,
    'a stale banner must not claim the data is from now'
  );
});

test('an empty dependency list is reported as empty, not as an error', async () => {
  const controller = makeController(staticClient('1.0.1'), {
    manifestText: JSON.stringify({ name: 'app', version: '1.0.0' }),
    lockfileText: JSON.stringify({ lockfileVersion: 3, packages: { '': { name: 'app' } } }),
  });
  const sink = recordingSink();

  await controller.handleReady(sink);

  assert.deepEqual(sink.statuses, ['loading', 'empty']);
  assert.deepEqual(sink.posted[1].data.rows, []);
});

// ------------------------------------------------------------- refresh

test('handleRefresh reruns even with a warm cache, and never replays it', async () => {
  const controller = makeController(generationalClient({ versions: ['1.0.1', '1.0.2'] }));

  const priming = recordingSink();
  await controller.handleReady(priming);

  const sink = recordingSink();
  await controller.handleRefresh(sink);

  assert.deepEqual(sink.statuses, ['loading', 'partial-error'], 'no stale replay on a manual refresh');
  assert.equal(latestOf(sink.posted[1]), '1.0.2');
});

test('a refresh after a refresh does not serve the discarded cache', async () => {
  const controller = makeController(generationalClient({ versions: ['1.0.1', '1.0.2', '1.0.3'] }));
  const sink = recordingSink();

  await controller.handleRefresh(sink);
  await controller.handleRefresh(sink);
  await controller.handleReady(sink);

  assert.deepEqual(sink.statuses, [
    'loading',
    'partial-error',
    'loading',
    'partial-error',
    'stale',
    'partial-error',
  ]);
  assert.equal(latestOf(sink.posted[4]), '1.0.2', 'the replay is the most recent completed run');
});

// -------------------------------------------------- cancellation

test('a superseded run never posts its result', async () => {
  // Run 0 is held back so it would otherwise finish last and overwrite run 1's
  // newer data. Without the abort-and-supersede logic the sink ends on run 0.
  const client = generationalClient({ versions: ['1.0.1', '1.0.2'], delayMs: { 0: 60 } });
  const controller = makeController(client);
  const sink = recordingSink();

  const superseded = controller.handleRefresh(sink);
  // Let run 0 reach its first await before starting run 1, so the two runs get
  // distinct generations rather than racing for the same one.
  await new Promise((resolve) => setTimeout(resolve, 5));
  const winner = controller.handleRefresh(sink);

  await Promise.all([superseded, winner]);
  await new Promise((resolve) => setTimeout(resolve, 100));

  const results = sink.posted.filter((m) => m.status !== 'loading');
  assert.equal(results.length, 1, `expected exactly one result, got ${sink.statuses.join(', ')}`);
  assert.equal(latestOf(results[0]), '1.0.2', 'the newer run is the one that lands');
});

test('dispose stops an in-flight run from posting anything', async () => {
  const client = generationalClient({ versions: ['1.0.1'], delayMs: { 0: 40 } });
  const controller = makeController(client);
  const sink = recordingSink();

  const run = controller.handleRefresh(sink);
  await new Promise((resolve) => setTimeout(resolve, 5));
  controller.dispose();

  await run;
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.deepEqual(sink.statuses, ['loading'], 'a disposed panel receives no further messages');
});

test('a superseded run does not poison the cache either', async () => {
  const client = generationalClient({ versions: ['1.0.1', '1.0.2'], delayMs: { 0: 60 } });
  const controller = makeController(client);

  const racing = recordingSink();
  const superseded = controller.handleRefresh(racing);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const winner = controller.handleRefresh(racing);
  await Promise.all([superseded, winner]);
  await new Promise((resolve) => setTimeout(resolve, 100));

  const sink = recordingSink();
  await controller.handleReady(sink);

  assert.equal(sink.posted[0].status, 'stale');
  assert.equal(latestOf(sink.posted[0]), '1.0.2', 'the cache holds the winning run, not the stale one');
});

// ------------------------------------------------------- fatal errors

test('an unsupported lockfile version is a fatal error, not an empty table', async () => {
  const controller = makeController(staticClient('1.0.1'), {
    lockfileText: JSON.stringify({ lockfileVersion: 9, packages: {} }),
  });
  const sink = recordingSink();

  await controller.handleReady(sink);

  assert.deepEqual(sink.statuses, ['loading', 'fatal-error']);
  assert.equal(sink.posted[1].error.code, 'UnsupportedLockfileError');
  assert.ok(sink.posted[1].error.message.length > 0);
});

test('an unreadable manifest is a fatal error', async () => {
  const controller = makeController(staticClient('1.0.1'), { manifestText: '{not json' });
  const sink = recordingSink();

  await controller.handleReady(sink);

  assert.deepEqual(sink.statuses, ['loading', 'fatal-error']);
});

test('a fatal error leaves nothing cached, so a retry starts clean', async () => {
  const controller = makeController(staticClient('1.0.1'), { manifestText: '{not json' });
  const first = recordingSink();
  await controller.handleReady(first);

  const sink = recordingSink();
  await controller.handleReady(sink);

  assert.deepEqual(sink.statuses, ['loading', 'fatal-error'], 'no stale replay of a run that failed');
});

// -------------------------------------------------------------- reload

test('updateProjectSnapshot then handleRefresh scans the new lockfile content, not the original', async () => {
  const controller = makeController(staticClient('2.0.0'));
  const first = recordingSink();
  await controller.handleReady(first);
  assert.equal(first.posted[1].data.rows[0].current, '1.0.0', 'sanity check on the original snapshot');

  const updatedLockfile = JSON.stringify({
    name: 'app',
    lockfileVersion: 3,
    packages: {
      '': { name: 'app', version: '1.0.0', dependencies: { 'clean-pkg': '^1.0.0' } },
      // Simulates an upgrade task having rewritten the lockfile on disk.
      'node_modules/clean-pkg': { version: '1.5.0' },
    },
  });
  controller.updateProjectSnapshot({
    root: ROOT,
    manifestText: MANIFEST,
    lockfileText: updatedLockfile,
    registry: REGISTRY,
    projectInfo: PROJECT_INFO,
    canChangeProject: false,
  });

  const sink = recordingSink();
  await controller.handleRefresh(sink);

  assert.equal(
    sink.posted[1].data.rows[0].current,
    '1.5.0',
    'the second scan must reflect the updated lockfile, not the string captured at construction'
  );
});

test('updateProjectSnapshot then handleRefresh scans the new manifest content, not the original', async () => {
  const controller = makeController(staticClient('1.0.1'));
  const first = recordingSink();
  await controller.handleReady(first);
  assert.deepEqual(
    first.posted[1].data.rows.map((r) => r.name),
    ['clean-pkg'],
    'sanity check on the original snapshot'
  );

  const updatedManifest = JSON.stringify({
    name: 'app',
    version: '1.0.0',
    dependencies: { 'clean-pkg': '^1.0.0', 'new-pkg': '^1.0.0' },
  });
  const updatedLockfile = JSON.stringify({
    name: 'app',
    lockfileVersion: 3,
    packages: {
      '': {
        name: 'app',
        version: '1.0.0',
        dependencies: { 'clean-pkg': '^1.0.0', 'new-pkg': '^1.0.0' },
      },
      'node_modules/clean-pkg': { version: '1.0.0' },
      'node_modules/new-pkg': { version: '1.0.0' },
    },
  });
  controller.updateProjectSnapshot({
    root: ROOT,
    manifestText: updatedManifest,
    lockfileText: updatedLockfile,
    registry: REGISTRY,
    projectInfo: PROJECT_INFO,
    canChangeProject: false,
  });

  const sink = recordingSink();
  await controller.handleRefresh(sink);

  assert.deepEqual(
    sink.posted[1].data.rows.map((r) => r.name).sort(),
    ['clean-pkg', 'new-pkg'],
    'the second scan must reflect the updated manifest’s dependency set, not the string captured at construction'
  );
});

test('updateProjectSnapshot changes root, read via the root getter', () => {
  const controller = makeController(staticClient('1.0.1'));
  assert.equal(controller.root, ROOT);

  controller.updateProjectSnapshot({
    root: '/tmp/other-project',
    manifestText: MANIFEST,
    lockfileText: LOCKFILE,
    registry: REGISTRY,
    projectInfo: PROJECT_INFO,
    canChangeProject: false,
  });

  assert.equal(controller.root, '/tmp/other-project');
});

test('switching project updates root, manifest, lockfile, registry, dependency classification, and the outgoing project info', async () => {
  const controller = makeController(staticClient('1.0.1'), {
    projectInfo: { label: 'frontend', manifestPath: 'package.json' },
    canChangeProject: true,
  });
  const first = recordingSink();
  await controller.handleReady(first);
  assert.deepEqual(first.posted[1].data.project, { label: 'frontend', manifestPath: 'package.json' });
  assert.equal(first.posted[1].data.canChangeProject, true);

  const otherManifest = JSON.stringify({
    name: 'api',
    version: '1.0.0',
    devDependencies: { 'clean-pkg': '^1.0.0' },
  });
  const otherLockfile = JSON.stringify({
    name: 'api',
    lockfileVersion: 3,
    packages: {
      '': { name: 'api', version: '1.0.0', devDependencies: { 'clean-pkg': '^1.0.0' } },
      'node_modules/clean-pkg': { version: '1.0.0', dev: true },
    },
  });
  const otherProjectInfo = { label: 'api — packages/api', manifestPath: 'packages/api/package.json' };

  controller.updateProjectSnapshot({
    root: '/tmp/other-project',
    manifestText: otherManifest,
    lockfileText: otherLockfile,
    registry: 'https://custom.registry.example/',
    projectInfo: otherProjectInfo,
    canChangeProject: true,
  });

  const sink = recordingSink();
  await controller.handleRefresh(sink);

  assert.equal(controller.root, '/tmp/other-project', 'root switched');
  assert.deepEqual(sink.posted[1].data.project, otherProjectInfo, 'project info switched');
  assert.equal(sink.posted[1].data.rows[0].dev, true, 'manifest/lockfile switched — dependency now reads as dev');

  const classification = controller.validateUpgradeRequest({ package: 'clean-pkg', target: '1.0.1' });
  assert.notEqual(classification.reason, 'not-declared', 'dependency classification derives from the new manifest');
});

test('a project switch while a scan is in flight is not overwritten by the superseded scan', async () => {
  // Run 0 (the original project) is held back so it would otherwise finish
  // last and overwrite the switch's newer scan. Uses the same abort-and-
  // supersede mechanism as two racing refreshes — switching project is just
  // another handleRefresh, preceded by updateProjectSnapshot.
  const client = generationalClient({ versions: ['1.0.1', '1.0.2'], delayMs: { 0: 60 } });
  const controller = makeController(client);
  const sink = recordingSink();

  const superseded = controller.handleRefresh(sink);
  await new Promise((resolve) => setTimeout(resolve, 5));

  controller.updateProjectSnapshot({
    root: '/tmp/other-project',
    manifestText: MANIFEST,
    lockfileText: LOCKFILE,
    registry: REGISTRY,
    projectInfo: { label: 'other', manifestPath: 'package.json' },
    canChangeProject: true,
  });
  const winner = controller.handleRefresh(sink);

  await Promise.all([superseded, winner]);
  await new Promise((resolve) => setTimeout(resolve, 100));

  const results = sink.posted.filter((m) => m.status !== 'loading');
  assert.equal(results.length, 1, `expected exactly one result, got ${sink.statuses.join(', ')}`);
  assert.equal(latestOf(results[0]), '1.0.2', 'the scan for the newly selected project is the one that lands');
  assert.equal(controller.root, '/tmp/other-project', 'the selection itself was not reverted either');
});

test('updateProjectSnapshot changes declaredDependencies, reflected in upgrade classification', async () => {
  const controller = makeController(staticClient('1.0.1'));
  await controller.handleReady(recordingSink());

  // Originally a prod dependency — reclassify it as dev via a fresh manifest.
  const reclassifiedManifest = JSON.stringify({
    name: 'app',
    version: '1.0.0',
    devDependencies: { 'clean-pkg': '^1.0.0' },
  });
  const reclassifiedLockfile = JSON.stringify({
    name: 'app',
    lockfileVersion: 3,
    packages: {
      '': { name: 'app', version: '1.0.0', devDependencies: { 'clean-pkg': '^1.0.0' } },
      'node_modules/clean-pkg': { version: '1.0.0', dev: true },
    },
  });
  controller.updateProjectSnapshot({
    root: ROOT,
    manifestText: reclassifiedManifest,
    lockfileText: reclassifiedLockfile,
    registry: REGISTRY,
    projectInfo: PROJECT_INFO,
    canChangeProject: false,
  });
  await controller.handleRefresh(recordingSink());

  // clean-pkg has no advisories, so there is still no eligible upgrade — this
  // only proves the reclassification took effect, via `not-declared` staying
  // unset (the row + declared dependency now agree it's a real, dev entry).
  const result = controller.validateUpgradeRequest({ package: 'clean-pkg', target: '1.0.1' });
  assert.equal(result.ok, false);
  assert.notEqual(result.reason, 'not-declared');
});

// ------------------------------------------------------------ upgrade eligibility

test('root exposes the project directory the controller was constructed with', () => {
  const controller = makeController(staticClient('1.0.1'));
  assert.equal(controller.root, ROOT);
});

test('before any scan completes, an upgrade request is rejected with no-scan-result', () => {
  const controller = makeController(staticClient('1.0.1'));
  const result = controller.validateUpgradeRequest({ package: 'clean-pkg', target: '1.0.1' });
  assert.deepEqual(result, { ok: false, reason: 'no-scan-result' });
});

test('an unknown package is rejected even after a successful scan', async () => {
  const controller = makeController(staticClient('1.0.1'));
  await controller.handleReady(recordingSink());

  const result = controller.validateUpgradeRequest({ package: 'never-heard-of-it', target: '9.9.9' });
  assert.deepEqual(result, { ok: false, reason: 'unknown-package' });
});

test('a package with no eligible upgrade is rejected, and a stale/forged target too', async () => {
  const controller = makeController(staticClient('1.0.1'));
  await controller.handleReady(recordingSink());

  // clean-pkg has no advisories, so resolveUpgradeTarget leaves upgradeTo
  // null — no matter what target a (forged or stale) request names.
  const noUpgrade = controller.validateUpgradeRequest({ package: 'clean-pkg', target: '1.0.1' });
  assert.deepEqual(noUpgrade, { ok: false, reason: 'no-eligible-upgrade' });

  const forged = controller.validateUpgradeRequest({ package: 'clean-pkg', target: '99.0.0' });
  assert.equal(forged.ok, false);
});

test('classification is derived from the manifest, never trusted from the request', async () => {
  const manifestWithDevAndOptional = JSON.stringify({
    name: 'app',
    version: '1.0.0',
    dependencies: { 'clean-pkg': '^1.0.0' },
    devDependencies: { 'dev-pkg': '^1.0.0' },
  });
  const lockfileWithDev = JSON.stringify({
    name: 'app',
    lockfileVersion: 3,
    packages: {
      '': {
        name: 'app',
        version: '1.0.0',
        dependencies: { 'clean-pkg': '^1.0.0' },
        devDependencies: { 'dev-pkg': '^1.0.0' },
      },
      'node_modules/clean-pkg': { version: '1.0.0' },
      'node_modules/dev-pkg': { version: '1.0.0', dev: true },
    },
  });

  const controller = makeController(staticClient('1.0.1'), {
    manifestText: manifestWithDevAndOptional,
    lockfileText: lockfileWithDev,
  });
  await controller.handleReady(recordingSink());

  // Both rows are clean (no advisories fetched for dev-pkg — the fake client
  // only answers clean-pkg's /latest), so neither has an eligible upgrade;
  // this exercises that a request naming a package never trusts anything
  // about its classification — only manifestText decides dev vs prod.
  const result = controller.validateUpgradeRequest({ package: 'dev-pkg', target: '1.0.1' });
  assert.equal(result.ok, false);
  assert.notEqual(result.reason, 'not-declared', 'dev-pkg is a real declared dependency');
});

test('a working audit runner produces a plain ready status', async () => {
  const auditRunner = {
    async run() {
      return { stdout: JSON.stringify({ vulnerabilities: {} }), exitCode: 0 };
    },
  };
  const controller = makeController(staticClient('1.0.1'), { auditRunner });
  const sink = recordingSink();

  await controller.handleReady(sink);

  assert.deepEqual(sink.statuses, ['loading', 'ready']);
  assert.equal(sink.posted[1].data.auditUnavailable, undefined);
});
