/**
 * NodeHttpClient — the parts testable without a network.
 *
 * The transport itself is exercised live during development; these cover the
 * input-validation boundary, where a bad value must surface as a FetchError
 * rather than an unrelated runtime exception.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  NodeHttpClient,
  FetchError,
  errorForStatus,
  MAX_RESPONSE_BYTES,
} from '../out/core/registry/http.js';

test('an undefined header value does not crash the request', async () => {
  // node:https throws ERR_HTTP_INVALID_HEADER_VALUE on an undefined value.
  // Callers build headers from optional values (a cached ETag that may not
  // exist), so empties are dropped rather than escaping the FetchError
  // contract. Reaching a network error here means it got past header
  // validation, which is the point.
  const client = new NodeHttpClient();
  await assert.rejects(
    () =>
      client.get('https://invalid.invalid/x', {
        headers: { accept: 'application/json', 'if-none-match': undefined },
        timeoutMs: 2000,
      }),
    (err) => {
      assert.ok(err instanceof FetchError, `expected FetchError, got ${err?.constructor?.name}`);
      assert.notEqual(err.code, 'BAD_URL');
      return true;
    }
  );
});

test('non-https URLs are refused', async () => {
  const client = new NodeHttpClient();
  await assert.rejects(() => client.get('http://registry.npmjs.org/react/latest'), (err) => {
    assert.equal(err.code, 'BAD_URL');
    return true;
  });
});

test('a malformed URL is a BAD_URL error', async () => {
  const client = new NodeHttpClient();
  await assert.rejects(() => client.get('not-a-url'), (err) => {
    assert.equal(err.code, 'BAD_URL');
    return true;
  });
});

test('an already-aborted signal is refused before the socket opens', async () => {
  const controller = new AbortController();
  controller.abort();
  const client = new NodeHttpClient();
  await assert.rejects(
    () => client.get('https://registry.npmjs.org/react/latest', { signal: controller.signal }),
    (err) => {
      assert.equal(err.code, 'CANCELLED');
      return true;
    }
  );
});

test('status codes map to typed, correctly-retryable errors', () => {
  assert.equal(errorForStatus(404, 'u').code, 'REGISTRY_404');
  assert.equal(errorForStatus(404, 'u').retryable, false);
  assert.equal(errorForStatus(429, 'u').code, 'RATE_LIMITED');
  assert.equal(errorForStatus(503, 'u').code, 'REGISTRY_5XX');
  assert.equal(errorForStatus(503, 'u').retryable, true);
  assert.equal(errorForStatus(418, 'u').code, 'NETWORK');
});

test('the response size cap is set to something sane', () => {
  assert.equal(MAX_RESPONSE_BYTES, 10 * 1024 * 1024);
});

// -------------------------------------------------------------------- POST

test('POST: an undefined header value does not crash the request', async () => {
  const client = new NodeHttpClient();
  await assert.rejects(
    () =>
      client.post('https://invalid.invalid/x', '{}', {
        headers: { 'content-type': 'application/json', 'if-none-match': undefined },
        timeoutMs: 2000,
      }),
    (err) => {
      assert.ok(err instanceof FetchError, `expected FetchError, got ${err?.constructor?.name}`);
      assert.notEqual(err.code, 'BAD_URL');
      return true;
    }
  );
});

test('POST: non-https URLs are refused', async () => {
  const client = new NodeHttpClient();
  await assert.rejects(() => client.post('http://registry.npmjs.org/x', '{}'), (err) => {
    assert.equal(err.code, 'BAD_URL');
    return true;
  });
});

test('POST: a malformed URL is a BAD_URL error', async () => {
  const client = new NodeHttpClient();
  await assert.rejects(() => client.post('not-a-url', '{}'), (err) => {
    assert.equal(err.code, 'BAD_URL');
    return true;
  });
});

test('POST: an already-aborted signal is refused before the socket opens', async () => {
  const controller = new AbortController();
  controller.abort();
  const client = new NodeHttpClient();
  await assert.rejects(
    () =>
      client.post('https://registry.npmjs.org/-/npm/v1/security/advisories/bulk', '{}', {
        signal: controller.signal,
      }),
    (err) => {
      assert.equal(err.code, 'CANCELLED');
      return true;
    }
  );
});

test('POST: a real request against the live bulk advisories endpoint round-trips correctly', async () => {
  // Live-network check, same spirit as the GET tests above: this is the one
  // place that actually exercises content-length computation and body
  // writing against a real server, not a mock.
  const client = new NodeHttpClient();
  const body = JSON.stringify({ minimatch: ['3.0.4'], react: ['18.2.0'] });

  const response = await client.post(
    'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk',
    body,
    { headers: { 'content-type': 'application/json', accept: 'application/json' }, timeoutMs: 10_000 }
  );

  assert.equal(response.status, 200);
  const parsed = JSON.parse(response.body);
  assert.ok(Array.isArray(parsed.minimatch) && parsed.minimatch.length > 0, 'minimatch@3.0.4 has known advisories');
  assert.equal('react' in parsed, false, 'a clean package at the queried version is absent, not empty');
  assert.ok(
    parsed.minimatch.every(
      (a) =>
        typeof a.id !== 'undefined' &&
        typeof a.severity === 'string' &&
        typeof a.vulnerable_versions === 'string'
    )
  );
});
