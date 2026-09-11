import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';

const read = (path) => readFileSync(join(process.cwd(), path), 'utf8');
const cards = read('webview/src/components/UpgradeAnalysisCards.tsx');
const review = read('webview/src/components/UpgradeReviewPanel.tsx');
const progressive = read('webview/src/components/UpgradeAnalysisSections.tsx');
const manage = read('webview/src/components/ManageDependencyModal.tsx');
const targetSelector = read('webview/src/components/UpgradeTargetSelector.tsx');
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
  assert.match(cards, />\s*Planned change\s*</);
  assert.match(cards, /exact dependency change that will be applied after confirmation/);
  assert.doesNotMatch(cards, /Smart upgrade plan/);
  assert.match(cards, />\s*Coordinated upgrade\s*</);
  assert.match(cards, /smartPlan\.reasonFindingIds/);
  assert.match(cards, /plannerAddedUpgradeChanges\(requestedChanges, smartPlan\.changes\)/);
  assert.match(cards, /finding\.explanation/);
  assert.match(cards, /Coordinated plan not confirmed/);
  assert.match(review, /<UpgradeRecommendationCard/);
  assert.match(read('src/host/upgradeReviewDecision.ts'), /A coordinated resolution could not be confirmed by this analysis/);
  assert.doesNotMatch(review, /No safe path is currently available/);
});

test('hard analysis expiry is visible and disables the footer action', () => {
  assert.match(review, /upgradeAnalysisFreshness\(analysis\.analyzedAt, analysis\.expiresAt, now\)/);
  assert.match(review, /This analysis expired and can no longer authorize an upgrade/);
  assert.match(review, /disabled=\{busy \|\| executionBlocked\}/);
});

test('completed reviews use one decision brief with explicit review counts and four status rows', () => {
  assert.match(review, /function upgradeReviewAreas/);
  assert.match(review, /project compatibility \$\{projectSummary\.total === 1 \? 'finding' : 'findings'\}/);
  assert.match(review, /incomplete dependency checks/);
  assert.match(review, /vulnerabilities that remain/);
  assert.match(review, /undetermined security/);
  assert.match(review, /function UpgradeDecisionBrief/);
  assert.equal((review.match(/<UpgradeDecisionBrief\b/g) ?? []).length, 1);
  for (const label of ['Dependency compatibility', 'Project compatibility', 'Security impact', 'Verification']) {
    assert.match(`${review}\n${progressive}`, new RegExp(label));
  }
  assert.doesNotMatch(review, /<UpgradeSummaryCard\b|<AtAGlanceCard\b/);
});

test('important review evidence stays ahead of secondary disclosures', () => {
  const details = review.slice(review.indexOf('const UpgradeReviewDetails'));
  const dependency = details.indexOf('<CompatibilityCheckCard');
  const project = details.indexOf('<ProjectCompatibilitySection');
  const security = details.indexOf('<SecurityOutcomeCard');
  const verification = details.indexOf('<VerificationStepsCard');
  assert.ok(dependency >= 0 && project > dependency && security > project && verification > security);
  assert.match(progressive, /export function UpgradeReviewDisclosure/);
  assert.ok((details.match(/<UpgradeReviewDisclosure\b/g) ?? []).length >= 4);
  const disclosureComponent = progressive.slice(
    progressive.indexOf('export function UpgradeReviewDisclosure'),
    progressive.indexOf('function dependencyReviewSignal')
  );
  assert.match(disclosureComponent, /<details/);
  assert.doesNotMatch(disclosureComponent, /defaultOpen/);
  assert.doesNotMatch(details, /defaultOpen=|expanded=/);
});

test('progressive and completed reviews share one disclosure and evidence-card composition', () => {
  assert.equal((progressive.match(/function UpgradeReviewDisclosure\b/g) ?? []).length, 1);
  assert.ok((progressive.match(/<UpgradeReviewDisclosure\b/g) ?? []).length >= 5);
  assert.match(progressive, /<CompatibilityCheckCard[\s\S]*?<ProjectCompatibilitySection[\s\S]*?<SecurityOutcomeCard[\s\S]*?<SimpleUpgradePlanCard[\s\S]*?<VerificationStepsCard/);
  assert.match(review, /import \{ buildUpgradeReviewSignals, UpgradeAnalysisSections, UpgradeReviewDisclosure \}/);
  assert.doesNotMatch(review, /function UpgradeReviewDisclosure/);
});

