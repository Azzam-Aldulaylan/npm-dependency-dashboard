/**
 * reloadControllerFromDisk — the actual "re-read from disk and replace a
 * live controller's snapshot" behind a file-watcher-triggered reload.
 *
 * Uses a fake `ReloadSource` (no vscode) but a REAL `DashboardController`,
 * so these tests prove actual snapshot replacement and actual persisted-
 * cache overwrite — not just that some coordination function was called.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DashboardController } from '../out/host/dashboardController.js';
import { MemoryEtagStore } from '../out/core/registry/versions.js';
import { PersistentProjectCacheStore } from '../out/core/cache/projectCacheStore.js';
import { reloadControllerFromDisk } from '../out/host/fileChangeReload.js';

const REGISTRY = 'https://registry.npmjs.org';

const json = (body) => ({ status: 200, headers: {}, body: JSON.stringify(body), wireBytes: JSON.stringify(body).length });

function staticClient(version) {
  return {
    async get(url) {
      if (url !== `${REGISTRY}/clean-pkg/latest`) return { status: 404, headers: {}, body: '', wireBytes: 0 };
      return json({ version });
    },
    async post() {
      return json({});
    },
  };
}

function recordingSink() {
  const posted = [];
  return { posted, get statuses() { return posted.map((m) => m.status); }, postMessage: (m) => posted.push(m) };
}

function fakeKeyValueStore() {
  const data = new Map();
  return { get: (key) => data.get(key), async update(key, value) { data.set(key, value); } };
}

const BEFORE_MANIFEST = JSON.stringify({ name: 'app', version: '1.0.0', dependencies: { 'clean-pkg': '^1.0.0' } });
const BEFORE_LOCKFILE = JSON.stringify({
  name: 'app',
  lockfileVersion: 3,
  packages: {
    '': { name: 'app', version: '1.0.0', dependencies: { 'clean-pkg': '^1.0.0' } },
    'node_modules/clean-pkg': { version: '1.0.0' },
  },
});

// `1.6.0` (the fake registry's answer, below) satisfies both `^1.0.0` and
// `^1.5.0` — staying within the hybrid fetch's fast /latest-only path for
// both scans, rather than needing a full packument fetch this fake client
// doesn't implement. `current` (from the lockfile) still visibly changes
// between scans; `latest` (from the registry) deliberately does not — that
// contrast is what proves the reload re-read disk rather than just re-asking
// the registry.
const AFTER_MANIFEST = JSON.stringify({ name: 'app', version: '1.0.0', dependencies: { 'clean-pkg': '^1.5.0' } });
const AFTER_LOCKFILE = JSON.stringify({
  name: 'app',
  lockfileVersion: 3,
  packages: {
    '': { name: 'app', version: '1.0.0', dependencies: { 'clean-pkg': '^1.5.0' } },
    'node_modules/clean-pkg': { version: '1.5.0' },
  },
});

function makeControllerAndStore(cacheKey) {
  const projectCacheStore = new PersistentProjectCacheStore(fakeKeyValueStore());
  const controller = new DashboardController({
    root: '/tmp/project',
    manifestText: BEFORE_MANIFEST,
    lockfileText: BEFORE_LOCKFILE,
    lockfilePath: '/tmp/project/package-lock.json',
    registry: REGISTRY,
    httpClient: staticClient('1.6.0'),
    etagStore: new MemoryEtagStore(),
    projectInfo: { label: 'app', manifestPath: 'package.json' },
    canChangeProject: false,
    buildInfo: { extensionVersion: '0.0.1', builtAt: '2026-08-01T09:00:00.000Z' },
    projectCacheStore,
    cacheKey,
    ttlMinutesProvider: () => 30,
  });
  return { controller, projectCacheStore };
}

function fakeSource({ afterCalled }) {
  return {
    async loadProject(candidate) {
      afterCalled?.();
      return {
        root: '/tmp/project',
        manifestText: AFTER_MANIFEST,
        lockfileText: AFTER_LOCKFILE,
        lockfilePath: '/tmp/project/package-lock.json',
        registry: REGISTRY,
      };
    },
    toProjectInfo: (candidate) => ({ label: candidate.label, manifestPath: 'package.json' }),
    cacheKeyFor: (candidate, registry) => `${candidate.id}::${registry}`,
  };
}

test('reloadControllerFromDisk actually replaces the controller snapshot — new rows, new declared dependencies, not the old construction-time strings', async () => {
  const cacheKey = 'candidate-a::' + REGISTRY;
  const { controller, projectCacheStore } = makeControllerAndStore(cacheKey);
  const sink = recordingSink();

  // Prime the controller with the "before" scan, exactly like a real panel would have.
  await controller.handleReady(recordingSink());
  const beforeEligibility = controller.validateUpgradeRequest({ package: 'clean-pkg', target: '1.6.0' });
  assert.notEqual(beforeEligibility.reason, 'not-declared', 'sanity check: clean-pkg is a real dependency before the reload');

  const outcome = await reloadControllerFromDisk({
    candidate: { id: 'candidate-a', label: 'app' },
    controller,
    canChangeProject: false,
    sink,
    source: fakeSource({}),
    generationAtReadStart: controller.beginRevalidation(),
  });

  assert.equal(outcome.applied, true);
  assert.equal(sink.statuses.includes('loading'), false, 'never flashes loading — the prior render stays up');
  assert.equal(sink.statuses[sink.statuses.length - 1], 'partial-error', 'a completed scan of the NEW manifest/lockfile posted');
  assert.equal(
    sink.posted[sink.posted.length - 1].data.rows[0].current,
    '1.5.0',
    'current reflects the freshly re-read lockfile, not the old construction-time string (1.0.0)'
  );
  assert.equal(sink.posted[sink.posted.length - 1].data.rows[0].latest, '1.6.0', 'latest still comes from the registry, unchanged');

  // The persisted cache entry itself was overwritten with the fresh scan — not just the in-memory controller.
  const persisted = projectCacheStore.get(cacheKey);
  assert.equal(persisted.rows[0].current, '1.5.0');
});

test('purging by the previous lockfile path before reloading (not after) preserves this project\'s own freshly-persisted entry when the resolved path is unchanged — the ordinary content-only-edit case', async () => {
  // Documents the correct sequencing dashboardPanel.ts's reloadAfterFileChange
  // must use: purge-by-lockfile-path THEN reload, never the reverse. The
  // reload ends by persisting a fresh entry for this project's own cacheKey
  // under its resolved lockfile path — when that path hasn't actually
  // changed (a plain content edit, not a topology change), purging by that
  // same path *after* the reload would immediately delete the entry the
  // reload just wrote.
  const cacheKey = 'candidate-a::' + REGISTRY;
  const { controller, projectCacheStore } = makeControllerAndStore(cacheKey);
  await controller.handleReady(recordingSink());

  const previousLockfilePath = '/tmp/project/package-lock.json'; // identical before and after in this fixture

  projectCacheStore.deleteByLockfilePath(previousLockfilePath); // purge first
  const outcome = await reloadControllerFromDisk({
    candidate: { id: 'candidate-a', label: 'app' },
    controller,
    canChangeProject: false,
    sink: recordingSink(),
    source: fakeSource({}),
    generationAtReadStart: controller.beginRevalidation(),
  }); // reload (and persist) second

  assert.equal(outcome.applied, true);
  const persisted = projectCacheStore.get(cacheKey);
  assert.notEqual(persisted, undefined, "the reload's own fresh write survives — purging first does not wipe it out afterward");
  assert.equal(persisted.rows[0].current, '1.5.0', 'and it is the new scan, not a stale leftover');
});

test('reloadControllerFromDisk never mutates the controller when isStillCurrent() is false — a project switch that finished during the disk read wins', async () => {
  const cacheKey = 'candidate-a::' + REGISTRY;
  const { controller } = makeControllerAndStore(cacheKey);
  await controller.handleReady(recordingSink());
  const rootBefore = controller.root;

  const outcome = await reloadControllerFromDisk({
    candidate: { id: 'candidate-a', label: 'app' },
    controller,
    canChangeProject: false,
    sink: recordingSink(),
    source: fakeSource({}),
    generationAtReadStart: controller.beginRevalidation(),
    isStillCurrent: () => false,
  });

  assert.deepEqual(outcome, { applied: false, reason: 'superseded' });
  assert.equal(controller.root, rootBefore, 'the controller was never touched');
});

test('isStillCurrent() is checked after the disk read, not before — a switch that starts mid-read is still caught', async () => {
  const cacheKey = 'candidate-a::' + REGISTRY;
  const { controller } = makeControllerAndStore(cacheKey);
  await controller.handleReady(recordingSink());

  let stillCurrent = true;
  const source = fakeSource({
    afterCalled: () => {
      // Simulates a project switch completing while loadProject was in flight.
      stillCurrent = false;
    },
  });

  const outcome = await reloadControllerFromDisk({
    candidate: { id: 'candidate-a', label: 'app' },
    controller,
    canChangeProject: false,
    sink: recordingSink(),
    source,
    generationAtReadStart: controller.beginRevalidation(),
    isStillCurrent: () => stillCurrent,
  });

  assert.equal(outcome.applied, false);
});

test('a loadProject failure propagates to the caller without touching the controller', async () => {
  const cacheKey = 'candidate-a::' + REGISTRY;
  const { controller } = makeControllerAndStore(cacheKey);
  await controller.handleReady(recordingSink());
  const rootBefore = controller.root;

  const failingSource = {
    async loadProject() {
      throw new Error('ENOENT: package.json was deleted');
    },
    toProjectInfo: () => ({ label: 'app', manifestPath: 'package.json' }),
    cacheKeyFor: () => cacheKey,
  };

  await assert.rejects(
    reloadControllerFromDisk({
      candidate: { id: 'candidate-a', label: 'app' },
      controller,
      canChangeProject: false,
      sink: recordingSink(),
      source: failingSource,
      generationAtReadStart: controller.beginRevalidation(),
    }),
    /ENOENT/
  );
  assert.equal(controller.root, rootBefore, 'the controller was never touched by the failed reload');
});
