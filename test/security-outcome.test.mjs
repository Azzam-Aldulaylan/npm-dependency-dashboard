/**
 * evaluateSecurityOutcome — whether a proposed upgrade fixes, leaves, or has
 * an undetermined effect on this row's already-known vulnerabilities. The
 * one rule under test throughout: a transitive advisory is never marked
 * resolved/remains from the target version alone — only real resolver
 * evidence (a materialized post-upgrade graph) can answer for it; without
 * that evidence it is always `unknown`, never guessed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { evaluateSecurityOutcome } from '../out/core/advisories/securityOutcome.js';

function advisory(overrides) {
  return {
    id: 'GHSA-test',
    severity: 'high',
    title: 'a vulnerability',
    url: 'https://example.invalid',
    vulnerableVersions: '<4.0.0',
    ...overrides,
  };
}

function attributed(overrides) {
  return {
    advisory: advisory(),
    flaggedPackage: 'axios',
    path: ['axios'],
    patchedVersion: { status: 'known', version: '4.0.0' },
    ...overrides,
  };
}

function node(name, { version, direct = true, deps = [], edges = [], path } = {}) {
  return {
    name,
    version,
    range: '^1.0.0',
    dev: false,
    direct,
    path: path ?? `node_modules/${name}`,
    deps,
    edges,
  };
}

function graphOf(nodes) {
  const map = new Map(nodes.map((n) => [n.path, n]));
  return { root: '/app', packageManager: 'npm', lockfileVersion: 3, nodes: map };
}

// ------------------------------------------------------------- no advisories

test('a row with no advisories is not-applicable, regardless of resolver evidence', () => {
  const result = evaluateSecurityOutcome({
    before: [],
    targetVersion: '2.0.0',
    rootPackageName: 'axios',
    after: 'no-resolver-evidence',
  });
  assert.deepEqual(result, { status: 'not-applicable', resolvedAdvisories: [], remaining: [] });
});

// -------------------------------------------------- direct, no resolver evidence

test('a direct advisory resolved by the target version, with no resolver evidence, is resolved', () => {
  const entry = attributed({ advisory: advisory({ vulnerableVersions: '<4.0.0' }) });
  const result = evaluateSecurityOutcome({
    before: [entry],
    targetVersion: '4.0.1',
    rootPackageName: 'axios',
    after: 'no-resolver-evidence',
  });
  assert.equal(result.status, 'resolved');
  assert.deepEqual(result.resolvedAdvisories, [entry]);
  assert.deepEqual(result.remaining, []);
});

test('a direct advisory the target version still satisfies is remains, never resolved by assumption', () => {
  const entry = attributed({ advisory: advisory({ vulnerableVersions: '<4.0.0' }) });
  const result = evaluateSecurityOutcome({
    before: [entry],
    targetVersion: '3.9.9',
    rootPackageName: 'axios',
    after: 'no-resolver-evidence',
  });
  assert.equal(result.status, 'remains');
  assert.equal(result.remaining.length, 1);
  assert.equal(result.remaining[0].status, 'remains');
  assert.equal(result.remaining[0].resolvedVersion, '3.9.9');
});

test('the direct-only doctrine: upgrading to a newer version never itself proves a fix for a transitive advisory', () => {
  const entry = attributed({
    advisory: advisory({ vulnerableVersions: '<2.0.0' }),
    flaggedPackage: 'form-data',
    path: ['axios', 'form-data'],
  });
  // The target ("axios 99.0.0") is dramatically newer, but this advisory is
  // against a transitive package — no resolver evidence means no claim.
  const result = evaluateSecurityOutcome({
    before: [entry],
    targetVersion: '99.0.0',
    rootPackageName: 'axios',
    after: 'no-resolver-evidence',
  });
  assert.equal(result.status, 'unknown');
  assert.equal(result.remaining.length, 1);
  assert.equal(result.remaining[0].status, 'unknown');
  assert.equal(result.remaining[0].resolvedVersion, null);
  assert.deepEqual(result.resolvedAdvisories, []);
});

test('a known-remains direct advisory takes precedence over an unrelated unknown transitive one in the overall status', () => {
  const direct = attributed({ advisory: advisory({ vulnerableVersions: '<4.0.0' }), path: ['axios'] });
  const transitive = attributed({
    advisory: advisory({ id: 'GHSA-other', vulnerableVersions: '<2.0.0' }),
    flaggedPackage: 'form-data',
    path: ['axios', 'form-data'],
  });
  const result = evaluateSecurityOutcome({
    before: [direct, transitive],
    targetVersion: '3.9.9', // still inside the direct advisory's range
    rootPackageName: 'axios',
    after: 'no-resolver-evidence',
  });
  assert.equal(result.status, 'remains');
  assert.equal(result.remaining.length, 2);
});

// ------------------------------------------------------ transitive, with resolver evidence

test('resolver evidence proving the transitive package is now clean marks the advisory resolved', () => {
  const entry = attributed({
    advisory: advisory({ vulnerableVersions: '<4.0.0' }),
    flaggedPackage: 'form-data',
    path: ['axios', 'form-data'],
  });
  const axiosNode = node('axios', {
    version: '2.0.0',
    deps: ['form-data'],
    edges: [{ name: 'form-data', requestedRange: '^4.0.0', kind: 'runtime', targetNodeId: 'node_modules/form-data', optional: false }],
  });
  const formDataNode = node('form-data', { version: '4.0.0', direct: false });
  const graph = graphOf([axiosNode, formDataNode]);
  const advisoriesByName = new Map([['form-data', [advisory({ vulnerableVersions: '<4.0.0' })]]]);

  const result = evaluateSecurityOutcome({
    before: [entry],
    targetVersion: '2.0.0',
    rootPackageName: 'axios',
    after: { graph, advisoriesByName },
  });

  assert.equal(result.status, 'resolved');
  assert.deepEqual(result.resolvedAdvisories, [entry]);
  assert.deepEqual(result.remaining, []);
});

test('resolver evidence proving the transitive package is still vulnerable marks the advisory remains, with the resolved version reported', () => {
  const entry = attributed({
    advisory: advisory({ vulnerableVersions: '<4.0.0' }),
    flaggedPackage: 'form-data',
    path: ['axios', 'form-data'],
  });
  const axiosNode = node('axios', {
    version: '2.0.0',
    deps: ['form-data'],
    edges: [{ name: 'form-data', requestedRange: '^3.5.0', kind: 'runtime', targetNodeId: 'node_modules/form-data', optional: false }],
  });
  const formDataNode = node('form-data', { version: '3.5.0', direct: false });
  const graph = graphOf([axiosNode, formDataNode]);
  const advisoriesByName = new Map([['form-data', [advisory({ vulnerableVersions: '<4.0.0' })]]]);

  const result = evaluateSecurityOutcome({
    before: [entry],
    targetVersion: '2.0.0',
    rootPackageName: 'axios',
    after: { graph, advisoriesByName },
  });

  assert.equal(result.status, 'remains');
  assert.equal(result.remaining.length, 1);
  assert.equal(result.remaining[0].status, 'remains');
  assert.equal(result.remaining[0].resolvedVersion, '3.5.0');
  assert.equal(result.remaining[0].patchedVersion.status, 'known');
});

test('a direct advisory this row already knows about survives even with resolver evidence for the tree', () => {
  const direct = attributed({ advisory: advisory({ vulnerableVersions: '<4.0.0' }), path: ['axios'] });
  const axiosNode = node('axios', { version: '2.0.0', deps: [], edges: [] });
  const graph = graphOf([axiosNode]);
  // The after-graph's own re-attribution (attributeAdvisories) checks the
  // resolved axios node's version against the advisoriesByName map — axios
  // itself is still vulnerable at 2.0.0.
  const advisoriesByName = new Map([['axios', [advisory({ vulnerableVersions: '<4.0.0' })]]]);

  const result = evaluateSecurityOutcome({
    before: [direct],
    targetVersion: '2.0.0',
    rootPackageName: 'axios',
    after: { graph, advisoriesByName },
  });

  assert.equal(result.status, 'remains');
  assert.equal(result.remaining[0].resolvedVersion, '2.0.0');
});
