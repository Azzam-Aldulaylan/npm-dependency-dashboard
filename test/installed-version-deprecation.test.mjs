import assert from 'node:assert/strict';
import test from 'node:test';

import { installedVersionDeprecation } from '../out/host/installedVersionDeprecation.js';

function metadata(overrides = {}) {
  return {
    name: 'legacy-package',
    version: '1.4.0',
    dependencies: {},
    optionalDependencies: {},
    peerDependencies: {},
    peerDependenciesMeta: {},
    ...overrides,
  };
}

test('exact installed-version evidence preserves the maintainer message and explicit replacement', () => {
  assert.deepEqual(
    installedVersionDeprecation(metadata({
      deprecated: 'This version is unsupported. Please use @scope/maintained instead.',
    })),
    {
      packageName: 'legacy-package',
      installedVersion: '1.4.0',
      message: 'This version is unsupported. Please use @scope/maintained instead.',
      suggestedReplacement: '@scope/maintained',
    }
  );
});

test('deprecation without explicit maintainer replacement never invents one', () => {
  assert.deepEqual(
    installedVersionDeprecation(metadata({ deprecated: 'This version is no longer maintained.' })),
    {
      packageName: 'legacy-package',
      installedVersion: '1.4.0',
      message: 'This version is no longer maintained.',
    }
  );
});

test('an exact version without a deprecation notice is not deprecated', () => {
  assert.equal(installedVersionDeprecation(metadata()), null);
});
