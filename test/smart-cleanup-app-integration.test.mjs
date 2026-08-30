import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

const app = await readFile(join(process.cwd(), 'webview/src/App.tsx'), 'utf8');
const panel = await readFile(join(process.cwd(), 'src/host/dashboardPanel.ts'), 'utf8');
const coordinator = await readFile(
  join(process.cwd(), 'src/host/smartCleanupMetadataCoordinator.ts'),
  'utf8'
);
const upgradeCoordinator = await readFile(
  join(process.cwd(), 'src/host/upgradeAssistantCoordinator.ts'),
  'utf8'
);
const completionReport = await readFile(
  join(process.cwd(), 'src/host/smartCleanupCompletionReport.ts'),
  'utf8'
);

test('dashboard exposes a dedicated Smart Cleanup entry point and workspace', () => {
  assert.match(app, />\s*Smart Cleanup\s*</);
  assert.match(app, /<SmartCleanupWorkspace/);
  assert.match(app, /onOpenSmartCleanup=\{startSmartCleanup\}/);
});

test('Smart Cleanup starts usage and exact installed-version metadata in parallel', () => {
  assert.match(app, /type: 'analyze-cleanup'/);
  assert.match(app, /type: 'analyze-smart-cleanup-metadata'/);
  assert.match(panel, /smartCleanupMetadataCoordinator\.analyze\(message\.requestId\)/);
  assert.match(coordinator, /fetchPackageVersionMetadata/);
  assert.match(coordinator, /installedVersionDeprecation/);
});

test('Smart Cleanup requires a correlated host preflight and explicit confirmation', () => {
  assert.match(app, /type: 'smart-cleanup-remove'/);
  assert.match(app, /requestId: smartCleanupState\.requestId/);
  assert.match(app, /removalRequestId/);
  assert.match(app, /dedupeActionId/);
  assert.match(app, /packages\[0\] \?\? 'Smart Cleanup'/);
  assert.match(app, /const confirmSmartCleanup/);
  assert.match(app, /type: 'confirm-remove', analysisId/);
  assert.match(app, /removeOrigin !== 'smart-cleanup'/);
  assert.match(app, /incoming\.status === 'remove-result'/);
});

test('revising a checked cleanup cancels its old host reservation before another final check', () => {
  assert.match(app, /const keepDependencyFromSmartCleanupConfirmation/);
  assert.match(app, /type: 'cancel-remove', analysisId: snapshot\.analysisId, requestId: snapshot\.requestId/);
  assert.match(app, /type: 'keep-dependency', actionId/);
  assert.match(app, /onKeepDependency=\{keepDependencyFromSmartCleanupConfirmation\}/);
});

test('pre-mutation removal rejections return to review without claiming an incomplete rollback', () => {
  assert.match(app, /type: 'operation-rejected'/);
  assert.match(app, /No cleanup changes were made/);
  assert.match(app, /incoming\.error\.code !== 'ROLLBACK_CONFLICT'/);
  assert.match(app, /incoming\.error\.code !== 'ROLLBACK_FAILED'/);
  assert.match(app, /incoming\.error\.code !== 'REMOVE_TRANSACTION_FAILED'/);
});

test('completion is correlated and computed by the host from final refreshed evidence', () => {
  assert.match(panel, /reloadSmartCleanupFinalState: \(\) => this\.reloadAndCaptureFinalState\(\)/);
  assert.match(panel, /outcome\?\.status !== 'succeeded'/);
  assert.match(panel, /lastResultEvidence\(\)/);
  assert.match(upgradeCoordinator, /buildSmartCleanupCompletionReport/);
  assert.match(upgradeCoordinator, /smartCleanup: smartCleanupPresentation/);
  assert.match(completionReport, /vulnerabilitySnapshotMetrics/);
  assert.match(completionReport, /removedAdvisories/);
  assert.match(completionReport, /sourceFingerprint/);
  assert.match(completionReport, /generationAtReadStart/);
  assert.match(app, /const hostCompletion = incoming\.result\.smartCleanup/);
  assert.match(app, /metrics: hostCompletion\.metrics/);
  assert.match(app, /resolvedAdvisories: hostCompletion\.removedAdvisories/);
  assert.match(app, /introducedAdvisories: hostCompletion\.introducedAdvisories/);
  assert.doesNotMatch(app, /function vulnerabilityCount/);
});

test('Smart Cleanup drill-down opens the existing dependency review workspace', () => {
  assert.match(app, /const openDependencyReviewFromSmartCleanup/);
  assert.match(app, /openManage\(packageName\)/);
  assert.match(app, /setManageTab\(tab\)/);
  assert.match(app, /onOpenDependencyReview=\{openDependencyReviewFromSmartCleanup\}/);
  assert.match(app, /smartCleanupDrilldownRef/);
  assert.match(app, /const savedImpact = drilldown\.removalImpact/);
  assert.match(app, /setRemovalImpact\(savedImpact\)/);
  assert.match(app, /impactWasReplaced/);
  assert.match(app, /requestAnalyzeRemovalImpact\(savedImpact\.packages\)/);
  assert.match(app, /Back to Smart Cleanup/);
});

test('closing and reopening reuses only a fresh project-scoped Smart Cleanup review', () => {
  assert.match(app, /smartCleanupReviewIsReusable/);
  assert.match(app, /SMART_CLEANUP_REVIEW_CACHE_MS/);
  assert.match(app, /smartCleanupProjectKey/);
  assert.match(app, /smartCleanupReviewCacheRef/);
  assert.match(app, /cachedReview\.dashboardGeneratedAt !== incoming\.data\.generatedAt/);
});
