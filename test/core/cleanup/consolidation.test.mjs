import { test } from 'node:test';
import assert from 'node:assert/strict';

import { assessDuplicateConsolidation } from '../../../out/core/cleanup/index.js';

function constraint(dependentPackage, range, kind = 'dependency', dependentVersion = '1.0.0') {
  return { dependentPackage, dependentVersion, kind, range };
}

function options(overrides = {}) {
  const constraints = [constraint('parent-a', '^1.0.0'), constraint('parent-b', '>=1.2.0 <2')];
  return {
    packageName: 'shared',
    resolvedVersions: ['1.1.0', '1.5.0'],
    constraints,
    constraintsComplete: true,
    simulation: {
      status: 'complete',
      resolvedVersions: ['1.5.0'],
      constraints,
      constraintsComplete: true,
      parentUpgrades: [],
    },
    ...overrides,
  };
}

test('classifies complete one-version simulation without parent changes as safe convergence', () => {
  assert.deepEqual(assessDuplicateConsolidation(options()), {
    outcome: 'safe-convergence',
    packageName: 'shared',
    currentVersions: ['1.1.0', '1.5.0'],
    targetVersion: '1.5.0',
    parentUpgrades: [],
    reason: 'The complete simulation converged on 1.5.0 without changing a direct parent dependency.',
  });
});

test('classifies convergence that changes a direct parent separately', () => {
  const simulatedConstraints = [constraint('parent-a', '^2.0.0', 'dependency', '2.0.0'), constraint('parent-b', '^2.0.0')];
  const result = assessDuplicateConsolidation(options({
    constraints: [constraint('parent-a', '^1.0.0'), constraint('parent-b', '^2.0.0')],
    simulation: {
      status: 'complete',
      resolvedVersions: ['2.2.0'],
      constraints: simulatedConstraints,
      constraintsComplete: true,
      parentUpgrades: [{ packageName: 'parent-a', fromVersion: '1.0.0', toVersion: '2.0.0' }],
    },
  }));
  assert.equal(result.outcome, 'requires-parent-upgrade');
  assert.equal(result.targetVersion, '2.2.0');
  assert.deepEqual(result.parentUpgrades, [{ packageName: 'parent-a', fromVersion: '1.0.0', toVersion: '2.0.0' }]);
});

test('keeps multiple versions when a complete simulation retains disjoint ranges', () => {
  const constraints = [constraint('legacy-parent', '^1.0.0'), constraint('modern-parent', '^2.0.0')];
  const result = assessDuplicateConsolidation(options({
    resolvedVersions: ['2.4.0', '1.9.0'],
    constraints,
    simulation: {
      status: 'complete',
      resolvedVersions: ['2.4.0', '1.9.0'],
      constraints,
      constraintsComplete: true,
      parentUpgrades: [],
    },
  }));
  assert.deepEqual(result, {
    outcome: 'keep-both',
    packageName: 'shared',
    currentVersions: ['1.9.0', '2.4.0'],
    retainedVersions: ['1.9.0', '2.4.0'],
    parentUpgrades: [],
    reason: 'The complete simulation retained multiple versions because no retained version satisfies every supplied dependency and peer range.',
  });
});

test('peer constraints participate in convergence validation', () => {
  const constraints = [constraint('runtime-parent', '^2.0.0'), constraint('peer-host', '^1.0.0', 'peer')];
  const result = assessDuplicateConsolidation(options({
    constraints,
    simulation: {
      status: 'complete',
      resolvedVersions: ['2.2.0'],
      constraints,
      constraintsComplete: true,
      parentUpgrades: [],
    },
  }));
  assert.equal(result.outcome, 'unknown');
  assert.match(result.reason, /does not satisfy every supplied dependency and peer range/);
});

test('incomplete constraints and unavailable simulations fail closed', () => {
  assert.equal(assessDuplicateConsolidation(options({ constraintsComplete: false })).outcome, 'unknown');
  assert.deepEqual(assessDuplicateConsolidation(options({
    simulation: { status: 'unavailable', reason: 'Resolver timed out.' },
  })), {
    outcome: 'unknown',
    packageName: 'shared',
    currentVersions: ['1.1.0', '1.5.0'],
    reason: 'Resolver timed out.',
  });
});

test('invalid versions, invalid ranges, and contradictory parent upgrades fail closed', () => {
  assert.equal(assessDuplicateConsolidation(options({ resolvedVersions: ['1.0.0', 'not-semver'] })).outcome, 'unknown');
  assert.equal(assessDuplicateConsolidation(options({ constraints: [constraint('parent-a', 'not-a-range')] })).outcome, 'unknown');
  const result = assessDuplicateConsolidation(options({
    simulation: {
      status: 'complete',
      resolvedVersions: ['2.0.0'],
      constraints: [constraint('parent-a', '^2.0.0')],
      constraintsComplete: true,
      parentUpgrades: [
        { packageName: 'parent-a', fromVersion: '1.0.0', toVersion: '2.0.0' },
        { packageName: 'parent-a', fromVersion: '1.0.0', toVersion: '3.0.0' },
      ],
    },
  }));
  assert.equal(result.outcome, 'unknown');
  assert.match(result.reason, /invalid or contradictory/);
});

test('classification is deterministic across evidence ordering and duplicate entries', () => {
  const constraints = [constraint('z-parent', '^1.0.0'), constraint('a-parent', '^1.0.0')];
  const result = assessDuplicateConsolidation(options({
    resolvedVersions: ['1.5.0', '1.1.0', '1.5.0'],
    constraints: [...constraints].reverse(),
    simulation: {
      status: 'complete',
      resolvedVersions: ['1.5.0', '1.5.0'],
      constraints,
      constraintsComplete: true,
      parentUpgrades: [],
    },
  }));
  assert.equal(result.outcome, 'safe-convergence');
  assert.deepEqual(result.currentVersions, ['1.1.0', '1.5.0']);
});

test('identical simulated parent upgrades are deduplicated deterministically', () => {
  const upgrade = { packageName: 'parent-a', fromVersion: '1.0.0', toVersion: '2.0.0' };
  const constraints = [constraint('parent-a', '^2.0.0', 'dependency', '2.0.0')];
  const result = assessDuplicateConsolidation(options({
    simulation: {
      status: 'complete',
      resolvedVersions: ['2.1.0'],
      constraints,
      constraintsComplete: true,
      parentUpgrades: [upgrade, upgrade],
    },
  }));
  assert.equal(result.outcome, 'requires-parent-upgrade');
  assert.deepEqual(result.parentUpgrades, [upgrade]);
});

test('a multi-version simulation remains unknown when one retained version satisfies every range', () => {
  const constraints = [constraint('parent-a', '^1.0.0'), constraint('parent-b', '^1.0.0')];
  const result = assessDuplicateConsolidation(options({
    constraints,
    simulation: {
      status: 'complete',
      resolvedVersions: ['1.1.0', '1.5.0'],
      constraints,
      constraintsComplete: true,
      parentUpgrades: [],
    },
  }));
  assert.equal(result.outcome, 'unknown');
  assert.match(result.reason, /satisfies every range/);
});
