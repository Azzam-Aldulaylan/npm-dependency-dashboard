/**
 * Bulk advisories request/response handling.
 *
 * Fixture shapes below were captured live against
 * https://registry.npmjs.org/-/npm/v1/security/advisories/bulk (minimatch@3.0.4,
 * lodash@4.17.15) during development of this test — a clean package is simply
 * absent from the response, not an empty array, and severity/vulnerable_versions
 * come back snake_case.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ADVISORIES_HOST,
  ADVISORIES_PATH,
  buildBulkRequestBody,
  fetchBulkAdvisories,
} from '../out/core/advisories/bulk.js';

function graphOf(nodes) {
  const map = new Map();
  for (const [path, node] of Object.entries(nodes)) {
    map.set(path, { path, deps: [], direct: false, dev: false, range: '', ...node });
  }
  return { root: '/app', lockfileVersion: 3, nodes: map };
}

// ------------------------------------------------------ request body shape

test('buildBulkRequestBody dedupes versions per name and skips unresolvable nodes', () => {
  const graph = graphOf({
    'node_modules/minimatch': { name: 'minimatch', version: '3.0.4' },
    'node_modules/a/node_modules/minimatch': { name: 'minimatch', version: '3.0.4' },
    'node_modules/b/node_modules/minimatch': { name: 'minimatch', version: '5.1.6' },
    'node_modules/workspace-thing': { name: 'workspace-thing', version: null },
  });

  const body = buildBulkRequestBody(graph);
  assert.deepEqual(new Set(body.minimatch), new Set(['3.0.4', '5.1.6']));
  assert.equal('workspace-thing' in body, false, 'unresolvable nodes carry no version to look up');
});

test('an empty graph never calls the endpoint', async () => {
  let called = false;
  const client = { async post() { called = true; return { status: 200, headers: {}, body: '{}', wireBytes: 2 }; } };
  const result = await fetchBulkAdvisories(client, {});
  assert.equal(called, false);
  assert.equal(result.size, 0);
});

// --------------------------------------------------------- response parsing

test('a clean package absent from the response yields no entry', async () => {
  const client = {
    async post(url, body, options) {
      assert.equal(url, `${ADVISORIES_HOST}${ADVISORIES_PATH}`);
      assert.equal(options.headers['content-type'], 'application/json');
      assert.deepEqual(JSON.parse(body), { react: ['18.2.0'] });
      return { status: 200, headers: {}, body: '{}', wireBytes: 2 };
    },
  };
  const result = await fetchBulkAdvisories(client, { react: ['18.2.0'] });
  assert.equal(result.size, 0);
});

test('snake_case advisory fields are mapped onto the camelCase Advisory shape', async () => {
  const raw = {
    minimatch: [
      {
        id: 1113459,
        url: 'https://github.com/advisories/GHSA-3ppc-4f35-3m26',
        title: 'minimatch has a ReDoS via repeated wildcards',
        severity: 'high',
        vulnerable_versions: '<3.1.3',
        cwe: ['CWE-1333'],
        cvss: { score: 7.5, vectorString: null },
      },
    ],
  };
  const client = {
    async post() {
      return { status: 200, headers: {}, body: JSON.stringify(raw), wireBytes: 100 };
    },
  };
  const result = await fetchBulkAdvisories(client, { minimatch: ['3.0.4'] });
  assert.deepEqual(result.get('minimatch'), [
    {
      id: 1113459,
      severity: 'high',
      title: 'minimatch has a ReDoS via repeated wildcards',
      url: 'https://github.com/advisories/GHSA-3ppc-4f35-3m26',
      vulnerableVersions: '<3.1.3',
    },
  ]);
});

test('a malformed advisory entry is dropped, not thrown', async () => {
  const raw = {
    pkg: [
      { id: 1, url: 'u', title: 't', severity: 'not-a-real-severity', vulnerable_versions: '<1' },
      { id: 2, url: 'u', title: 't', severity: 'high', vulnerable_versions: '<1' },
    ],
  };
  const client = { async post() { return { status: 200, headers: {}, body: JSON.stringify(raw), wireBytes: 10 }; } };
  const result = await fetchBulkAdvisories(client, { pkg: ['0.1.0'] });
  assert.equal(result.get('pkg').length, 1);
  assert.equal(result.get('pkg')[0].id, 2);
});

test('a non-200 status becomes a typed FetchError', async () => {
  const client = { async post() { return { status: 503, headers: {}, body: '', wireBytes: 0 }; } };
  await assert.rejects(
    () => fetchBulkAdvisories(client, { pkg: ['1.0.0'] }),
    (err) => {
      assert.equal(err.code, 'REGISTRY_5XX');
      return true;
    }
  );
});

test('unparseable JSON is a PARSE_ERROR', async () => {
  const client = { async post() { return { status: 200, headers: {}, body: 'not json', wireBytes: 8 }; } };
  await assert.rejects(
    () => fetchBulkAdvisories(client, { pkg: ['1.0.0'] }),
    (err) => {
      assert.equal(err.code, 'PARSE_ERROR');
      return true;
    }
  );
});
