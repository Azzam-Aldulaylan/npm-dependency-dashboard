import assert from 'node:assert/strict';
import test from 'node:test';

import { createTransitiveRemediationPlan } from '../out/core/advisories/transitiveRemediationPlan.js';

function edge(name, targetNodeId) {
  return { name, requestedRange: '*', kind: 'runtime', targetNodeId, optional: false };
}

function node(name, path, { version = '1.0.0', direct = false, edges = [] } = {}) {
  return {
    name,
    version,
    range: direct ? '*' : '',
    dev: false,
    direct,
    path,
    deps: edges.map((entry) => entry.name),
    edges,
  };
}

function graph(nodes, packageManager = 'npm') {
  return {
    root: '/project',
    packageManager,
    lockfileVersion: packageManager === 'npm' ? 3 : '9.0',
    nodes: new Map(nodes.map((entry) => [entry.path, entry])),
  };
}

function advisory(id, vulnerableVersions, overrides = {}) {
  return {
    id,
    severity: 'high',
    title: `Advisory ${id}`,
    url: `https://github.com/advisories/${id}`,
    vulnerableVersions,
    identifiers: [{ type: 'GHSA', value: id }],
    ...overrides,
  };
}

function target(entry, flaggedPackage = 'websocket-driver') {
  return {
    advisory: entry,
    flaggedPackage,
    path: ['sockjs-client', flaggedPackage],
    flaggedVersion: '0.7.3',
    patchedVersion: { status: 'known', version: '0.7.5' },
  };
}

function snapshot(dependencyGraph, advisoriesByName, availability = 'complete') {
  return { graph: dependencyGraph, advisoriesByName: new Map(advisoriesByName), advisories: availability };
}

function simpleGraph(transitiveVersion, rootVersion = '1.6.1') {
  const transitivePath = 'node_modules/websocket-driver';
  return graph([
    node('sockjs-client', 'node_modules/sockjs-client', {
      version: rootVersion,
      direct: true,
      edges: [edge('websocket-driver', transitivePath)],
    }),
    node('websocket-driver', transitivePath, { version: transitiveVersion }),
  ]);
}

const websocketIssue = advisory('GHSA-AAAA-BBBB-CCCC', '<0.7.5');

test('classifies a complete targeted transitive fix as apply-eligible and records its exact version change', () => {
  const plan = createTransitiveRemediationPlan({
    rootPackageName: 'sockjs-client',
    // Repeated attribution records are one requested vulnerability identity.
    targetAdvisories: [target(websocketIssue), target(websocketIssue)],
    manifestUnchanged: true,
    before: snapshot(simpleGraph('0.7.3'), [['websocket-driver', [websocketIssue]]]),
    after: snapshot(simpleGraph('0.7.5'), [['websocket-driver', [websocketIssue]]]),
  });

  assert.equal(plan.classification, 'full');
  assert.equal(plan.target.requestedCount, 1);
  assert.equal(plan.automaticApplyAllowed, true);
  assert.deepEqual(plan.reasons, []);
  assert.equal(plan.rootVersion, '1.6.1');
  assert.deepEqual(plan.directDependencyChanges, []);
  assert.deepEqual(plan.packageChanges, [{
    kind: 'updated',
    packageName: 'websocket-driver',
    lockfilePath: 'node_modules/websocket-driver',
    beforeVersion: '0.7.3',
    afterVersion: '0.7.5',
    direct: false,
  }]);
  assert.equal(plan.target.resolved[0].identity, 'GHSA-AAAA-BBBB-CCCC');
  assert.deepEqual(plan.target.resolved[0].beforeInstances[0].dependencyPaths, [
    ['sockjs-client', 'websocket-driver'],
  ]);
  assert.deepEqual(plan.target.resolved[0].afterInstances, []);
});

test('classifies a candidate that fixes one target while another remains as a disclosed partial fix', () => {
  const fixed = advisory('GHSA-AAAA-BBBB-CCCC', '<0.7.5');
  const remains = advisory('GHSA-DDDD-EEEE-FFFF', '<0.8.0');
  const plan = createTransitiveRemediationPlan({
    rootPackageName: 'sockjs-client',
    targetAdvisories: [target(fixed), target(remains)],
    manifestUnchanged: true,
    before: snapshot(simpleGraph('0.7.3'), [['websocket-driver', [fixed, remains]]]),
    after: snapshot(simpleGraph('0.7.5'), [['websocket-driver', [fixed, remains]]]),
  });

  assert.equal(plan.classification, 'partial');
  assert.equal(plan.automaticApplyAllowed, true);
  assert.deepEqual(plan.reasons, ['TARGET_ADVISORIES_REMAIN']);
  assert.deepEqual(plan.target.resolved.map((entry) => entry.identity), ['GHSA-AAAA-BBBB-CCCC']);
  assert.deepEqual(plan.target.remaining.map((entry) => entry.identity), ['GHSA-DDDD-EEEE-FFFF']);
});

test('classifies an unchanged vulnerable graph as no-fix rather than safe', () => {
  const plan = createTransitiveRemediationPlan({
    rootPackageName: 'sockjs-client',
    targetAdvisories: [target(websocketIssue), target(websocketIssue)],
    manifestUnchanged: true,
    before: snapshot(simpleGraph('0.7.3'), [['websocket-driver', [websocketIssue]]]),
    after: snapshot(simpleGraph('0.7.3'), [['websocket-driver', [websocketIssue]]]),
  });

  assert.equal(plan.classification, 'no-fix');
  assert.equal(plan.automaticApplyAllowed, false);
  assert.deepEqual(plan.reasons, ['NO_TARGET_ADVISORY_RESOLVED']);
  assert.equal(plan.target.remaining.length, 1);
});

