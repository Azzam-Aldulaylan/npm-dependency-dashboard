import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const component = readFileSync(join(process.cwd(), 'webview/src/components/UsageReferencesPanel.tsx'), 'utf8');
const css = readFileSync(join(process.cwd(), 'webview/src/styles.css'), 'utf8');

test('usage summary and detail cards expose restrained semantic color hooks', () => {
  for (const className of [
    'usage-summary-card--primary',
    'usage-summary-card--secondary',
    'usage-summary-card--insight',
    'usage-detail-card--references',
    'usage-detail-card--path',
    'usage-detail-card--duplicates',
    'usage-detail-card--hygiene',
  ]) assert.match(component, new RegExp(className));
});

test('usage color remains theme-aware and structural', () => {
  assert.match(css, /\.usage-summary-card\s*\{[^}]*border:[^}]*color-mix[^}]*background:[^}]*color-mix/s);
  assert.match(css, /\.usage-detail-card\s*\{[^}]*border-color:[^}]*color-mix[^}]*background:[^}]*color-mix/s);
  assert.match(css, /--usage-detail-accent: var\(--vscode-editorWarning-foreground\)/);
  assert.match(css, /--usage-detail-accent: var\(--vscode-charts-green/);
});
