/**
 * The Available column's Wanted/Latest split decision — pure, no React/DOM
 * involved. See upgrade-action.test.mjs for why this repo tests presentation
 * logic this way instead of rendering components.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { versionDisplay } from '../out/host/versionDisplay.js';

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
