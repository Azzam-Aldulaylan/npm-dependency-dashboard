import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import test from 'node:test';

let findFilesCalls = 0;

class MockCancellationTokenSource {
  #listeners = new Set();
  #cancelled = false;

  token = {
    get isCancellationRequested() {
      return this.owner.#cancelled;
    },
    owner: this,
    onCancellationRequested: (listener) => {
      this.#listeners.add(listener);
      return { dispose: () => this.#listeners.delete(listener) };
    },
  };

  cancel() {
    if (this.#cancelled) return;
    this.#cancelled = true;
    for (const listener of this.#listeners) listener();
  }

  dispose() {
    this.#listeners.clear();
  }
}

const vscode = {
  CancellationTokenSource: MockCancellationTokenSource,
  RelativePattern: class RelativePattern {
    constructor(base, pattern) {
      this.base = base;
      this.pattern = pattern;
    }
  },
  workspace: {
    findFiles: async () => {
      findFilesCalls += 1;
      return [];
    },
    fs: {
      stat: async () => ({ size: 0 }),
      readFile: async () => new Uint8Array(),
    },
  },
  window: {
    withProgress: async (_options, run) => run(
      { report: () => undefined },
      { onCancellationRequested: () => ({ dispose: () => undefined }) }
    ),
    showTextDocument: async () => ({}),
  },
  ProgressLocation: { Notification: 1 },
  Uri: { joinPath: () => ({}) },
  Position: class Position {},
  Selection: class Selection {},
  Range: class Range {},
  TextEditorRevealType: { InCenter: 1 },
};

const originalLoad = Module._load;
Module._load = function loadWithVscodeMock(request, parent, isMain) {
  if (request === 'vscode') return vscode;
  return originalLoad.call(this, request, parent, isMain);
};
const require = createRequire(import.meta.url);
const { UsageAnalysisCoordinator } = require('../out/host/usage/usageCoordinator.js');
Module._load = originalLoad;

function fixture() {
  const messages = [];
  const selected = {
    id: 'project-a',
    dir: '',
    relativePath: 'package.json',
    manifestPath: '/workspace/package.json',
    folder: { uri: { fsPath: '/workspace' }, name: 'workspace', index: 0 },
  };
  const controller = {
    root: '/workspace',
    upgradeSource: {
      manifestText: JSON.stringify({ name: 'fixture', dependencies: { react: '^18.0.0' } }),
      lockfileText: null,
      lockfilePath: null,
      packageManager: 'npm',
      importerId: '.',
    },
    lastResultRows: () => [{ name: 'react' }],
  };
  const coordinator = new UsageAnalysisCoordinator({
    sink: { postMessage: (message) => messages.push(message) },
    ensureController: async () => controller,
    getSelectedProject: () => selected,
    isDisposed: () => false,
  });
  return { coordinator, messages };
}

test('coordinator reuses a real cleanup scan and immediately supersedes rendered evidence on source invalidation', async () => {
  findFilesCalls = 0;
  const { coordinator, messages } = fixture();

  assert.equal(await coordinator.handleAnalyzeCleanup({ background: true }), true);
  assert.equal(findFilesCalls, 2, 'cleanup performs one concurrent source/config discovery pair');

  await coordinator.handleWhereUsed({ package: 'react' });
  const usage = messages.findLast((message) => message.status === 'usage-result');
  assert.equal(usage.analysis.fromCache, true);
  assert.equal(findFilesCalls, 2, 'where-used reuses cleanup instead of scanning');

  await coordinator.handleAnalyzeRemovalImpact({ packages: ['react'] });
  assert.equal(messages.findLast((message) => message.status === 'removal-impact-result').assessments.length, 1);
  assert.equal(findFilesCalls, 2, 'removal impact reuses the complete cleanup entry');

  const beforeInvalidation = messages.length;
  assert.equal(coordinator.invalidateProjectSource('project-a'), 1);
  const supersession = messages.slice(beforeInvalidation);
  assert.deepEqual(supersession.map((message) => message.status), [
    'usage-error',
    'cleanup-result',
    'removal-impact-error',
  ]);
  assert.equal(supersession[0].error.code, 'STALE_SOURCE');
  assert.deepEqual(supersession[1].findings, []);
  assert.equal(Date.parse(supersession[1].cacheExpiresAt), 0);
  assert.equal(supersession[2].error.code, 'STALE_SOURCE');

  coordinator.dispose();
});
