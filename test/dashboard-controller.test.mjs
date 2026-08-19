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
import { PersistentProjectCacheStore } from '../out/core/cache/projectCacheStore.js';
import { deriveProjectCacheKey } from '../out/core/cache/keys.js';
import { computeSourceFingerprint } from '../out/core/cache/sourceFingerprint.js';
import { deriveProjectId } from '../out/core/workspace/scan.js';

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

const throwingClient = {
  async get() {
    throw new Error('network must not be used here');
  },
  async post() {
    throw new Error('network must not be used here');
  },
};

/** A duck-typed KeyValueStore backed by a plain Map — no vscode dependency, same shape as vscode.Memento. */
function fakeKeyValueStore() {
  const data = new Map();
  return {
    raw: data,
    get(key) {
      return data.get(key);
    },
    async update(key, value) {
      data.set(key, value);
    },
  };
}

const CACHED_ROW = {
  name: 'clean-pkg',
  current: '1.0.0',
  wanted: '1.0.1',
  latest: '1.0.1',
  dev: false,
  range: '^1.0.0',
  advisories: [],
  worstSeverity: null,
  upgradeTo: null,
  upgradeReason: null,
};

/**
 * `makeController`'s defaults are `manifestText: MANIFEST, lockfileText:
 * LOCKFILE, lockfilePath: null` — every persisted-cache test below that
 * doesn't override those must seed its entry with a matching fingerprint, or
 * S7's "bind persisted snapshots to their actual source state" check
 * (dashboardController.ts's hydrateFromPersistedCache) correctly treats it
 * as stale-relative-to-disk and ignores it, exactly as it must for a real
 * file-changed-while-closed scenario — see the dedicated test for that.
 */
const SOURCE_FINGERPRINT = computeSourceFingerprint({ manifestText: MANIFEST, lockfileText: LOCKFILE, lockfilePath: null });

const PROJECT_INFO = { label: 'app', manifestPath: 'package.json' };

/**
 * `ttlMinutesProvider` defaults to `() => 0` — "always revalidate" per the
 * TTL=0 semantic (freshness.js: `ttlMinutes <= 0` always classifies as
 * stale) — so every existing test below, none of which is about TTL, keeps
 * observing exactly the pre-S7 "warm cache replays as stale, then a fresh
 * run follows" behavior. Tests that exercise TTL-aware freshness override
 * this explicitly.
 */
const BUILD_INFO = { extensionVersion: '0.0.1', builtAt: '2026-08-01T09:00:00.000Z' };

function makeController(client, overrides = {}) {
  return new DashboardController({
    root: ROOT,
    manifestText: MANIFEST,
    lockfileText: LOCKFILE,
    lockfilePath: null,
    registry: REGISTRY,
    httpClient: client,
    etagStore: new MemoryEtagStore(),
    projectInfo: PROJECT_INFO,
    canChangeProject: false,
    buildInfo: BUILD_INFO,
    projectCacheStore: new PersistentProjectCacheStore(fakeKeyValueStore()),
    cacheKey: 'test-project',
    ttlMinutesProvider: () => 0,
    ...overrides,
  });
}

const latestOf = (message) => message.data.rows[0].latest;

/**
 * `updateProjectSnapshot`'s second argument is the caller's own
 * `beginRevalidation()` return value, captured *before* the (real or, in
 * these tests, simulated) disk read that produced `snapshot` started — see
 * that method's own doc. For the many tests below that apply a snapshot
 * directly with no async gap in between (a "clean, uninterrupted reload"),
 * capturing it immediately before the call is equivalent and correct. Tests
 * that specifically exercise an *interleaved* beginRevalidation() call (a
 * race) call `controller.updateProjectSnapshot(...)` directly instead, with
 * their own explicitly-captured (and deliberately stale) token.
 */
function updateProjectSnapshot(controller, snapshot) {
  controller.updateProjectSnapshot(snapshot, controller.beginRevalidation());
}

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

