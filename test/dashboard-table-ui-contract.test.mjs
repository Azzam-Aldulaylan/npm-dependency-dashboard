import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';

const read = (path) => readFileSync(join(process.cwd(), path), 'utf8');
const app = read('webview/src/App.tsx');
const packageTable = read('webview/src/components/PackageTable.tsx');
const styles = read('webview/src/styles.css');

test('dependency type All stays project-wide while narrowed results are reported separately', () => {
  assert.match(app, /return \{ \.\.\.contextualCounts, all: data\.rows\.length \};/);
  assert.match(app, /Current filters match \{filteredRows\.length\} of \{dependencyCountLabel\(data\.rows\.length\)\}/);
  assert.match(app, /className="dashboard__matching-results" aria-live="polite"/);
});

test('the dependency table is a keyboard-accessible scroll region with sticky themed headers', () => {
  assert.match(packageTable, /role="region" aria-label="Dependency packages" tabIndex=\{0\}/);
  assert.match(styles, /\.packages-container \{[\s\S]*?max-height:[^;]+;[\s\S]*?overflow: auto;/);
  assert.match(styles, /\.packages-container:focus-visible/);
  assert.match(styles, /\.packages thead th \{[\s\S]*?position: sticky;[\s\S]*?top: 0;[\s\S]*?z-index: 2;/);
  assert.match(styles, /background: var\(--vscode-sideBar-background, var\(--vscode-editor-background\)\);/);
});

test('a completed embedded removal review can yield to Upgrade review without relaxing active-work gates', () => {
  assert.match(app, /const embeddedRemovalCanYield = removeActive && removeAnalysis !== null && !removeBusy;/);
  assert.match(
    app,
    /const manageActionsDisabled =[\s\S]*?loading \|\|[\s\S]*?activeUpgrade !== null \|\|[\s\S]*?remediationBusy \|\|[\s\S]*?cleanupState\.phase === 'analyzing' \|\|[\s\S]*?\(activeRemove !== null && !embeddedRemovalCanYield\);/
  );
  assert.match(
    app,
    /const manageUpgradeDisabled =[\s\S]*?remediationBusy \|\|[\s\S]*?confirmBusy \|\|[\s\S]*?removeBusy \|\|[\s\S]*?removalImpact\.phase === 'analyzing'/
  );
  assert.match(app, /actionsDisabled=\{manageActionsDisabled\}/);
  assert.match(app, /upgradeDisabled=\{manageUpgradeDisabled\}/);
});
