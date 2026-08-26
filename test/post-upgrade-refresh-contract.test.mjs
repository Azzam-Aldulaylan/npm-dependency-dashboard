import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const app = readFileSync(new URL('../webview/src/App.tsx', import.meta.url), 'utf8');
const modal = readFileSync(new URL('../webview/src/components/ManageDependencyModal.tsx', import.meta.url), 'utf8');
const panel = readFileSync(new URL('../src/host/dashboardPanel.ts', import.meta.url), 'utf8');

test('upgrade result keeps Manage context, patches local facts, and preserves usage during enrichment', () => {
  const resultBranch = app.slice(app.indexOf("if (incoming.status === 'upgrade-result')"), app.indexOf("if (incoming.status === 'upgrade-error')"));
  assert.match(resultBranch, /applyUpgradeResultLocalFacts/);
  assert.doesNotMatch(resultBranch, /setManageRow\(/);
  assert.doesNotMatch(resultBranch, /setManageTab\(/);
  assert.doesNotMatch(resultBranch, /setUsageByPackage\(/);
  assert.match(app, /if \(pendingUpgradeResult === null\) setUsageByPackage\(new Map\(\)\)/);
});

test('Manage renders completion and section-level refreshing states without blanking usage', () => {
  assert.match(modal, /Upgrade verified/);
  assert.match(modal, /Install/);
  assert.match(modal, /Applied state/);
  assert.match(modal, /Verification/);
  assert.match(modal, /Refreshing vulnerability data/);
  assert.match(modal, /Refreshing security and available-version information/);
  assert.match(modal, /activeTab === 'usage'[\s\S]*?<UsageReferencesPanel/);
  assert.match(modal, /Dependency data refresh failed/);
  assert.match(modal, /Retry dependency data refresh/);
  assert.match(modal, /shouldShowUpgradeVulnerabilitySeverity/);
});

test('post-mutation panel suppresses only the pre-read watcher burst and uses local-mutation enrichment', () => {
  const fastRead = panel.slice(panel.indexOf('private async readAndApplyMutationLocalState'), panel.indexOf('private refreshMutationEnrichmentInBackground'));
  assert.ok(fastRead.indexOf('discardPending()') < fastRead.indexOf('loadProjectMeasured('));
  assert.equal((fastRead.match(/discardPending\(\)/g) ?? []).length, 1);
  assert.match(panel, /flushDeferredChanges: async \(\) => \{\s*await this\.fileChangeCoordinator\.flushAll\(\);/);
  assert.match(panel, /refreshInBackground\(this\.sink, 'local-mutation'\)/);
});

test('only a correlated enrichment terminal, never an arbitrary dashboard snapshot, ends refreshing', () => {
  const terminalBranch = app.slice(
    app.indexOf("if (incoming.status === 'upgrade-enrichment-result')"),
    app.indexOf("if (incoming.status === 'upgrade-error')")
  );
  assert.match(terminalBranch, /applyUpgradeEnrichmentTerminal/);
  assert.match(terminalBranch, /pendingResult\.refreshId === incoming\.refreshId/);
  const snapshotBranch = app.slice(app.indexOf('// Any other message is a dashboard snapshot'), app.indexOf('activeUpgradeRef.current = null', app.indexOf('// Any other message is a dashboard snapshot')));
  assert.doesNotMatch(snapshotBranch, /refreshingDerivedData: false/);
  assert.match(snapshotBranch, /completedDashboardSnapshotAbandonsUpgradeEnrichment/);
  assert.match(snapshotBranch, /setUpgradeResult\(null\)/);
});
