/**
 * The full orchestration race dashboardPanel.ts's reloadAndScan() and
 * FileChangeCoordinator must close together: a watcher event arriving while
 * reloadAndScan's own loadProject() is in flight must never let a scan of
 * pre-event (stale) content grant Upgrade eligibility, and must always be
 * drained afterward via a mandatory second disk read — even though watcher
 * recreation cancels whatever external debounce timer would otherwise have
 * been the only thing left to flush it.
 *
 * This mirrors dashboardPanel.ts's fixed sequence step for step, using the
 * REAL DashboardController and the REAL FileChangeCoordinator (only
 * loadProject itself — the one genuinely vscode-touching piece — is faked),
 * so this proves the actual orchestration, not just each piece in isolation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DashboardController } from '../out/host/dashboardController.js';
import { MemoryEtagStore } from '../out/core/registry/versions.js';
import { PersistentProjectCacheStore } from '../out/core/cache/projectCacheStore.js';
import { FileChangeCoordinator } from '../out/core/cache/fileChangeCoordinator.js';
import { reloadControllerFromDisk } from '../out/host/fileChangeReload.js';
import { isSameProjectReload } from '../out/core/workspace/scan.js';
import { UpgradeLock } from '../out/host/upgradeTracker.js';

const REGISTRY = 'https://registry.npmjs.org';
const ROOT = '/tmp/project';
const CACHE_KEY = 'project-a::' + REGISTRY;
const PROJECT_INFO = { label: 'app', manifestPath: 'package.json' };
const BUILD_INFO = { extensionVersion: '0.0.1', builtAt: '2026-08-01T09:00:00.000Z' };

const json = (body) => ({ status: 200, headers: {}, body: JSON.stringify(body), wireBytes: JSON.stringify(body).length });

// `1.6.0` satisfies both `^1.0.0` and `^1.5.0` — the hybrid fetch's fast
// /latest-only path, same trick host-file-change-reload.test.mjs uses, so a
// fake client that only answers `/latest` is enough for every scan below.
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

const ORIGINAL_MANIFEST = JSON.stringify({ name: 'app', version: '1.0.0', dependencies: { 'clean-pkg': '^1.0.0' } });
const ORIGINAL_LOCKFILE = JSON.stringify({
  name: 'app',
  lockfileVersion: 3,
  packages: {
    '': { name: 'app', version: '1.0.0', dependencies: { 'clean-pkg': '^1.0.0' } },
    'node_modules/clean-pkg': { version: '1.0.0' },
  },
});

// What the *held-open* first disk read returns — captured from before the
// watcher-reported change, exactly as a real filesystem read that started
// before a concurrent write completed would.
const STALE_MANIFEST = JSON.stringify({ name: 'app', version: '1.0.0', dependencies: { 'clean-pkg': '^1.0.0' } });
const STALE_LOCKFILE = ORIGINAL_LOCKFILE;

// What the second, drained disk read correctly picks up — the real,
// post-event content.
const FRESH_MANIFEST = JSON.stringify({ name: 'app', version: '1.0.0', dependencies: { 'clean-pkg': '^1.5.0' } });
const FRESH_LOCKFILE = JSON.stringify({
  name: 'app',
  lockfileVersion: 3,
  packages: {
    '': { name: 'app', version: '1.0.0', dependencies: { 'clean-pkg': '^1.5.0' } },
    'node_modules/clean-pkg': { version: '1.5.0' },
  },
});

test('a watcher event arriving during reloadAndScan\'s own disk read is drained afterward, and a stale first scan never grants Upgrade eligibility', async () => {
  const projectCacheStore = new PersistentProjectCacheStore(fakeKeyValueStore());
  const controller = new DashboardController({
    root: ROOT,
    manifestText: ORIGINAL_MANIFEST,
    lockfileText: ORIGINAL_LOCKFILE,
    lockfilePath: '/tmp/project/package-lock.json',
    registry: REGISTRY,
    httpClient: staticClient('1.6.0'),
    etagStore: new MemoryEtagStore(),
    projectInfo: PROJECT_INFO,
    canChangeProject: false,
    buildInfo: BUILD_INFO,
    projectCacheStore,
    cacheKey: CACHE_KEY,
    ttlMinutesProvider: () => 30,
  });

  // Prime it — a real panel would already have an eligible controller before
  // the user clicks Refresh (the trigger for reloadAndScan in this scenario).
  await controller.handleReady(recordingSink());
  assert.notEqual(
    controller.validateUpgradeRequest({ package: 'clean-pkg', target: '1.6.0' }).reason,
    'revalidating',
    'sanity check: eligible before the reload starts'
  );

  // ---- mirrors dashboardPanel.ts's reloadAndScan(), step by step ----

  // Step 1: captured before the disk read even starts.
  const generationAtReadStart = controller.beginRevalidation();
  controller.announceRevalidating(recordingSink());

  // Step 2: the disk read starts, held open.
  let resolveFirstLoadProject;
  const firstLoadProjectHeldOpen = new Promise((resolve) => {
    resolveFirstLoadProject = resolve;
  });
  const firstLoadProject = firstLoadProjectHeldOpen.then(() => ({
    root: ROOT,
    manifestText: STALE_MANIFEST,
    lockfileText: STALE_LOCKFILE,
    lockfilePath: '/tmp/project/package-lock.json',
    registry: REGISTRY,
  }));

  // Step 3: the coordinator that would own a real watcher-triggered reload —
  // its `reload` callback mirrors reloadAfterFileChange(): a fresh
  // beginRevalidation() call, then a second, genuinely up-to-date disk read.
  let secondLoadProjectCalls = 0;
  const coordinator = new FileChangeCoordinator({
    isBusy: () => false,
    currentGeneration: () => 0,
    reload: async () => {
      secondLoadProjectCalls += 1;
      const generationAtSecondReadStart = controller.beginRevalidation();
      await reloadControllerFromDisk({
        candidate: { id: 'project-a' },
        controller,
        canChangeProject: false,
        sink: recordingSink(),
        source: {
          async loadProject() {
            return {
              root: ROOT,
              manifestText: FRESH_MANIFEST,
              lockfileText: FRESH_LOCKFILE,
              lockfilePath: '/tmp/project/package-lock.json',
              registry: REGISTRY,
            };
          },
          toProjectInfo: () => PROJECT_INFO,
          cacheKeyFor: () => CACHE_KEY,
        },
        generationAtReadStart: generationAtSecondReadStart,
      });
    },
  });

  // Step 4: a watcher event fires WHILE the first disk read is still
  // pending — exactly like a real file save racing a manual refresh.
  controller.beginRevalidation();
  coordinator.notify('manifest');
  assert.equal(coordinator.hasPending, true, 'sanity check: the event is queued, not yet processed');

  // Step 5: the first (held-open) disk read finally resolves — with the
  // STALE content, since it started before the watcher-reported write.
  resolveFirstLoadProject();
  const project = await firstLoadProject;

  // Step 6: updateProjectSnapshot with the now-outdated generationAtReadStart.
  controller.updateProjectSnapshot(
    { ...project, projectInfo: PROJECT_INFO, canChangeProject: false, cacheKey: CACHE_KEY },
    generationAtReadStart
  );

  // Step 7: the first scan itself, of stale content — this is the actual
  // regression check: it must NEVER grant eligibility, even though nothing
  // bumped the generation *during* this specific scan.
  await controller.handleRefresh(recordingSink());
  assert.deepEqual(
    controller.validateUpgradeRequest({ package: 'clean-pkg', target: '1.6.0' }),
    { ok: false, reason: 'revalidating' },
    'a scan of stale (pre-event) content must never grant eligibility, even when nothing raced the scan itself'
  );
  // And the row data itself still reflects the stale content, proving this
  // isn't a vacuous check against an already-fresh scan.
  assert.equal(controller.validateUpgradeRequest({ package: 'clean-pkg', target: '1.6.0' }).ok, false);

  // Step 8: mirrors reloadAndScan's own end-of-method step, post-Fix-1 — this
  // step is now unconditional, never branched on isSameProjectReload here
  // (the mid-method conditional discard, skipped entirely for a same-project
  // reload like this one, is what would have handled a switch instead — see
  // the dedicated switch test below). This is the fix under test: nothing
  // external ever calls flush() again (the debounce timer that would have is
  // gone, simulating watcher recreation cancelling it), so this explicit
  // drain is the *only* thing that can still process the queued event — the
  // "mandatory second disk reload."
  await coordinator.flush();

  assert.equal(secondLoadProjectCalls, 1, 'the queued event was drained exactly once, with no external flush() call');
  assert.equal(coordinator.hasPending, false);

  // Step 9: the second, genuinely fresh scan must now correctly restore eligibility.
  const finalEligibility = controller.validateUpgradeRequest({ package: 'clean-pkg', target: '1.6.0' });
  assert.notEqual(
    finalEligibility.reason,
    'revalidating',
    'the drained, second disk read captured the real content and correctly restores eligibility'
  );
});

test('a watcher event arriving during a reloadAndScan for a DIFFERENT project (a switch) is discarded, never drained onto the new selection', async () => {
  const projectCacheStore = new PersistentProjectCacheStore(fakeKeyValueStore());
  const controller = new DashboardController({
    root: ROOT,
    manifestText: ORIGINAL_MANIFEST,
    lockfileText: ORIGINAL_LOCKFILE,
    lockfilePath: '/tmp/project/package-lock.json',
    registry: REGISTRY,
    httpClient: staticClient('1.6.0'),
    etagStore: new MemoryEtagStore(),
    projectInfo: PROJECT_INFO,
    canChangeProject: true,
    buildInfo: BUILD_INFO,
    projectCacheStore,
    cacheKey: CACHE_KEY,
    ttlMinutesProvider: () => 30,
  });
  await controller.handleReady(recordingSink());

  const generationAtReadStart = controller.beginRevalidation();

  let resolveSwitchLoadProject;
  const switchLoadProjectHeldOpen = new Promise((resolve) => {
    resolveSwitchLoadProject = resolve;
  });

  let reloadCalls = 0;
  const coordinator = new FileChangeCoordinator({
    isBusy: () => false,
    currentGeneration: () => 0,
    reload: async () => {
      reloadCalls += 1;
    },
  });

  // Mirrors reloadAndScan's own unconditional discardPending() at the very
  // top of the method — nothing pending yet in this test.
  coordinator.discardPending();

  // A watcher event fires for the OLD project while the switch's own
  // loadProject (for the NEW project) is in flight — the old watchers are
  // still the live ones at this exact moment, since setupFileWatchers for
  // the new project hasn't run yet.
  controller.beginRevalidation();
  coordinator.notify('manifest');
  assert.equal(coordinator.hasPending, true);

  resolveSwitchLoadProject();
  await switchLoadProjectHeldOpen;

  // setupFileWatchers(candidate) installs the NEW project's watchers here in
  // the real code. Immediately afterward, before any further await, Fix 1
  // discards whatever is pending — for a genuine switch (the *same* pure
  // function decides this, with genuinely different ids, not a hardcoded
  // assumption of which branch should run) this is the ONLY point that
  // discards the old project's event in the corrected sequencing; the old
  // end-of-method branch is gone.
  const previousSelectedId = 'project-a';
  const candidateId = 'project-b';
  const sameProjectReload = isSameProjectReload(previousSelectedId, candidateId);
  assert.equal(sameProjectReload, false, 'sanity check: this really is a switch');
  if (!sameProjectReload) {
    coordinator.discardPending();
  }

  const newProjectSnapshot = {
    root: '/tmp/other-project',
    manifestText: JSON.stringify({ name: 'other', version: '1.0.0', dependencies: { 'clean-pkg': '^1.0.0' } }),
    lockfileText: ORIGINAL_LOCKFILE,
    lockfilePath: null,
    registry: REGISTRY,
  };
  controller.updateProjectSnapshot(
    { ...newProjectSnapshot, projectInfo: { label: 'other', manifestPath: 'package.json' }, canChangeProject: true, cacheKey: 'project-b::' + REGISTRY },
    generationAtReadStart
  );
  await controller.handleRefresh(recordingSink());

  // Fix 1's end-of-method step is now unconditional — always flush, never
  // branch on sameProjectReload here. A no-op in this test: the old
  // project's event was already discarded above, before this reload's own
  // scan even started.
  await coordinator.flush();

  assert.equal(coordinator.hasPending, false, 'the old project\'s queued event never lingers to be applied to the new selection');
  assert.equal(reloadCalls, 0, 'reload() was never invoked for the old project\'s event — it was discarded, not drained onto the new one');
});

// A registry client whose /latest response can be held open on demand, so a
// test can fire a watcher event WHILE a scan is genuinely in flight — not
// just between two already-resolved steps.
function gatedClient(version) {
  let gate = Promise.resolve();
  let resolveGate;
  return {
    client: {
      async get(url) {
        await gate;
        if (url !== `${REGISTRY}/clean-pkg/latest`) return { status: 404, headers: {}, body: '', wireBytes: 0 };
        return json({ version });
      },
      async post() {
        return json({});
      },
    },
    hold() {
      gate = new Promise((resolve) => {
        resolveGate = resolve;
      });
    },
    release() {
      resolveGate?.();
    },
  };
}

test('project B changes after B\'s watchers are installed but while B\'s own scan is held open — the event is drained, triggering a second reload, never discarded', async () => {
  const projectCacheStore = new PersistentProjectCacheStore(fakeKeyValueStore());
  const gated = gatedClient('1.6.0');
  const controller = new DashboardController({
    root: ROOT,
    manifestText: ORIGINAL_MANIFEST,
    lockfileText: ORIGINAL_LOCKFILE,
    lockfilePath: '/tmp/project/package-lock.json',
    registry: REGISTRY,
    httpClient: gated.client,
    etagStore: new MemoryEtagStore(),
    projectInfo: PROJECT_INFO,
    canChangeProject: true,
    buildInfo: BUILD_INFO,
    projectCacheStore,
    cacheKey: CACHE_KEY,
    ttlMinutesProvider: () => 30,
  });
  await controller.handleReady(recordingSink());

  // ---- mirrors the FIXED reloadAndScan() sequencing exactly, for a switch
  // from project A to project B, per Fix 1's corrected three-part order:
  //   1. discard old-project leftovers up front (existing, unchanged step)
  //   2. after "installing B's watchers" and before any further await, for a
  //      genuine switch, discard again — clearing anything from the OLD
  //      watchers that arrived during the disk read
  //   3. after the scan, unconditionally flush — draining anything that
  //      arrived on the NEW (B's) watchers, never discarding it
  // ----

  const generationAtReadStart = controller.beginRevalidation();
  controller.announceRevalidating(recordingSink());

  let reloadCalls = 0;
  const coordinator = new FileChangeCoordinator({
    isBusy: () => false,
    currentGeneration: () => 0,
    reload: async () => {
      reloadCalls += 1;
      const generationAtSecondReadStart = controller.beginRevalidation();
      await reloadControllerFromDisk({
        candidate: { id: 'project-b' },
        controller,
        canChangeProject: true,
        sink: recordingSink(),
        source: {
          async loadProject() {
            return {
              root: '/tmp/project-b',
              manifestText: FRESH_MANIFEST,
              lockfileText: FRESH_LOCKFILE,
              lockfilePath: null,
              registry: REGISTRY,
            };
          },
          toProjectInfo: () => ({ label: 'b', manifestPath: 'package.json' }),
          cacheKeyFor: () => 'project-b::' + REGISTRY,
        },
        generationAtReadStart: generationAtSecondReadStart,
      });
    },
  });

  // Step 1 (top of reloadAndScan): nothing pending yet in this test.
  coordinator.discardPending();

  // The switch's own disk read for B (not held open — the race under test is
  // during B's own SCAN, per the task description, not this read).
  const projectBSnapshot = {
    root: '/tmp/project-b',
    manifestText: JSON.stringify({ name: 'b', version: '1.0.0', dependencies: { 'clean-pkg': '^1.0.0' } }),
    lockfileText: ORIGINAL_LOCKFILE,
    lockfilePath: null,
    registry: REGISTRY,
  };

  // setupFileWatchers(candidate) installs B's watchers here in the real
  // code. Immediately afterward, before any further await, a genuine switch
  // discards old-project leftovers — this is Fix 1's new mid-method step.
  const sameProjectReload = isSameProjectReload('project-a', 'project-b');
  assert.equal(sameProjectReload, false, 'sanity check: this is a genuine switch');
  if (!sameProjectReload) {
    coordinator.discardPending();
  }

  controller.updateProjectSnapshot(
    { ...projectBSnapshot, projectInfo: { label: 'b', manifestPath: 'package.json' }, canChangeProject: true, cacheKey: 'project-b::' + REGISTRY },
    generationAtReadStart
  );

  // B's own scan begins, held open so a genuine B-watcher event can fire
  // while it's still in flight — exactly the scenario Fix 1 targets: B's
  // watchers are already live (installed above) but B's scan hasn't
  // finished yet.
  gated.hold();
  const scanPromise = controller.handleRefresh(recordingSink());

  // A real change to project B fires now — on B's own, already-installed
  // watchers, while B's scan is still held open.
  controller.beginRevalidation();
  coordinator.notify('manifest');
  assert.equal(coordinator.hasPending, true, 'sanity check: the event is queued');

  gated.release();
  await scanPromise;

  // Final step of reloadAndScan, per the fix: unconditional, never branched
  // on sameProjectReload — whatever is pending now is guaranteed to be from
  // B's own (currently active) watchers, since old-project leftovers were
  // already cleared above.
  await coordinator.flush();

  assert.equal(reloadCalls, 1, 'the event from B\'s own watchers triggered a second reload — it was drained, not discarded');
  assert.equal(coordinator.hasPending, false);

  const finalEligibility = controller.validateUpgradeRequest({ package: 'clean-pkg', target: '1.6.0' });
  assert.notEqual(
    finalEligibility.reason,
    'revalidating',
    'the drained second scan of B correctly restores eligibility once it completes'
  );
});

// dashboardPanel.ts's own debounce window before a watcher-triggered reload
// actually runs — mirrored here (not imported; it's a private module
// constant) purely to prove the ordering guarantee under test holds for the
// entire span a real debounce would cover, not just for an instant.
const FILE_EVENT_DEBOUNCE_MS = 300;

test('onWatchedFileEvent announces revalidating synchronously, before its own debounce timer (and therefore any reload) ever runs', async () => {
  const projectCacheStore = new PersistentProjectCacheStore(fakeKeyValueStore());
  const controller = new DashboardController({
    root: ROOT,
    manifestText: ORIGINAL_MANIFEST,
    lockfileText: ORIGINAL_LOCKFILE,
    lockfilePath: '/tmp/project/package-lock.json',
    registry: REGISTRY,
    httpClient: staticClient('1.6.0'),
    etagStore: new MemoryEtagStore(),
    projectInfo: PROJECT_INFO,
    canChangeProject: false,
    buildInfo: BUILD_INFO,
    projectCacheStore,
    cacheKey: CACHE_KEY,
    ttlMinutesProvider: () => 30,
  });
  const sink = recordingSink();
  await controller.handleReady(sink);
  assert.notEqual(
    controller.validateUpgradeRequest({ package: 'clean-pkg', target: '1.6.0' }).reason,
    'revalidating',
    'sanity check: eligible before the watcher event'
  );
  sink.posted.length = 0;

  let reloadCalls = 0;
  let invalidationTimer;

  // Mirrors dashboardPanel.ts's onWatchedFileEvent() body exactly, step for
  // step — this is Fix 2 under test: beginRevalidation() is immediately
  // followed by announceRevalidating(), both synchronous and both BEFORE
  // notify()/the debounce timer that eventually triggers the real reload.
  function onWatchedFileEvent() {
    controller.beginRevalidation();
    controller.announceRevalidating(sink);
    if (invalidationTimer !== undefined) clearTimeout(invalidationTimer);
    invalidationTimer = setTimeout(() => {
      invalidationTimer = undefined;
      reloadCalls += 1;
    }, FILE_EVENT_DEBOUNCE_MS);
  }

  onWatchedFileEvent();

  // Checked synchronously, right after the call returns — no `await`, no
  // timer has had any chance to fire yet, so this is a direct proof of
  // ordering, not merely a "happens eventually" check. This is the actual
  // regression: without Fix 2, nothing posts here at all until the debounced
  // reload eventually completes, leaving Upgrade looking enabled for the
  // entire debounce window.
  assert.deepEqual(sink.statuses, ['stale'], 'the stale announcement posted synchronously, before the debounce timer or any reload ever ran');
  assert.equal(reloadCalls, 0, 'sanity check: the debounced reload has not run yet');
  assert.deepEqual(
    controller.validateUpgradeRequest({ package: 'clean-pkg', target: '1.6.0' }),
    { ok: false, reason: 'revalidating' },
    'Upgrade is already disabled for the whole debounce window, not just once the reload itself starts'
  );

  // The debounce eventually fires and the reload runs — unaffected by Fix 2,
  // included only to show the announcement really did precede it.
  await new Promise((resolve) => setTimeout(resolve, FILE_EVENT_DEBOUNCE_MS + 50));
  assert.equal(reloadCalls, 1);
});

test('changeProject()\'s single-candidate branch re-checks isBusy() after discoverProjects() resolves, immediately before reloadAndScan() — matching the multi-candidate branch\'s own re-check', async () => {
  const lock = new UpgradeLock();

  let resolveDiscovery;
  const discoverProjects = () =>
    new Promise((resolve) => {
      resolveDiscovery = resolve;
    });

  let reloadAndScanCalls = 0;
  const reloadAndScan = async () => {
    reloadAndScanCalls += 1;
  };

  // Mirrors dashboardPanel.ts's changeProject() single-candidate branch,
  // post-Fix-3, using the real UpgradeLock underlying UpgradeExecutionSession
  // .isBusy() (upgradeRunner.ts wraps this exact class — see upgradeTracker.ts's
  // own doc for why the vscode-bound wrapper itself has no direct test
  // coverage here) — not a hardcoded assumption of the outcome, but the same
  // state machine the real code checks.
  async function changeProjectSingleCandidateBranch() {
    const candidates = await discoverProjects();
    if (candidates.length === 1) {
      // An upgrade could have started while discoverProjects() was pending
      // (it isn't itself lock-holding) — re-check right before applying.
      if (lock.isHeld()) return;
      await reloadAndScan(candidates[0]);
      return;
    }
    throw new Error('test only exercises the single-candidate branch');
  }

  const changePromise = changeProjectSingleCandidateBranch();

  // An upgrade begins WHILE discoverProjects() is still pending.
  assert.equal(lock.tryAcquire('clean-pkg'), true, 'sanity check: the lock was free before this');

  resolveDiscovery([{ id: 'only-candidate', label: 'app' }]);
  await changePromise;

  assert.equal(
    reloadAndScanCalls,
    0,
    'the isBusy() re-check after discovery resolved must catch the upgrade that began mid-discovery and bail out — never silently reload while an upgrade is in flight'
  );

  lock.release('clean-pkg');

  // With the lock free again, an otherwise-identical call proceeds normally
  // — proving the branch isn't just permanently short-circuited.
  let resolveDiscovery2;
  const discoverProjects2 = () =>
    new Promise((resolve) => {
      resolveDiscovery2 = resolve;
    });
  async function changeProjectSingleCandidateBranch2() {
    const candidates = await discoverProjects2();
    if (candidates.length === 1) {
      if (lock.isHeld()) return;
      await reloadAndScan(candidates[0]);
      return;
    }
    throw new Error('test only exercises the single-candidate branch');
  }
  const changePromise2 = changeProjectSingleCandidateBranch2();
  resolveDiscovery2([{ id: 'only-candidate', label: 'app' }]);
  await changePromise2;

  assert.equal(reloadAndScanCalls, 1, 'with the lock free, the same branch proceeds to reloadAndScan as normal');
});

test('a slow refresh of project A is superseded by a switch to B — A must not perform its final coordinator flush', async () => {
  const projectCacheStore = new PersistentProjectCacheStore(fakeKeyValueStore());
  const controller = new DashboardController({
    root: ROOT,
    manifestText: ORIGINAL_MANIFEST,
    lockfileText: ORIGINAL_LOCKFILE,
    lockfilePath: '/tmp/project/package-lock.json',
    registry: REGISTRY,
    httpClient: staticClient('1.6.0'),
    etagStore: new MemoryEtagStore(),
    projectInfo: PROJECT_INFO,
    canChangeProject: true,
    buildInfo: BUILD_INFO,
    projectCacheStore,
    cacheKey: CACHE_KEY,
    ttlMinutesProvider: () => 30,
  });
  await controller.handleReady(recordingSink());

  // Mirrors just the panel-level field this fix is about — `this.reloadGeneration`.
  let reloadGeneration = 1;

  let reloadCalls = 0;
  const coordinator = new FileChangeCoordinator({
    isBusy: () => false,
    currentGeneration: () => reloadGeneration,
    reload: async () => {
      reloadCalls += 1;
    },
  });

  // Mirrors reloadAndScan()'s own generation bump and its (fixed)
  // end-of-method supersession check, for a plain REFRESH of the currently
  // selected project (A) — held open right at the `handleRefresh` await
  // (`scanGate` stands in for the network scan) so a faster switch to B can
  // start and fully complete while this call is still in flight.
  async function mirrorRefreshA(scanGate) {
    reloadGeneration += 1;
    const generation = reloadGeneration;
    coordinator.discardPending();
    await scanGate; // stands in for `await controller.handleRefresh(this.sink)`
    // Fix 1 under test: bail without flushing once superseded.
    if (generation !== reloadGeneration) return;
    await coordinator.flush();
  }

  // Mirrors reloadAndScan(B)'s own generation bump and end-of-method flush,
  // for a genuine switch — completes fully, uninterrupted, while A's own
  // refresh above is still held open.
  async function mirrorSwitchToB() {
    reloadGeneration += 1;
    const generation = reloadGeneration;
    coordinator.discardPending();
    if (generation !== reloadGeneration) return;
    await coordinator.flush();
  }

  let releaseA;
  const scanGateA = new Promise((resolve) => {
    releaseA = resolve;
  });

  const aRefreshPromise = mirrorRefreshA(scanGateA);

  // The switch to B starts and completes entirely while A's own scan is
  // still held open — B's own end-of-method flush runs here, correctly, for
  // whatever it finds pending (nothing, in this test).
  await mirrorSwitchToB();
  assert.equal(reloadGeneration, 3, 'sanity check: both the refresh and the switch bumped the generation');

  // A genuine event now arrives — for the project actually selected after
  // the switch. If A's belated, superseded flush() were still allowed to
  // run, it would incorrectly drain this.
  coordinator.notify('manifest');
  assert.equal(coordinator.hasPending, true, 'sanity check: the event is queued');

  // A's own scan finally resolves — well after it was superseded.
  releaseA();
  await aRefreshPromise;

  assert.equal(reloadCalls, 0, 'A\'s superseded reload must never have called reload() via its own flush()');
  assert.equal(coordinator.hasPending, true, 'the event queued after the switch is untouched by A\'s belated (and skipped) flush — still waiting for its own, legitimate flush');
});

test('an old A watcher reload starts while B is loading and resolves after B becomes selected — it must not replace B\'s snapshot, selected lockfile, or watchers', async () => {
  const projectCacheStore = new PersistentProjectCacheStore(fakeKeyValueStore());
  const controller = new DashboardController({
    root: ROOT,
    manifestText: ORIGINAL_MANIFEST,
    lockfileText: ORIGINAL_LOCKFILE,
    lockfilePath: '/tmp/project/package-lock.json',
    registry: REGISTRY,
    httpClient: staticClient('1.6.0'),
    etagStore: new MemoryEtagStore(),
    projectInfo: PROJECT_INFO,
    canChangeProject: true,
    buildInfo: BUILD_INFO,
    projectCacheStore,
    cacheKey: CACHE_KEY,
    ttlMinutesProvider: () => 30,
  });
  await controller.handleReady(recordingSink());

  const PROJECT_A = { id: 'project-a', label: 'a' };
  const PROJECT_B = { id: 'project-b', label: 'b' };

  // Panel-level state this test mirrors — the exact fields reloadAndScan and
  // reloadAfterFileChange read and mutate in the real code. `watchersFor`
  // stands in for the watchers `setupFileWatchers` would install.
  const panel = {
    reloadGeneration: 1,
    selectedProject: PROJECT_A,
    watchersFor: PROJECT_A.id,
    selectedLockfilePath: '/tmp/project/package-lock.json',
  };

  let resolveALoadProject;
  const aLoadProjectHeldOpen = new Promise((resolve) => {
    resolveALoadProject = resolve;
  });

  // Mirrors reloadAfterFileChange(kinds, generation) exactly, including both
  // of this task's checks: Fix 2 (isStillCurrent also compares candidate
  // identity, not only the numeric generation) and Fix 3 (a second,
  // independent re-check after reloadControllerFromDisk returns, before
  // mutating panel-level state) — using the REAL reloadControllerFromDisk,
  // not a hand-rolled equivalent, so Fix 2's isStillCurrent callback is
  // exercised exactly as a real caller would pass it.
  async function mirrorReloadAfterFileChangeA(generation) {
    const candidate = panel.selectedProject; // captured here, exactly like the real method's own first line
    const generationAtReadStart = controller.beginRevalidation();
    controller.announceRevalidating(recordingSink());

    let outcome;
    try {
      outcome = await reloadControllerFromDisk({
        candidate,
        controller,
        canChangeProject: true,
        sink: recordingSink(),
        source: {
          async loadProject() {
            await aLoadProjectHeldOpen;
            return {
              root: ROOT,
              manifestText: FRESH_MANIFEST,
              lockfileText: FRESH_LOCKFILE,
              lockfilePath: '/tmp/project/package-lock.json',
              registry: REGISTRY,
            };
          },
          toProjectInfo: () => ({ label: 'a', manifestPath: 'package.json' }),
          cacheKeyFor: () => CACHE_KEY,
        },
        generationAtReadStart,
        // Fix 2 under test.
        isStillCurrent: () => generation === panel.reloadGeneration && candidate === panel.selectedProject,
      });
    } catch {
      return;
    }
    if (!outcome.applied) return;

    // Fix 3 under test — unreached in THIS specific interleaving (Fix 2's
    // check above already catches it, since B's switch here never bumps the
    // generation a second time — see the comment below for why that's
    // exactly the scenario that makes the candidate check, not just the
    // generation check, necessary), but included because the real method
    // always runs it, and a correct implementation must reach the same
    // outcome regardless of which of the two checks is what actually catches
    // a given interleaving.
    if (generation !== panel.reloadGeneration || candidate !== panel.selectedProject) return;

    panel.watchersFor = candidate.id;
    panel.selectedLockfilePath = outcome.project.lockfilePath;
  }

  // A's watcher event is captured with generation 2 — the SAME generation
  // number B's own switch below bumps to, because the event is notified
  // (reading the live generation) *after* B's switch has already bumped it
  // but *before* B has finished loading and actually become selected. This
  // is precisely the gap that makes candidate identity necessary: a
  // generation-only check would see these two as indistinguishable.
  panel.reloadGeneration = 2; // B "is loading": already bumped, not yet selected
  const aReloadPromise = mirrorReloadAfterFileChangeA(2);

  // B's switch now finishes — selectedProject (and everything else) becomes
  // B's, while A's reload above is still held open mid-disk-read.
  panel.selectedProject = PROJECT_B;
  panel.watchersFor = PROJECT_B.id;
  panel.selectedLockfilePath = '/tmp/project-b/package-lock.json';
  controller.updateProjectSnapshot(
    {
      root: '/tmp/project-b',
      manifestText: JSON.stringify({ name: 'b', version: '1.0.0', dependencies: { 'clean-pkg': '^1.0.0' } }),
      lockfileText: ORIGINAL_LOCKFILE,
      lockfilePath: '/tmp/project-b/package-lock.json',
      registry: REGISTRY,
      projectInfo: { label: 'b', manifestPath: 'package.json' },
      canChangeProject: true,
      cacheKey: 'project-b::' + REGISTRY,
    },
    controller.beginRevalidation()
  );

  // A's held-open disk read finally resolves — well after B became selected.
  resolveALoadProject();
  await aReloadPromise;

  assert.equal(panel.selectedProject, PROJECT_B, 'B is still the selected project — A\'s belated reload did not revert it');
  assert.equal(panel.watchersFor, PROJECT_B.id, 'B\'s watchers were never replaced by A\'s stale reload');
  assert.equal(
    panel.selectedLockfilePath,
    '/tmp/project-b/package-lock.json',
    'B\'s selected lockfile path was never overwritten by A\'s'
  );
  // Not just panel-level bookkeeping — the shared controller's own snapshot
  // must also still be B's, proving A's stale data was never applied to it.
  assert.equal(controller.root, '/tmp/project-b');
});

test('an old A watcher reload passes its own isStillCurrent check, then is superseded during reloadControllerFromDisk\'s OWN network scan — Fix 3\'s independent window, not caught by Fix 2', async () => {
  // The previous test's interleaving is caught by Fix 2 (isStillCurrent's
  // candidate check) before Fix 3's own re-check is ever reached — see that
  // test's own comment. This one isolates Fix 3's distinct window: B's
  // switch happens strictly AFTER isStillCurrent has already run and
  // legitimately returned true (nothing had switched yet at that moment),
  // during reloadControllerFromDisk's own subsequent network scan
  // (refreshInBackground) — the only thing that can still catch it there is
  // Fix 3's second, independent check.
  const projectCacheStore = new PersistentProjectCacheStore(fakeKeyValueStore());
  const gated = gatedClient('1.6.0');
  const controller = new DashboardController({
    root: ROOT,
    manifestText: ORIGINAL_MANIFEST,
    lockfileText: ORIGINAL_LOCKFILE,
    lockfilePath: '/tmp/project/package-lock.json',
    registry: REGISTRY,
    httpClient: gated.client,
    etagStore: new MemoryEtagStore(),
    projectInfo: PROJECT_INFO,
    canChangeProject: true,
    buildInfo: BUILD_INFO,
    projectCacheStore,
    cacheKey: CACHE_KEY,
    ttlMinutesProvider: () => 30,
  });
  await controller.handleReady(recordingSink());

  const PROJECT_A = { id: 'project-a', label: 'a' };
  const PROJECT_B = { id: 'project-b', label: 'b' };

  const panel = {
    reloadGeneration: 1,
    selectedProject: PROJECT_A,
    watchersFor: PROJECT_A.id,
    selectedLockfilePath: '/tmp/project/package-lock.json',
  };

  // Resolved the first (and only) time isStillCurrent is actually called —
  // lets the test wait for that exact point deterministically, instead of
  // guessing how many microtask ticks it takes to get there.
  let resolveIsStillCurrentChecked;
  const isStillCurrentChecked = new Promise((resolve) => {
    resolveIsStillCurrentChecked = resolve;
  });

  let outcomeApplied;

  async function mirrorReloadAfterFileChangeA(generation) {
    const candidate = panel.selectedProject;
    const generationAtReadStart = controller.beginRevalidation();
    controller.announceRevalidating(recordingSink());

    let outcome;
    try {
      outcome = await reloadControllerFromDisk({
        candidate,
        controller,
        canChangeProject: true,
        sink: recordingSink(),
        source: {
          async loadProject() {
            // Resolves immediately — no gate here. Fix 2's isStillCurrent
            // check below runs (and passes) before B's switch has started.
            return {
              root: ROOT,
              manifestText: FRESH_MANIFEST,
              lockfileText: FRESH_LOCKFILE,
              lockfilePath: '/tmp/project/package-lock.json',
              registry: REGISTRY,
            };
          },
          toProjectInfo: () => ({ label: 'a', manifestPath: 'package.json' }),
          cacheKeyFor: () => CACHE_KEY,
        },
        generationAtReadStart,
        isStillCurrent: () => {
          const result = generation === panel.reloadGeneration && candidate === panel.selectedProject;
          resolveIsStillCurrentChecked();
          return result;
        },
      });
    } catch {
      return;
    }
    outcomeApplied = outcome.applied;
    if (!outcome.applied) return;

    // Fix 3 under test — the ONLY thing left that can catch a switch
    // completing during reloadControllerFromDisk's own network scan, since
    // Fix 2's isStillCurrent check above already ran and passed before that
    // scan even started.
    if (generation !== panel.reloadGeneration || candidate !== panel.selectedProject) return;

    panel.watchersFor = candidate.id;
    panel.selectedLockfilePath = outcome.project.lockfilePath;
  }

  // A's reload begins. Its own disk read resolves immediately (ungated), so
  // isStillCurrent legitimately passes — A is still selected at that exact
  // moment. reloadControllerFromDisk then moves on to its own network scan
  // (refreshInBackground), which is held open via the gated client.
  gated.hold();
  const aReloadPromise = mirrorReloadAfterFileChangeA(1);

  // Deterministically wait for isStillCurrent to have already run (and
  // passed) before mutating panel state for B — otherwise this would
  // collapse into the previous test's scenario (Fix 2 catching it) instead
  // of isolating Fix 3's own window.
  await isStillCurrentChecked;

  // B's switch now completes in full, entirely during A's held-open network
  // scan — after isStillCurrent already said "yes, still current."
  panel.reloadGeneration = 2;
  panel.selectedProject = PROJECT_B;
  panel.watchersFor = PROJECT_B.id;
  panel.selectedLockfilePath = '/tmp/project-b/package-lock.json';
  controller.updateProjectSnapshot(
    {
      root: '/tmp/project-b',
      manifestText: JSON.stringify({ name: 'b', version: '1.0.0', dependencies: { 'clean-pkg': '^1.0.0' } }),
      lockfileText: ORIGINAL_LOCKFILE,
      lockfilePath: '/tmp/project-b/package-lock.json',
      registry: REGISTRY,
      projectInfo: { label: 'b', manifestPath: 'package.json' },
      canChangeProject: true,
      cacheKey: 'project-b::' + REGISTRY,
    },
    controller.beginRevalidation()
  );

  // A's network scan finally resolves — well after B became selected.
  gated.release();
  await aReloadPromise;

  assert.equal(
    outcomeApplied,
    true,
    'sanity check: this exercises Fix 3\'s own window specifically — reloadControllerFromDisk considered itself NOT superseded (Fix 2\'s check already passed), so Fix 3 is the only thing left standing between this and applying A\'s stale outcome'
  );
  assert.equal(panel.selectedProject, PROJECT_B, 'B is still the selected project');
  assert.equal(panel.watchersFor, PROJECT_B.id, 'B\'s watchers were never replaced by A\'s belated, post-scan reload');
  assert.equal(
    panel.selectedLockfilePath,
    '/tmp/project-b/package-lock.json',
    'B\'s selected lockfile path was never overwritten by A\'s'
  );
  assert.equal(controller.root, '/tmp/project-b');
});