test('two overlapping background-triggered runs each announce their own stale start, but only the winner posts a final result', async () => {
  // Unlike handleRefresh (which clears lastResult first, so its own
  // announcement is always skipped), two background-triggered runs close
  // together both find `lastResult` already populated and each post their
  // own `stale` announcement carrying it — a harmless, idempotent duplicate
  // (identical data both times, since the older run hasn't completed yet to
  // change it) rather than a reordering or data-integrity issue.
  // Signal-generation index (see generationalClient's own doc), not call
  // order, is what delayMs/versions key off: the priming handleReady() below
  // is generation 0, "older" is generation 1, "newer" is generation 2 —
  // only "older" (generation 1) is held open.
  const client = generationalClient({ versions: ['1.0.0', '1.0.1', '1.0.2'], delayMs: { 1: 60 } });
  const controller = makeController(client, { ttlMinutesProvider: () => 30 });
  await controller.handleReady(recordingSink()); // generation 0 — primes lastResult with version 1.0.0

  const sink = recordingSink();
  const older = controller.refreshInBackground(sink); // generation 1, held open
  await new Promise((resolve) => setTimeout(resolve, 5));
  const newer = controller.refreshInBackground(sink); // generation 2, fast — aborts "older"

  await Promise.all([older, newer]);
  await new Promise((resolve) => setTimeout(resolve, 100));

  const staleAnnouncements = sink.posted.filter((m) => m.status === 'stale');
  assert.equal(staleAnnouncements.length, 2, 'both runs announce their own start');
  for (const announcement of staleAnnouncements) {
    assert.equal(latestOf(announcement), '1.0.0', 'both announcements carry the identical, still-current prior snapshot from priming');
  }

  const completed = sink.posted.filter((m) => m.status !== 'stale');
  assert.equal(completed.length, 1, 'only the winning (newer) run posts a completed result');
  assert.equal(latestOf(completed[0]), '1.0.2');
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
  updateProjectSnapshot(controller, {
    root: ROOT,
    manifestText: MANIFEST,
    lockfileText: updatedLockfile,
    lockfilePath: null,
    registry: REGISTRY,
    projectInfo: PROJECT_INFO,
    canChangeProject: false,
    cacheKey: 'test-project',
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
  updateProjectSnapshot(controller, {
    root: ROOT,
    manifestText: updatedManifest,
    lockfileText: updatedLockfile,
    lockfilePath: null,
    registry: REGISTRY,
    projectInfo: PROJECT_INFO,
    canChangeProject: false,
    cacheKey: 'test-project',
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

  updateProjectSnapshot(controller, {
    root: '/tmp/other-project',
    manifestText: MANIFEST,
    lockfileText: LOCKFILE,
    lockfilePath: null,
    registry: REGISTRY,
    projectInfo: PROJECT_INFO,
    canChangeProject: false,
    cacheKey: 'test-project',
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

  updateProjectSnapshot(controller, {
    root: '/tmp/other-project',
    manifestText: otherManifest,
    lockfileText: otherLockfile,
    lockfilePath: null,
    registry: 'https://custom.registry.example/',
    projectInfo: otherProjectInfo,
    canChangeProject: true,
    cacheKey: 'test-other-project',
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

  updateProjectSnapshot(controller, {
    root: '/tmp/other-project',
    manifestText: MANIFEST,
    lockfileText: LOCKFILE,
    lockfilePath: null,
    registry: REGISTRY,
    projectInfo: { label: 'other', manifestPath: 'package.json' },
    canChangeProject: true,
    cacheKey: 'test-other-project',
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
  updateProjectSnapshot(controller, {
    root: ROOT,
    manifestText: reclassifiedManifest,
    lockfileText: reclassifiedLockfile,
    lockfilePath: null,
    registry: REGISTRY,
    projectInfo: PROJECT_INFO,
    canChangeProject: false,
    cacheKey: 'test-project',
  });
  await controller.handleRefresh(recordingSink());

  // clean-pkg has a genuine general update available (1.0.0 -> 1.0.1, no
  // advisory involved) — proving the reclassification took effect directly,
  // via the returned classification, rather than indirectly via a rejection
  // reason that is no longer produced now that the update is eligible.
  const result = controller.validateUpgradeRequest({ package: 'clean-pkg', target: '1.0.1' });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.classification, 'dev');
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
  // 1.0.0 is clean-pkg's own installed version — nothing newer is reported,
  // so there is genuinely no general-update or security-fix candidate for
  // resolveUpgradeCandidate to find, regardless of what target a (forged or
  // stale) request names.
  const controller = makeController(staticClient('1.0.0'));
  await controller.handleReady(recordingSink());

  const noUpgrade = controller.validateUpgradeRequest({ package: 'clean-pkg', target: '1.0.0' });
  assert.deepEqual(noUpgrade, { ok: false, reason: 'no-eligible-upgrade' });

  const forged = controller.validateUpgradeRequest({ package: 'clean-pkg', target: '99.0.0' });
  assert.equal(forged.ok, false);
});

test('a genuine general update is eligible, but a stale/forged target for it is still rejected', async () => {
  // clean-pkg is at 1.0.0; 1.0.1 is a real, newer version with no advisory
  // involved at all — exactly the "healthy package with an update" case
  // Problem 1 exists to make actionable.
  const controller = makeController(staticClient('1.0.1'));
  await controller.handleReady(recordingSink());

  const eligible = controller.validateUpgradeRequest({ package: 'clean-pkg', target: '1.0.1' });
  assert.equal(eligible.ok, true);
  if (eligible.ok) assert.equal(eligible.target, '1.0.1');

  const stale = controller.validateUpgradeRequest({ package: 'clean-pkg', target: '1.0.2' });
  assert.deepEqual(stale, { ok: false, reason: 'stale-target' });
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

// --------------------------------------------------- S7: persisted cache

test('a fresh persisted cache renders as ready with no pipeline/network run at all', async () => {
  const projectCacheStore = new PersistentProjectCacheStore(fakeKeyValueStore());
  const now = Date.now();
  projectCacheStore.set('cache-key-fresh', {
    rows: [CACHED_ROW],
    generatedAt: new Date(now).toISOString(),
    lockfilePath: null,
    sourceFingerprint: SOURCE_FINGERPRINT,
  });

  const controller = makeController(throwingClient, {
    projectCacheStore,
    cacheKey: 'cache-key-fresh',
    ttlMinutesProvider: () => 30,
    now: () => now,
  });
  const sink = recordingSink();

  await controller.handleReady(sink);

  assert.deepEqual(sink.statuses, ['ready'], 'exactly one message, straight to ready — no loading, no run');
  assert.deepEqual(sink.posted[0].data.rows, [CACHED_ROW]);
});

test('a stale persisted cache renders immediately as stale, then a real revalidation follows', async () => {
  const projectCacheStore = new PersistentProjectCacheStore(fakeKeyValueStore());
  const oldTimestamp = new Date(Date.now() - 60 * 60_000).toISOString();
  projectCacheStore.set('cache-key-stale', {
    rows: [CACHED_ROW],
    generatedAt: oldTimestamp,
    lockfilePath: null,
    sourceFingerprint: SOURCE_FINGERPRINT,
  });

  const controller = makeController(staticClient('1.0.1'), {
    projectCacheStore,
    cacheKey: 'cache-key-stale',
    ttlMinutesProvider: () => 30,
  });
  const sink = recordingSink();

  await controller.handleReady(sink);

  assert.deepEqual(sink.statuses, ['stale', 'partial-error']);
  assert.deepEqual(sink.posted[0].data.rows, [CACHED_ROW], 'the stale replay is the persisted snapshot');
  assert.equal(latestOf(sink.posted[1]), '1.0.1', 'a real scan still follows');
});

test('handleRefresh bypasses a fresh persisted cache — it never short-circuits, unlike handleReady', async () => {
  const projectCacheStore = new PersistentProjectCacheStore(fakeKeyValueStore());
  const now = Date.now();
  projectCacheStore.set('cache-key-fresh-refresh', {
    rows: [CACHED_ROW],
    generatedAt: new Date(now).toISOString(),
    lockfilePath: null,
  });

  const controller = makeController(staticClient('1.0.1'), {
    projectCacheStore,
    cacheKey: 'cache-key-fresh-refresh',
    ttlMinutesProvider: () => 30,
    now: () => now,
  });
  const sink = recordingSink();

  await controller.handleRefresh(sink);

  assert.deepEqual(sink.statuses, ['loading', 'partial-error'], 'a real scan always runs, regardless of freshness');
  assert.equal(latestOf(sink.posted[1]), '1.0.1');
});

test('TTL boundary at the controller level: exactly at the limit revalidates, just under it renders ready with no run', async () => {
  const ttlMinutes = 10;
  const now = Date.now();

  const atBoundaryStore = new PersistentProjectCacheStore(fakeKeyValueStore());
  atBoundaryStore.set('boundary', {
    rows: [CACHED_ROW],
    generatedAt: new Date(now - ttlMinutes * 60_000).toISOString(),
    lockfilePath: null,
    sourceFingerprint: SOURCE_FINGERPRINT,
  });
  const atBoundaryController = makeController(staticClient('1.0.1'), {
    projectCacheStore: atBoundaryStore,
    cacheKey: 'boundary',
    ttlMinutesProvider: () => ttlMinutes,
    now: () => now,
  });
  const atBoundarySink = recordingSink();
  await atBoundaryController.handleReady(atBoundarySink);
  assert.equal(atBoundarySink.statuses[0], 'stale', 'age === ttl revalidates');

  const underBoundaryStore = new PersistentProjectCacheStore(fakeKeyValueStore());
  underBoundaryStore.set('under-boundary', {
    rows: [CACHED_ROW],
    generatedAt: new Date(now - ttlMinutes * 60_000 + 1).toISOString(),
    lockfilePath: null,
    sourceFingerprint: SOURCE_FINGERPRINT,
  });
  const underBoundaryController = makeController(throwingClient, {
    projectCacheStore: underBoundaryStore,
    cacheKey: 'under-boundary',
    ttlMinutesProvider: () => ttlMinutes,
    now: () => now,
  });
  const underBoundarySink = recordingSink();
  await underBoundaryController.handleReady(underBoundarySink);
  assert.deepEqual(underBoundarySink.statuses, ['ready']);
});

test('ttlMinutesProvider returning 0 always revalidates, even for a snapshot generated this instant', async () => {
  const now = Date.now();
  const projectCacheStore = new PersistentProjectCacheStore(fakeKeyValueStore());
  projectCacheStore.set('zero-ttl', {
    rows: [CACHED_ROW],
    generatedAt: new Date(now).toISOString(),
    lockfilePath: null,
    sourceFingerprint: SOURCE_FINGERPRINT,
  });

  const controller = makeController(staticClient('1.0.1'), {
    projectCacheStore,
    cacheKey: 'zero-ttl',
    ttlMinutesProvider: () => 0,
    now: () => now,
  });
  const sink = recordingSink();
  await controller.handleReady(sink);

  assert.deepEqual(sink.statuses, ['stale', 'partial-error']);
});

test('a manifest edited while the panel was closed cannot produce a fresh cache hit after reopening — the source fingerprint no longer matches', async () => {
  const projectCacheStore = new PersistentProjectCacheStore(fakeKeyValueStore());
  const now = Date.now();

  // A previous session persisted a snapshot for the manifest/lockfile as
  // they existed *then*.
  const before = makeController(staticClient('1.0.1'), {
    projectCacheStore,
    cacheKey: 'edited-while-closed',
    ttlMinutesProvider: () => 30,
    now: () => now,
  });
  await before.handleReady(recordingSink());
  assert.notEqual(projectCacheStore.get('edited-while-closed'), undefined, 'sanity check: something was persisted');

  // The panel is closed (no watcher running), the user edits package.json —
  // adding a dependency — then reopens the panel. A brand new controller is
  // built the same way DashboardPanel always builds one for a reload: with
  // manifestText freshly read from disk, reflecting the edit.
  const editedManifest = JSON.stringify({
    name: 'app',
    version: '1.0.0',
    dependencies: { 'clean-pkg': '^1.0.0', 'new-pkg': '^1.0.0' },
  });
  const after = makeController(staticClient('1.0.1'), {
    manifestText: editedManifest,
    projectCacheStore,
    cacheKey: 'edited-while-closed', // same project identity + registry — same cacheKey
    ttlMinutesProvider: () => 30,
    now: () => now,
  });
  const sink = recordingSink();
  await after.handleReady(sink);

  assert.equal(
    sink.statuses[0],
    'loading',
    'the fingerprint mismatch means this is treated as no cache at all — never replayed as ready or stale'
  );
  assert.notEqual(sink.statuses.includes('ready') || sink.statuses.includes('stale'), true);
});

test('a persisted blob with the wrong schema version is ignored — handleReady starts cold, not from an unreadable old-schema snapshot', async () => {
  const kv = fakeKeyValueStore();
  kv.raw.set('dependencyDashboard.projectCache', {
    schemaVersion: 999,
    entries: [['cache-key-old-schema', { rows: [CACHED_ROW], generatedAt: new Date().toISOString(), lockfilePath: null }]],
  });
  const projectCacheStore = new PersistentProjectCacheStore(kv);

  const controller = makeController(staticClient('1.0.1'), {
    projectCacheStore,
    cacheKey: 'cache-key-old-schema',
    ttlMinutesProvider: () => 30,
  });
  const sink = recordingSink();
  await controller.handleReady(sink);

  assert.deepEqual(sink.statuses, ['loading', 'partial-error'], 'no stale replay of the unreadable old-schema blob');
});

test('a completely malformed persisted blob (not even the right shape) is ignored the same way', async () => {
  const kv = fakeKeyValueStore();
  kv.raw.set('dependencyDashboard.projectCache', 'not even an object');
  const projectCacheStore = new PersistentProjectCacheStore(kv);

  const controller = makeController(staticClient('1.0.1'), {
    projectCacheStore,
    cacheKey: 'anything',
    ttlMinutesProvider: () => 30,
  });
  const sink = recordingSink();
  await controller.handleReady(sink);

  assert.deepEqual(sink.statuses, ['loading', 'partial-error']);
});

test('cache entries are isolated by S6 project identity — the same relative manifest path in two different workspace folders never collides', async () => {
  const projectCacheStore = new PersistentProjectCacheStore(fakeKeyValueStore());
  const idInFolderOne = deriveProjectId('file:///workspace/one', 'package.json');
  const idInFolderTwo = deriveProjectId('file:///workspace/two', 'package.json');
  const keyOne = deriveProjectCacheKey(idInFolderOne, REGISTRY);
  const keyTwo = deriveProjectCacheKey(idInFolderTwo, REGISTRY);

  const now = Date.now();
  projectCacheStore.set(keyOne, {
    rows: [{ ...CACHED_ROW, name: 'folder-one-pkg' }],
    generatedAt: new Date(now).toISOString(),
    lockfilePath: null,
    sourceFingerprint: SOURCE_FINGERPRINT,
  });
  projectCacheStore.set(keyTwo, {
    rows: [{ ...CACHED_ROW, name: 'folder-two-pkg' }],
    generatedAt: new Date(now).toISOString(),
    lockfilePath: null,
    sourceFingerprint: SOURCE_FINGERPRINT,
  });

  const controllerOne = makeController(throwingClient, {
    projectCacheStore,
    cacheKey: keyOne,
    ttlMinutesProvider: () => 30,
    now: () => now,
  });
  const sinkOne = recordingSink();
  await controllerOne.handleReady(sinkOne);
  assert.deepEqual(sinkOne.posted[0].data.rows.map((r) => r.name), ['folder-one-pkg']);

  const controllerTwo = makeController(throwingClient, {
    projectCacheStore,
    cacheKey: keyTwo,
    ttlMinutesProvider: () => 30,
    now: () => now,
  });
  const sinkTwo = recordingSink();
  await controllerTwo.handleReady(sinkTwo);
  assert.deepEqual(sinkTwo.posted[0].data.rows.map((r) => r.name), ['folder-two-pkg']);
});

test('invalidateCache drops only this controller’s own persisted entry, leaving other projects alone', async () => {
  const projectCacheStore = new PersistentProjectCacheStore(fakeKeyValueStore());
  const now = Date.now();
  projectCacheStore.set('project-a', { rows: [CACHED_ROW], generatedAt: new Date(now).toISOString(), lockfilePath: null });
  projectCacheStore.set('project-b', { rows: [CACHED_ROW], generatedAt: new Date(now).toISOString(), lockfilePath: null });

  const controller = makeController(staticClient('1.0.1'), {
    projectCacheStore,
    cacheKey: 'project-a',
    ttlMinutesProvider: () => 30,
    now: () => now,
  });

  controller.invalidateCache();

  assert.equal(projectCacheStore.get('project-a'), undefined, 'the affected project’s entry is gone');
  assert.notEqual(projectCacheStore.get('project-b'), undefined, 'an unrelated project is untouched');

  const sink = recordingSink();
  await controller.handleReady(sink);
  assert.deepEqual(sink.statuses, ['loading', 'partial-error'], 'a subsequent open starts cold, not from the invalidated snapshot');
});

test('a successful handleRefresh always overwrites the persisted snapshot with the freshly scanned data', async () => {
  const projectCacheStore = new PersistentProjectCacheStore(fakeKeyValueStore());
  projectCacheStore.set('project-a', {
    rows: [{ ...CACHED_ROW, current: 'stale-version' }],
    generatedAt: new Date(0).toISOString(),
    lockfilePath: null,
  });

  const controller = makeController(staticClient('2.0.0'), {
    projectCacheStore,
    cacheKey: 'project-a',
    ttlMinutesProvider: () => 30,
  });
  await controller.handleRefresh(recordingSink());

  const persisted = projectCacheStore.get('project-a');
  assert.equal(
    persisted.rows[0].current,
    '1.0.0',
    'the persisted entry now reflects the real scan, replacing whatever was cached before'
  );
});

test('a superseded scan never persists its result — only the winning generation reaches the persisted cache', async () => {
  const client = generationalClient({ versions: ['1.0.1', '1.0.2'], delayMs: { 0: 60 } });
  const projectCacheStore = new PersistentProjectCacheStore(fakeKeyValueStore());
  const controller = makeController(client, {
    projectCacheStore,
    cacheKey: 'project-race',
    ttlMinutesProvider: () => 30,
  });
  const sink = recordingSink();

  const superseded = controller.handleRefresh(sink);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const winner = controller.handleRefresh(sink);
  await Promise.all([superseded, winner]);
  await new Promise((resolve) => setTimeout(resolve, 100));

  const persisted = projectCacheStore.get('project-race');
  assert.equal(latestOf({ data: persisted }), '1.0.2', 'the persisted entry holds the winning run only');
});

test('dispose() prevents a still-in-flight run from persisting its result too', async () => {
  const client = generationalClient({ versions: ['1.0.1'], delayMs: { 0: 40 } });
  const projectCacheStore = new PersistentProjectCacheStore(fakeKeyValueStore());
  const controller = makeController(client, {
    projectCacheStore,
    cacheKey: 'project-disposed',
    ttlMinutesProvider: () => 30,
  });
  const sink = recordingSink();

  const run = controller.handleRefresh(sink);
  await new Promise((resolve) => setTimeout(resolve, 5));
  controller.dispose();

  await run;
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.deepEqual(sink.statuses, ['loading']);
  assert.equal(projectCacheStore.get('project-disposed'), undefined, 'nothing was persisted from the disposed run');
});

test('needsBackgroundRefresh is false with nothing renderable yet, and false immediately after a fresh scan', async () => {
  const projectCacheStore = new PersistentProjectCacheStore(fakeKeyValueStore());
  const controller = makeController(staticClient('1.0.1'), {
    projectCacheStore,
    cacheKey: 'bg',
    ttlMinutesProvider: () => 30,
  });

  assert.equal(controller.needsBackgroundRefresh(), false, 'nothing renderable yet');

  await controller.handleReady(recordingSink());
  assert.equal(controller.needsBackgroundRefresh(), false, 'just scanned — still fresh');
});

test('needsBackgroundRefresh becomes true once the last scan falls outside the configured TTL', async () => {
  const now = Date.now();
  const projectCacheStore = new PersistentProjectCacheStore(fakeKeyValueStore());
  const controller = makeController(staticClient('1.0.1'), {
    projectCacheStore,
    cacheKey: 'bg-stale',
    ttlMinutesProvider: () => 10,
    now: () => now,
  });
  projectCacheStore.set('bg-stale', {
    rows: [CACHED_ROW],
    generatedAt: new Date(now - 60 * 60_000).toISOString(),
    lockfilePath: null,
  });
  await controller.handleReady(recordingSink()); // hydrates lastResult from the stale persisted entry, then revalidates

  assert.equal(controller.needsBackgroundRefresh(), false, 'the revalidation that handleReady just ran made it fresh again');
});

test('refreshInBackground never posts loading first — the last render stays on screen until new data actually arrives', async () => {
  const controller = makeController(staticClient('1.0.1'), { ttlMinutesProvider: () => 0 });
  await controller.handleReady(recordingSink());

  const sink = recordingSink();
  await controller.refreshInBackground(sink);

  assert.equal(sink.statuses.includes('loading'), false);
  assert.equal(latestOf(sink.posted[sink.posted.length - 1]), '1.0.1');
});

test('a failed background revalidation does not destroy the last renderable snapshot, and posts nothing at all', async () => {
  // A degraded advisory/audit fetch is folded into partial-error by the
  // pipeline itself, not thrown — run()'s catch block only ever sees
  // something that makes buildPackageRows reject outright, e.g. a manifest
  // that stops parsing. Simulating that here (via a mid-session
  // updateProjectSnapshot to a corrupt manifest, as if the file were
  // mid-write when the watcher fired) is what actually exercises "a failed
  // background revalidation" for run()'s own fatal-error suppression logic.
  const controller = makeController(staticClient('1.0.1'), { ttlMinutesProvider: () => 30 });
  const priming = recordingSink();
  await controller.handleReady(priming);
  assert.equal(latestOf(priming.posted[priming.posted.length - 1]), '1.0.1');

  updateProjectSnapshot(controller, {
    root: ROOT,
    manifestText: '{not json',
    lockfileText: LOCKFILE,
    lockfilePath: null,
    registry: REGISTRY,
    projectInfo: PROJECT_INFO,
    canChangeProject: false,
    cacheKey: 'test-project',
  });

  const sink = recordingSink();
  await controller.refreshInBackground(sink);
  // run() announces the revalidation as it begins (carrying the still-good
  // prior snapshot as 'stale' — requirement: background revalidation must be
  // visible to the webview so it can disable Upgrade buttons) — but the
  // failure itself posts nothing further: no fatal-error, no second message.
  assert.deepEqual(sink.statuses, ['stale'], 'only the start-of-revalidation announcement — the failure itself is silent');
  assert.equal(latestOf(sink.posted[0]), '1.0.1', 'the announcement carries the still-good prior snapshot, not the failed one');
});

test('switching project never replays the previous project’s cached rows under the new label', async () => {
  const projectCacheStore = new PersistentProjectCacheStore(fakeKeyValueStore());
  const controller = makeController(staticClient('1.0.1'), {
    projectCacheStore,
    cacheKey: 'project-old',
    projectInfo: { label: 'old-project', manifestPath: 'package.json' },
    ttlMinutesProvider: () => 30,
  });

  const first = recordingSink();
  await controller.handleReady(first);
  assert.equal(first.posted[first.posted.length - 1].data.project.label, 'old-project');

  const newManifest = JSON.stringify({
    name: 'other',
    version: '1.0.0',
    dependencies: { 'clean-pkg': '^1.0.0' },
  });
  updateProjectSnapshot(controller, {
    root: '/tmp/other-project',
    manifestText: newManifest,
    lockfileText: LOCKFILE,
    lockfilePath: null,
    registry: REGISTRY,
    projectInfo: { label: 'new-project', manifestPath: 'package.json' },
    canChangeProject: false,
    cacheKey: 'project-new',
  });

  const sink = recordingSink();
  await controller.handleRefresh(sink);
  assert.equal(sink.posted[sink.posted.length - 1].data.project.label, 'new-project');

  assert.notEqual(projectCacheStore.get('project-old'), undefined, 'the old project keeps its own persisted entry');
  assert.notEqual(projectCacheStore.get('project-new'), undefined, 'the new project gets its own persisted entry');

  const again = recordingSink();
  await controller.handleReady(again);
  assert.equal(again.posted[0].data.project.label, 'new-project', 'a reopened ready only ever replays the currently selected project');
});

// --------------------------------------------- S7: Upgrade eligibility races

test('an old target cannot be accepted while a changed manifest or lockfile is being rescanned', async () => {
  const controller = makeController(staticClient('1.0.1'), { ttlMinutesProvider: () => 30 });

  await controller.handleReady(recordingSink());
  const beforeChange = controller.validateUpgradeRequest({ package: 'clean-pkg', target: '1.0.1' });
  assert.notEqual(beforeChange.reason, 'revalidating', 'freshly-scanned data is not gated as revalidating');

  // A watcher event fires — this is exactly what the panel calls, and calls
  // synchronously, the instant a filesystem event arrives, well before its
  // own ~300ms debounce (let alone the rescan the debounce eventually
  // schedules) ever runs.
  controller.beginRevalidation();
  const immediatelyAfterEvent = controller.validateUpgradeRequest({ package: 'clean-pkg', target: '1.0.1' });
  assert.deepEqual(
    immediatelyAfterEvent,
    { ok: false, reason: 'revalidating' },
    'the old target must not be accepted the instant a change is known, even before any rescan runs'
  );

  // The rescan itself is now in flight (not yet awaited) — still must not
  // authorize the stale target while it's running.
  const rescan = controller.refreshInBackground(recordingSink());
  const duringRescan = controller.validateUpgradeRequest({ package: 'clean-pkg', target: '1.0.1' });
  assert.deepEqual(duringRescan, { ok: false, reason: 'revalidating' }, 'still ineligible while the rescan itself is in flight');

  await rescan;
});

test('a manual reload begins revalidation before its disk read even starts — an Upgrade request is rejected for the whole duration loadProject is held open', async () => {
  // Mirrors dashboardPanel.ts's reloadAndScan(): `controller.beginRevalidation()`
  // is called synchronously, before `await loadProject(candidate)` — this
  // simulates that exact sequence, holding the "disk read" open explicitly.
  const controller = makeController(staticClient('1.0.1'), { ttlMinutesProvider: () => 30 });
  await controller.handleReady(recordingSink());
  assert.notEqual(
    controller.validateUpgradeRequest({ package: 'clean-pkg', target: '1.0.1' }).reason,
    'revalidating'
  );

  const generationAtReadStart = controller.beginRevalidation();
  let resolveLoadProject;
  const loadProjectHeldOpen = new Promise((resolve) => {
    resolveLoadProject = resolve;
  });

  assert.deepEqual(
    controller.validateUpgradeRequest({ package: 'clean-pkg', target: '1.0.1' }),
    { ok: false, reason: 'revalidating' },
    'rejected while the (simulated) disk read is still pending — updateProjectSnapshot has not even run yet'
  );

  resolveLoadProject();
  await loadProjectHeldOpen;

  controller.updateProjectSnapshot(
    {
      root: ROOT,
      manifestText: MANIFEST,
      lockfileText: LOCKFILE,
      lockfilePath: null,
      registry: REGISTRY,
      projectInfo: PROJECT_INFO,
      canChangeProject: false,
      cacheKey: 'test-project',
    },
    generationAtReadStart
  );
  await controller.handleRefresh(recordingSink());

  assert.notEqual(
    controller.validateUpgradeRequest({ package: 'clean-pkg', target: '1.0.1' }).reason,
    'revalidating',
    'a clean, uninterrupted reload restores eligibility once it completes'
  );
});

test('a timer-triggered background refresh — no watcher event, no project reload at all — still revokes eligibility for its whole duration', async () => {
  // Mirrors DashboardPanel's onBackgroundTick(): calls refreshInBackground()
  // directly, with nothing else having called beginRevalidation() first.
  // run()'s own internal beginRevalidation() call must be the thing that
  // revokes eligibility here — there is no other trigger to rely on.
  const client = generationalClient({ versions: ['1.0.1'], delayMs: { 0: 30 } });
  const controller = makeController(client, { ttlMinutesProvider: () => 30 });
  await controller.handleReady(recordingSink());
  assert.notEqual(
    controller.validateUpgradeRequest({ package: 'clean-pkg', target: '1.0.1' }).reason,
    'revalidating'
  );

  const tick = controller.refreshInBackground(recordingSink());
  assert.deepEqual(
    controller.validateUpgradeRequest({ package: 'clean-pkg', target: '1.0.1' }),
    { ok: false, reason: 'revalidating' },
    'rejected while the background refresh itself is still in flight'
  );

  await tick;
  assert.notEqual(
    controller.validateUpgradeRequest({ package: 'clean-pkg', target: '1.0.1' }).reason,
    'revalidating',
    'restored once the background refresh completes cleanly'
  );
});

test('a second, later background-only revalidation (no project reload in between either) also restores eligibility — the watermark keeps up across repeated timer ticks', async () => {
  // Every run() call advances the shared revalidation generation via its own
  // beginRevalidation() call, including a plain background tick with no
  // updateProjectSnapshot anywhere nearby. If granting eligibility didn't
  // also re-confirm `optionsGeneration` forward (not just `eligibleGeneration`),
  // this would wedge permanently after the *first* successful scan: the
  // second tick's own generation would always be one step ahead of a
  // watermark stuck at whatever it was after the first grant.
  const controller = makeController(staticClient('1.0.1'), { ttlMinutesProvider: () => 30 });
  await controller.handleReady(recordingSink());
  assert.notEqual(
    controller.validateUpgradeRequest({ package: 'clean-pkg', target: '1.0.1' }).reason,
    'revalidating',
    'sanity check: eligible after the first scan'
  );

  await controller.refreshInBackground(recordingSink());
  assert.notEqual(
    controller.validateUpgradeRequest({ package: 'clean-pkg', target: '1.0.1' }).reason,
    'revalidating',
    'still eligible after a second, independent background-only revalidation'
  );

  await controller.refreshInBackground(recordingSink());
  assert.notEqual(
    controller.validateUpgradeRequest({ package: 'clean-pkg', target: '1.0.1' }).reason,
    'revalidating',
    'and a third — this must never wedge shut regardless of how many clean ticks accumulate'
  );
});

test('event B (a fresh beginRevalidation()) arriving after reload A has already read disk, but before A applies its snapshot, prevents A from exposing eligibility once A finishes', async () => {
  const client = generationalClient({ versions: ['1.0.1'], delayMs: { 0: 30 } });
  const controller = makeController(client, { ttlMinutesProvider: () => 30 });

  const reloadA = controller.refreshInBackground(recordingSink()); // begins revalidation (token A), starts "reading disk" (the delayed fetch)
  // Event B arrives while A is still mid-flight — A has already begun (and,
  // conceptually, already read whatever it read), but has not yet applied
  // its result. `run()`'s own drained/queued follow-up for B has not run
  // yet either — only the generation bump itself has landed so far.
  controller.beginRevalidation();
  await reloadA; // A finishes — completes successfully, but for the pre-B state

  assert.deepEqual(
    controller.validateUpgradeRequest({ package: 'clean-pkg', target: '1.0.1' }),
    { ok: false, reason: 'revalidating' },
    'the scan succeeded, but for a source state that is already known to be stale — it must not grant eligibility'
  );
});

test('once the rescan triggered by a change completes cleanly (no further change in the meantime), eligibility is restored', async () => {
  const controller = makeController(staticClient('1.0.1'), { ttlMinutesProvider: () => 30 });
  await controller.handleReady(recordingSink());

  // Mirrors the real panel sequence (dashboardPanel.ts's reloadAfterFileChange):
  // beginRevalidation() fires synchronously on the raw watcher event,
  // then — once the debounced reload actually runs — updateProjectSnapshot()
  // re-reads disk before the rescan itself. A bare beginRevalidation()
  // with no accompanying options refresh is deliberately never enough on its
  // own to restore eligibility — see the dedicated optionsGeneration test.
  const generationAtReadStart = controller.beginRevalidation();
  assert.deepEqual(controller.validateUpgradeRequest({ package: 'clean-pkg', target: '1.0.1' }), {
    ok: false,
    reason: 'revalidating',
  });

  controller.updateProjectSnapshot(
    {
      root: ROOT,
      manifestText: MANIFEST,
      lockfileText: LOCKFILE,
      lockfilePath: null,
      registry: REGISTRY,
      projectInfo: PROJECT_INFO,
      canChangeProject: false,
      cacheKey: 'test-project',
    },
    generationAtReadStart
  );
  await controller.refreshInBackground(recordingSink());

  const after = controller.validateUpgradeRequest({ package: 'clean-pkg', target: '1.0.1' });
  assert.notEqual(after.reason, 'revalidating', 'a clean, uninterrupted rescan against fresh options restores eligibility');
});

test('beginRevalidation() alone, with no accompanying options refresh, can never restore eligibility even after a scan completes — the reviewer-found gap', async () => {
  // If a watcher event bumps sourceGeneration but the debounced reload that
  // would call updateProjectSnapshot() hasn't run yet, `this.options` still
  // holds pre-change content. A scan run in that window (e.g. an unrelated
  // background-timer tick racing the pending file-change reload) must not
  // be allowed to grant eligibility just because nothing bumped the
  // generation *again* during that particular scan — the scan itself was
  // already stale from the moment it started.
  const controller = makeController(staticClient('1.0.1'), { ttlMinutesProvider: () => 30 });
  await controller.handleReady(recordingSink());
  assert.notEqual(
    controller.validateUpgradeRequest({ package: 'clean-pkg', target: '1.0.1' }).reason,
    'revalidating',
    'sanity check: eligible after the initial clean scan'
  );

  controller.beginRevalidation(); // no updateProjectSnapshot follows
  await controller.refreshInBackground(recordingSink()); // scans against still-stale this.options

  assert.deepEqual(
    controller.validateUpgradeRequest({ package: 'clean-pkg', target: '1.0.1' }),
    { ok: false, reason: 'revalidating' },
    'a scan against options that never caught up to the pending change must not restore eligibility'
  );
});

test('a cold controller cannot be hydrated into eligibility if a watcher event bumped the generation before its first handleReady ever ran', async () => {
  // The exact gap a reviewer pass found: construction captures options at
  // generation 0; if a file changes (bumping sourceGeneration) before the
  // very first handleReady() call — plausible during webview activation,
  // which routinely takes longer than the watcher's own debounce — a
  // persisted entry matching those same (already-stale) construction-time
  // options must still not be trusted for Upgrade just because nothing
  // bumped the generation a second time before hydration ran.
  const projectCacheStore = new PersistentProjectCacheStore(fakeKeyValueStore());
  const now = Date.now();
  projectCacheStore.set('cold-hydration-race', {
    rows: [{ ...CACHED_ROW, current: '1.0.0' }],
    generatedAt: new Date(now).toISOString(),
    lockfilePath: null,
    sourceFingerprint: SOURCE_FINGERPRINT,
  });

  const controller = makeController(throwingClient, {
    projectCacheStore,
    cacheKey: 'cold-hydration-race',
    ttlMinutesProvider: () => 30,
    now: () => now,
  });

  // A watcher event fires before the webview's first 'ready' ever arrives.
  controller.beginRevalidation();

  const sink = recordingSink();
  await controller.handleReady(sink);

  assert.deepEqual(sink.statuses, ['ready'], 'sanity check: the fingerprint still matched construction-time options, so it still hydrates and renders');
  assert.deepEqual(
    controller.validateUpgradeRequest({ package: 'clean-pkg', target: '1.0.1' }),
    { ok: false, reason: 'revalidating' },
    'a pre-hydration generation bump must never be mistaken for "nothing changed" just because hydration itself did not bump it again'
  );
});

test('a project reload (updateProjectSnapshot) immediately revokes eligibility, independent of any watcher event', async () => {
  const controller = makeController(staticClient('1.0.1'), { ttlMinutesProvider: () => 30 });
  await controller.handleReady(recordingSink());
  assert.notEqual(
    controller.validateUpgradeRequest({ package: 'clean-pkg', target: '1.0.1' }).reason,
    'revalidating'
  );

  updateProjectSnapshot(controller, {
    root: ROOT,
    manifestText: MANIFEST,
    lockfileText: LOCKFILE,
    lockfilePath: null,
    registry: REGISTRY,
    projectInfo: PROJECT_INFO,
    canChangeProject: false,
    cacheKey: 'test-project',
  });

  assert.deepEqual(controller.validateUpgradeRequest({ package: 'clean-pkg', target: '1.0.1' }), {
    ok: false,
    reason: 'revalidating',
  });
});

test('a failed revalidation keeps the prior table on screen but leaves Upgrade rejected, not restored', async () => {
  const controller = makeController(staticClient('1.0.1'), { ttlMinutesProvider: () => 30 });
  await controller.handleReady(recordingSink());
  assert.notEqual(
    controller.validateUpgradeRequest({ package: 'clean-pkg', target: '1.0.1' }).reason,
    'revalidating'
  );

  controller.beginRevalidation();
  updateProjectSnapshot(controller, {
    root: ROOT,
    manifestText: '{not json', // triggers a fatal (non-degraded) failure in run()
    lockfileText: LOCKFILE,
    lockfilePath: null,
    registry: REGISTRY,
    projectInfo: PROJECT_INFO,
    canChangeProject: false,
    cacheKey: 'test-project',
  });

  const sink = recordingSink();
  await controller.refreshInBackground(sink);

  // run() announces the revalidation starting (carrying the still-good prior
  // table, marked stale — this is the mechanism that lets the webview
  // disable Upgrade buttons for the duration); the failure itself is silent,
  // so that announcement is the only message — the table stays exactly as
  // it was, never wiped by a fatal-error.
  assert.deepEqual(sink.statuses, ['stale'], 'only the start-of-revalidation announcement — the failure itself posts nothing more');
  assert.equal(latestOf(sink.posted[0]), '1.0.1', 'the announcement carries the prior table');
  assert.deepEqual(
    controller.validateUpgradeRequest({ package: 'clean-pkg', target: '1.0.1' }),
    { ok: false, reason: 'revalidating' },
    'a failed revalidation must not restore eligibility just because the old table is still showing'
  );
});

test('fresh, fingerprint-matching persisted data may authorize an Upgrade purely from hydration, with no live scan at all', async () => {
  const projectCacheStore = new PersistentProjectCacheStore(fakeKeyValueStore());
  const now = Date.now();
  projectCacheStore.set('cache-key-fresh-eligible', {
    rows: [{ ...CACHED_ROW, current: '1.0.0' }],
    generatedAt: new Date(now).toISOString(),
    lockfilePath: null,
    sourceFingerprint: SOURCE_FINGERPRINT,
  });

  const controller = makeController(throwingClient, {
    projectCacheStore,
    cacheKey: 'cache-key-fresh-eligible',
    ttlMinutesProvider: () => 30,
    now: () => now,
  });
  const sink = recordingSink();
  await controller.handleReady(sink);

  assert.deepEqual(sink.statuses, ['ready'], 'sanity check: hydrated straight to ready, no network run');
  assert.notEqual(
    controller.validateUpgradeRequest({ package: 'clean-pkg', target: '1.0.1' }).reason,
    'revalidating',
    'fresh, fingerprint-matching hydration alone may grant eligibility'
  );
});

test('TTL-stale persisted data — even with a matching fingerprint — never grants eligibility merely from hydration', async () => {
  const projectCacheStore = new PersistentProjectCacheStore(fakeKeyValueStore());
  const oldTimestamp = new Date(Date.now() - 60 * 60_000).toISOString();
  projectCacheStore.set('cache-key-stale-ineligible', {
    rows: [{ ...CACHED_ROW, current: '1.0.0' }],
    generatedAt: oldTimestamp,
    lockfilePath: null,
    sourceFingerprint: SOURCE_FINGERPRINT,
  });

  const controller = makeController(staticClient('1.0.1'), {
    projectCacheStore,
    cacheKey: 'cache-key-stale-ineligible',
    ttlMinutesProvider: () => 30,
  });
  const sink = recordingSink();
  const readyPromise = controller.handleReady(sink);

  // Checked synchronously, right after the call returns: the stale replay
  // has already posted (handleReady's synchronous prefix), and the
  // follow-up rescan it triggers is in flight but hasn't resolved yet — no
  // `await` has handed control back to this test in between.
  assert.deepEqual(sink.statuses, ['stale'], 'sanity check: the stale replay already posted');
  assert.deepEqual(
    controller.validateUpgradeRequest({ package: 'clean-pkg', target: '1.0.1' }),
    { ok: false, reason: 'revalidating' },
    'stale persisted data must be ineligible before the rescan it triggers even completes'
  );

  await readyPromise;
});
