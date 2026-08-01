/**
 * The Action column's display decision — pure, no React/DOM involved, so this
 * is a plain unit test rather than a component-rendering one (this repo has
 * no jsdom/testing-library set up; see PackageTable.tsx for where this feeds
 * into the actual cell).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  upgradeActionDisplay,
  UPGRADE_UNAVAILABLE_TOOLTIP,
} from '../out/host/upgradeAction.js';

test('a null upgradeTo means no button at all', () => {
  assert.equal(upgradeActionDisplay(null), null);
});

test('a non-null upgradeTo names the target version in the label', () => {
  const action = upgradeActionDisplay('3.1.5');
  assert.deepEqual(action, {
    label: 'Upgrade to 3.1.5',
    tooltip: UPGRADE_UNAVAILABLE_TOOLTIP,
  });
});

test('the tooltip explains the button is inert, not broken', () => {
  const action = upgradeActionDisplay('2.0.0');
  assert.ok(action !== null);
  assert.match(action.tooltip, /future release/i);
});
