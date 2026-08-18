/**
 * Persisted cache record validators — pure. Every case here is something a
 * corrupted or stale extension-storage blob could plausibly contain; the
 * only acceptable outcome is "rejected, never thrown, never partially
 * trusted" — see schema.ts's file header.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CACHE_SCHEMA_VERSION,
  ETAG_CACHE_SCHEMA_VERSION,
  isPersistedProjectCache,
  isPersistedProjectCacheCollection,
  isPersistedEtagCacheCollection,
} from '../out/core/cache/schema.js';

const ROW = {
  name: 'clean-pkg',
  current: '1.0.0',
  wanted: '1.0.1',
  latest: '1.0.1',
  dev: false,
  range: '^1.0.0',
  advisories: [],
  worstSeverity: null,
  upgradeTo: null,
  upgradeReason: null,
};

const VALID_FINGERPRINT = { manifestHash: 'h-manifest', lockfileHash: 'h-lockfile', lockfilePath: '/tmp/project/package-lock.json' };

const VALID_ENTRY = {
  rows: [ROW],
  generatedAt: '2026-08-01T12:00:00.000Z',
  lockfilePath: '/tmp/project/package-lock.json',
  sourceFingerprint: VALID_FINGERPRINT,
};

test('isPersistedProjectCache accepts a well-formed record, including a null lockfilePath and a null lockfileHash', () => {
  assert.equal(isPersistedProjectCache(VALID_ENTRY), true);
  assert.equal(isPersistedProjectCache({ ...VALID_ENTRY, rows: [{ ...ROW, description: 'A fixture package.' }] }), true);
  assert.equal(isPersistedProjectCache({ ...VALID_ENTRY, lockfilePath: null }), true);
  assert.equal(
    isPersistedProjectCache({ ...VALID_ENTRY, sourceFingerprint: { ...VALID_FINGERPRINT, lockfileHash: null, lockfilePath: null } }),
    true
  );
});

test('isPersistedProjectCache rejects a malformed generatedAt, missing lockfilePath, a missing/malformed sourceFingerprint, or a row that fails validation', () => {
  assert.equal(isPersistedProjectCache({ ...VALID_ENTRY, generatedAt: 'not-a-date' }), false);
  assert.equal(isPersistedProjectCache({ ...VALID_ENTRY, generatedAt: undefined }), false);
  const { lockfilePath: _omit, ...withoutLockfilePath } = VALID_ENTRY;
  assert.equal(isPersistedProjectCache(withoutLockfilePath), false, 'lockfilePath is required, not optional');
  const { sourceFingerprint: _omitFingerprint, ...withoutFingerprint } = VALID_ENTRY;
  assert.equal(isPersistedProjectCache(withoutFingerprint), false, 'sourceFingerprint is required, not optional');
  assert.equal(isPersistedProjectCache({ ...VALID_ENTRY, sourceFingerprint: { manifestHash: 'h' } }), false, 'a partial fingerprint is rejected');
  assert.equal(isPersistedProjectCache({ ...VALID_ENTRY, sourceFingerprint: 'not-an-object' }), false);
  assert.equal(isPersistedProjectCache({ ...VALID_ENTRY, rows: [{ name: 'oops' }] }), false);
  assert.equal(isPersistedProjectCache({ ...VALID_ENTRY, rows: [{ ...ROW, description: 42 }] }), false);
  assert.equal(isPersistedProjectCache({ ...VALID_ENTRY, rows: 'not-an-array' }), false);
  assert.equal(isPersistedProjectCache(null), false);
  assert.equal(isPersistedProjectCache('a string'), false);
  assert.equal(isPersistedProjectCache([VALID_ENTRY]), false, 'an array is not a record');
});

test('isPersistedProjectCacheCollection rejects an old or future schema version outright — no migration attempted', () => {
  const collection = { schemaVersion: CACHE_SCHEMA_VERSION, entries: [['key', VALID_ENTRY]] };
  assert.equal(isPersistedProjectCacheCollection(collection), true);
  assert.equal(isPersistedProjectCacheCollection({ ...collection, schemaVersion: 0 }), false);
  assert.equal(isPersistedProjectCacheCollection({ ...collection, schemaVersion: CACHE_SCHEMA_VERSION + 1 }), false);
  assert.equal(isPersistedProjectCacheCollection({ ...collection, schemaVersion: '1' }), false);
});

test('isPersistedProjectCacheCollection rejects malformed entries: non-tuples, wrong-length tuples, non-string keys, invalid values', () => {
  const base = { schemaVersion: CACHE_SCHEMA_VERSION };
  assert.equal(isPersistedProjectCacheCollection({ ...base, entries: 'not-an-array' }), false);
  assert.equal(isPersistedProjectCacheCollection({ ...base, entries: [{ key: 'x', value: VALID_ENTRY }] }), false);
  assert.equal(isPersistedProjectCacheCollection({ ...base, entries: [['key', VALID_ENTRY, 'extra']] }), false);
  assert.equal(isPersistedProjectCacheCollection({ ...base, entries: [[123, VALID_ENTRY]] }), false);
  assert.equal(isPersistedProjectCacheCollection({ ...base, entries: [['key', { bad: true }]] }), false);
  assert.equal(isPersistedProjectCacheCollection(undefined), false);
});

test('isPersistedEtagCacheCollection accepts well-formed entries without sharing the project-row schema version', () => {
  const good = { schemaVersion: ETAG_CACHE_SCHEMA_VERSION, entries: [['https://registry.npmjs.org/x', { etag: 'W/"1"', body: '{}' }]] };
  assert.equal(isPersistedEtagCacheCollection(good), true);
  assert.notEqual(ETAG_CACHE_SCHEMA_VERSION, CACHE_SCHEMA_VERSION, 'a project-row refresh must preserve the registry cache');
  assert.equal(isPersistedEtagCacheCollection({ ...good, schemaVersion: CACHE_SCHEMA_VERSION }), false);
  assert.equal(isPersistedEtagCacheCollection({ ...good, schemaVersion: 999 }), false);
  assert.equal(
    isPersistedEtagCacheCollection({ schemaVersion: ETAG_CACHE_SCHEMA_VERSION, entries: [['k', { etag: 'x' }]] }),
    false,
    'body is required'
  );
  assert.equal(isPersistedEtagCacheCollection(null), false);
});
