import assert from 'node:assert/strict';
import test from 'node:test';

import {
  loadUpgradeTargets,
  MAX_PRERELEASE_UPGRADE_TARGETS,
  MAX_STABLE_UPGRADE_TARGETS,
  publishedUpgradeTargetsForRequest,
  selectUpgradeTargets,
  selectUpgradeTargetsFromDistTags,
} from '../out/core/upgrade/targets.js';
import { FetchError } from '../out/core/registry/http.js';
import { MemoryEtagStore } from '../out/core/registry/versions.js';

function packument(versions, distTags = {}) {
  return { versions, distTags };
}

test('a valid stable lts tag ahead of installed is the recommended target', () => {
  const result = selectUpgradeTargets(
    packument(['4.0.0', '5.4.2', '6.0.0'], { lts: '5.4.2', latest: '6.0.0' }),
    '4.0.0',
    '6.0.0'
  );
  assert.equal(result.recommendedVersion, '5.4.2');
  assert.deepEqual(result.options[0], {
    version: '5.4.2',
    channel: 'stable',
    labels: ['recommended', 'lts'],
  });
});

test('a package without lts recommends its stable latest dist-tag', () => {
  const result = selectUpgradeTargets(
    packument(['1.0.0', '2.0.0', '3.0.0-beta.1'], { latest: '2.0.0', next: '3.0.0-beta.1' }),
    '1.0.0',
    null
  );
  assert.equal(result.recommendedVersion, '2.0.0');
  assert.deepEqual(result.options[0].labels, ['recommended', 'latest']);
});

test('an lts target older than installed never causes a downgrade', () => {
  const result = selectUpgradeTargets(
    packument(['4.0.0', '5.0.0', '6.0.0'], { lts: '4.0.0', latest: '6.0.0' }),
    '5.0.0',
    '6.0.0'
  );
  assert.equal(result.recommendedVersion, '6.0.0');
  assert.equal(result.options.some((option) => option.version === '4.0.0'), false);
});

test('a prerelease latest tag is never selected by default', () => {
  const result = selectUpgradeTargets(
    packument(['1.0.0', '1.5.0', '2.0.0-beta.2'], { latest: '2.0.0-beta.2' }),
    '1.0.0',
    '1.5.0'
  );
  assert.equal(result.recommendedVersion, '1.5.0');
  assert.equal(result.options.at(-1).channel, 'prerelease');
  assert.deepEqual(result.options.at(-1).labels, []);
});

test('explicit prerelease choices remain available and clearly classified', () => {
  const result = selectUpgradeTargets(
    packument(['1.0.0', '1.1.0', '2.0.0-beta.1', '2.0.0-beta.2'], { latest: '1.1.0', next: '2.0.0-beta.2' }),
    '1.0.0',
    '1.1.0'
  );
  assert.deepEqual(
    result.options.filter((option) => option.channel === 'prerelease').map((option) => option.version),
    ['2.0.0-beta.2', '2.0.0-beta.1']
  );
});

test('malformed or unpublished tags fall back without inventing a target', () => {
  const result = selectUpgradeTargets(
    packument(['1.0.0', '1.2.0'], { lts: 'banana', latest: '9.9.9' }),
    '1.0.0',
    '1.2.0'
  );
  assert.equal(result.recommendedVersion, '1.2.0');
  assert.deepEqual(result.options[0].labels, ['recommended']);
});

test('a huge version history is bounded while preserving representative lines', () => {
  const stable = Array.from({ length: 160 }, (_, index) => {
    const major = 1 + Math.floor(index / 40);
    const minor = Math.floor((index % 40) / 4);
    const patch = index % 4;
    return `${major}.${minor}.${patch}`;
  });
  const prerelease = Array.from({ length: 20 }, (_, index) => `6.0.0-beta.${index + 1}`);
  const result = selectUpgradeTargets(
    packument(['1.0.0', ...stable, ...prerelease], { latest: '4.9.3', next: '6.0.0-beta.20' }),
    '1.0.0',
    '4.9.3'
  );
  assert.ok(result.options.filter((option) => option.channel === 'stable').length <= MAX_STABLE_UPGRADE_TARGETS);
  assert.ok(result.options.filter((option) => option.channel === 'prerelease').length <= MAX_PRERELEASE_UPGRADE_TARGETS);
  assert.equal(result.options[0].version, '4.9.3');
  assert.equal(result.truncated, true);
});

