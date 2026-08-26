import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';

const component = readFileSync(
  join(process.cwd(), 'webview/src/components/UpgradeTargetSelector.tsx'),
  'utf8'
);

test('the target selector is registry-backed and has no free-text version entry', () => {
  assert.match(component, /<select/);
  assert.match(component, /optgroup label="Stable releases"/);
  assert.match(component, /optgroup label="Prereleases — review carefully"/);
  assert.match(component, /onChange=\{\(event\) => onChange\(event\.currentTarget\.value\)\}/);
  assert.doesNotMatch(component, /Enter another version|Exact published version|manualVersion|<input/);
  assert.doesNotMatch(component, /onAnalyzeUpgrade/);
});
