import assert from 'node:assert/strict';
import test from 'node:test';

import { SmartCleanupMetadataCoordinator } from '../out/host/smartCleanupMetadataCoordinator.js';

function row(name, current) {
  return {
    name,
    current,
    wanted: current,
    latest: current,
    dev: false,
    optional: false,
    range: `^${current}`,
    advisories: [],
    worstSeverity: null,
    upgradeTo: null,
    upgradeReason: null,
  };
}

function harness(responses, overrides = {}) {
  const messages = [];
  let generation = 0;
  const source = {
    manifestText: '{"dependencies":{"old-package":"^1.0.0"}}',
    lockfileText: '{}',
    lockfilePath: '/workspace/package-lock.json',
    registry: 'https://registry.npmjs.org/',
    resolvedRegistry: { url: 'https://registry.npmjs.org/', source: 'default', scoped: {} },
    packageManager: 'npm',
    importerId: '.',
    lockfileName: 'package-lock.json',
  };
  const controller = {
    upgradeSource: source,
    lastResultRows: () => overrides.rows ?? [row('old-package', '1.0.0'), row('healthy-package', '2.0.0')],
  };
  const coordinator = new SmartCleanupMetadataCoordinator({
    sink: { postMessage: (message) => messages.push(message) },
    httpClient: {
      async get(url) {
        if (overrides.get !== undefined) return overrides.get(url);
        const response = responses.get(url);
        if (response === undefined) return { status: 404, headers: {}, body: '', wireBytes: 0 };
        return { status: 200, headers: {}, body: JSON.stringify(response), wireBytes: 100 };
      },
      async post() {
        throw new Error('not used');
      },
    },
    etagStore: { get: () => undefined, set: () => undefined },
    ensureController: async () => {
      if (overrides.ensureControllerGate !== undefined) await overrides.ensureControllerGate;
      return controller;
    },
    isDisposed: () => false,
    sourceGeneration: () => generation,
  });
  return {
    coordinator,
    messages,
    advanceSourceGeneration: () => { generation += 1; },
  };
}

test('Smart Cleanup reports deprecation for the exact installed version only', async () => {
  const responses = new Map([
    [
      'https://registry.npmjs.org/old-package/1.0.0',
      { name: 'old-package', version: '1.0.0', deprecated: 'Please use new-package instead' },
    ],
    [
      'https://registry.npmjs.org/healthy-package/2.0.0',
      { name: 'healthy-package', version: '2.0.0' },
    ],
  ]);
  const { coordinator, messages } = harness(responses);

  await coordinator.analyze('cleanup-1');

  const result = messages.at(-1);
  assert.equal(messages.every((message) => message.requestId === 'cleanup-1'), true);
  assert.equal(result.status, 'smart-cleanup-metadata-result');
  assert.equal(result.requestId, 'cleanup-1');
  assert.deepEqual(result.capability, { executionSupported: true });
  assert.deepEqual(result.unavailablePackages, []);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].packageName, 'old-package');
  assert.equal(result.findings[0].evidence.suggestedReplacement, 'new-package');
  assert.deepEqual(coordinator.currentDeprecationEvidence(), {
    deprecatedPackages: ['old-package'],
    installedVersions: { 'old-package': '1.0.0', 'healthy-package': '2.0.0' },
  });
});

test('retained deprecation evidence is invalidated by source changes and cancellation', async () => {
  const responses = new Map([
    [
      'https://registry.npmjs.org/old-package/1.0.0',
      { name: 'old-package', version: '1.0.0', deprecated: 'No longer maintained' },
    ],
    [
      'https://registry.npmjs.org/healthy-package/2.0.0',
      { name: 'healthy-package', version: '2.0.0' },
    ],
  ]);
  const sourceChanged = harness(responses);
  await sourceChanged.coordinator.analyze('source-change');
  sourceChanged.advanceSourceGeneration();
  assert.equal(sourceChanged.coordinator.currentDeprecationEvidence(), undefined);

  const cancelled = harness(responses);
  await cancelled.coordinator.analyze('cancelled');
  cancelled.coordinator.cancel('cancelled');
  assert.equal(cancelled.coordinator.currentDeprecationEvidence(), undefined);
});

