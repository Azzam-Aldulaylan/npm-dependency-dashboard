/**
 * assessRemoval — classifies already-gathered removal evidence into
 * low-risk / review / blocked / unknown. See src/core/upgrade/removalAssessment.ts
 * and RemovalAssessment's own doc in src/core/types.ts for why these four
 * outcomes are never collapsed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { assessRemoval } from '../out/core/upgrade/removalAssessment.js';

function usage(references, truncated = false) {
  return { references, truncated };
}

function ref(kind, overrides = {}) {
  return { filePath: 'src/x.ts', line: 1, column: 1, snippet: 'x', kind, ...overrides };
}

test('no known references at all is low-risk', () => {
  const result = assessRemoval({ usage: usage([]), peerRequirements: [], stillRequiredBy: [] });
  assert.deepEqual(result, { status: 'low-risk', evidence: [] });
});

test('low-risk still surfaces informational transitive evidence, non-blocking', () => {
  const result = assessRemoval({ usage: usage([]), peerRequirements: [], stillRequiredBy: ['other-pkg'] });
  assert.equal(result.status, 'low-risk');
  assert.equal(result.evidence.length, 1);
  assert.equal(result.evidence[0].kind, 'transitive-dependency');
});

test('a source import is review, not blocked', () => {
  const result = assessRemoval({
    usage: usage([ref('import', { filePath: 'src/api/client.ts' })]),
    peerRequirements: [],
    stillRequiredBy: [],
  });
  assert.equal(result.status, 'review');
  assert.ok(result.evidence.some((e) => e.kind === 'source-reference'));
});

test('a require reference counts the same as an import', () => {
  const result = assessRemoval({ usage: usage([ref('require')]), peerRequirements: [], stillRequiredBy: [] });
  assert.equal(result.status, 'review');
});

test('a dynamic-import reference counts the same as an import', () => {
  const result = assessRemoval({ usage: usage([ref('dynamic-import')]), peerRequirements: [], stillRequiredBy: [] });
  assert.equal(result.status, 'review');
});

test('a package.json script reference is review', () => {
  const result = assessRemoval({
    usage: usage([ref('script', { context: 'lint' })]),
    peerRequirements: [],
    stillRequiredBy: [],
  });
  assert.equal(result.status, 'review');
  const script = result.evidence.find((e) => e.kind === 'script-reference');
  assert.ok(script?.summary.includes('lint'));
});

test('a recognized config-file reference is review', () => {
  const result = assessRemoval({
    usage: usage([ref('config', { context: '.eslintrc.json' })]),
    peerRequirements: [],
    stillRequiredBy: [],
  });
  assert.equal(result.status, 'review');
  assert.ok(result.evidence.some((e) => e.kind === 'config-reference'));
});

test('a required (non-optional) peer dependency is blocked, overriding everything else', () => {
  const result = assessRemoval({
    usage: usage([ref('import')]),
    peerRequirements: [{ requiredBy: 'package-x', range: '^1.0.0', optional: false }],
    stillRequiredBy: [],
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.evidence.length, 1);
  assert.equal(result.evidence[0].kind, 'peer-requirement');
});

test('an optional peer dependency is review, not blocked', () => {
  const result = assessRemoval({
    usage: usage([]),
    peerRequirements: [{ requiredBy: 'package-x', range: '^1.0.0', optional: true }],
    stillRequiredBy: [],
  });
  assert.equal(result.status, 'review');
});

test('an ordinary transitive dependency (stillRequiredBy) alone, with no other evidence, is still low-risk', () => {
  // Being transitively depended on by something else is informational, never
  // by itself equivalent to "the root must keep declaring this package".
  const result = assessRemoval({ usage: usage([]), peerRequirements: [], stillRequiredBy: ['other-root'] });
  assert.equal(result.status, 'low-risk');
});

test('a null usage result (incomplete/cancelled scan) is unknown', () => {
  const result = assessRemoval({ usage: null, peerRequirements: [], stillRequiredBy: [] });
  assert.equal(result.status, 'unknown');
});

test('a truncated scan that found nothing is unknown, not low-risk — cannot prove "no references" from partial data', () => {
  const result = assessRemoval({ usage: usage([], true), peerRequirements: [], stillRequiredBy: [] });
  assert.equal(result.status, 'unknown');
});

test('a truncated scan that already found real evidence is still review — found evidence remains real regardless of truncation', () => {
  const result = assessRemoval({ usage: usage([ref('import')], true), peerRequirements: [], stillRequiredBy: [] });
  assert.equal(result.status, 'review');
});

test('a convention-loaded package with no static references is unknown, not low-risk', () => {
  const result = assessRemoval({
    usage: { ...usage([]), conventionUncertainty: true },
    peerRequirements: [],
    stillRequiredBy: [],
  });
  assert.equal(result.status, 'unknown');
  assert.match(result.evidence[0].summary, /framework or tooling conventions/);
});

test('real usage evidence takes priority over convention uncertainty', () => {
  const result = assessRemoval({
    usage: { ...usage([ref('config')]), conventionUncertainty: true },
    peerRequirements: [],
    stillRequiredBy: [],
  });
  assert.equal(result.status, 'review');
});

test('blocked takes priority even over an incomplete usage scan', () => {
  const result = assessRemoval({
    usage: null,
    peerRequirements: [{ requiredBy: 'package-x', range: '*', optional: false }],
    stillRequiredBy: [],
  });
  assert.equal(result.status, 'blocked');
});
