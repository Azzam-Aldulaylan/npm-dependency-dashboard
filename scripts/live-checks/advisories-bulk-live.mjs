/**
 * Live-network check against the real bulk advisories endpoint.
 *
 * This lives outside `test/` on purpose. `node --test`'s auto-discovery picks
 * up any .js/.cjs/.mjs file under a directory named `test` at any depth, plus
 * anything matching *.test.* / test-* / test.* — so nesting or renaming inside
 * `test/` would not have excluded it (verified empirically). Only a path that
 * satisfies neither rule keeps the default `npm test` suite offline.
 *
 * Run with `npm run test:live`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { NodeHttpClient } from '../../out/core/registry/http.js';

test('POST: a real request against the live bulk advisories endpoint round-trips correctly', async () => {
  // This is the one place that actually exercises content-length computation
  // and body writing against a real server, not a mock.
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