test('rejects a security fix when the direct root resolved version drifts', () => {
  const plan = createTransitiveRemediationPlan({
    rootPackageName: 'sockjs-client',
    targetAdvisories: [target(websocketIssue)],
    manifestUnchanged: true,
    before: snapshot(simpleGraph('0.7.3', '1.6.1'), [['websocket-driver', [websocketIssue]]]),
    after: snapshot(simpleGraph('0.7.5', '1.6.2'), [['websocket-driver', [websocketIssue]]]),
  });

  assert.equal(plan.classification, 'unsafe');
  assert.equal(plan.automaticApplyAllowed, false);
  assert.ok(plan.reasons.includes('DIRECT_DEPENDENCY_CHANGED'));
  assert.deepEqual(plan.directDependencyChanges, [{
    packageName: 'sockjs-client',
    beforeVersions: ['1.6.1'],
    afterVersions: ['1.6.2'],
  }]);
});

test('records and verifies every vulnerable installed instance independently', () => {
  const beforeFirst = 'node_modules/branch-a/node_modules/websocket-driver';
  const beforeSecond = 'node_modules/branch-b/node_modules/websocket-driver';
  const root = (firstVersion, secondVersion) => graph([
    node('sockjs-client', 'node_modules/sockjs-client', {
      direct: true,
      edges: [edge('branch-a', 'node_modules/branch-a'), edge('branch-b', 'node_modules/branch-b')],
    }),
    node('branch-a', 'node_modules/branch-a', { edges: [edge('websocket-driver', beforeFirst)] }),
    node('branch-b', 'node_modules/branch-b', { edges: [edge('websocket-driver', beforeSecond)] }),
    node('websocket-driver', beforeFirst, { version: firstVersion }),
    node('websocket-driver', beforeSecond, { version: secondVersion }),
  ]);

  const plan = createTransitiveRemediationPlan({
    rootPackageName: 'sockjs-client',
    targetAdvisories: [target(websocketIssue), target(websocketIssue)],
    manifestUnchanged: true,
    before: snapshot(root('0.7.2', '0.7.3'), [['websocket-driver', [websocketIssue]]]),
    after: snapshot(root('0.7.5', '0.7.6'), [['websocket-driver', [websocketIssue]]]),
  });

  assert.equal(plan.classification, 'full');
  assert.equal(plan.target.requestedCount, 1);
  assert.equal(plan.packageChanges.length, 2);
  assert.deepEqual(
    plan.packageChanges.map((entry) => [entry.lockfilePath, entry.beforeVersion, entry.afterVersion]),
    [
      [beforeFirst, '0.7.2', '0.7.5'],
      [beforeSecond, '0.7.3', '0.7.6'],
    ]
  );
  assert.equal(plan.target.resolved[0].beforeInstances.length, 2);
  assert.deepEqual(plan.target.resolved[0].beforeInstances.map((entry) => entry.dependencyPaths[0]), [
    ['sockjs-client', 'branch-a', 'websocket-driver'],
    ['sockjs-client', 'branch-b', 'websocket-driver'],
  ]);
});

test('rejects a candidate that fixes the target but introduces another advisory', () => {
  const evilIssue = advisory('GHSA-EVIL-EVIL-EVIL', '*', { severity: 'critical' });
  const afterGraph = simpleGraph('0.7.5');
  const root = afterGraph.nodes.get('node_modules/sockjs-client');
  root.edges.push(edge('new-risk', 'node_modules/new-risk'));
  root.deps.push('new-risk');
  afterGraph.nodes.set('node_modules/new-risk', node('new-risk', 'node_modules/new-risk'));

  const plan = createTransitiveRemediationPlan({
    rootPackageName: 'sockjs-client',
    targetAdvisories: [target(websocketIssue)],
    manifestUnchanged: true,
    before: snapshot(simpleGraph('0.7.3'), [['websocket-driver', [websocketIssue]]]),
    after: snapshot(afterGraph, [
      ['websocket-driver', [websocketIssue]],
      ['new-risk', [evilIssue]],
    ]),
  });

  assert.equal(plan.classification, 'unsafe');
  assert.equal(plan.automaticApplyAllowed, false);
  assert.ok(plan.reasons.includes('NEW_ADVISORY_INTRODUCED'));
  assert.deepEqual(plan.security.introduced.map((entry) => entry.identity), ['GHSA-EVIL-EVIL-EVIL']);
});

test('rejects unavailable security evidence and a changed manifest without claiming no-fix', () => {
  const plan = createTransitiveRemediationPlan({
    rootPackageName: 'sockjs-client',
    targetAdvisories: [target(websocketIssue)],
    manifestUnchanged: false,
    before: snapshot(simpleGraph('0.7.3'), [['websocket-driver', [websocketIssue]]], 'unavailable'),
    after: snapshot(simpleGraph('0.7.5'), [['websocket-driver', [websocketIssue]]]),
  });

  assert.equal(plan.classification, 'unsafe');
  assert.ok(plan.reasons.includes('MANIFEST_CHANGED'));
  assert.ok(plan.reasons.includes('SECURITY_EVIDENCE_UNAVAILABLE'));
});
