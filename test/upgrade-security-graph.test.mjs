import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { materializeUpgradeSecurityGraph } from '../out/host/upgradeSecurityGraph.js';

const proposal = {
  requested: {
    packageName: 'react',
    currentVersion: '18.2.0',
    targetVersion: '19.0.0',
    classification: 'prod',
  },
  changes: [{
    packageName: 'react',
    currentVersion: '18.2.0',
    targetVersion: '19.0.0',
    classification: 'prod',
  }],
};

test('security graph work forwards cancellation authority and returns the materialized graph', async () => {
  const abort = new AbortController();
  const graph = { root: '/tmp', packageManager: 'npm', lockfileVersion: 3, nodes: new Map() };
  let observedSignal;
  const result = await materializeUpgradeSecurityGraph({
    compatibilityStatus: 'compatible',
    proposal,
    materializer: {
      async materializeResolvedGraph(_proposal, signal) {
        observedSignal = signal;
        return { ok: true, graph };
      },
    },
    signal: abort.signal,
  });

  assert.equal(observedSignal, abort.signal);
  assert.equal(result, graph);
});

test('security graph work never starts for conflicts or an already-cancelled analysis', async () => {
  let calls = 0;
  const materializer = {
    async materializeResolvedGraph() {
      calls += 1;
      return { ok: false };
    },
  };
  const active = new AbortController();
  const cancelled = new AbortController();
  cancelled.abort();

  assert.equal(await materializeUpgradeSecurityGraph({
    compatibilityStatus: 'conflict', proposal, materializer, signal: active.signal,
  }), undefined);
  assert.equal(await materializeUpgradeSecurityGraph({
    compatibilityStatus: 'compatible', proposal, materializer, signal: cancelled.signal,
  }), undefined);
  assert.equal(calls, 0);
});

test('security graph failures degrade to missing evidence instead of failing Upgrade Review', async () => {
  const result = await materializeUpgradeSecurityGraph({
    compatibilityStatus: 'compatible',
    proposal,
    materializer: { materializeResolvedGraph: async () => { throw new Error('resolver unavailable'); } },
    signal: new AbortController().signal,
  });
  assert.equal(result, undefined);
});

test('the coordinator overlaps security with project checks but serializes package-manager subprocesses', () => {
  const source = readFileSync(join(process.cwd(), 'src/host/upgradeAssistantCoordinator.ts'), 'utf8');
  const workflow = readFileSync(join(process.cwd(), 'src/host/projectCompatibility/projectCompatibilityWorkflow.ts'), 'utf8');
  const compatibilityStarted = source.indexOf('const compatibilityResultPromise =');
  const securityStarted = source.indexOf('const securityGraphPromise = compatibilityResultPromise.then');
  const compatibilitySettled = source.indexOf('const compatibilityResult = await compatibilityResultPromise');
  const projectStarted = source.indexOf('const projectResultPromise = runProjectCompatibilityWorkflow(');
  const securityPublished = source.indexOf('const securityResultPromise = securityGraphPromise.then');
  const inventoryWait = workflow.indexOf('await waitForWork(input.packageManagerIdle, input.signal)');
  const inventoryStarts = workflow.indexOf('await input.inspect(');

  assert.ok(compatibilityStarted >= 0 && compatibilityStarted < securityStarted, 'security is chained from compatibility work');
  assert.ok(securityStarted < compatibilitySettled, 'security can begin as soon as compatibility settles, before the main flow consumes it');
  assert.ok(projectStarted > securityStarted && projectStarted < compatibilitySettled, 'project checks launch without waiting for resolution');
  assert.ok(securityPublished > securityStarted && securityPublished < projectStarted, 'security publication is independent of inventory completion');
  assert.match(source, /packageManagerIdle: securityGraphPromise/);
  assert.ok(inventoryWait >= 0 && inventoryWait < inventoryStarts, 'uncached inventory waits for the resolver subprocess');
  assert.match(source, /if \(!succeeded\) analysisAbort\.abort\(\);\s+await Promise\.allSettled\(pendingAnalysisWork\)/);
});

test('final evidence reread rechecks cancellation before stale errors or review retention', () => {
  const source = readFileSync(join(process.cwd(), 'src/host/upgradeAssistantCoordinator.ts'), 'utf8');
  const read = source.indexOf('const [finalProjectEvidence, finalDiskSnapshot] = await Promise.all(');
  const staleCheck = source.indexOf('!projectCompatibilityFinalReadIsCurrent(', read);
  const guard = source.indexOf('if (analysisAbort.signal.aborted || this.droppedByCancellation(eligibility.packageName)) return;', read);
  const retain = source.indexOf('this.analysis = {', read);
  assert.ok(read >= 0 && guard > read && guard < staleCheck && staleCheck < retain);
});
