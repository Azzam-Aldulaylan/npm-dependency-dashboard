import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';

const read = (path) => readFileSync(join(process.cwd(), path), 'utf8');
const app = read('webview/src/App.tsx');
const packageTable = read('webview/src/components/PackageTable.tsx');
const summaryCards = read('webview/src/components/SummaryCards.tsx');
const styles = read('webview/src/styles.css');

test('dependency type All stays project-wide while narrowed results are reported separately', () => {
  assert.match(app, /return \{ \.\.\.contextualCounts, all: data\.rows\.length \};/);
  assert.match(app, /`\$\{filteredRows\.length\} of \$\{dependencyCountLabel\(data\.rows\.length\)\} match the current filters`/);
  assert.match(app, /className="dashboard__matching-results" aria-live="polite"/);
});

test('the dashboard groups health signals and inventory in named theme-aware surfaces', () => {
  assert.match(app, /className="dashboard__overview" aria-labelledby="dashboard-overview-title"/);
  assert.match(app, /className="dashboard__inventory" aria-labelledby="dashboard-inventory-title"/);
  assert.match(app, /<h2 id="dashboard-overview-title">Project health<\/h2>/);
  assert.match(app, /<h2 id="dashboard-inventory-title">Dependency inventory<\/h2>/);
  assert.match(styles, /\.dashboard__overview \{[\s\S]*?border-radius: 12px;[\s\S]*?background: var\(--dashboard-surface\);/);
  assert.match(styles, /\.dashboard__inventory \{[\s\S]*?border-radius: 12px;[\s\S]*?background: var\(--dashboard-surface\);/);
});

test('summary signals expose a strong selected state without relying on color alone', () => {
  assert.match(summaryCards, /aria-pressed=\{selected\}/);
  assert.match(summaryCards, /aria-label=\{`\$\{card\.label\}: \$\{card\.count\}\. \$\{card\.subtitle\}`\}/);
  assert.match(styles, /\.summary-card\[data-selected='true'\]::after/);
  assert.match(styles, /\.summary-card\[data-selected='true'\] \.summary-card__selection \{[\s\S]*?visibility: visible;/);
  assert.match(styles, /\.summary-card__subtitle \{[^}]*white-space: normal;/);
});

test('the dependency table is a keyboard-accessible scroll region with sticky themed headers', () => {
  assert.match(packageTable, /role="region" aria-label="Dependency packages" tabIndex=\{0\}/);
  assert.match(styles, /\.packages-container \{[\s\S]*?max-height:[^;]+;[\s\S]*?overflow: auto;/);
  assert.match(styles, /\.packages-container:focus-visible/);
  assert.match(styles, /\.packages thead th \{[\s\S]*?position: sticky;[\s\S]*?top: 0;[\s\S]*?z-index: 2;/);
  assert.match(styles, /background: var\(--vscode-sideBar-background, var\(--vscode-editor-background\)\);/);
});

test('completed embedded reviews can yield without relaxing active-work gates', () => {
  assert.match(app, /const embeddedUpgradeCanYield = upgradeActive && analysis !== null && !confirmBusy;/);
  assert.match(app, /const embeddedRemovalCanYield = removeActive && removeAnalysis !== null && !removeBusy;/);
  assert.match(
    app,
    /const manageActionsDisabled =[\s\S]*?loading \|\|[\s\S]*?\(activeUpgrade !== null && !embeddedUpgradeCanYield\) \|\|[\s\S]*?remediationBusy \|\|[\s\S]*?cleanupState\.phase === 'analyzing' \|\|[\s\S]*?\(activeRemove !== null && !embeddedRemovalCanYield\);/
  );
  assert.match(
    app,
    /const manageUpgradeDisabled =[\s\S]*?remediationBusy \|\|[\s\S]*?confirmBusy \|\|[\s\S]*?removeBusy \|\|[\s\S]*?removalImpact\.phase === 'analyzing'/
  );
  assert.match(app, /actionsDisabled=\{manageActionsDisabled\}/);
  assert.match(app, /upgradeDisabled=\{manageUpgradeDisabled\}/);
});
