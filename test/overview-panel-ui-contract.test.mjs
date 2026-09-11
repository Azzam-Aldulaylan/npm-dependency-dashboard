import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

const overview = readFileSync('webview/src/components/OverviewPanel.tsx', 'utf8');
const styles = readFileSync('webview/src/styles.css', 'utf8');

test('overview summary groups use restrained semantic accents without changing their content', () => {
  assert.match(overview, /overview-summary-card overview-summary-card--identity/);
  assert.match(overview, /overview-summary-card overview-summary-card--health/);
  assert.match(styles, /\.overview-summary-card\s*\{[^}]*border:[^}]*background:/s);
  assert.match(styles, /\.overview-summary-card--health\s*\{[^}]*--overview-summary-accent:/s);
  assert.match(styles, /\.overview-summary-card \.manage-section-heading/);
});
