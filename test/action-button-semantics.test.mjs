import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  bulkRemovalAction,
  semanticButtonClassName,
  upgradeConfirmationAction,
} from '../out/host/actionButtonSemantics.js';

function analysis(status, overrides = {}) {
  return {
    targetVersion: '2.0.0',
    changes: [{ packageName: 'pkg' }],
    compatibility: { status },
    smartPlan: null,
    ...overrides,
  };
}

test('compatible upgrades use the standard primary action and selected target', () => {
  assert.deepEqual(upgradeConfirmationAction(analysis('compatible')), {
    label: 'Upgrade to 2.0.0',
    onClick: 'confirm',
    variant: 'primary',
  });
});

test('warning and unknown upgrades use the same cautious action vocabulary', () => {
  for (const status of ['warning', 'unknown']) {
    assert.deepEqual(upgradeConfirmationAction(analysis(status)), {
      label: 'Upgrade anyway',
      onClick: 'confirm',
      variant: 'caution',
    });
  }
});

test('multi-package caution and primary labels stay explicit', () => {
  const changes = [{ packageName: 'one' }, { packageName: 'two' }];
  assert.equal(upgradeConfirmationAction(analysis('compatible', { changes })).label, 'Upgrade 2 dependencies');
  assert.deepEqual(upgradeConfirmationAction(analysis('warning', { changes })), {
    label: 'Upgrade 2 anyway',
    onClick: 'confirm',
    variant: 'caution',
  });
});

test('a coordinated conflict plan is primary while an unresolved conflict has no action', () => {
  assert.deepEqual(upgradeConfirmationAction(analysis('conflict', { smartPlan: { groups: [] } })), {
    label: 'Use coordinated upgrade',
    onClick: 'use-smart-plan',
    variant: 'primary',
  });
  assert.equal(upgradeConfirmationAction(analysis('conflict')), null);
});

test('bulk removal changes from primary analysis to destructive confirmation', () => {
  assert.deepEqual(bulkRemovalAction(3, false), {
    label: 'Analyze removal impact (3)',
    variant: 'primary',
  });
  assert.deepEqual(bulkRemovalAction(3, true), { label: 'Remove 3', variant: 'danger' });
});

test('semantic class names always include the shared base and explicit variant', () => {
  for (const variant of ['primary', 'caution', 'danger', 'secondary', 'subtle']) {
    assert.equal(semanticButtonClassName(variant), `button button--${variant}`);
  }
  assert.equal(semanticButtonClassName('caution', 'footer-action'), 'button button--caution footer-action');
});

test('button CSS defines every semantic variant with VS Code theme tokens and shared interaction structure', () => {
  const css = readFileSync(join(process.cwd(), 'webview/src/styles.css'), 'utf8');
  for (const variant of ['primary', 'caution', 'danger', 'secondary', 'subtle']) {
    assert.match(css, new RegExp(`\\.button--${variant}\\s*\\{`));
  }
  assert.match(css, /\.button--caution\s*\{[^}]*--vscode-inputValidation-warningForeground/s);
  assert.match(css, /\.button--caution\s*\{[^}]*--vscode-inputValidation-warningBorder/s);
  assert.match(css, /\.button\s*\{[^}]*min-height:[^;}]+;[^}]*border-radius:[^;}]+;[^}]*font-family:\s*inherit/s);
  assert.match(css, /\.button:focus-visible\s*\{[^}]*--vscode-focusBorder/s);
  assert.match(css, /\.button:disabled\s*\{/s);
});
