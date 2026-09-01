import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const modal = readFileSync(join(process.cwd(), 'webview/src/components/UpgradeAnalysisModal.tsx'), 'utf8');
const compatibility = readFileSync(join(process.cwd(), 'webview/src/components/CompatibilitySection.tsx'), 'utf8');
const security = readFileSync(join(process.cwd(), 'webview/src/components/SecuritySection.tsx'), 'utf8');
const embeddedReview = readFileSync(join(process.cwd(), 'webview/src/components/UpgradeReviewPanel.tsx'), 'utf8');
const styles = readFileSync(join(process.cwd(), 'webview/src/styles.css'), 'utf8');
const app = readFileSync(join(process.cwd(), 'webview/src/App.tsx'), 'utf8');

test('dashboard enrichment cannot erase an open review or clear a structural stale marker', () => {
  assert.match(app, /upgradeReviewDashboardEffect\(activeUpgradeRef\.current, dashboardDataRef\.current, incoming\)/);
  const reset = app.slice(app.indexOf("if (reviewEffect === 'reset')"), app.indexOf('activeRemoveRef.current = null', app.indexOf("if (reviewEffect === 'reset')")));
  assert.match(reset, /setAnalysis\(null\)/);
  assert.match(reset, /setSelectedManageTarget\(null\)/);
  assert.match(reset, /else if \(reviewEffect === 'mark-stale'\)\s*\{[\s\S]*setHardStaleAnalysisId\(analysisIdRef.current\)/);
  assert.doesNotMatch(reset.slice(reset.indexOf('} else')), /setAnalysis\(null\)|setHardStaleAnalysisId\(null\)/);
});

test('completed Upgrade Review removes the static Files card and gives Security the full result width', () => {
  assert.doesNotMatch(modal, /FilesSection/);
  assert.match(security, /analysis-card analysis-card--full/);
});

test('Security evidence tiles use one readable column narrow and two columns when the review has room', () => {
  assert.match(styles, /\.analysis-card__vulnerabilities\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/s);
  assert.match(
    styles,
    /\.modal__grid\s*>\s*\.analysis-card--full\s+\.analysis-card__vulnerabilities\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/s
  );
});

test('Compatibility receives the full result width and reflows findings into two columns when space allows', () => {
  assert.match(compatibility, /analysis-card analysis-card--full compatibility-card/);
  assert.match(styles, /\.compatibility-card \.finding-list\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/s);
  assert.match(
    styles,
    /\.modal__grid\s*>\s*\.compatibility-card \.finding-list\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/s
  );
});

test('static result evidence is memoized away from freshness-clock-only renders', () => {
  assert.match(modal, /export const UpgradeAnalysisBody = memo\(UpgradeAnalysisBodyContent\)/);
  assert.match(embeddedReview, /const UpgradeReviewDetails = memo\(function UpgradeReviewDetails/);
});
