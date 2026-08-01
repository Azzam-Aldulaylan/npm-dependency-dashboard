/**
 * The dashboard footer's dependency-count wording — pure, no React/DOM
 * involved. See upgrade-action.test.mjs for why this repo tests presentation
 * logic this way instead of rendering components.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { dependencyCountLabel } from '../out/host/dependencySummary.js';

test('a count of one dependency uses singular wording', () => {
  assert.equal(dependencyCountLabel(1), '1 dependency checked');
});

test('zero and plural counts use plural wording', () => {
  assert.equal(dependencyCountLabel(0), '0 dependencies checked');
  assert.equal(dependencyCountLabel(2), '2 dependencies checked');
  assert.equal(dependencyCountLabel(47), '47 dependencies checked');
});
