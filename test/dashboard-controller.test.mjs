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

function makeController(client, overrides = {}) {
  return new DashboardController({
    root: ROOT,
    manifestText: MANIFEST,
    lockfileText: LOCKFILE,
    registry: REGISTRY,
    httpClient: client,
    etagStore: new MemoryEtagStore(),
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

// ------------------------------------------------------------- audit

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
