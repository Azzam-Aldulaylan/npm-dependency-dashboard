import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const workspace = readFileSync(join(process.cwd(), 'webview/src/components/SmartCleanupWorkspace.tsx'), 'utf8');
const app = readFileSync(join(process.cwd(), 'webview/src/App.tsx'), 'utf8');
const category = readFileSync(join(process.cwd(), 'webview/src/components/SmartCleanupCategorySection.tsx'), 'utf8');
const findingList = readFileSync(join(process.cwd(), 'webview/src/components/SmartCleanupFindingList.tsx'), 'utf8');
const styles = readFileSync(join(process.cwd(), 'webview/src/styles.css'), 'utf8');
const adapter = readFileSync(join(process.cwd(), 'webview/src/smartCleanupPlanAdapter.ts'), 'utf8');
const duplicateItem = workspace.slice(workspace.indexOf('function DuplicateItem'), workspace.indexOf('function SecurityItem'));

test('Smart Cleanup owns a dedicated, correlated modal workspace with focus restoration', () => {
  assert.match(workspace, /className="modal smart-cleanup-workspace"/);
  assert.match(workspace, /role="dialog"/);
  assert.match(workspace, /aria-modal="true"/);
  assert.match(workspace, /headingRef\.current\?\.focus\(\)/);
  assert.match(workspace, /previouslyFocused\.current\.focus\(\)/);
  assert.match(workspace, /event\.key === 'Escape' && canClose/);
});

