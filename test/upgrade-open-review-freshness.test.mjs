import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import test from 'node:test';

// Exercise the real coordinator and source-evidence collector without an
// Extension Host, network requests, or writes to a user's project.
registerHooks({
  resolve(specifier, context, nextResolve) {
    return specifier === 'vscode' ? { shortCircuit: true, url: 'test:freshness-vscode' } : nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url !== 'test:freshness-vscode') return nextLoad(url, context);
    return { shortCircuit: true, format: 'module', source: `
      export const files = new Map();
      export const workspace = {
        getConfiguration: () => ({ get: (_key, fallback) => fallback }),
        findFiles: async (pattern) => [...files.keys()]
          .filter(path => pattern.pattern.includes('**/*') || path.endsWith('next.config.js'))
          .map(fsPath => ({ fsPath })),
        fs: {
          stat: async uri => ({ size: Buffer.byteLength(files.get(uri.fsPath)) }),
          readFile: async uri => Buffer.from(files.get(uri.fsPath)),
        },
      };
      export class RelativePattern { constructor(base, pattern) { this.pattern = pattern; } }
      export class CancellationTokenSource {
        token = { isCancellationRequested: false };
        cancel() { this.token.isCancellationRequested = true; }
        dispose() {}
      }
      export const window = {}, commands = {}, tasks = {};
      export const ProgressLocation = { Notification: 15 };
      export const TaskRevealKind = { Always: 1 }, TaskPanelKind = { Dedicated: 2 };
    ` };
  },
});

const { UpgradeAssistantCoordinator } = await import('../out/host/upgradeAssistantCoordinator.js');
const { collectProjectCompatibilityEvidence } = await import('../out/host/projectCompatibility/projectEvidenceCollector.js');
const { files } = createRequire(import.meta.url)('vscode');

test('source collector reports specific coverage limits and already-cancelled scans', async () => {
  const input = { folder: { uri: { fsPath: '/workspace' } }, dir: '', manifestText: '{}', packageName: 'next' };
  files.clear();
  files.set('/workspace/page.ts', 'import Link from "next/link"');
  const capped = await collectProjectCompatibilityEvidence({ ...input, maxFiles: 1 });
  assert.deepEqual(capped.scanLimitations, ['project-source-file-limit']);
  assert.equal(capped.truncated, true);

  files.set('/workspace/page.ts', Array.from({ length: 401 }, (_, i) => `import x${i} from "next/link";`).join('\n'));
  const references = await collectProjectCompatibilityEvidence(input);
  assert.deepEqual(references.scanLimitations, ['project-import-reference-limit']);
  assert.equal(references.imports.length, 400);

  files.clear();
  for (let i = 0; i < 201; i += 1) files.set(`/workspace/app/route${i}/page.tsx`, 'export default function Page() {}');
  const framework = await collectProjectCompatibilityEvidence(input);
  assert.deepEqual(framework.scanLimitations, ['project-framework-file-limit']);
  assert.equal(framework.ruleFiles.length, 200);

  files.clear();
  files.set('/workspace/large.ts', 'x'.repeat(2 * 1024 * 1024 + 1));
  const unreadable = await collectProjectCompatibilityEvidence(input);
  assert.deepEqual(unreadable.scanLimitations, ['project-source-file-unreadable']);

  const abort = new AbortController();
  abort.abort();
  const cancelled = await collectProjectCompatibilityEvidence({ ...input, signal: abort.signal });
  assert.deepEqual(cancelled.scanLimitations, ['project-source-scan-cancelled']);
  assert.equal(cancelled.truncated, true);
});

async function fixture() {
  files.clear();
  // This source already differs from Git HEAD when the review starts. Only
  // its current contents, not Git status/mtime/watcher count, define freshness.
  files.set('/workspace/page.ts', 'import Link from "next/link"; // existing edit');
  files.set('/workspace/next.config.js', 'module.exports = { reactStrictMode: true };');
  const selected = { id: 'project', dir: '', folder: { uri: { fsPath: '/workspace' } } };
  const snapshot = {
    root: '/workspace', manifestText: '{"dependencies":{"next":"14.2.35"}}',
    lockfileText: '{"lockfileVersion":3}', lockfilePath: '/workspace/package-lock.json',
    registry: 'https://registry.npmjs.org/', packageManager: 'npm', importerId: '.',
    peerPolicy: {}, resolvedRegistry: { defaultRegistry: 'https://registry.npmjs.org/', scopes: {} },
  };
  const evidence = await collectProjectCompatibilityEvidence({ ...selected, manifestText: snapshot.manifestText, packageName: 'next' });
  assert.equal(evidence.imports.length, 1, 'fixture must collect the real source import');
  assert.equal(evidence.ruleFiles.length, 1, 'fixture must collect the real Next config');
  const messages = [];
  const lifecycle = [];
  let read = async () => structuredClone(snapshot);
  let currentProject = selected;
  const coordinator = new UpgradeAssistantCoordinator({
    sink: { postMessage: message => messages.push(message) }, httpClient: {}, etagStore: {},
    ensureController: async () => ({ root: snapshot.root, validateBulkUpgradeRequest: () => ({ ok: true }) }),
    getSelectedProject: () => currentProject, isDisposed: () => false,
    reloadFinalState: async () => {}, flushDeferredChanges: async () => lifecycle.push('flush'),
    loadProject: () => read(),
  });
  // Seed the completed-review boundary, skipping unrelated resolver/network work.
  const stored = {
    id: 'review-1', snapshot: structuredClone(snapshot), eligibility: { packageName: 'next' },
    projectCompatibilityEvidenceFingerprint: evidence.evidenceFingerprint,
    compatibilityStatus: 'compatible', expiresAt: Date.now() + 60_000,
    smartPlanProposal: null, proposal: { changes: [] }, requests: [], publishedTargetsByPackage: new Map(),
  };
  coordinator.analysis = stored;
  assert.equal(coordinator.reserve('next'), true);
  return { coordinator, stored, snapshot, messages, lifecycle, setRead: value => { read = value; },
    switchProject: () => { currentProject = { ...selected, id: 'other' }; } };
}

