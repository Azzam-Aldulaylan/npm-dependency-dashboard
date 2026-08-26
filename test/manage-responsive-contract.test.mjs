import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const component = readFileSync(
  join(process.cwd(), 'webview/src/components/ManageDependencyModal.tsx'),
  'utf8'
);
const css = readFileSync(join(process.cwd(), 'webview/src/styles.css'), 'utf8');
const responsiveCss = css.slice(css.indexOf('/* -------------------------------------- Manage dependency responsive pass */'));

test('Manage dependency uses a dedicated narrow overlay without changing other modal shells', () => {
  assert.match(component, /className="modal-overlay modal-overlay--manage"/);
  assert.match(responsiveCss, /@media \(max-width: 38rem\)/);
  assert.match(responsiveCss, /\.modal-overlay--manage\s*\{[^}]*padding:\s*0/s);
  assert.match(
    responsiveCss,
    /\.modal-overlay--manage \.manage-modal\s*\{[^}]*height:\s*100dvh[^}]*max-height:\s*100dvh[^}]*border-radius:\s*0/s
  );
});

test('all five Manage tabs keep the shared wide rail and collapse below it', () => {
  for (const selector of ['overview-panel', 'vuln-tab', 'usage-tab', 'upgrade-tab', 'removal-tab']) {
    assert.match(css, new RegExp(`@media \\(min-width: 64rem\\)[\\s\\S]*?\\.${selector}\\s*\\{`));
  }
  assert.match(responsiveCss, /@media \(max-width: 63\.99rem\)/);
  assert.match(responsiveCss, /\.overview-panel__summary,[\s\S]*\.removal-tab__details\s*\{[^}]*width:\s*100%/);
});

test('Manage tabs expose complete relationships and keyboard navigation', () => {
  assert.match(component, /id=\{`manage-tab-\$\{id\}`\}/);
  assert.match(component, /aria-controls="manage-panel"/);
  assert.match(component, /tabIndex=\{active \? 0 : -1\}/);
  assert.match(component, /id="manage-panel"/);
  assert.match(component, /aria-labelledby=\{`manage-tab-\$\{activeTab\}`\}/);
  for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End']) assert.match(component, new RegExp(`'${key}'`));
  assert.match(component, /scrollIntoView\(\{ block: 'nearest', inline: 'nearest' \}\)/);
});

test('initial focus falls back to the selected tab when Close is disabled', () => {
  assert.match(component, /!closeButton\.disabled/);
  assert.match(component, /querySelector<HTMLButtonElement>\('\[role="tab"\]\[aria-selected="true"\]'\)/);
  assert.match(component, /else dialogRef\.current\?\.focus\(\)/);
});

test('narrow content wraps while horizontal scrolling stays intentionally local', () => {
  assert.match(responsiveCss, /\.manage-action-card__versions,[\s\S]*\.verification-steps__item\s*\{[^}]*flex-wrap:\s*wrap/s);
  assert.match(responsiveCss, /\.security-outcome\s*\{[^}]*flex-direction:\s*column/s);
  assert.match(responsiveCss, /\.usage-path\s*\{[^}]*flex-direction:\s*column/s);
  assert.match(responsiveCss, /@media \(max-width: 26rem\)/);
  assert.doesNotMatch(responsiveCss, /\.button--(?:primary|caution|danger|secondary|subtle)\s*\{/);
});