test('category disclosure and progress announcements expose accessible state', () => {
  assert.match(category, /aria-expanded=\{expanded\}/);
  assert.match(category, /aria-controls=\{panelId\}/);
  assert.match(category, /role="region"/);
  assert.match(category, /aria-labelledby=\{triggerId\}/);
  assert.match(workspace, /role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(workspace, /aria-busy="true"/);
});

test('progress lists only checks that perform asynchronous analysis', () => {
  assert.doesNotMatch(app, /Reading dependency inventory/);
  assert.doesNotMatch(app, /Preparing security impact/);
  for (const label of [
    'Checking project usage',
    'Checking removal safety',
    'Simulating safe duplicate consolidation',
    'Checking installed-version deprecations',
  ]) {
    assert.match(app, new RegExp(label));
  }
});

test('the summary uses explicit units and large evidence lists share bounded searchable disclosure', () => {
  assert.doesNotMatch(workspace, /\{findingsCount\} findings/);
  assert.match(workspace, /direct removals available/);
  assert.match(workspace, /duplicate groups/);
  assert.match(workspace, /advisory findings/);
  assert.match(workspace, /<SmartCleanupFindingList/);
  assert.match(findingList, /type="search"/);
  assert.match(findingList, /visibleItems = filteredItems\.slice/);
  assert.match(findingList, /Show \{Math\.min\(initialCount, remaining\)\} more/);
});

test('only direct removals render selectable controls and uncertain recommendations stay disabled', () => {
  assert.match(workspace, /recommendation\.confidence === 'blocked' \|\| recommendation\.confidence === 'unknown'/);
  assert.match(workspace, /Review evidence/);
  assert.match(workspace, /Use the checkbox to include this removal/);
  assert.match(workspace, /unknown: 'Not verified'/);
  assert.match(workspace, /Why removal is blocked/);
  assert.match(workspace, /Why removal could not be verified/);
  assert.match(workspace, /Why removal is recommended/);
  assert.match(workspace, /Deprecation alone never authorizes removal/);
  assert.match(adapter, /duplicateAssessments/);
  assert.match(workspace, /Review removal/);
  assert.match(workspace, /Review upgrade to/);
  assert.match(workspace, /Review related dependencies/);
  assert.match(workspace, /Maintainer suggests/);
  assert.match(workspace, /excessVersionCount/);
  assert.match(workspace, /primaryPath\.join\(' → '\)/);
  assert.match(workspace, /Dedupe is project-wide/);
  assert.match(workspace, /Apply safe project deduplication/);
  assert.match(workspace, /additional resolved versions/);
  assert.doesNotMatch(duplicateItem, /finding\.summary/);
  assert.doesNotMatch(workspace, /Consolidate selected|Remove deprecated/);
});

test('execution cancellation is shown only when the host supplies a safe cancellation handler', () => {
  assert.match(workspace, /onCancelExecution\?: \(\) => void/);
  assert.match(workspace, /state\.phase === 'executing' && onCancelExecution !== undefined/);
});

test('returning from package review keeps the plan visible while removal evidence refreshes', () => {
  assert.match(workspace, /reviewEvidenceRefreshing/);
  assert.match(workspace, /Your selections are preserved/);
  assert.match(workspace, /disabled=\{state\.selectedActionIds\.size === 0 \|\| reviewEvidenceRefreshing\}/);
});

test('destructive confirmation requires a matching host-owned final plan and a second explicit action', () => {
  assert.match(workspace, /removalPreflight: RemoveAnalysisPresentation \| null/);
  assert.match(workspace, /preflightBusy: boolean/);
  assert.match(workspace, /onPrepareRemoval: \(actionIds: readonly string\[\]\) => void/);
  assert.match(workspace, /onConfirmRemoval: \(analysisId: string\) => void/);
  assert.match(workspace, /samePackageSet\(/);
  assert.match(workspace, /Check final plan/);
  assert.match(workspace, /Final plan checked/);
  assert.match(workspace, /className="smart-cleanup-preflight__heading" role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(workspace, /onConfirmRemoval\(removalPreflight\.analysisId\)/);
  assert.match(workspace, /Confirm and clean/);
  assert.doesNotMatch(workspace, /onExecute/);
});

test('final review exposes fresh dependency warnings, verification, files, and selected evidence', () => {
  assert.match(workspace, /change\.stillRequiredBy/);
  assert.match(workspace, /Still required transitively by/);
  assert.match(workspace, /Keep direct dependency/);
  assert.match(workspace, /onKeepDependency/);
  assert.match(workspace, /checkedPreflight\.verification\.configured/);
  assert.match(workspace, /checkedPreflight\.verification\.scriptNames/);
  assert.match(workspace, /checkedPreflight\.files\.manifestPath/);
  assert.match(workspace, /checkedPreflight\.files\.lockfilePath/);
  assert.match(workspace, /checkedPreflight\?\.files\.rollbackAvailable/);
  assert.match(workspace, /Dependency files/);
  assert.match(workspace, /recommendation\.rationale/);
  assert.match(workspace, /recommendation\.evidence\.map/);
  assert.match(workspace, /onClick=\{onBackToReview\}/);
});

test('security and completion copy make no result claim before post-cleanup verification', () => {
  assert.match(workspace, /Security impact of selection/);
  assert.match(workspace, /directRootActionIds/);
  assert.match(workspace, /Selected direct/);
  assert.match(workspace, /Also introduced through/);
  assert.match(workspace, /The refreshed dashboard confirms the result after cleanup/);
  assert.match(workspace, /Dependency removals and project deduplication run inside one restore boundary/);
  assert.match(workspace, /<SeverityBadge severity=\{finding\.severity\}/);
  assert.match(adapter, /directRootActionIds/);
  assert.match(adapter, /directRoots: \[\.\.\.directRoots\]\.sort/);
  assert.match(adapter, /canonicalAdvisoryFindingKey/);
  assert.match(adapter, /severityRank\[right\.severity\] - severityRank\[left\.severity\]/);
  assert.match(adapter, /`Not verified: \$\{evidence\[0\]/);
  assert.match(adapter, /suggestedReplacement/);
  assert.match(adapter, /resolveDeprecatedRemediation/);
  assert.match(adapter, /relatedUpgrades/);
  assert.match(adapter, /excessVersionCount/);
  assert.match(adapter, /directRoots/);
  assert.doesNotMatch(workspace, /expectedResolved/);
  assert.match(workspace, /const verified = phase === 'complete' && result\.verification === 'passed'/);
  assert.match(workspace, /Cleanup applied without verified checks/);
  assert.match(styles, /data-verified='true'/);
  assert.match(workspace, /Removed dependencies/);
  assert.match(styles, /\.smart-cleanup-metric__bars/);
  assert.match(workspace, /Dependency files restored/);
  assert.match(workspace, /node_modules and script side effects were not restored/);
});

test('mutation state visibly explains why the workspace cannot close', () => {
  assert.match(workspace, /Close is unavailable while project files are changing/);
  assert.match(workspace, /It becomes available when cleanup or restoration finishes/);
  assert.match(styles, /\.smart-cleanup-mutation-lock-note/);
});

test('styles handle narrow workspaces and reduced motion', () => {
  assert.match(styles, /@media \(max-width: 42rem\)/);
  assert.match(styles, /@media \(max-width: 28rem\)/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(styles, /\.smart-cleanup-category__chevron\s*\{[\s\S]*?transition: none/);
  assert.match(styles, /\.smart-cleanup-analysis__steps li\[data-status='running'\][\s\S]*?animation: none/);
  assert.match(styles, /\.smart-cleanup-preflight__facts\s*\{[\s\S]*?grid-template-columns: 1fr/);
});
