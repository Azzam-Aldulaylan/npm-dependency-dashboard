/**
 * The Vulnerabilities column's badge label/class decision — pure, no
 * React/DOM involved. See upgrade-action.test.mjs for why this repo tests
 * presentation logic this way instead of rendering components.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { severityDisplay, sortAdvisoriesBySeverity } from '../out/host/severityDisplay.js';

function advisory(severity, flaggedPackage, title) {
  return {
    advisory: { id: `${flaggedPackage}-${title}`, severity, title, url: 'https://example.test', vulnerableVersions: '*' },
    flaggedPackage,
    path: [flaggedPackage],
    flaggedVersion: '1.0.0',
    patchedVersion: { status: 'unknown' },
  };
}

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

test('sortAdvisoriesBySeverity orders worst first, regardless of input order', () => {
  const input = [
    advisory('low', 'a', 'a-low'),
    advisory('critical', 'b', 'b-critical'),
    advisory('info', 'c', 'c-info'),
    advisory('high', 'd', 'd-high'),
    advisory('moderate', 'e', 'e-moderate'),
  ];
  const sorted = sortAdvisoriesBySeverity(input).map((entry) => entry.advisory.severity);
  assert.deepEqual(sorted, ['critical', 'high', 'moderate', 'low', 'info']);
});

test('sortAdvisoriesBySeverity never mutates the input array', () => {
  const input = [advisory('low', 'a', 'a-low'), advisory('critical', 'b', 'b-critical')];
  const originalOrder = input.map((entry) => entry.flaggedPackage);
  sortAdvisoriesBySeverity(input);
  assert.deepEqual(input.map((entry) => entry.flaggedPackage), originalOrder);
});

test('sortAdvisoriesBySeverity tie-breaks equal severities by flagged package, then title', () => {
  const input = [
    advisory('high', 'zeta', 'z-title'),
    advisory('high', 'alpha', 'b-title'),
    advisory('high', 'alpha', 'a-title'),
  ];
  const sorted = sortAdvisoriesBySeverity(input).map((entry) => `${entry.flaggedPackage}:${entry.advisory.title}`);
  assert.deepEqual(sorted, ['alpha:a-title', 'alpha:b-title', 'zeta:z-title']);
});
