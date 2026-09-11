import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const panel = readFileSync(join(process.cwd(), 'src/host/dashboardPanel.ts'), 'utf8');
const app = readFileSync(join(process.cwd(), 'webview/src/App.tsx'), 'utf8');

test('read-only usage and removal analysis are blocked only by a real mutation', () => {
  const removalHandler = panel.slice(
    panel.indexOf("if (message.type === 'analyze-removal-impact')"),
    panel.indexOf("if (message.type === 'open-usage-reference')")
  );
  assert.match(removalHandler, /upgradeCoordinator\.isMutationBusy\(\)/);
  assert.doesNotMatch(removalHandler, /upgradeCoordinator\.isBusy\(\)/);
  assert.doesNotMatch(removalHandler, /Another upgrade is already in progress/);
  assert.match(panel, /isUpgradeBusy: \(\) => this\.upgradeCoordinator\.isMutationBusy\(\)/);
});

test('a remounted webview abandons invisible read-only review ownership', () => {
  const readyHandler = panel.slice(
    panel.indexOf("if (message.type === 'ready')"),
    panel.indexOf("if (message.type === 'load-upgrade-targets')")
  );
  assert.match(readyHandler, /await this\.upgradeCoordinator\.handleWebviewReady\(\)/);
});

test('completed embedded reviews coexist without cancelling either cached result', () => {
  assert.match(app, /const embeddedUpgradeCanYield = upgradeActive && analysis !== null && !confirmBusy/);
  assert.match(app, /\(activeUpgrade !== null && !embeddedUpgradeCanYield\)/);
  assert.match(app, /completedManageReviewCanCoexist/);
  const upgradeStart = app.slice(app.indexOf('const requestUpgradeFromManage'), app.indexOf('// Selecting a card'));
  const removalStart = app.slice(app.indexOf('const requestRemoveFromManage'), app.indexOf('useEffect(() =>', app.indexOf('const requestRemoveFromManage')));
  assert.doesNotMatch(upgradeStart, /requestCancelRemove\(\)/);
  assert.doesNotMatch(removalStart, /requestCancelUpgrade\(\)/);
  assert.match(app, /setConfirmBusy\(false\);[\s\S]*?if \(upgradeErrorClearsActiveState/);
  assert.match(app, /if \(incoming\.status === 'remove-error'\) \{\s*setRemoveBusy\(false\)/);
});