test('dependency compatibility exposes detailed findings and project-check navigation', () => {
  assert.match(cards, /<CompatibilityFindings compatibility=\{compatibility\} context=\{context\}/);
  assert.match(cards, /Dependency findings/);
  assert.match(review, /onViewProjectDetails=\{openProjectDetails\}/);
  assert.match(review, /sectionRefs\.project\.current/);
});

test('decision status rows open, scroll to, and focus their matching disclosure', () => {
  assert.match(review, /onClick=\{\(\) => onOpen\(signal\.area\)\}/);
  assert.match(review, /const openReviewArea = \(area: UpgradeReviewArea\)/);
  assert.match(review, /const section = sectionRefs\[area\]\.current/);
  assert.match(review, /section\.open = true/);
  assert.match(review, /section\.scrollIntoView\(\{ block: 'start' \}\)/);
  assert.match(review, /section\.querySelector<HTMLElement>\('summary'\)\?\.focus\(\{ preventScroll: true \}\)/);
  assert.match(review, /onOpenArea=\{openReviewArea\}/);
});

test('decision rows use restrained separation and keep labels and values aligned', () => {
  assert.match(styles, /\.upgrade-decision__signal \+ \.upgrade-decision__signal\s*\{[^}]*border-top:/s);
  assert.match(
    styles,
    /\.upgrade-decision__signal > button\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:[^}]*align-items:\s*center;/s
  );
  assert.match(styles, /\.upgrade-decision__signal-value\s*\{[^}]*text-align:\s*right;/s);
  assert.match(
    styles,
    /@media \(max-width: 32rem\)[\s\S]*?\.upgrade-decision__signal-value\s*\{[^}]*text-align:\s*left;/s
  );
});

test('recommended action remains primary review content rather than complementary aside content', () => {
  assert.match(review, /<div className="upgrade-tab__recommendation">/);
  assert.doesNotMatch(review, /<aside className="upgrade-tab__recommendation"/);
});

test('the redesign leaves the Manage header, tabs, and target selector in place', () => {
  assert.match(manage, /<header className="modal__header">/);
  assert.match(manage, /<nav className="manage-tabs" role="tablist" aria-label="Manage dependency sections"/);
  assert.match(manage, /id="upgrade"[\s\S]*?label="Upgrade review"/);
  assert.match(review, /<UpgradeTargetSelector/);
  assert.match(targetSelector, /<label[^>]+htmlFor="upgrade-target-version">\s*Upgrade to/);
});

test('compatibility summary is separated from checks and unsupported checks stay honest', () => {
  assert.match(cards, /upgrade-compatibility__summary/);
  assert.match(styles, /\.upgrade-tab \.upgrade-compatibility__summary \{\s*margin-bottom: 0\.8rem;/);
  assert.match(cards, /label="Node requirements" value=\{runtimeValue\}/);
  assert.match(cards, /runtimeStatus === 'partial'/);
  assert.match(cards, /label="Source & config" value=\{projectValue\}/);
  assert.doesNotMatch(cards, /label="Deprecated APIs"|No matches in known rules|No rules for this target/);
  assert.match(cards, /known APIs being phased out/);
  assert.match(styles, /\.upgrade-tab \.hygiene-strip \{\s*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/);
  assert.doesNotMatch(cards, /label="Breaking changes"|No major version change/);
});

test('static transaction files and rollback remain compact context in the decision brief', () => {
  assert.match(review, /Will update <code>\{baseName\(analysis\.files\.manifestPath\)\}<\/code> and <code>\{baseName\(analysis\.files\.lockfilePath\)\}<\/code>/);
  assert.match(review, /Restore point included/);
  assert.match(styles, /\.upgrade-decision__context/);
  assert.doesNotMatch(review, /UpgradePreviewCard|FilesModifiedCard|Files to be modified/);
  assert.doesNotMatch(progressive, /FilesModifiedCard|Preparing file list/);
});
