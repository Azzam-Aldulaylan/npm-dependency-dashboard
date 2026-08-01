/**
 * Hybrid version fetching.
 *
 * Tests run against a fake HttpClient — the point of the port. Nothing here
 * touches the network, so the suite stays deterministic and fast.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  fetchVersionInfo,
  fetchAllVersions,
  fetchLatest,
  needsPackument,
  encodePackageName,
  MemoryEtagStore,
  ABBREVIATED_ACCEPT,
} from '../out/core/registry/versions.js';

const REGISTRY = 'https://registry.npmjs.org';

/**
 * Fake registry. Records every request so tests can assert on which endpoint
 * was hit — that is the whole point of the hybrid rule.
 */
function fakeClient(routes) {
  const calls = [];
  return {
    calls,
    async get(url, options = {}) {
      calls.push({ url, headers: options.headers ?? {} });
      const route = routes[url];
      if (route === undefined) return { status: 404, headers: {}, body: '', wireBytes: 120 };
      return typeof route === 'function' ? route(options) : route;
    },
  };
}

const json = (body, etag) => ({
  status: 200,
  headers: etag === undefined ? {} : { etag },
  body: JSON.stringify(body),
  wireBytes: JSON.stringify(body).length,
});

// ------------------------------------------------------- the hybrid rule

test('needsPackument: latest satisfying the range means Wanted == Latest', () => {
  assert.equal(needsPackument('18.3.0', '^18.0.0', '18.2.0'), false);
});

test('needsPackument: latest outside the range requires the version list', () => {
  assert.equal(needsPackument('19.0.0', '^18.0.0', '18.2.0'), true);
});

test('needsPackument: a prerelease install always requires the version list', () => {
  assert.equal(needsPackument('18.3.0', '*', '18.4.0-beta.1'), true);
});

test('needsPackument: open ranges never need the list', () => {
  for (const range of ['', '*', 'latest']) {
    assert.equal(needsPackument('1.0.0', range, '1.0.0'), false, `range ${JSON.stringify(range)}`);
  }
});

test('the common case costs exactly one request to /latest', async () => {
  const client = fakeClient({
    [`${REGISTRY}/react/latest`]: json({ version: '18.3.0', license: 'MIT' }),
  });

  const info = await fetchVersionInfo(
    { client, store: new MemoryEtagStore(), registry: REGISTRY },
    { name: 'react', range: '^18.0.0', installed: '18.2.0' }
  );

  assert.equal(client.calls.length, 1);
  assert.match(client.calls[0].url, /\/react\/latest$/);
  assert.equal(info.wanted, '18.3.0');
  assert.equal(info.latest, '18.3.0');
  assert.equal(info.license, 'MIT', 'license comes free from /latest');
});

test('escalates to the abbreviated packument when latest leaves the range', async () => {
  const client = fakeClient({
    [`${REGISTRY}/react/latest`]: json({ version: '19.0.0' }),
    [`${REGISTRY}/react`]: json({
      'dist-tags': { latest: '19.0.0' },
      versions: { '18.2.0': {}, '18.3.0': {}, '19.0.0': {} },
    }),
  });

  const info = await fetchVersionInfo(
    { client, store: new MemoryEtagStore(), registry: REGISTRY },
    { name: 'react', range: '^18.0.0', installed: '18.2.0' }
  );

  assert.equal(client.calls.length, 2);
  assert.equal(client.calls[1].headers.accept, ABBREVIATED_ACCEPT);
  // Delegated to resolveWanted/resolveLatest, not recomputed here.
  assert.equal(info.wanted, '18.3.0', 'highest in-range');
  assert.equal(info.latest, '19.0.0', 'highest stable overall');
});

test('the canary rule still holds through the escalation path', async () => {
  const client = fakeClient({
    [`${REGISTRY}/pkg/latest`]: json({ version: '19.2.8' }),
    [`${REGISTRY}/pkg`]: json({
      'dist-tags': { latest: '19.2.8', canary: '19.3.0-canary-abc' },
      versions: { '19.2.7': {}, '19.2.8': {}, '19.3.0-canary-abc': {} },
    }),
  });

  const info = await fetchVersionInfo(
    { client, store: new MemoryEtagStore(), registry: REGISTRY },
    { name: 'pkg', range: '~19.2.7', installed: '19.2.7' }
  );
  assert.equal(info.latest, '19.2.8', 'a canary is never offered to a stable install');
});

test('deprecated is surfaced from /latest', async () => {
  const client = fakeClient({
    [`${REGISTRY}/request/latest`]: json({
      version: '2.88.2',
      deprecated: 'request has been deprecated',
      license: 'Apache-2.0',
    }),
  });
  const info = await fetchVersionInfo(
    { client, store: new MemoryEtagStore(), registry: REGISTRY },
    { name: 'request', range: '^2.0.0', installed: '2.88.2' }
  );
  assert.equal(info.deprecated, 'request has been deprecated');
  assert.equal(info.license, 'Apache-2.0');
});

test('scoped names are URL-encoded', async () => {
  assert.equal(encodePackageName('@types/node'), '@types%2fnode');
  const client = fakeClient({
    [`${REGISTRY}/@types%2fnode/latest`]: json({ version: '20.0.0' }),
  });
  const info = await fetchVersionInfo(
    { client, store: new MemoryEtagStore(), registry: REGISTRY },
    { name: '@types/node', range: '^20.0.0', installed: '20.0.0' }
  );
  assert.equal(info.latest, '20.0.0');
});

// ----------------------------------------------------------------- ETags

