import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseProjectManifestCompatibilityEvidence,
  projectCompatibilityScanIsTruncated,
  shouldRetainFrameworkRuleFile,
} from '../out/host/projectCompatibility/projectEvidenceParsing.js';

test('project compatibility manifest evidence keeps scripts, declarations, and an honest Node range', () => {
  const evidence = parseProjectManifestCompatibilityEvidence(JSON.stringify({
    scripts: { lint: 'next lint', invalid: 42 },
    engines: { node: '>=18.18.0' },
    dependencies: { next: '^14.2.35' },
    devDependencies: { 'eslint-config-next': '^14.2.35' },
  }));
  assert.deepEqual(evidence, {
    scripts: { lint: 'next lint' },
    declaredDependencies: { 'eslint-config-next': '^14.2.35', next: '^14.2.35' },
    projectNodeRange: '>=18.18.0',
  });
});

test('malformed manifest compatibility evidence degrades to unknown', () => {
  assert.deepEqual(parseProjectManifestCompatibilityEvidence('{bad'), {
    scripts: {},
    declaredDependencies: {},
    projectNodeRange: null,
  });
});

test('framework rule retention is narrow and Next-specific', () => {
  assert.equal(shouldRetainFrameworkRuleFile('next', 'app/users/[id]/page.tsx'), true);
  assert.equal(shouldRetainFrameworkRuleFile('next', 'src/components/Card.tsx'), false);
  assert.equal(shouldRetainFrameworkRuleFile('react', 'app/users/[id]/page.tsx'), false);
});

test('cancelled, unreadable, or bounded evidence is always reported as partial', () => {
  const complete = {
    discoveredSourceFiles: 9,
    maxFiles: 10,
    sourceCancelled: false,
    configCancelled: false,
    failedReadCount: 0,
    evidenceLimitReached: false,
  };
  assert.equal(projectCompatibilityScanIsTruncated(complete), false);
  for (const degraded of [
    { discoveredSourceFiles: 10 },
    { sourceCancelled: true },
    { configCancelled: true },
    { failedReadCount: 1 },
    { evidenceLimitReached: true },
  ]) {
    assert.equal(projectCompatibilityScanIsTruncated({ ...complete, ...degraded }), true);
  }
});
