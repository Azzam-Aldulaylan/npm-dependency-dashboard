import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveDeprecatedRemediation } from '../out/core/cleanup/deprecatedRemediation.js';

test('safe unused deprecation routes to removal while uncertain removal prefers a real upgrade', () => {
  assert.equal(resolveDeprecatedRemediation({
    removalAction: { id: 'remove:a', confidence: 'safe' },
    upgradeTarget: '2.0.0',
    requiredBy: [],
    relatedUpgrades: [],
  }).kind, 'review-removal');

  assert.deepEqual(resolveDeprecatedRemediation({
    removalAction: { id: 'remove:a', confidence: 'review' },
    upgradeTarget: '2.0.0',
    requiredBy: [],
    relatedUpgrades: [],
  }), {
    kind: 'review-upgrade',
    targetVersion: '2.0.0',
    reason: 'A newer direct version (2.0.0) is available for compatibility review.',
  });
});

test('blocked peer deprecation exposes only related packages with real upgrade targets', () => {
  const result = resolveDeprecatedRemediation({
    removalAction: { id: 'remove:eslint', confidence: 'blocked' },
    upgradeTarget: null,
    requiredBy: ['plugin-b', 'plugin-a', 'transitive-owner'],
    relatedUpgrades: [
      { packageName: 'plugin-b', targetVersion: '3.0.0' },
      { packageName: 'plugin-a', targetVersion: '2.0.0' },
      { packageName: 'plugin-b', targetVersion: '3.0.0' },
    ],
  });
  assert.equal(result.kind, 'review-related-upgrades');
  assert.deepEqual(result.upgrades, [
    { packageName: 'plugin-a', targetVersion: '2.0.0' },
    { packageName: 'plugin-b', targetVersion: '3.0.0' },
  ]);
  assert.match(result.reason, /transitive-owner/);
});

test('non-actionable peer blockers remain visible in manual guidance', () => {
  const result = resolveDeprecatedRemediation({
    upgradeTarget: null,
    requiredBy: ['peer-owner'],
    relatedUpgrades: [],
  });
  assert.deepEqual(result, {
    kind: 'guidance',
    reason: 'No safe automated step was verified. This package is still required by peer-owner.',
  });
});
