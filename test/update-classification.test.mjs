/**
 * Major/minor/patch classification — pure, no React/DOM involved. See
 * upgrade-action.test.mjs for why this repo tests presentation logic this
 * way instead of rendering components.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyUpdate, classifyRowUpdate, updateTarget } from '../out/host/updateClassification.js';

function row(overrides = {}) {
  return {
    name: 'pkg',
    current: '1.0.0',
    wanted: '1.0.0',
    latest: '1.0.0',
    dev: false,
    range: '^1.0.0',
    advisories: [],
    worstSeverity: null,
    upgradeTo: null,
    ...overrides,
  };
}

// ------------------------------------------------------------ classifyUpdate

test('a major-boundary change classifies as major', () => {
  assert.equal(classifyUpdate('1.2.3', '2.0.0'), 'major');
});

test('a minor-only change classifies as minor', () => {
  assert.equal(classifyUpdate('1.2.3', '1.3.0'), 'minor');
});

test('a patch-only change classifies as patch', () => {
  assert.equal(classifyUpdate('1.2.3', '1.2.4'), 'patch');
});

test('identical versions classify as null', () => {
  assert.equal(classifyUpdate('1.2.3', '1.2.3'), null);
});

test('invalid semver on either side classifies as null rather than throwing', () => {
  assert.equal(classifyUpdate('not-a-version', '2.0.0'), null);
  assert.equal(classifyUpdate('1.0.0', 'not-a-version'), null);
});

// -------------------------------------------------------------- updateTarget

test('latest is the target when it differs from current', () => {
  assert.equal(updateTarget(row({ current: '1.0.0', wanted: '1.0.0', latest: '2.0.0' })), '2.0.0');
});

test('wanted is the target when only it differs from current', () => {
  assert.equal(updateTarget(row({ current: '1.0.0', wanted: '1.1.0', latest: '1.0.0' })), '1.1.0');
});

test('no target when nothing differs from current', () => {
  assert.equal(updateTarget(row()), null);
});

test('no target when current is unresolved', () => {
  assert.equal(updateTarget(row({ current: null, wanted: '1.1.0', latest: '1.1.0' })), null);
});

// ---------------------------------------------------------- classifyRowUpdate

test('classifies the row using whichever value actually differs from current', () => {
  assert.equal(classifyRowUpdate(row({ current: '1.0.0', wanted: '1.0.0', latest: '2.0.0' })), 'major');
  assert.equal(classifyRowUpdate(row({ current: '1.0.0', wanted: '1.1.0', latest: '1.1.0' })), 'minor');
  assert.equal(classifyRowUpdate(row({ current: '1.0.0', wanted: '1.0.1', latest: '1.0.1' })), 'patch');
});

test('a row with no update classifies as null', () => {
  assert.equal(classifyRowUpdate(row()), null);
});