test('tag-only selection keeps useful maintained lines when a complete history is unavailable', () => {
  const result = selectUpgradeTargetsFromDistTags(
    {
      'next-14': '14.2.35',
      'next-15-3': '15.3.9',
      backport: '15.5.24',
      latest: '16.3.3',
      canary: '16.4.0-canary.8',
    },
    '14.2.35',
    '16.3.3'
  );
  assert.equal(result.recommendedVersion, '16.3.3');
  assert.deepEqual(
    result.options.filter((option) => option.channel === 'stable').map((option) => option.version),
    ['16.3.3', '15.5.24', '15.3.9']
  );
  assert.equal(result.options.at(-1).version, '16.4.0-canary.8');
});

test('an oversized packument falls back to the compact dist-tags endpoint', async () => {
  const calls = [];
  const client = {
    async get(url) {
      calls.push(url);
      if (url === 'https://registry.npmjs.org/next') {
        throw new FetchError('TOO_LARGE', 'response exceeded the safety budget');
      }
      assert.equal(url, 'https://registry.npmjs.org/-/package/next/dist-tags');
      const body = JSON.stringify({ 'next-15-3': '15.3.9', backport: '15.5.24', latest: '16.3.3' });
      return { status: 200, headers: {}, body, wireBytes: body.length };
    },
  };
  const result = await loadUpgradeTargets(
    client,
    new MemoryEtagStore(),
    'https://registry.npmjs.org',
    'next',
    '14.2.35',
    '16.3.3'
  );
  assert.equal(result.recommendedVersion, '16.3.3');
  assert.deepEqual(calls, [
    'https://registry.npmjs.org/next',
    'https://registry.npmjs.org/-/package/next/dist-tags',
  ]);
});

test('a manually entered target outside the menu is proven by its exact-version document', async () => {
  const calls = [];
  const client = {
    async get(url) {
      calls.push(url);
      assert.equal(url, 'https://registry.npmjs.org/pkg/2.7.0');
      const body = JSON.stringify({ name: 'pkg', version: '2.7.0' });
      return { status: 200, headers: {}, body, wireBytes: body.length };
    },
  };
  const published = await publishedUpgradeTargetsForRequest(
    client,
    new MemoryEtagStore(),
    'https://registry.npmjs.org',
    'pkg',
    '1.0.0',
    '3.0.0',
    '2.7.0'
  );
  assert.equal(published.has('2.7.0'), true);
  assert.deepEqual(calls, ['https://registry.npmjs.org/pkg/2.7.0']);
});

test('manual targets that are malformed or not upgrades never reach the registry', async () => {
  const calls = [];
  const client = {
    async get(url) {
      calls.push(url);
      throw new Error(`unexpected registry call: ${url}`);
    },
  };
  for (const target of ['latest', '1.0.0', '0.9.0']) {
    const published = await publishedUpgradeTargetsForRequest(
      client,
      new MemoryEtagStore(),
      'https://registry.npmjs.org',
      'pkg',
      '1.0.0',
      '3.0.0',
      target
    );
    assert.equal(published.has(target), false);
  }
  assert.deepEqual(calls, []);
});

test('an unpublished manual target is rejected by the exact-version registry lookup', async () => {
  const client = {
    async get(url) {
      assert.equal(url, 'https://registry.npmjs.org/pkg/2.7.0');
      return { status: 404, headers: {}, body: '', wireBytes: 0 };
    },
  };
  await assert.rejects(
    () =>
      publishedUpgradeTargetsForRequest(
        client,
        new MemoryEtagStore(),
        'https://registry.npmjs.org',
        'pkg',
        '1.0.0',
        '3.0.0',
        '2.7.0'
      ),
    (error) => error instanceof FetchError && error.code === 'REGISTRY_404'
  );
});
