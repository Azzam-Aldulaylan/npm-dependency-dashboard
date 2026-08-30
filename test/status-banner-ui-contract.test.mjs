import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const banner = readFileSync(join(process.cwd(), 'webview/src/components/StatusBanner.tsx'), 'utf8');
const app = readFileSync(join(process.cwd(), 'webview/src/App.tsx'), 'utf8');
const bulk = readFileSync(join(process.cwd(), 'webview/src/components/ManageDependenciesModal.tsx'), 'utf8');
const cleanup = readFileSync(join(process.cwd(), 'webview/src/components/SmartCleanupWorkspace.tsx'), 'utf8');
const upgrade = readFileSync(join(process.cwd(), 'webview/src/components/UpgradeReviewPanel.tsx'), 'utf8');
const styles = readFileSync(join(process.cwd(), 'webview/src/styles.css'), 'utf8');

test('status banners share one component with an optional recovery action', () => {
  assert.match(banner, /export interface StatusBannerAction/);
  assert.match(banner, /action\?: StatusBannerAction/);
  assert.match(banner, /className="button button--secondary banner__action"/);
  for (const consumer of [app, bulk, cleanup, upgrade]) {
    assert.match(consumer, /<StatusBanner/);
  }
});

test('banner copy is structurally left aligned and resilient to long text', () => {
  assert.match(styles, /\.banner\s*\{[\s\S]*?grid-template-columns: auto minmax\(0, 1fr\) auto/);
  assert.match(styles, /\.banner__text\s*\{[\s\S]*?overflow-wrap: anywhere;[\s\S]*?text-align: start;/);
  assert.match(styles, /@media \(max-width: 34rem\)[\s\S]*?\.banner__action\s*\{[\s\S]*?grid-column: 2;/);
});

test('recoverable failures expose actions in their local context', () => {
  assert.match(app, /action=\{\{ label: 'Refresh', onClick: onRefresh/);
  assert.match(app, /Showing partial results:/);
  assert.match(bulk, /label: 'Try again'/);
  assert.match(bulk, /Couldn't analyze removal impact:/);
  assert.match(upgrade, /label: 'Refresh data'/);
});
