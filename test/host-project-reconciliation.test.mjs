import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { reconcileProjectCandidates } from '../out/host/projectReconciliation.js';

const candidate = (id, manifestPath, folderId = 'folder') => ({ id, manifestPath, folderId });

test('a branch change at the same manifest preserves the selected project', () => {
  const selected = candidate('folder::package.json', 'package.json');
  assert.deepEqual(reconcileProjectCandidates(selected, [selected]), { kind: 'preserve', candidate: selected });
});

test('a recreated stable id falls back to folder plus manifest-relative path', () => {
  const before = candidate('old-id', 'apps/web/package.json');
  const after = candidate('new-id', 'apps/web/package.json');
  assert.deepEqual(reconcileProjectCandidates(before, [after]), { kind: 'preserve', candidate: after });
});

test('a removed or moved manifest auto-selects the sole candidate', () => {
  const before = candidate('old', 'apps/old/package.json');
  const moved = candidate('new', 'apps/new/package.json');
  assert.deepEqual(reconcileProjectCandidates(before, [moved]), { kind: 'auto-select', candidate: moved });
});

test('a removed selection with no candidates yields the branch-specific empty state decision', () => {
  assert.deepEqual(reconcileProjectCandidates(candidate('old', 'package.json'), []), { kind: 'none' });
});

test('new multiple-project topology requires explicit selection instead of guessing', () => {
  const candidates = [candidate('a', 'a/package.json'), candidate('b', 'b/package.json')];
  assert.deepEqual(reconcileProjectCandidates(candidate('old', 'old/package.json'), candidates), {
    kind: 'selection-required',
    candidates,
  });
});

test('branch fatal-state Retry re-enters project discovery when no selection remains', () => {
  const panel = readFileSync(new URL('../src/host/dashboardPanel.ts', import.meta.url), 'utf8');
  const refreshBranch = panel.slice(
    panel.indexOf("if (message.type === 'refresh')"),
    panel.indexOf("if (message.type === 'open-advisory')")
  );
  assert.match(
    refreshBranch,
    /if \(this\.selectedProject === undefined\) \{[\s\S]*?await this\.ensureController\(\)[\s\S]*?controller\.handleReady\(this\.sink\)/,
    'Retry must rediscover branch candidates instead of calling reloadAndScan(undefined)'
  );
  assert.match(
    refreshBranch,
    /await this\.reloadAndScan\(this\.selectedProject, \{ forceUsageRecheck: true \}\)/,
    'ordinary refresh keeps reloading the selected project directly'
  );
});
