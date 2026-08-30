import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const component = readFileSync(
  join(process.cwd(), 'webview/src/components/ManageDependenciesModal.tsx'),
  'utf8'
);
const app = readFileSync(join(process.cwd(), 'webview/src/App.tsx'), 'utf8');

test('bulk review exposes one context-aware selection control and accessible step state', () => {
  assert.doesNotMatch(component, />\s*Select all\s*</);
  assert.doesNotMatch(component, />\s*Clear selection\s*</);
  assert.match(component, /\{allBulkSelectableSelected \? 'Clear' : 'Select'\}/);
  assert.match(component, /aria-current=\{step === 'select' \? 'step' : undefined\}/);
  assert.match(component, /aria-current=\{step === 'review' \? 'step' : undefined\}/);
});

test('step transitions move focus and impact completion has a polite live announcement', () => {
  assert.match(component, /titleRef\.current\?\.focus\(\)/);
  assert.match(component, /role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(component, /Impact analysis complete\./);
});

test('health re-check lives beside the workflow steps and exposes immediate busy feedback', () => {
  assert.match(component, /className="bulk-modal__step-bar"/);
  assert.match(component, /className="button button--secondary button--small bulk-modal__recheck"/);
  assert.match(component, /cleanupBusy \? 'Checking health…' : 'Re-check health'/);
  assert.match(component, /aria-busy=\{cleanupBusy\}/);
  assert.doesNotMatch(component, /criteria-group__recheck|headerAction/);
  assert.match(app, /if \(cleanupProgressActiveRef\.current\) return;/);
  assert.match(app, /setCleanupState\(\{ phase: 'analyzing', scanned: 0, total: 0 \}\)/);
});

test('the capped batch is used for review rendering and all submitted package lists', () => {
  assert.match(component, /\{batchRows\.map\(\(row\) => \{/);
  assert.match(component, /onAnalyzeRemovalImpact\(reviewRows\.map\(\(row\) => row\.name\)\)/);
  assert.match(component, /onBulkRemove\(reviewRows\.map\(\(row\) => row\.name\), matchTags\)/);
  assert.doesNotMatch(component, /reviewRows\.slice\(/);
});

test('bulk maintenance omits the read-only transitive-fix dead end', () => {
  assert.doesNotMatch(component, /Check(?:ing)? transitive fixes|Transitive security fix results/);
  assert.doesNotMatch(component, /onAnalyzeRemediations|onCancelRemediations|remediationBatch/);
  assert.doesNotMatch(app, /requestAnalyzeRemediations|requestCancelRemediationBatch|remediationBatch=/);
});

test('Project Maintenance does not show a relative age or stale label for cleanup analysis', () => {
  assert.doesNotMatch(app, /formatAnalysisAge/);
  assert.doesNotMatch(app, /toolbar__analysis-age/);
  assert.doesNotMatch(app, /Analyzed just now|minutes? ago|Previous analysis · stale/);
});
