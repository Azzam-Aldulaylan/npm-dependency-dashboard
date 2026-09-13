import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

const component = readFileSync('webview/src/components/DependencyLoadingState.tsx', 'utf8');
const styles = readFileSync('webview/src/styles.css', 'utf8');

test('startup skeleton mirrors grouped health and five-column inventory', () => {
  assert.match(component, /loading-skeleton__health/);
  assert.match(component, /loading-skeleton__inventory/);
  assert.equal((component.match(/bar--col-header/g) ?? []).length, 5);
  assert.match(component, /bar--action/);
  assert.match(styles, /grid-template-columns: 2\.5fr 1fr 1\.5fr 1\.3fr 1fr/);
  assert.match(styles, /\.loading-skeleton__table \{\s*overflow-x: auto;/);
});

test('scan announcements remain real and decorative placeholders stay hidden', () => {
  assert.match(component, /role="status" aria-live="polite"/);
  assert.match(component, /\$\{progress.completed\} of \$\{progress.total\} analyzed/);
  assert.match(component, /STAGE_LABELS\[stage\]/);
  assert.match(component, /loading-skeleton__cards" aria-hidden="true"/);
  assert.match(component, /loading-skeleton__inventory" aria-hidden="true"/);
  assert.match(styles, /prefers-reduced-motion: reduce[\s\S]*?\.loading-skeleton__bar \{\s*animation: none;/);
});
