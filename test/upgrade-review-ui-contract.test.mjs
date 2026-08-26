import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';

const read = (path) => readFileSync(join(process.cwd(), path), 'utf8');
const cards = read('webview/src/components/UpgradeAnalysisCards.tsx');
const review = read('webview/src/components/UpgradeReviewPanel.tsx');
const progressive = read('webview/src/components/UpgradeAnalysisSections.tsx');
const styles = read('webview/src/styles.css');

test('remaining and unknown vulnerabilities are inspectable in context with host detail', () => {
  assert.match(cards, /<details className="security-remaining">/);
  assert.match(cards, /entry\.status === 'remains'/);
  assert.match(cards, /entry\.status === 'unknown'/);
  assert.match(cards, /Confirmed to remain/);
  assert.match(cards, /Undetermined/);
  assert.match(cards, /<SeverityBadge severity=\{entry\.advisory\.severity\}/);
  assert.match(cards, /entry\.advisory\.title/);
  assert.match(cards, /String\(entry\.advisory\.id\)/);
  assert.match(cards, /Flagged package/);
  assert.match(cards, /entry\.path\.join\(' → '\)/);
  assert.match(cards, /patchedVersionText\(entry\.patchedVersion\)/);
  assert.match(cards, /remainingVulnerabilityPatchedVersionLabel\(entry\.flaggedPackage\)/);
  assert.match(cards, /Proposed resolved version/);
  assert.match(cards, /onOpenAdvisory\(row\.name, entry\.advisory\.id, \[\.\.\.entry\.path\]\)/);
  assert.match(styles, /\.security-remaining__summary/);
});

test('security before and after copy does not treat undetermined advisories as resolved', () => {
  assert.match(cards, /security\.resolvedAdvisories\.length \+ security\.remaining\.length/);
  assert.match(cards, /unknownCount > 0 \? `, \$\{unknownCount\} undetermined`/);
  assert.match(cards, /security\.remaining\.length > 0/);
});

test('simple and coordinated plans use distinct truthful presentation', () => {
  assert.match(cards, />\s*Upgrade plan\s*</);
  assert.doesNotMatch(cards, /Smart upgrade plan/);
  assert.match(cards, />\s*Coordinated upgrade\s*</);
  assert.match(cards, /smartPlan\.reasonFindingIds/);
  assert.match(cards, /plannerAddedUpgradeChanges\(requestedChanges, smartPlan\.changes\)/);
  assert.match(cards, /finding\.explanation/);
  assert.match(cards, /Coordinated plan not confirmed/);
  assert.match(review, /A coordinated resolution could not be confirmed by this analysis/);
  assert.doesNotMatch(review, /No safe path is currently available/);
});

test('hard analysis expiry is visible and disables both embedded action surfaces', () => {
  assert.match(review, /upgradeAnalysisFreshness\(analysis\.analyzedAt, analysis\.expiresAt, now\)/);
  assert.match(review, /This analysis expired and can no longer authorize an upgrade/);
  assert.match(review, /disabled=\{busy \|\| executionBlocked\}/);
});

test('compatibility summary is separated from checks and unsupported checks stay honest', () => {
  assert.match(cards, /upgrade-compatibility__summary/);
  assert.match(styles, /\.upgrade-tab \.upgrade-compatibility__summary \{\s*margin-bottom: 0\.8rem;/);
  assert.match(cards, /label="Engine requirements" value="Not checked"/);
  assert.match(cards, /label="Deprecated APIs" value="Not checked"/);
  assert.match(cards, /label="Breaking changes" value=\{hasMajorFinding \? 'Major version change' : 'No major version change'\}/);
});

test('static transaction files and rollback are compact metadata in Upgrade Preview', () => {
  assert.match(review, /Will update <code>\{baseName\(analysis\.files\.manifestPath\)\}<\/code> and <code>\{baseName\(analysis\.files\.lockfilePath\)\}<\/code>/);
  assert.match(review, /Restore point included/);
  assert.match(styles, /\.upgrade-preview__files/);
  assert.doesNotMatch(review, /FilesModifiedCard|Files to be modified/);
  assert.doesNotMatch(progressive, /FilesModifiedCard|Preparing file list/);
});
