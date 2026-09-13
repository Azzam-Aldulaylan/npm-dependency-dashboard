import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const read = (path) => readFileSync(join(process.cwd(), path), 'utf8');
const panel = read('webview/src/components/VulnerabilitiesPanel.tsx');
const styles = read('webview/src/styles.css');

test('vulnerability cards and the summary expose severity-aware styling hooks', () => {
  assert.match(panel, /vuln-card vuln-card--\$\{context\.advisory\.severity\}/);
  assert.match(panel, /vuln-summary-card vuln-summary-card--\$\{worstPresent\}/);
  for (const severity of ['critical', 'high', 'moderate', 'low']) {
    assert.match(styles, new RegExp(`\\.vuln-card--${severity}`));
  }
});

test('the polish keeps color semantic and preserves card hierarchy', () => {
  assert.match(styles, /\.vuln-card\s*\{[^}]*--vuln-card-accent:[^}]*border:[^}]*var\(--vuln-card-accent\)[^}]*background:/s);
  assert.match(styles, /\.vuln-card__head\s*\{[^}]*border-bottom:/s);
  assert.match(styles, /\.vuln-tab__summary > \.vuln-recommended\s*\{[^}]*border-color:[^}]*charts-purple[^}]*background:/s);
  assert.match(styles, /\.vuln-source-note\s*\{[^}]*border-bottom:/s);
});
