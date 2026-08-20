import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  fetchPackageVersionMetadata,
  MemoryEtagStore,
} from '../out/core/registry/versions.js';
import {
  RegistryPackageMetadataProvider,
  registryForPackage,
} from '../out/core/compatibility/registryMetadataProvider.js';

const response = (body, etag) => ({
  status: 200,
  headers: etag === undefined ? {} : { etag },
  body: JSON.stringify(body),
  wireBytes: 1,
});

test('exact-version metadata preserves peer ranges and optional peer flags', async () => {
  const calls = [];
  const client = {
    async get(url, options) {
      calls.push({ url, options });
      return response({
        name: 'plugin',
        version: '2.0.0',
        dependencies: { runtime: '^1' },
        optionalDependencies: { native: '^3' },
        peerDependencies: { react: '^18 || ^19', optionalHost: '^2' },
        peerDependenciesMeta: { optionalHost: { optional: true } },
      }, '"metadata"');
    },
  };

  const metadata = await fetchPackageVersionMetadata(
    client,
    new MemoryEtagStore(),
    'https://registry.example/',
    'plugin',
    '2.0.0'
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://registry.example/plugin/2.0.0');
  assert.deepEqual(metadata.peerDependencies, { react: '^18 || ^19', optionalHost: '^2' });
  assert.deepEqual(metadata.peerDependenciesMeta, { optionalHost: { optional: true } });
  assert.deepEqual(metadata.dependencies, { runtime: '^1' });
  assert.deepEqual(metadata.optionalDependencies, { native: '^3' });
});

test('scoped package names are encoded and use scoped registry routing lazily', async () => {
  const calls = [];
  const client = {
    async get(url) {
      calls.push(url);
      return response({ name: '@scope/plugin', version: '1.2.0' });
    },
  };
  const registry = {
    url: 'https://registry.example',
    source: 'default',
    scoped: { '@scope': 'https://scope.registry.example/' },
  };
  const provider = new RegistryPackageMetadataProvider(client, new MemoryEtagStore(), registry);

  assert.equal(calls.length, 0, 'construction does not fetch metadata');
  assert.equal(registryForPackage(registry, '@scope/plugin'), 'https://scope.registry.example/');
  await provider.getPackageVersionMetadata('@scope/plugin', '1.2.0');
  assert.deepEqual(calls, ['https://scope.registry.example/@scope%2fplugin/1.2.0']);
});

test('one preflight provider reuses pending and settled exact-version metadata', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const provider = new RegistryPackageMetadataProvider(
    {
      async get() {
        calls += 1;
        await gate;
        return response({ name: 'pkg', version: '2.0.0' });
      },
    },
    new MemoryEtagStore(),
    { url: 'https://registry.example', source: 'default', scoped: {} }
  );

  const first = provider.getPackageVersionMetadata('pkg', '2.0.0');
  const concurrent = provider.getPackageVersionMetadata('pkg', '2.0.0');
  release();
  assert.deepEqual(await first, await concurrent);
  await provider.getPackageVersionMetadata('pkg', '2.0.0');
  assert.equal(calls, 1);
});

test('one preflight provider retries failed exact-version metadata', async () => {
  let calls = 0;
  const provider = new RegistryPackageMetadataProvider(
    {
      async get() {
        calls += 1;
        if (calls === 1) throw new Error('transient registry failure');
        return response({ name: 'pkg', version: '2.0.0' });
      },
    },
    new MemoryEtagStore(),
    { url: 'https://registry.example', source: 'default', scoped: {} }
  );

  await assert.rejects(
    () => provider.getPackageVersionMetadata('pkg', '2.0.0'),
    /transient registry failure/
  );
  await provider.getPackageVersionMetadata('pkg', '2.0.0');
  assert.equal(calls, 2);
});

test('registry metadata with a mismatched exact version is rejected', async () => {
  const client = {
    async get() {
      return response({ name: 'pkg', version: '9.9.9' });
    },
  };
  await assert.rejects(
    () => fetchPackageVersionMetadata(
      client,
      new MemoryEtagStore(),
      'https://registry.example',
      'pkg',
      '1.0.0'
    ),
    /version mismatch/
  );
});

test('unsafe names and non-exact versions are refused before network I/O', async () => {
  let calls = 0;
  const client = {
    async get() {
      calls += 1;
      return response({ name: 'pkg', version: '1.0.0' });
    },
  };
  await assert.rejects(
    () => fetchPackageVersionMetadata(
      client,
      new MemoryEtagStore(),
      'https://registry.example',
      '../escape',
      'latest'
    ),
    /invalid package name or exact version/
  );
  assert.equal(calls, 0);
});

test('prototype-related metadata keys are dropped', async () => {
  const client = {
    async get() {
      return {
        status: 200,
        headers: {},
        body: '{"name":"pkg","version":"1.0.0","peerDependencies":{"__proto__":"*","constructor":"*","safe":"^1"}}',
        wireBytes: 1,
      };
    },
  };
  const metadata = await fetchPackageVersionMetadata(
    client,
    new MemoryEtagStore(),
    'https://registry.example',
    'pkg',
    '1.0.0'
  );
  assert.deepEqual(metadata.peerDependencies, { safe: '^1' });
  assert.equal({}.polluted, undefined);
});