test('no-op source/dependency watcher bursts keep a completed review with pre-existing edits', async () => {
  const f = await fixture();
  f.coordinator.handleProjectSourceChanged();
  f.coordinator.handleDependencySourceChanged();
  assert.equal(f.coordinator.analysis, f.stored, 'do not revoke before comparing contents');
  await f.coordinator.checkOpenAnalysisFreshness();
  assert.deepEqual(f.messages, []);
  assert.deepEqual(f.lifecycle, []);
  assert.equal(f.coordinator.analysis, f.stored);
  assert.equal(f.coordinator.isBusy(), true, 'keep the review reservation usable');
  f.coordinator.handleCancelUpgrade({ analysisId: f.stored.id });
});

test('a watched file outside consumed evidence does not stale the review', async () => {
  const f = await fixture();
  files.set('/workspace/unrelated.ts', 'export const unrelated = 2;');
  f.coordinator.handleProjectSourceChanged();
  await f.coordinator.checkOpenAnalysisFreshness();
  assert.deepEqual(f.messages, []);
  assert.equal(f.coordinator.analysis, f.stored);
});

for (const field of ['manifestText', 'lockfileText', 'registry', 'importerId']) {
  test(`a real ${field} change revokes the completed review exactly once`, async () => {
    const f = await fixture();
    f.snapshot[field] += ' changed';
    f.coordinator.handleDependencySourceChanged();
    await f.coordinator.checkOpenAnalysisFreshness();
    await f.coordinator.checkOpenAnalysisFreshness();
    assert.deepEqual(f.messages, [{ status: 'upgrade-analysis-stale', analysisId: 'review-1' }]);
    assert.equal(f.coordinator.analysis, undefined);
    assert.equal(f.coordinator.isBusy(), false);
    assert.deepEqual(f.lifecycle, ['flush']);
  });
}

for (const [path, text] of [
  ['/workspace/page.ts', 'import removed from "next/private-api";'],
  ['/workspace/next.config.js', 'module.exports = { experimental: { changed: true } };'],
]) {
  test(`changed consumed evidence in ${path} is detected`, async () => {
    const f = await fixture();
    files.set(path, text);
    f.coordinator.handleProjectSourceChanged();
    await f.coordinator.checkOpenAnalysisFreshness();
    assert.deepEqual(f.messages, [{ status: 'upgrade-analysis-stale', analysisId: 'review-1' }]);
    assert.equal(f.coordinator.isBusy(), false);
  });
}

for (const supersede of ['cancel', 'replacement', 'project-switch', 'newer-event']) {
  test(`a freshness read superseded by ${supersede} cannot revoke the current review`, async () => {
    const f = await fixture();
    let finish;
    f.setRead(() => new Promise(resolve => { finish = resolve; }));
    const checking = f.coordinator.checkOpenAnalysisFreshness();
    if (supersede === 'cancel') f.coordinator.handleCancelUpgrade({ analysisId: f.stored.id });
    if (supersede === 'replacement') f.coordinator.analysis = { ...f.stored, id: 'review-2' };
    if (supersede === 'project-switch') f.switchProject();
    if (supersede === 'newer-event') f.coordinator.handleProjectSourceChanged();
    finish({ ...f.snapshot, manifestText: 'temporary intermediate contents' });
    await checking;
    assert.deepEqual(f.messages, []);
    if (supersede === 'replacement') assert.equal(f.coordinator.analysis.id, 'review-2');
    if (supersede === 'newer-event') {
      f.setRead(async () => f.snapshot);
      await f.coordinator.checkOpenAnalysisFreshness();
      assert.equal(f.coordinator.analysis, f.stored);
    }
  });
}

test('a failed background reread is contained and does not falsely report changed files', async () => {
  const f = await fixture();
  f.setRead(async () => { throw new Error('temporarily unreadable'); });
  await f.coordinator.checkOpenAnalysisFreshness();
  assert.deepEqual(f.messages, []);
  assert.equal(f.coordinator.analysis, f.stored);
});

test('confirm during the debounce window still rejects changed dependency contents', async () => {
  const f = await fixture();
  f.snapshot.lockfileText = 'changed after review';
  f.coordinator.handleProjectSourceChanged();
  await f.coordinator.handleConfirmUpgrade({ analysisId: f.stored.id });
  assert.equal(f.messages.find(message => message.status === 'upgrade-error')?.error.code, 'STALE_SOURCE');
  assert.equal(f.coordinator.isBusy(), false);
});

test('confirm without a watcher notification still rejects changed source evidence', async () => {
  const f = await fixture();
  files.set('/workspace/page.ts', 'import removed from "next/private-api";');
  await f.coordinator.handleConfirmUpgrade({ analysisId: f.stored.id });
  assert.equal(f.messages.find(message => message.status === 'upgrade-error')?.error.code, 'STALE_SOURCE');
  assert.equal(f.coordinator.isBusy(), false);
});
