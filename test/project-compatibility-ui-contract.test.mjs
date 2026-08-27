import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';

const read = (path) => readFileSync(join(process.cwd(), path), 'utf8');
const section = read('webview/src/components/ProjectCompatibilitySection.tsx');
const progressive = read('webview/src/components/UpgradeAnalysisSections.tsx');
const review = read('webview/src/components/UpgradeReviewPanel.tsx');
const cards = read('webview/src/components/UpgradeAnalysisCards.tsx');
const vulnerabilities = read('webview/src/components/VulnerabilitiesPanel.tsx');
const vulnerabilityCard = read('webview/src/components/VulnerabilityCard.tsx');
const styles = read('webview/src/styles.css');

test('project compatibility uses the three host-provided confidence classes', () => {
  assert.match(section, /CONFIDENCE_ORDER[^\n]+\['confirmed', 'likely', 'review'\]/);
  assert.match(section, /Confirmed incompatibilities/);
  assert.match(section, /Likely migrations/);
  assert.match(section, /Review recommended/);
  assert.match(section, /groupProjectCompatibilityFindings\(analysis\)/);
  assert.match(section, /summarizeProjectCompatibility\(analysis\)/);
  assert.match(styles, /\.project-compat__confidence-rail/);
});

test('project compatibility streams independently and unavailable checks are never called compatible', () => {
  assert.match(progressive, /projectCompatibility\.status === 'complete'/);
  assert.match(progressive, /PHASE_LABEL\['project-compatibility'\]/);
  assert.match(progressive, /Waiting to check project compatibility/);
  assert.match(section, /Some checks could not be completed/);
  assert.match(section, /could not verify/);
  assert.match(section, /No issues were found by the checks that completed/);
  assert.doesNotMatch(section, /Project compatible|All checks passed/);
});

test('source navigation uses only the existing host-issued trust tuple', () => {
  assert.match(section, /usageId !== undefined && referenceIndex !== undefined/);
  assert.match(section, /onOpenUsageReference\?\.\(usageId, referenceIndex\)/);
  assert.doesNotMatch(section, /onOpenUsageReference\?\.\(evidence\.filePath/);
  assert.match(review, /onOpenUsageReference=\{onOpenUsageReference\}/);
});

test('major version alone is not presented as project breakage', () => {
  assert.doesNotMatch(cards, /hasMajorFinding|label="Breaking changes"|No major version change/);
  assert.match(cards, /projectCompatibility\?\.findings/);
});

test('compatibility ledger is responsive and keyboard-focusable', () => {
  assert.match(styles, /\.project-compat__group > summary:focus-visible/);
  assert.match(styles, /@media \(max-width: 38rem\)[\s\S]*\.project-compat__confidence-rail \{\s*grid-template-columns: 1fr;/);
});

test('transitive vulnerability copy keeps flagged-package patches separate from proven direct upgrades', () => {
  assert.match(cards, /remainingVulnerabilityPatchedVersionLabel\(context\.flaggedPackage\)/);
  assert.match(cards, /context\.provenResolution !== null/);
  assert.match(cards, /directDependencyChanges\.map/);
  assert.match(cards, /Resolved by upgrading/);
  assert.match(cards, /context\.pathsTruncated === true/);
  assert.match(cards, /`all \$\{context\.paths\.length\}`/);
  assert.match(cards, /const contextRootPackage = primaryPath\[0\] \?\? row\.name/);
  assert.match(cards, /onOpenAdvisory\(contextRootPackage, context\.advisory\.id, primaryPath\)/,
    'coordinated contexts navigate through their own host-provided direct root, not always the primary managed row');
  assert.doesNotMatch(cards, /Resolved by upgrading[^\n]+patchedVersion/);
  assert.match(vulnerabilities, /Fixed in \{context\.flaggedPackage\}/);
  assert.match(vulnerabilities, /context\.directRoots\.map/);
  assert.match(vulnerabilities, /context\.pathsTruncated/);
  assert.match(vulnerabilities, /context\.paths\.map/);
  assert.match(vulnerabilities, /vulnerabilityIdentifiers\(context\.advisory\)/);
  assert.doesNotMatch(vulnerabilities, /Resolved by upgrading[^\n]+patchedVersion/);
});

test('the dashboard vulnerability dropdown exposes every available advisory identifier', () => {
  assert.match(vulnerabilityCard, /vulnerabilityIdentifiers\(advisory\)/);
  assert.match(vulnerabilityCard, /<dt>Vulnerability ID<\/dt>/);
  assert.match(vulnerabilityCard, /identifiers\.map/);
});
