import { test } from 'node:test';
import assert from 'node:assert/strict';

import { combineSecurityOutcomes } from '../out/host/securityOutcomeBatch.js';

const resolved = {
  status: 'resolved',
  resolvedAdvisories: [{ advisory: { id: 1 }, flaggedPackage: 'alpha', path: ['root-a', 'alpha'] }],
  remaining: [],
};
const unknown = {
  status: 'unknown',
  resolvedAdvisories: [],
  remaining: [{ advisory: { id: 2 }, flaggedPackage: 'beta', path: ['root-b', 'beta'] }],
};
const remains = {
  status: 'remains',
  resolvedAdvisories: [],
  remaining: [{ advisory: { id: 3 }, flaggedPackage: 'gamma', path: ['root-c', 'gamma'] }],
};

test('remaining advisories take precedence while every package detail is retained', () => {
  const result = combineSecurityOutcomes([resolved, unknown, remains]);
  assert.equal(result.status, 'remains');
  assert.deepEqual(result.resolvedAdvisories, resolved.resolvedAdvisories);
  assert.deepEqual(result.remaining, [...unknown.remaining, ...remains.remaining]);
});

test('unknown evidence takes precedence over resolved when no advisory is known to remain', () => {
  assert.equal(combineSecurityOutcomes([resolved, unknown]).status, 'unknown');
});

test('an all-not-applicable batch has no security section', () => {
  assert.equal(combineSecurityOutcomes([{ status: 'not-applicable', resolvedAdvisories: [], remaining: [] }]), null);
});
