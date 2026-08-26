import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';

const component = readFileSync(
  join(process.cwd(), 'webview/src/components/UpgradeTargetSelector.tsx'),
  'utf8'
);

test('the target selector offers explicit manual entry without silently analyzing', () => {
  assert.match(component, /Enter another version/);
  assert.match(component, /Exact published version/);
  assert.match(component, /npm verifies this version before analysis/);
  assert.match(component, /onSubmit=\{applyManualVersion\}/);
  assert.doesNotMatch(component, /onAnalyzeUpgrade/);
});