test('304 returns zero body bytes and serves the cached copy', async () => {
  const store = new MemoryEtagStore();
  let served = 0;

  const client = fakeClient({
    [`${REGISTRY}/react/latest`]: (options) => {
      served += 1;
      if (options.headers?.['if-none-match'] === 'W/"abc"') {
        // A 304 carries no body at all — only header bytes on the wire.
        return { status: 304, headers: { etag: 'W/"abc"' }, body: '', wireBytes: 0 };
      }
      return json({ version: '18.3.0', license: 'MIT' }, 'W/"abc"');
    },
  });

  const first = await fetchLatest(client, store, REGISTRY, 'react');
  assert.equal(first.version, '18.3.0');
  assert.equal(store.get(`${REGISTRY}/react/latest`).etag, 'W/"abc"');

  const second = await fetchLatest(client, store, REGISTRY, 'react');
  assert.equal(served, 2, 'the request is still made');
  assert.equal(client.calls[1].headers['if-none-match'], 'W/"abc"');
  assert.equal(second.version, '18.3.0', 'served from cache');
  assert.equal(second.license, 'MIT');
});

test('a response without an ETag is not cached, and refetching still works', async () => {
  // Measured: GET /<pkg>/latest sends no ETag (only the abbreviated packument
  // does), so the common path can never be made conditional. Nothing may
  // assume a cache entry exists.
  const store = new MemoryEtagStore();
  const client = fakeClient({
    [`${REGISTRY}/react/latest`]: json({ version: '18.3.0', license: 'MIT' }), // no etag
  });

  const first = await fetchLatest(client, store, REGISTRY, 'react');
  assert.equal(first.version, '18.3.0');
  assert.equal(store.get(`${REGISTRY}/react/latest`), undefined, 'nothing cached without an ETag');

  const second = await fetchLatest(client, store, REGISTRY, 'react');
  assert.equal(second.version, '18.3.0');
  assert.equal(
    client.calls[1]['if-none-match'],
    undefined,
    'no conditional header is sent when nothing is cached'
  );
});

test('a 304 with nothing cached is an error, not a silent empty result', async () => {
  const client = fakeClient({
    [`${REGISTRY}/x/latest`]: { status: 304, headers: {}, body: '', wireBytes: 0 },
  });
  await assert.rejects(
    () => fetchLatest(client, new MemoryEtagStore(), REGISTRY, 'x'),
    /304 .* with nothing cached/
  );
});

// ---------------------------------------------------------- error paths

test('404 becomes a per-row error, not a batch failure', async () => {
  const client = fakeClient({
    [`${REGISTRY}/good/latest`]: json({ version: '1.0.0' }),
    // "gone" is absent from the routes, so the fake returns 404.
    [`${REGISTRY}/also-good/latest`]: json({ version: '2.0.0' }),
  });

  const results = await fetchAllVersions(
    { client, store: new MemoryEtagStore(), registry: REGISTRY },
    [
      { name: 'good', range: '^1.0.0', installed: '1.0.0' },
      { name: 'gone', range: '^1.0.0', installed: '1.0.0' },
      { name: 'also-good', range: '^2.0.0', installed: '2.0.0' },
    ]
  );

  assert.equal(results.length, 3);
  assert.equal(results[0].ok, true);
  assert.equal(results[0].value.latest, '1.0.0');

  assert.equal(results[1].ok, false, 'the missing package fails on its own');
  assert.equal(results[1].error.code, 'REGISTRY_404');

  assert.equal(results[2].ok, true, 'the batch continued past the 404');
  assert.equal(results[2].value.latest, '2.0.0');
});

test('malformed JSON is a PARSE_ERROR on that row only', async () => {
  const client = fakeClient({
    [`${REGISTRY}/bad/latest`]: { status: 200, headers: {}, body: '{not json', wireBytes: 9 },
    [`${REGISTRY}/fine/latest`]: json({ version: '1.0.0' }),
  });

  const results = await fetchAllVersions(
    { client, store: new MemoryEtagStore(), registry: REGISTRY },
    [
      { name: 'bad', range: '*', installed: null },
      { name: 'fine', range: '*', installed: null },
    ]
  );

  assert.equal(results[0].ok, false);
  assert.equal(results[0].error.code, 'PARSE_ERROR');
  assert.equal(results[1].ok, true);
});

test('a 500 is marked retryable; a 404 is not', async () => {
  const client = fakeClient({
    [`${REGISTRY}/boom/latest`]: { status: 503, headers: {}, body: '', wireBytes: 10 },
  });
  const results = await fetchAllVersions(
    { client, store: new MemoryEtagStore(), registry: REGISTRY },
    [
      { name: 'boom', range: '*', installed: null },
      { name: 'missing', range: '*', installed: null },
    ]
  );
  assert.equal(results[0].error.code, 'REGISTRY_5XX');
  assert.equal(results[0].error.retryable, true);
  assert.equal(results[1].error.code, 'REGISTRY_404');
  assert.equal(results[1].error.retryable, false);
});

test('fetchAllVersions respects the concurrency limit', async () => {
  let inFlight = 0;
  let peak = 0;
  const client = {
    async get(url) {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight -= 1;
      return json({ version: '1.0.0' });
    },
  };

  const requests = Array.from({ length: 40 }, (_, i) => ({
    name: `pkg-${i}`,
    range: '*',
    installed: null,
  }));

  await fetchAllVersions({ client, store: new MemoryEtagStore(), registry: REGISTRY }, requests);
  assert.ok(peak <= 8, `peak in-flight ${peak}, expected <= 8`);
});
