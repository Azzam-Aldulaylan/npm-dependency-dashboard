import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolvePeerResolutionPolicy } from '../out/core/registry/npmrc.js';

test('peer resolution policy defaults to npm defaults', () => {
  assert.deepEqual(resolvePeerResolutionPolicy({ allowProjectNpmrc: true }), {
    strictPeerDeps: false,
    legacyPeerDeps: false,
    sources: { strictPeerDeps: 'default', legacyPeerDeps: 'default' },
  });
});

test('project peer settings override user settings with provenance', () => {
  const policy = resolvePeerResolutionPolicy({
    userNpmrc: 'strict-peer-deps=false\nlegacy-peer-deps=true',
    projectNpmrc: 'strict-peer-deps=true\nlegacy-peer-deps=false',
    allowProjectNpmrc: true,
  });
  assert.deepEqual(policy, {
    strictPeerDeps: true,
    legacyPeerDeps: false,
    sources: { strictPeerDeps: 'project-npmrc', legacyPeerDeps: 'project-npmrc' },
  });
});

test('project peer settings are ignored in an untrusted/disallowed workspace', () => {
  const policy = resolvePeerResolutionPolicy({
    userNpmrc: 'strict-peer-deps=true',
    projectNpmrc: 'strict-peer-deps=false\nlegacy-peer-deps=true',
    allowProjectNpmrc: false,
  });
  assert.equal(policy.strictPeerDeps, true);
  assert.equal(policy.legacyPeerDeps, false);
  assert.equal(policy.sources.strictPeerDeps, 'user-npmrc');
});

test('expanded and invalid boolean values are never interpreted as policy', () => {
  const policy = resolvePeerResolutionPolicy({
    projectNpmrc: 'strict-peer-deps=${STRICT}\nlegacy-peer-deps=maybe',
    allowProjectNpmrc: true,
  });
  assert.equal(policy.strictPeerDeps, false);
  assert.equal(policy.legacyPeerDeps, false);
  assert.deepEqual(policy.sources, {
    strictPeerDeps: 'default',
    legacyPeerDeps: 'default',
  });
});

test('pnpm strict-peer-dependencies maps to the normalized strict peer policy', () => {
  const policy = resolvePeerResolutionPolicy({
    allowProjectNpmrc: true,
    projectNpmrc: 'strict-peer-dependencies=true',
  });
  assert.equal(policy.strictPeerDeps, true);
  assert.equal(policy.sources.strictPeerDeps, 'project-npmrc');
});
