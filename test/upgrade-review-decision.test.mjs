import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { deriveUpgradeReviewDecision } from '../out/host/upgradeReviewDecision.js';
import { upgradeConfirmationAction } from '../out/host/actionButtonSemantics.js';

const require = createRequire(import.meta.url);
const bundle = await build({
  stdin: { contents: `
    export { UpgradeRecommendationCard } from './webview/src/components/UpgradeRecommendationCard.tsx';
    export { UpgradeReviewPanel } from './webview/src/components/UpgradeReviewPanel.tsx';
    export { UpgradeAnalysisBody } from './webview/src/components/UpgradeAnalysisModal.tsx';
  `, resolveDir: process.cwd(), loader: 'tsx' },
  bundle: true, write: false, format: 'esm', platform: 'browser',
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [{ name: 'shared-react', setup(plugin) {
    plugin.onResolve({ filter: /^react(?:\/.*)?$/ }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }));
  } }],
});
const { UpgradeRecommendationCard, UpgradeReviewPanel, UpgradeAnalysisBody } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text + '\n//# sourceURL=upgrade-review-decision.fixture.js').toString('base64')}`);

const now = Date.parse('2026-08-31T10:00:00Z');
function project(overrides = {}) {
  return {
    identity: { packageName: 'next', currentVersion: '14.2.35', targetVersion: '15.5.24', requestId: 'review', sourceFingerprint: 'source' },
    findings: [], analyzers: ['runtime-compatibility', 'import-compatibility', 'project-source-scan'].map(analyzerId => ({ analyzerId, status: 'complete', findings: [] })),
    startedAt: new Date(now).toISOString(), completedAt: new Date(now).toISOString(), ...overrides,
  };
}
function finding(confidence = 'confirmed') {
  return { id: 'removed-import', category: 'import', confidence, packageName: 'next', targetVersion: '15.5.24', title: 'Import path was removed', explanation: 'Target package does not publish the imported path.', migrationHint: 'Replace the import.', evidence: [], source: 'generic' };
}
function analysis(overrides = {}) {
  return {
    analysisId: 'review', analyzedAt: new Date(now).toISOString(), expiresAt: new Date(now + 3_600_000).toISOString(),
    package: 'next', currentVersion: '14.2.35', targetVersion: '15.5.24', classification: 'prod', majorUpdate: true,
    changes: [{ packageName: 'next', currentVersion: '14.2.35', targetVersion: '15.5.24', classification: 'prod', majorUpdate: true }],
    compatibility: { status: 'compatible', completeness: 'complete', findings: [] },
    projectCompatibility: project(), security: { status: 'not-applicable', resolvedAdvisories: [], remaining: [] }, smartPlan: null,
    verification: { configured: false }, files: { manifestPath: '/fixture/package.json', lockfilePath: '/fixture/package-lock.json', rollbackAvailable: true },
    ...overrides,
  };
}
const noop = () => {};
function recommendation(value, overrides = {}) {
  return renderToStaticMarkup(createElement(UpgradeRecommendationCard, { analysis: value, coordinated: false, executionBlocked: false, busy: false, onConfirm: noop, onUseSmartPlan: noop, ...overrides }));
}
function manageReview(value, overrides = {}) {
  return renderToStaticMarkup(createElement(UpgradeReviewPanel, {
    row: { name: 'next', installed: '14.2.35', latest: '16.0.0', upgradeTo: '16.0.0', advisories: [], worstSeverity: 'none' },
    active: true, targetVersion: value.targetVersion, targetState: { phase: 'idle' }, analyzingPhase: null, analysis: value, sections: {}, hardStale: false, now, busy: false, error: null, disabled: false, usage: undefined, advisoriesAvailable: true,
    onAnalyzeUpgrade: noop, onTargetChange: noop, onConfirm: noop, onUseSmartPlan: noop, onCancel: noop, onConfigureVerification: noop, onRefresh: noop, onChangeTab: noop,
    ...overrides,
  }));
}

test('unknown dependency checks never become a compatible or safe update', () => {
  const value = analysis({ compatibility: { status: 'unknown', completeness: 'partial', findings: [] }, security: null });
  const decision = deriveUpgradeReviewDecision(value);
  assert.equal(decision.caution, true);
  assert.equal(decision.headline.className, 'unknown');
  assert.match(decision.recommendation, /could not be fully verified/);
  assert.match(decision.recommendation, /Security impact was not assessed/);
  assert.doesNotMatch(decision.recommendation, /safe update|compatible update/);
  assert.doesNotMatch(recommendation(value), /<button/);
});

test('confirmed project findings override clean dependency resolution in headline and action', () => {
  const value = analysis({ projectCompatibility: project({ findings: [finding()] }) });
  const original = structuredClone(value);
  const decision = deriveUpgradeReviewDecision(value);
  assert.equal(decision.projectState, 'confirmed');
  assert.equal(decision.headline.className, 'warning');
  assert.match(decision.headline.label, /Confirmed project compatibility issues/);
  assert.match(decision.recommendation, /required project changes/);
  assert.equal(upgradeConfirmationAction(value).variant, 'caution');
  assert.deepEqual(value, original);
  assert.doesNotMatch(recommendation(value), /<button/);
  assert.doesNotMatch(recommendation(value), /safe update|compatible update/);
});

test('likely and review findings are caution, not confirmed incompatibilities', () => {
  for (const confidence of ['likely', 'review']) {
    const value = analysis({ projectCompatibility: project({ findings: [finding(confidence)] }) });
    const decision = deriveUpgradeReviewDecision(value);
    assert.equal(decision.projectState, 'review');
    assert.equal(decision.caution, true);
    assert.doesNotMatch(decision.headline.label, /Confirmed/);
    assert.match(decision.recommendation, /migration guidance/);
  }
});

test('partial, cancelled, unavailable, empty and absent coverage cannot certify project compatibility', () => {
  for (const projectCompatibility of [
    undefined, project({ analyzers: [] }), project({ analyzers: [{ analyzerId: 'project-source-scan', status: 'complete', findings: [] }] }),
    ...['partial', 'cancelled', 'unavailable'].map(status => project({ analyzers: [...project().analyzers, { analyzerId: 'tooling-peer-alignment', status, findings: [] }] })),
  ]) {
    const value = analysis({ projectCompatibility });
    assert.equal(deriveUpgradeReviewDecision(value).caution, true);
    assert.notEqual(deriveUpgradeReviewDecision(value).headline.className, 'compatible');
  }
});

test('unsupported deprecated-rule scope is a coverage limit, not an operational failure', () => {
  const value = analysis({ projectCompatibility: project({ analyzers: [...project().analyzers, { analyzerId: 'deprecated-api-compatibility', status: 'unavailable', findings: [], unavailableReason: 'deprecated-api-rules-unavailable' }] }) });
  assert.equal(deriveUpgradeReviewDecision(value).projectState, 'checked');
  assert.equal(deriveUpgradeReviewDecision(value).caution, false);
  assert.match(deriveUpgradeReviewDecision(value).recommendation, /coverage is limited/);
  assert.doesNotMatch(deriveUpgradeReviewDecision(value).recommendation, /could not be completed/);
  for (const status of ['partial', 'cancelled']) {
    value.projectCompatibility.analyzers.at(-1).status = status;
    assert.equal(deriveUpgradeReviewDecision(value).caution, true);
  }
});

test('dependency conflicts stay blocked and a coordinated plan never promises to fix project code', () => {
  const value = analysis({ compatibility: { status: 'conflict', completeness: 'complete', findings: [] }, projectCompatibility: project({ findings: [finding()] }) });
  assert.equal(upgradeConfirmationAction(value), null);
  assert.doesNotMatch(recommendation(value), /<button/);
  assert.equal(deriveUpgradeReviewDecision(value).headline.className, 'conflict');
  value.smartPlan = { changes: [], reasonFindingIds: [] };
  assert.equal(upgradeConfirmationAction(value).onClick, 'use-smart-plan');
  assert.equal(upgradeConfirmationAction(value).variant, 'caution');
  const html = recommendation(value, { coordinated: true });
  assert.doesNotMatch(html, /<button|<li>Use coordinated upgrade<\/li>/);
  assert.match(html, /does not make source or configuration changes/);
  assert.match(html, /required project changes/);
  assert.doesNotMatch(html, /coordinated upgrade resolves it/);
});

test('a coordinated plan with incomplete dependency checks remains caution even when project checks pass', () => {
  const value = analysis({ compatibility: { status: 'conflict', completeness: 'partial', findings: [] }, smartPlan: { changes: [], reasonFindingIds: [] } });
  assert.equal(deriveUpgradeReviewDecision(value).projectState, 'checked');
  assert.deepEqual(upgradeConfirmationAction(value), { label: 'Use coordinated upgrade', onClick: 'use-smart-plan', variant: 'caution' });
  const html = recommendation(value, { coordinated: true });
  assert.doesNotMatch(html, /<button/);
  assert.match(html, /Some dependency checks could not be completed/);
  value.compatibility.completeness = 'complete';
  assert.equal(upgradeConfirmationAction(value).variant, 'primary');
});

test('confirmed and review findings retain incomplete coverage guidance independently of their headline', () => {
  for (const confidence of ['confirmed', 'likely', 'review']) {
    for (const status of ['partial', 'unavailable', 'cancelled']) {
      const value = analysis({ projectCompatibility: project({
        findings: [finding(confidence)],
        analyzers: [...project().analyzers, { analyzerId: 'tooling-peer-alignment', status, findings: [], unavailableReason: 'project-source-scan-truncated' }],
      }) });
      const decision = deriveUpgradeReviewDecision(value);
      assert.equal(decision.projectState, confidence === 'confirmed' ? 'confirmed' : 'review');
      assert.match(decision.headline.label, confidence === 'confirmed' ? /Confirmed project/ : /Project findings/);
      assert.match(decision.recommendation, /Some project checks could not be completed/);
      assert.match(recommendation(value), /verify your build and runtime/);
      assert.equal(upgradeConfirmationAction(value).variant, 'caution');
    }
  }
  const noRules = analysis({ projectCompatibility: project({
    findings: [finding()],
    analyzers: [...project().analyzers, { analyzerId: 'deprecated-api-compatibility', status: 'unavailable', findings: [], unavailableReason: 'deprecated-api-rules-unavailable' }],
  }) });
  assert.doesNotMatch(deriveUpgradeReviewDecision(noRules).recommendation, /Some project checks could not be completed/);
});

test('known fixed, remaining and unknown security evidence are reported independently', () => {
  const security = { status: 'unknown', resolvedAdvisories: [{ advisory: { severity: 'high' } }], remaining: [{ status: 'remains' }, { status: 'unknown' }] };
  const text = deriveUpgradeReviewDecision(analysis({ security })).recommendation;
  assert.match(text, /1 known vulnerability is confirmed resolved/);
  assert.match(text, /1 known vulnerability remains/);
  assert.match(text, /Some security outcomes could not be verified/);
  assert.doesNotMatch(text, /all.*resolved|safe update/);
  assert.match(deriveUpgradeReviewDecision(analysis({ security: { ...security, resolvedAdvisories: [], remaining: [] } })).recommendation, /could not be verified/);
});

test('recommendation guidance retains its explanation but never duplicates the footer action', () => {
  for (const overrides of [{ busy: true }, { executionBlocked: true }]) {
    const value = analysis({ projectCompatibility: project({ findings: [finding()] }) });
    const html = recommendation(value, overrides);
    assert.match(html, /required project changes/);
    assert.doesNotMatch(html, /<button/);
    const action = upgradeConfirmationAction(value);
    assert.ok(action);
    assert.doesNotMatch(html, new RegExp(`<li>${action.label}<\\/li>`));
  }
});

test('missing required project analyzers are shown as incomplete rather than green', () => {
  const value = analysis({
    projectCompatibility: project({
      analyzers: [{ analyzerId: 'project-source-scan', status: 'complete', findings: [] }],
    }),
  });
  const html = manageReview(value);
  const projectSignal = html.match(/<li class="upgrade-decision__signal upgrade-decision__signal--([^"]+)"><button[^>]+aria-label="Project compatibility: ([^"]+)\. View details"/);
  assert.ok(projectSignal);
  assert.equal(projectSignal[1], 'unknown');
  assert.equal(projectSignal[2], '2 incomplete checks');
  assert.doesNotMatch(projectSignal[0], /upgrade-decision__signal--ok/);
});

test('an aggregate dependency conflict without individual findings uses honest singular copy', () => {
  const html = manageReview(analysis({
    compatibility: { status: 'conflict', completeness: 'complete', findings: [] },
  }));
  assert.match(html, /aria-label="Dependency compatibility: Conflict found\. View details"/);
  assert.doesNotMatch(html, /Dependency compatibility: 1 conflict/);
});

test('the review jump action names the first area needing attention', () => {
  const html = manageReview(analysis({ projectCompatibility: project({ findings: [finding()] }) }));
  assert.match(html, /<button[^>]+class="button button--secondary upgrade-decision__review"[^>]*>Start with Project compatibility/);
  assert.doesNotMatch(html, />Review \d+ areas?</);
});

test('all Upgrade Review evidence disclosures start closed even when attention is required', () => {
  const html = manageReview(analysis({
    compatibility: { status: 'warning', completeness: 'partial', findings: [] },
    projectCompatibility: project({ findings: [finding()] }),
    security: null,
    verification: { configured: false },
  }));
  const disclosures = [...html.matchAll(/<details class="upgrade-review-disclosure[^"]*"([^>]*)>/g)];
  assert.equal(disclosures.length, 5);
  for (const disclosure of disclosures) assert.doesNotMatch(disclosure[1], /\bopen(?:=|\b)/);
  assert.match(html, /Start with Dependency compatibility/);
  assert.match(html, /aria-label="Dependency compatibility: Warning\. View details"/);
});

test('recommendation lead states the next action for conflict and clean outcomes', () => {
  const conflict = recommendation(analysis({
    compatibility: { status: 'conflict', completeness: 'complete', findings: [] },
  }));
  assert.match(conflict, /<p class="upgrade-recommendation__lead">Choose another target or resolve the dependency conflict\.<\/p>/);

  const clean = recommendation(analysis({ verification: { configured: true, scriptNames: ['test'] } }));
  assert.match(clean, /<p class="upgrade-recommendation__lead">Upgrade to 15\.5\.24, then run verification\.<\/p>/);
});

test('unconfigured verification is recommended before applying the upgrade', () => {
  const unconfigured = recommendation(analysis());
  const configure = unconfigured.indexOf('<li>Configure build/test verification</li>');
  const apply = unconfigured.indexOf('<li>Apply the reviewed version change</li>');
  assert.ok(configure >= 0 && apply > configure);

  const configured = recommendation(analysis({ verification: { configured: true, scriptNames: ['test'] } }));
  const configuredApply = configured.indexOf('<li>Apply the reviewed version change</li>');
  const verify = configured.indexOf('<li>Run the configured verification after the upgrade</li>');
  assert.ok(configuredApply >= 0 && verify > configuredApply);
});

test('verification guidance distinguishes configured checks from missing checks', () => {
  const unconfigured = recommendation(analysis());
  assert.match(unconfigured, /Configure build\/test verification/);
  assert.doesNotMatch(unconfigured, /Run the configured verification/);

  const configuredValue = analysis({ verification: { configured: true, scriptNames: ['test', 'build'] } });
  const configured = recommendation(configuredValue);
  assert.match(configured, /Run the configured verification after the upgrade/);
  assert.doesNotMatch(configured, /Configure build\/test verification/);
  assert.match(manageReview(configuredValue), /aria-label="Verification: Install \+ 2 scripts queued\. View details"/);
});

test('Manage and standalone review render the same warning; selected target is not labeled latest', () => {
  const value = analysis({ projectCompatibility: project({ findings: [finding()] }) });
  const standalone = renderToStaticMarkup(createElement(UpgradeAnalysisBody, { packageName: 'next', targetVersion: value.targetVersion, analyzingPhase: null, analysis: value, onOpenAdvisory: noop, onConfigureVerification: noop }));
  const manage = manageReview(value);
  for (const html of [standalone, manage]) {
    assert.match(html, /Confirmed project compatibility issues/);
    assert.match(html, /required project changes/);
    assert.doesNotMatch(html, /This is a safe update|This is a compatible update/);
  }
  assert.match(manage, /Review 1 project compatibility finding before upgrading/);
  assert.equal((manage.match(/<section class="upgrade-decision\b/g) ?? []).length, 1);
  assert.match(manage, /<div class="upgrade-decision__versions">[\s\S]*?<code>14\.2\.35<\/code>[\s\S]*?<code>15\.5\.24<\/code>/);
  assert.match(manage, />Start with Project compatibility</);
  for (const label of ['Dependency compatibility', 'Project compatibility', 'Security impact', 'Verification']) {
    assert.match(manage, new RegExp(`aria-label="${label}: [^"]+\\. View details"`));
  }
  assert.doesNotMatch(manage, /<dt>Latest version<\/dt>/);
  assert.equal((manage.match(/>Upgrade anyway/g) ?? []).length, 1, 'the footer is the sole upgrade action area');
  const recommendationSection = manage.match(/<section[^>]+aria-labelledby="upgrade-recommended-heading"[^>]*>(.*?)<\/section>/s)?.[1];
  assert.ok(recommendationSection);
  assert.doesNotMatch(recommendationSection, /<button/);
  const footer = manage.match(/<div class="review-panel__footer">(.*?)<\/div>/s)?.[1];
  assert.ok(footer);
  assert.match(footer, />Upgrade anyway<\/button>/);
});
