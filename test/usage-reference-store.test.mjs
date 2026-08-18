/**
 * The trusted lookup for "Open file" / "Go to line" — the webview only ever
 * sends an opaque, host-issued id plus an index; a forged id, an expired
 * one, or an out-of-range index must all resolve to null. See the redesign
 * brief's own security-boundary description in usageReferenceStore.ts.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { UsageReferenceStore } from '../out/host/usage/usageReferenceStore.js';

const FAKE_FOLDER = { uri: { fsPath: '/workspace' }, name: 'workspace', index: 0 };

function result(references) {
  return { packageName: 'left-pad', references, truncated: false, scannedFileCount: 3, scannedAt: '2026-08-01T00:00:00.000Z' };
}

test('a stored result resolves each of its own references by index', () => {
  const store = new UsageReferenceStore();
  const references = [
    { filePath: 'src/a.ts', line: 1, column: 1, snippet: 'a', kind: 'import' },
    { filePath: 'src/b.ts', line: 2, column: 3, snippet: 'b', kind: 'require' },
  ];
  const id = store.store('left-pad', result(references), FAKE_FOLDER);

  const first = store.resolveReference(id, 0);
  assert.equal(first.folder, FAKE_FOLDER);
  assert.deepEqual(first.reference, references[0]);

  const second = store.resolveReference(id, 1);
  assert.deepEqual(second.reference, references[1]);
});

test('a forged (never-issued) id resolves to null', () => {
  const store = new UsageReferenceStore();
  store.store('left-pad', result([{ filePath: 'a', line: 1, column: 1, snippet: '', kind: 'import' }]), FAKE_FOLDER);
  assert.equal(store.resolveReference('not-a-real-id', 0), null);
});

test('an out-of-range index on a real id resolves to null', () => {
  const store = new UsageReferenceStore();
  const id = store.store('left-pad', result([{ filePath: 'a', line: 1, column: 1, snippet: '', kind: 'import' }]), FAKE_FOLDER);
  assert.equal(store.resolveReference(id, 5), null);
  assert.equal(store.resolveReference(id, -1), null);
});

test('a stale (past-TTL) result is rejected even with the correct id and index', () => {
  const store = new UsageReferenceStore(-1); // already-expired TTL
  const id = store.store('left-pad', result([{ filePath: 'a', line: 1, column: 1, snippet: '', kind: 'import' }]), FAKE_FOLDER);
  assert.equal(store.resolveReference(id, 0), null);
});

test('clear() invalidates every previously stored id', () => {
  const store = new UsageReferenceStore();
  const id = store.store('left-pad', result([{ filePath: 'a', line: 1, column: 1, snippet: '', kind: 'import' }]), FAKE_FOLDER);
  store.clear();
  assert.equal(store.resolveReference(id, 0), null);
});

test('two stored results for the same package get distinct ids', () => {
  const store = new UsageReferenceStore();
  const idA = store.store('left-pad', result([]), FAKE_FOLDER);
  const idB = store.store('left-pad', result([]), FAKE_FOLDER);
  assert.notEqual(idA, idB);
});
