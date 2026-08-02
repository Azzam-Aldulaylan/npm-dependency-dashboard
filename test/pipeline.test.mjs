/**
 * buildPackageRows — the composition of S1 + S2 + S3/S3b.
 *
 * Everything runs against a fake HttpClient and a fake AuditRunner, so the
 * suite is deterministic and touches neither the network nor a subprocess.
 * The assertions on WHICH urls were requested matter as much as the row
 * contents: S2's hybrid design exists to avoid fetching the packument for
 * every package, and the pipeline's escalation step must not regress that.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildPackageRows } from '../out/core/pipeline.js';
import { MemoryEtagStore } from '../out/core/registry/versions.js';
import { currentVersionDisplay } from '../out/host/versionDisplay.js';

const REGISTRY = 'https://registry.npmjs.org';
const BULK = 'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk';
const ROOT = '/tmp/project';

function fakeClient(getRoutes, postRoute) {
  const calls = [];
  const posts = [];
  return {
    calls,
    posts,
    get urls() {
      return calls.map((c) => c.url);
    },
    async get(url, options = {}) {
      calls.push({ url, headers: options.headers ?? {} });
      const route = getRoutes[url];
      if (route === undefined) return { status: 404, headers: {}, body: '', wireBytes: 120 };
      return typeof route === 'function' ? route(options) : route;
    },
    async post(url, body, options = {}) {
      posts.push({ url, body: JSON.parse(body), headers: options.headers ?? {} });
      if (postRoute === undefined) return { status: 200, headers: {}, body: '{}', wireBytes: 2 };
      return typeof postRoute === 'function' ? postRoute(body) : postRoute;
    },
  };
}

const json = (body) => ({
  status: 200,
  headers: {},
  body: JSON.stringify(body),
  wireBytes: JSON.stringify(body).length,
});

function fakeAuditRunner(stdout, exitCode = 1) {
  return {
    calls: [],
    async run(cwd) {
      this.calls.push(cwd);
      return { stdout, exitCode };
    },
  };
}

const MANIFEST = JSON.stringify({
  name: 'app',
  version: '1.0.0',
  dependencies: { 'clean-pkg': '^1.0.0', minimatch: '^3.0.0' },
});

const LOCKFILE = JSON.stringify({
  name: 'app',
  lockfileVersion: 3,
  packages: {
    '': { name: 'app', version: '1.0.0', dependencies: { 'clean-pkg': '^1.0.0', minimatch: '^3.0.0' } },
    'node_modules/clean-pkg': { version: '1.0.0' },
    'node_modules/minimatch': { version: '3.0.4' },
  },
});

const MINIMATCH_ADVISORY = {
  id: 1096549,
  severity: 'high',
  title: 'minimatch ReDoS vulnerability',
  url: 'https://github.com/advisories/GHSA-f8q6-p94x-37v3',
  vulnerable_versions: '<=3.1.3',
};

const BULK_RESPONSE = json({ minimatch: [MINIMATCH_ADVISORY] });

const LATEST_ROUTES = {
  [`${REGISTRY}/clean-pkg/latest`]: json({ version: '1.0.1', license: 'MIT' }),
  [`${REGISTRY}/minimatch/latest`]: json({ version: '3.1.5', license: 'ISC' }),
};

const MINIMATCH_PACKUMENT = json({
  'dist-tags': { latest: '3.1.5' },
  versions: { '3.0.4': {}, '3.0.8': {}, '3.1.5': {} },
});

const AUDIT_MINIMATCH = JSON.stringify({
  auditReportVersion: 2,
  vulnerabilities: {
    minimatch: {
      name: 'minimatch',
      severity: 'high',
      isDirect: true,
      via: [],
      effects: [],
      range: '<=3.1.3',
      nodes: ['node_modules/minimatch'],
      fixAvailable: { name: 'minimatch', version: '3.1.5', isSemVerMajor: false },
    },
  },
});

const AUDIT_MINIMATCH_BOOLEAN_FIX = JSON.stringify({
  auditReportVersion: 2,
  vulnerabilities: {
    minimatch: {
      name: 'minimatch',
      severity: 'high',
      isDirect: true,
      via: [],
      effects: [],
      range: '<=3.1.3',
      nodes: ['node_modules/minimatch'],
      fixAvailable: true,
    },
  },
});

function baseOptions(client, extra = {}) {
  return {
    root: ROOT,
    manifestText: MANIFEST,
    lockfileText: LOCKFILE,
    registry: REGISTRY,
    httpClient: client,
    etagStore: new MemoryEtagStore(),
    ...extra,
  };
}

const rowFor = (result, name) => result.rows.find((r) => r.name === name);

// ------------------------------------------------------------ happy path

test('a clean row and a vulnerable row are both fully populated', async () => {
  const client = fakeClient(LATEST_ROUTES, BULK_RESPONSE);
  const runner = fakeAuditRunner(AUDIT_MINIMATCH);

  const result = await buildPackageRows(baseOptions(client, { auditRunner: runner }));

  assert.equal(result.rows.length, 2);
  assert.equal(result.advisoriesError, undefined);
  assert.equal(result.auditUnavailable, undefined);
  assert.deepEqual(runner.calls, [ROOT], 'audit runs against the project root');

  const clean = rowFor(result, 'clean-pkg');
  assert.equal(clean.current, '1.0.0');
  assert.equal(clean.wanted, '1.0.1');
  assert.equal(clean.latest, '1.0.1');
  assert.deepEqual(clean.advisories, []);
  assert.equal(clean.worstSeverity, null);
  assert.equal(clean.upgradeTo, null);

  const vulnerable = rowFor(result, 'minimatch');
  assert.equal(vulnerable.current, '3.0.4');
  assert.equal(vulnerable.wanted, '3.1.5');
  assert.equal(vulnerable.worstSeverity, 'high');
  assert.equal(vulnerable.advisories.length, 1);
  assert.deepEqual(vulnerable.advisories[0].path, ['minimatch'], 'flagged at its own version');
  assert.equal(vulnerable.upgradeTo, '3.1.5', "audit's fixAvailable is authoritative");

  // The bulk request carries every (name, version) pair in the tree.
  assert.equal(client.posts.length, 1);
  assert.equal(client.posts[0].url, BULK);
  assert.deepEqual(client.posts[0].body, { 'clean-pkg': ['1.0.0'], minimatch: ['3.0.4'] });
});

test('a usable fixAvailable suppresses the packument escalation entirely', async () => {
  // The cost-conscious half of step 6: when audit answers, the full version
  // list is never needed, so it is never fetched.
  const client = fakeClient({ ...LATEST_ROUTES, [`${REGISTRY}/minimatch`]: MINIMATCH_PACKUMENT }, BULK_RESPONSE);

  const result = await buildPackageRows(
    baseOptions(client, { auditRunner: fakeAuditRunner(AUDIT_MINIMATCH) })
  );

  assert.equal(rowFor(result, 'minimatch').upgradeTo, '3.1.5');
  assert.deepEqual(client.urls, [`${REGISTRY}/clean-pkg/latest`, `${REGISTRY}/minimatch/latest`]);
});

test('fixAvailable: true fetches the packument and offers only a verified clean version', async () => {
  const client = fakeClient(
    { ...LATEST_ROUTES, [`${REGISTRY}/minimatch`]: MINIMATCH_PACKUMENT },
    BULK_RESPONSE
  );

  const result = await buildPackageRows(
    baseOptions(client, { auditRunner: fakeAuditRunner(AUDIT_MINIMATCH_BOOLEAN_FIX) })
  );

  assert.ok(client.urls.includes(`${REGISTRY}/minimatch`), 'the version list is fetched for verification');
  assert.equal(rowFor(result, 'minimatch').upgradeTo, '3.1.5');
});

// ------------------------------------------------- graceful degradation

test('a failed bulk fetch still returns rows, with advisories emptied', async () => {
  const client = fakeClient(LATEST_ROUTES, { status: 503, headers: {}, body: '', wireBytes: 10 });

  const result = await buildPackageRows(
    baseOptions(client, { auditRunner: fakeAuditRunner(AUDIT_MINIMATCH) })
  );

  assert.equal(result.advisoriesError.code, 'REGISTRY_5XX');
  assert.equal(result.advisoriesError.retryable, true);
  assert.equal(result.rows.length, 2, 'rows are still produced');
  for (const row of result.rows) {
    assert.deepEqual(row.advisories, []);
    assert.equal(row.worstSeverity, null);
    assert.equal(row.upgradeTo, null, 'no advisories means nothing to upgrade away from');
  }
  // Version data is unaffected by the advisory failure.
  assert.equal(rowFor(result, 'minimatch').wanted, '3.1.5');
});

test('unparseable bulk JSON is an advisoriesError, not a thrown pipeline', async () => {
  const client = fakeClient(LATEST_ROUTES, { status: 200, headers: {}, body: '{not json', wireBytes: 9 });
  const result = await buildPackageRows(baseOptions(client));
  assert.equal(result.advisoriesError.code, 'PARSE_ERROR');
  assert.equal(result.rows.length, 2);
});

test('with no audit runner the self-computed fallback still finds a fix', async () => {
  // Proves the escalation fires exactly where it is needed: minimatch is
  // flagged at its own version and has no fixAvailable, so its version list is
  // required; clean-pkg's is not.
  const client = fakeClient({ ...LATEST_ROUTES, [`${REGISTRY}/minimatch`]: MINIMATCH_PACKUMENT }, BULK_RESPONSE);

  const result = await buildPackageRows(baseOptions(client));

  assert.equal(result.auditUnavailable, true);
  assert.equal(rowFor(result, 'minimatch').upgradeTo, '3.1.5', 'highest in-range non-vulnerable');
  assert.equal(rowFor(result, 'clean-pkg').upgradeTo, null);

  assert.ok(client.urls.includes(`${REGISTRY}/minimatch`), 'escalated for the flagged package');
  assert.equal(
    client.urls.includes(`${REGISTRY}/clean-pkg`),
    false,
    'never escalated for a clean package'
  );
});

test('garbage on audit stdout degrades to the same fallback', async () => {
  const client = fakeClient({ ...LATEST_ROUTES, [`${REGISTRY}/minimatch`]: MINIMATCH_PACKUMENT }, BULK_RESPONSE);

  const result = await buildPackageRows(
    baseOptions(client, { auditRunner: fakeAuditRunner('npm ERR! code ENOLOCK', 1) })
  );

  assert.equal(result.auditUnavailable, true);
  assert.equal(rowFor(result, 'minimatch').upgradeTo, '3.1.5');
});

test('an audit runner that fails to spawn is not fatal', async () => {
  const client = fakeClient({ ...LATEST_ROUTES, [`${REGISTRY}/minimatch`]: MINIMATCH_PACKUMENT }, BULK_RESPONSE);
  const runner = {
    async run() {
      throw Object.assign(new Error('spawn npm ENOENT'), { code: 'ENOENT' });
    },
  };

  const result = await buildPackageRows(baseOptions(client, { auditRunner: runner }));

  assert.equal(result.auditUnavailable, true);
  assert.equal(result.rows.length, 2);
  assert.equal(rowFor(result, 'minimatch').upgradeTo, '3.1.5');
});

test('a failed packument escalation leaves the row intact with no upgrade offered', async () => {
  // The packument route is absent, so the escalation 404s.
  const client = fakeClient(LATEST_ROUTES, BULK_RESPONSE);
  const result = await buildPackageRows(baseOptions(client));

  const row = rowFor(result, 'minimatch');
  assert.equal(row.worstSeverity, 'high', 'the advisory is still reported');
  assert.equal(row.upgradeTo, null, 'no version list means nothing safe to offer');
});

test("one package's version fetch failing does not disturb the other rows", async () => {
  const client = fakeClient(
    {
      [`${REGISTRY}/clean-pkg/latest`]: LATEST_ROUTES[`${REGISTRY}/clean-pkg/latest`],
      // minimatch/latest is absent, so the fake returns 404.
    },
    json({})
  );

  const result = await buildPackageRows(baseOptions(client));

  assert.equal(result.rows.length, 2);
  const failed = rowFor(result, 'minimatch');
  assert.equal(failed.current, '3.0.4', 'the lockfile-resolved version is still known');
  assert.equal(failed.wanted, null);
  assert.equal(failed.latest, null);

  const ok = rowFor(result, 'clean-pkg');
  assert.equal(ok.wanted, '1.0.1');
  assert.equal(ok.latest, '1.0.1');
});

// ------------------------------------------------------ misattribution

test('a fixAvailable naming a non-direct package never lands on another row', async () => {
  // The end-to-end form of the task-3 validation: audit's only fix names
  // `express`, which is not a dependency of this project at all.
  const auditStdout = JSON.stringify({
    vulnerabilities: {
      'body-parser': {
        name: 'body-parser',
        isDirect: false,
        fixAvailable: { name: 'express', version: '4.22.2', isSemVerMajor: false },
      },
    },
  });
  const client = fakeClient({ ...LATEST_ROUTES, [`${REGISTRY}/minimatch`]: MINIMATCH_PACKUMENT }, BULK_RESPONSE);

  const result = await buildPackageRows(
    baseOptions(client, { auditRunner: fakeAuditRunner(auditStdout) })
  );

  assert.equal(result.auditUnavailable, undefined, 'audit itself worked fine');
  for (const row of result.rows) {
    assert.notEqual(row.upgradeTo, '4.22.2', `${row.name} must not inherit express's fix`);
  }
  assert.equal(rowFor(result, 'clean-pkg').upgradeTo, null);
  assert.equal(
    rowFor(result, 'minimatch').upgradeTo,
    '3.1.5',
    'the dropped fix falls through to the self-computed value'
  );
});

// -------------------------------------------------- unresolvable nodes

test('a workspace-linked dependency is tagged and never looked up', async () => {
  const manifestText = JSON.stringify({
    name: 'root',
    dependencies: { '@app/shared': '^1.0.0', minimatch: '^3.0.0' },
  });
  const lockfileText = JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': { name: 'root', dependencies: { '@app/shared': '^1.0.0', minimatch: '^3.0.0' } },
      'packages/shared': { name: '@app/shared', version: '1.0.0' },
      'node_modules/@app/shared': { resolved: 'packages/shared', link: true },
      'node_modules/minimatch': { version: '3.0.4' },
    },
  });
  const client = fakeClient(LATEST_ROUTES, BULK_RESPONSE);

  const result = await buildPackageRows(
    baseOptions(client, { manifestText, lockfileText, auditRunner: fakeAuditRunner(AUDIT_MINIMATCH) })
  );

  const linked = rowFor(result, '@app/shared');
  assert.ok(linked !== undefined, 'the linked package still gets a row');
  assert.equal(linked.unresolvable, 'workspace-link');
  // No real installed version — current stays null (never the range itself;
  // that would break upgrade-eligibility's `current === null` safety check).
  // The declared range is still carried on the row for display purposes.
  assert.equal(linked.current, null);
  assert.equal(linked.range, '^1.0.0', 'the declared range is preserved for the Current column fallback');
  assert.deepEqual(
    currentVersionDisplay(linked.current, linked.range, linked.unresolvable),
    { kind: 'declared-range', value: '^1.0.0', tag: 'workspace-link' },
    'the UI falls back to the declared spec/range, tagged workspace-link, instead of a bare dash'
  );
  assert.equal(linked.wanted, null);
  assert.equal(linked.latest, null);
  assert.equal(linked.upgradeTo, null, 'never offered without a real installed version');

  assert.equal(
    client.urls.some((u) => u.includes('%2fshared') || u.includes('@app')),
    false,
    'no registry request is ever made for a workspace link'
  );
  assert.equal('@app/shared' in client.posts[0].body, false, 'excluded from the bulk request too');

  // The rest of the table is unaffected.
  assert.equal(rowFor(result, 'minimatch').upgradeTo, '3.1.5');
});

test('with no lockfile every declared dependency still gets a tagged row, in order', async () => {
  const manifestText = JSON.stringify({
    name: 'app',
    dependencies: { alpha: '^1.0.0', bravo: '^2.0.0', charlie: '^3.0.0' },
  });
  const client = fakeClient({}, json({}));

  const result = await buildPackageRows(baseOptions(client, { manifestText, lockfileText: null }));

  assert.deepEqual(
    result.rows.map((r) => r.name),
    ['alpha', 'bravo', 'charlie'],
    'declaration order is preserved'
  );
  const expectedRanges = { alpha: '^1.0.0', bravo: '^2.0.0', charlie: '^3.0.0' };
  for (const row of result.rows) {
    assert.equal(row.unresolvable, 'no-lockfile');
    // No lockfile means no real installed version — current stays null, the
    // registry is never asked, and no upgrade is ever offered; the declared
    // range is still carried on the row so Current can show it instead of a
    // bare dash.
    assert.equal(row.current, null);
    assert.equal(row.range, expectedRanges[row.name]);
    assert.deepEqual(currentVersionDisplay(row.current, row.range, row.unresolvable), {
      kind: 'declared-range',
      value: expectedRanges[row.name],
      tag: 'no-lockfile',
    });
    assert.equal(row.wanted, null);
    assert.equal(row.upgradeTo, null, 'never offered without a real installed version');
  }
  assert.equal(client.calls.length, 0, 'nothing resolvable, so nothing is fetched');
  assert.equal(client.posts.length, 0, 'an empty bulk body is not sent at all');
});

test('a declared dependency missing from an otherwise-present lockfile is untagged in the graph but still shown with an "unresolved" tag, and its Wanted/Latest lookup is preserved', async () => {
  // Not the "no lockfile at all" case above, and not a workspace-link/file:/
  // git:/alias/tarball specifier either — a lockfile genuinely exists, this
  // one dependency is just absent from it (declared in package.json but
  // `npm install` hasn't run since, or the lockfile has drifted). The graph
  // correctly leaves `unresolvable` undefined for it (it's a normal,
  // resolvable semver range) — the regression this test guards is the
  // DISPLAY layer wrongly treating "no tag" as "this must be a real
  // resolved version" just because `unresolvable` happens to be undefined.
  const manifestText = JSON.stringify({
    name: 'app',
    dependencies: { 'clean-pkg': '^1.0.0', 'never-installed': '^2.0.0' },
  });
  const lockfileText = JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': { name: 'app', dependencies: { 'clean-pkg': '^1.0.0', 'never-installed': '^2.0.0' } },
      'node_modules/clean-pkg': { version: '1.0.0' },
      // 'never-installed' has no entry at all.
    },
  });
  const client = fakeClient(
    { ...LATEST_ROUTES, [`${REGISTRY}/never-installed/latest`]: json({ version: '2.5.0', license: 'MIT' }) },
    json({})
  );

  const result = await buildPackageRows(baseOptions(client, { manifestText, lockfileText }));

  const missing = rowFor(result, 'never-installed');
  assert.ok(missing !== undefined, 'still gets a row');
  assert.equal(
    missing.unresolvable,
    undefined,
    'not classified as unresolvable — a normal, resolvable specifier, just absent from the lockfile'
  );
  assert.equal(missing.current, null, 'no real installed version');
  assert.equal(missing.range, '^2.0.0');

  // Preserved: Wanted/Latest lookup is NOT skipped, unlike a genuinely
  // unresolvable node (workspace link, file:/git:, or no lockfile at all).
  assert.equal(missing.wanted, '2.5.0');
  assert.equal(missing.latest, '2.5.0');
  assert.equal(
    client.urls.includes(`${REGISTRY}/never-installed/latest`),
    true,
    'the registry IS asked for this package'
  );

  assert.equal(missing.upgradeTo, null, 'never offered without a real installed version');

  // The actual regression: without a display-layer fix, this would render
  // as a bare, untagged "^2.0.0" — indistinguishable from a real
  // lockfile-resolved version.
  assert.deepEqual(currentVersionDisplay(missing.current, missing.range, missing.unresolvable), {
    kind: 'declared-range',
    value: '^2.0.0',
    tag: 'unresolved',
  });

  // The rest of the table is unaffected.
  assert.equal(rowFor(result, 'clean-pkg').current, '1.0.0');
});

// ------------------------------------------------------------- plumbing

test('the concurrency limit reaches the version-fetch pool', async () => {
  let inFlight = 0;
  let peak = 0;
  const client = {
    async get() {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight -= 1;
      return json({ version: '1.0.0' });
    },
    async post() {
      return json({});
    },
  };

  const names = Array.from({ length: 12 }, (_, i) => `pkg-${i}`);
  const manifestText = JSON.stringify({
    dependencies: Object.fromEntries(names.map((n) => [n, '^1.0.0'])),
  });
  const lockfileText = JSON.stringify({
    lockfileVersion: 3,
    packages: Object.fromEntries([
      ['', { name: 'app' }],
      ...names.map((n) => [`node_modules/${n}`, { version: '1.0.0' }]),
    ]),
  });

  const result = await buildPackageRows(
    baseOptions(client, { manifestText, lockfileText, concurrency: 2 })
  );

  assert.equal(result.rows.length, 12);
  assert.equal(peak, 2, 'the pool saturates at the requested limit, and no higher');
});

test('an already-aborted signal rejects immediately, not a result with partial rows', async () => {
  // Cancellation is not a degraded-data case like a dead registry — the
  // caller no longer wants a result at all, so this must reject rather than
  // resolve with rows built from work that never should have started.
  const controller = new AbortController();
  controller.abort();
  const client = fakeClient(LATEST_ROUTES, BULK_RESPONSE);

  await assert.rejects(
    () => buildPackageRows(baseOptions(client, { signal: controller.signal })),
    (err) => {
      assert.equal(err.code, 'CANCELLED');
      return true;
    }
  );
});

test('a signal aborted mid-run stops before later stages run', async () => {
  // The abort fires from inside the bulk-advisories POST itself, simulating
  // cancellation racing a call that happens to complete anyway. The stage
  // boundary check right after must still catch it and stop before audit
  // ever runs — proving this isn't just a pre-flight check.
  const controller = new AbortController();
  const client = fakeClient(LATEST_ROUTES, () => {
    controller.abort();
    return BULK_RESPONSE;
  });
  const runner = fakeAuditRunner(AUDIT_MINIMATCH);

  await assert.rejects(
    () => buildPackageRows(baseOptions(client, { signal: controller.signal, auditRunner: runner })),
    (err) => {
      assert.equal(err.code, 'CANCELLED');
      return true;
    }
  );
  assert.deepEqual(runner.calls, [], 'audit never ran — the pipeline stopped before that stage');
});
