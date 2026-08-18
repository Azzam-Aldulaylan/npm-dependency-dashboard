/**
 * End-to-end: buildPackageRows attaches deprecated + duplicate-version
 * hygiene findings, reusing the graph it already built for S1 — no second
 * lockfile parse, no extra registry call beyond what S2 already does.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildPackageRows } from '../out/core/pipeline.js';
import { MemoryEtagStore } from '../out/core/registry/versions.js';

const REGISTRY = 'https://registry.npmjs.org';
const ROOT = '/tmp/hygiene-project';

function fakeClient(getRoutes) {
  return {
    async get(url) {
      const route = getRoutes[url];
      if (route === undefined) return { status: 404, headers: {}, body: '', wireBytes: 10 };
      return route;
    },
    async post() {
      return { status: 200, headers: {}, body: '{}', wireBytes: 2 };
    },
  };
}

const json = (body) => ({ status: 200, headers: {}, body: JSON.stringify(body), wireBytes: JSON.stringify(body).length });

const MANIFEST = JSON.stringify({
  name: 'app',
  dependencies: { 'old-pkg': '^1.0.0', 'dup-a': '^1.0.0', 'dup-b': '^1.0.0' },
});

const LOCKFILE = JSON.stringify({
  name: 'app',
  lockfileVersion: 3,
  packages: {
    '': { name: 'app', version: '1.0.0', dependencies: { 'old-pkg': '^1.0.0', 'dup-a': '^1.0.0', 'dup-b': '^1.0.0' } },
    'node_modules/old-pkg': { version: '1.0.0' },
    'node_modules/dup-a': { version: '1.0.0', dependencies: { shared: '^1.0.0' } },
    'node_modules/dup-b': { version: '1.0.0', dependencies: { shared: '^2.0.0' } },
    'node_modules/dup-a/node_modules/shared': { version: '1.0.0' },
    'node_modules/dup-b/node_modules/shared': { version: '2.0.0' },
  },
});

test('buildPackageRows attaches a deprecated finding and a duplicate-version finding from one scan', async () => {
  const routes = {
    [`${REGISTRY}/old-pkg/latest`]: json({ version: '1.0.0', deprecated: 'This package is no longer maintained.' }),
    [`${REGISTRY}/dup-a/latest`]: json({ version: '1.0.0' }),
    [`${REGISTRY}/dup-b/latest`]: json({ version: '1.0.0' }),
  };

  const result = await buildPackageRows({
    root: ROOT,
    manifestText: MANIFEST,
    lockfileText: LOCKFILE,
    registry: REGISTRY,
    httpClient: fakeClient(routes),
    etagStore: new MemoryEtagStore(),
  });

  assert.equal(result.rows.find((r) => r.name === 'old-pkg').deprecated, 'This package is no longer maintained.');

  const deprecated = result.hygieneFindings.find((f) => f.kind === 'deprecated');
  assert.ok(deprecated, 'expected a deprecated finding');
  assert.equal(deprecated.packageName, 'old-pkg');

  const duplicate = result.hygieneFindings.find((f) => f.kind === 'duplicate-version');
  assert.ok(duplicate, 'expected a duplicate-version finding');
  assert.equal(duplicate.packageName, 'shared');
  assert.deepEqual(
    duplicate.evidence.versions.map((v) => v.version),
    ['1.0.0', '2.0.0']
  );
});

test('a clean project (nothing deprecated, nothing duplicated) produces no hygiene findings', async () => {
  const manifest = JSON.stringify({ name: 'app', dependencies: { clean: '^1.0.0' } });
  const lockfile = JSON.stringify({
    name: 'app',
    lockfileVersion: 3,
    packages: {
      '': { name: 'app', version: '1.0.0', dependencies: { clean: '^1.0.0' } },
      'node_modules/clean': { version: '1.0.0' },
    },
  });
  const routes = { [`${REGISTRY}/clean/latest`]: json({ version: '1.0.0' }) };

  const result = await buildPackageRows({
    root: ROOT,
    manifestText: manifest,
    lockfileText: lockfile,
    registry: REGISTRY,
    httpClient: fakeClient(routes),
    etagStore: new MemoryEtagStore(),
  });

  assert.deepEqual(result.hygieneFindings, []);
});
