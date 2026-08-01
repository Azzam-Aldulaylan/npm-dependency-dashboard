/**
 * The Vulnerabilities column's badge label/class decision — pure, no
 * React/DOM involved. See upgrade-action.test.mjs for why this repo tests
 * presentation logic this way instead of rendering components.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { severityDisplay } from '../out/host/severityDisplay.js';

test('null severity reads as Safe', () => {
  assert.deepEqual(severityDisplay(null), { label: 'Safe', className: 'none' });
});

test('each known severity gets a capitalized label and a matching class', () => {
  assert.deepEqual(severityDisplay('low'), { label: 'Low', className: 'low' });
  assert.deepEqual(severityDisplay('moderate'), { label: 'Moderate', className: 'moderate' });
  assert.deepEqual(severityDisplay('high'), { label: 'High', className: 'high' });
  assert.deepEqual(severityDisplay('critical'), { label: 'Critical', className: 'critical' });
  assert.deepEqual(severityDisplay('info'), { label: 'Info', className: 'info' });
});
