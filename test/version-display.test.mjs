/**
 * The Available column's Wanted/Latest split decision — pure, no React/DOM
 * involved. See upgrade-action.test.mjs for why this repo tests presentation
 * logic this way instead of rendering components.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { currentVersionDisplay, versionDisplay } from '../out/host/versionDisplay.js';

test('neither value present renders an em dash', () => {
  assert.deepEqual(versionDisplay(null, null), { kind: 'dash' });
});

test('identical wanted and latest collapse to a single value', () => {
  assert.deepEqual(versionDisplay('20.19.43', '20.19.43'), {
    kind: 'single',
    value: '20.19.43',
  });
});

test('differing wanted and latest split into two lines', () => {
  assert.deepEqual(versionDisplay('20.19.43', '26.1.2'), {
    kind: 'split',
    wanted: '20.19.43',
    latest: '26.1.2',
  });
});

test('a missing side of a differing pair falls back to an em dash for that side', () => {
  assert.deepEqual(versionDisplay(null, '26.1.2'), {
    kind: 'split',
    wanted: '—',
    latest: '26.1.2',
  });
  assert.deepEqual(versionDisplay('20.19.43', null), {
    kind: 'split',
    wanted: '20.19.43',
    latest: '—',
  });
});

// ------------------------------------------------- currentVersionDisplay

test('a resolved current version with no unresolvable reason is shown as-is, untagged', () => {
  assert.deepEqual(currentVersionDisplay('1.0.0', '^1.0.0', undefined), {
    kind: 'resolved',
    value: '1.0.0',
    tag: null,
  });
});

test('a resolved current version can still carry a tag — e.g. a git/file/tarball dependency with a real resolved version', () => {
  assert.deepEqual(currentVersionDisplay('1.2.3', '^1.0.0', 'git'), {
    kind: 'resolved',
    value: '1.2.3',
    tag: 'git',
  });
});

test('no resolved version, with an explicit unresolvable reason, falls back to the declared range tagged with that reason', () => {
  assert.deepEqual(currentVersionDisplay(null, '^18.2.0', 'workspace-link'), {
    kind: 'declared-range',
    value: '^18.2.0',
    tag: 'workspace-link',
  });
  assert.deepEqual(currentVersionDisplay(null, 'file:../shared', 'file'), {
    kind: 'declared-range',
    value: 'file:../shared',
    tag: 'file',
  });
  assert.deepEqual(currentVersionDisplay(null, '^1.0.0', 'no-lockfile'), {
    kind: 'declared-range',
    value: '^1.0.0',
    tag: 'no-lockfile',
  });
});

test('no resolved version and no unresolvable reason still falls back to the declared range, tagged "unresolved" — a dependency declared but missing from an otherwise-present lockfile', () => {
  assert.deepEqual(currentVersionDisplay(null, '^1.0.0', undefined), {
    kind: 'declared-range',
    value: '^1.0.0',
    tag: 'unresolved',
  });
});

test('no resolved version and no declared range (defensive — should not occur in practice) renders a dash, still tagged', () => {
  assert.deepEqual(currentVersionDisplay(null, '', undefined), { kind: 'dash', tag: 'unresolved' });
  assert.deepEqual(currentVersionDisplay(null, '', 'no-lockfile'), { kind: 'dash', tag: 'no-lockfile' });
});