test('partial exact-version metadata never becomes completion-report authority', async () => {
  const responses = new Map([
    [
      'https://registry.npmjs.org/old-package/1.0.0',
      { name: 'old-package', version: '1.0.0', deprecated: 'No longer maintained' },
    ],
  ]);
  const { coordinator } = harness(responses);
  await coordinator.analyze('partial-evidence');
  assert.equal(coordinator.currentDeprecationEvidence(), undefined);
});

test('one exact-version metadata failure stays partial instead of losing successful evidence', async () => {
  const responses = new Map([
    [
      'https://registry.npmjs.org/old-package/1.0.0',
      { name: 'old-package', version: '1.0.0', deprecated: 'No longer maintained' },
    ],
  ]);
  const { coordinator, messages } = harness(responses);

  await coordinator.analyze('cleanup-2');

  const result = messages.at(-1);
  assert.equal(result.status, 'smart-cleanup-metadata-result');
  assert.equal(result.requestId, 'cleanup-2');
  assert.deepEqual(result.unavailablePackages, ['healthy-package']);
  assert.equal(result.findings.length, 1);
});

test('packages without exact registry-checkable installed versions are reported as unavailable', async () => {
  const workspaceRow = { ...row('workspace-package', null), range: 'workspace:*', unresolvable: 'workspace-link' };
  const { coordinator, messages } = harness(new Map(), { rows: [workspaceRow] });

  await coordinator.analyze('cleanup-skipped');

  const result = messages.at(-1);
  assert.equal(result.status, 'smart-cleanup-metadata-result');
  assert.deepEqual(result.unavailablePackages, ['workspace-package']);
  assert.deepEqual(result.findings, []);
});

test('a watcher generation change rejects metadata even before in-memory source strings change', async () => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const responses = new Map();
  const harnessResult = harness(responses, {
    async get(url) {
      await blocked;
      const encodedName = url.includes('old-package') ? 'old-package' : 'healthy-package';
      const version = encodedName === 'old-package' ? '1.0.0' : '2.0.0';
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({ name: encodedName, version }),
        wireBytes: 100,
      };
    },
  });

  const analysis = harnessResult.coordinator.analyze('stale-run');
  await new Promise((resolve) => setImmediate(resolve));
  harnessResult.advanceSourceGeneration();
  release();
  await analysis;

  const terminal = harnessResult.messages.at(-1);
  assert.equal(terminal.status, 'smart-cleanup-metadata-error');
  assert.equal(terminal.requestId, 'stale-run');
  assert.equal(terminal.error.code, 'STALE_SOURCE');
  assert.equal(
    harnessResult.messages.some((message) => message.status === 'smart-cleanup-metadata-result'),
    false
  );
});

test('source generation is captured before asynchronous controller acquisition', async () => {
  let releaseController;
  const controllerGate = new Promise((resolve) => { releaseController = resolve; });
  const harnessResult = harness(new Map(), { ensureControllerGate: controllerGate });

  const analysis = harnessResult.coordinator.analyze('controller-race');
  harnessResult.advanceSourceGeneration();
  releaseController();
  await analysis;

  assert.deepEqual(harnessResult.messages, [{
    status: 'smart-cleanup-metadata-error',
    requestId: 'controller-race',
    error: {
      code: 'STALE_SOURCE',
      message: 'Project dependencies changed during cleanup analysis. Analyze again.',
    },
  }]);
});

test('cancelling one request does not cancel a newer request id', async () => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const harnessResult = harness(new Map(), {
    async get(url) {
      await blocked;
      const encodedName = url.includes('old-package') ? 'old-package' : 'healthy-package';
      const version = encodedName === 'old-package' ? '1.0.0' : '2.0.0';
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({ name: encodedName, version }),
        wireBytes: 100,
      };
    },
  });

  const analysis = harnessResult.coordinator.analyze('current-run');
  await new Promise((resolve) => setImmediate(resolve));
  harnessResult.coordinator.cancel('older-run');
  release();
  await analysis;

  assert.equal(harnessResult.messages.at(-1).status, 'smart-cleanup-metadata-result');
  assert.equal(harnessResult.messages.at(-1).requestId, 'current-run');
});
