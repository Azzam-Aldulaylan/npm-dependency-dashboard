import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const card = readFileSync(new URL('../webview/src/components/VulnerabilityCard.tsx', import.meta.url), 'utf8');
const panel = readFileSync(new URL('../webview/src/components/VulnerabilitiesPanel.tsx', import.meta.url), 'utf8');
const app = readFileSync(new URL('../webview/src/App.tsx', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../webview/src/styles.css', import.meta.url), 'utf8');

test('every displayed vulnerability identifier is a labelled keyboard button', () => {
  assert.match(card, /className="advisory__identifier"/);
  assert.match(card, /aria-label={`Open \$\{identifier\} reference`}/);
  assert.match(card, /<IconExternalLink aria-hidden="true"/);
  assert.match(styles, /\.advisory__identifier:focus-visible/);
});

test('identifier clicks carry the exact advisory identity and clicked reference to the host', () => {
  assert.match(card, /onOpenAdvisory\(rootPackageName, advisory\.id, \[\.\.\.path\], identifier\)/);
  assert.match(panel, /onOpenAdvisory\(rootPackageName, context\.advisory\.id, \[\.\.\.context\.primaryPath\], identifier\)/);
  assert.match(app, /advisoryNavigationRequest\(packageName, advisoryId, path, reference\)/);
});
