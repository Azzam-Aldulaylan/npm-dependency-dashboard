import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { analyzeDeprecatedApis } from '../out/core/projectCompatibility/deprecatedApis.js';

const require = createRequire(import.meta.url);
const bundle = await build({
  stdin: { contents: 'export { CompatibilityCheckCard } from "./webview/src/components/UpgradeAnalysisCards.tsx"; export { ProjectCompatibilitySection } from "./webview/src/components/ProjectCompatibilitySection.tsx";', resolveDir: process.cwd(), loader: 'tsx' },
  bundle: true, write: false, format: 'esm', platform: 'browser',
  define: { 'process.env.NODE_ENV': '"production"' },
  // Tooltip hooks must share the React instance used by the SSR renderer.
  plugins: [{ name: 'shared-react', setup(plugin) {
    plugin.onResolve({ filter: /^react(?:\/.*)?$/ }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }));
  } }],
});
const { CompatibilityCheckCard, ProjectCompatibilitySection } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text + '\n//# sourceURL=compatibility-check-card.fixture.js').toString('base64')}`);
const identity = { packageName: 'next', currentVersion: '15.5.0', targetVersion: '16.0.0', requestId: 'ui', sourceFingerprint: 'ui-source' };
const compatibility = { status: 'compatible', completeness: 'complete', findings: [] };
function analysis(analyzers) { return { identity, analyzers, findings: analyzers.flatMap(entry => entry.findings), completedAt: new Date().toISOString() }; }
function renderSummary(projectCompatibility) { return renderToStaticMarkup(createElement(CompatibilityCheckCard, { compatibility, projectCompatibility })); }
function renderDetails(value) { return renderToStaticMarkup(createElement(ProjectCompatibilitySection, { analysis: value })); }

test('every compatibility tile reuses accessible help and puts the status icon on the result row', () => {
  const html = renderSummary(undefined);
  for (const label of ['peer dependencies', 'node requirements', 'source &amp; config']) {
    assert.ok(html.includes(`aria-label="About ${label}"`));
  }
  assert.equal((html.match(/class="info-tooltip__trigger"/g) ?? []).length, 3);
  assert.equal((html.match(/class="hygiene-strip__result"><span class="hygiene-strip__icon" aria-hidden="true">/g) ?? []).length, 3);
  assert.equal((html.match(/<\/svg><\/span><span class="hygiene-strip__value">/g) ?? []).length, 3);
  assert.doesNotMatch(html, /Deprecated APIs|About deprecated apis/);
});

test('tile alignment stays scoped and tooltip measurement avoids right-edge shrink wrapping', () => {
  const styles = readFileSync('webview/src/styles.css', 'utf8');
  assert.match(styles, /\.hygiene-strip__result \{[^}]*display: flex;[^}]*align-items: center;/);
  assert.match(styles, /\.hygiene-strip__heading \{[^}]*justify-content: space-between;/);
  const tooltip = readFileSync('webview/src/components/Tooltip.tsx', 'utf8');
  const measurement = tooltip.indexOf('const popoverRect = popover.getBoundingClientRect()');
  assert.ok(tooltip.indexOf('popover.style.left = `${margin}px`') < measurement);
  assert.doesNotMatch(tooltip.slice(0, measurement), /popover.style.left = `\$\{triggerRect.left\}px`/);
  assert.match(tooltip, /onKeyDownCapture=\{\(event\) => \{[\s\S]*?event\.stopPropagation\(\)/);
});

test('summary separates declared Node range from active runtime and links to one evidence section', () => {
  const value = analysis([
    { analyzerId: 'runtime-compatibility', status: 'partial', findings: [], unavailableReason: 'runtime-node-version-unknown' },
    { analyzerId: 'import-compatibility', status: 'complete', findings: [] },
    analyzeDeprecatedApis({ identity, references: [], sourceComplete: true }),
  ]);
  const summary = renderSummary(value);
  assert.match(summary, /Declared range checked/);
  assert.match(summary, /Active runtime not verified/);
  assert.match(summary, /Source &amp; config/);
  assert.match(summary, /View check details/);
  assert.doesNotMatch(summary, />Project compatibility</);
  assert.match(summary, /No issues found/);
  assert.doesNotMatch(summary, /Deprecated APIs|No matches in known rules/);
  const details = renderDetails(value);
  assert.match(details, /id="project-compat-heading" tabindex="-1"/);
  assert.match(details, /Project compatibility details/);
  assert.match(details, /These counts are findings, not completed checks/);
  assert.match(details, /Node version used to run or deploy/);
  assert.match(details, /Next step:/);
  assert.doesNotMatch(details, /project-compat__empty--complete/);
});

test('unsupported API scope is explained as a coverage limit, never a successful check', () => {
  const value = analysis([
    { analyzerId: 'import-compatibility', status: 'complete', findings: [] },
    analyzeDeprecatedApis({ identity: { ...identity, targetVersion: '15.5.24' }, references: [], sourceComplete: true }),
  ]);
  assert.doesNotMatch(renderSummary(value), /Deprecated APIs|No rules for this target|Checks incomplete/);
  const details = renderDetails(value);
  assert.match(details, /Coverage limits/);
  assert.match(details, /coverage limit, not a failed scan/);
  assert.doesNotMatch(details, /Some checks could not be completed/);
});

test('a package without a matching framework rule does not show Next.js-specific coverage guidance', () => {
  const reactNativeIdentity = {
    ...identity,
    packageName: 'react-native',
    currentVersion: '0.86.0',
    targetVersion: '0.87.0',
  };
  const value = {
    ...analysis([
      { analyzerId: 'runtime-compatibility', status: 'complete', findings: [] },
      { analyzerId: 'import-compatibility', status: 'complete', findings: [] },
      analyzeDeprecatedApis({ identity: reactNativeIdentity, references: [], sourceComplete: true }),
    ]),
    identity: reactNativeIdentity,
  };
  const details = renderDetails(value);
  assert.match(details, /Completed checks found no project compatibility issues/);
  assert.doesNotMatch(details, /Next\.js|Next 16|next\/legacy\/image|Coverage limits/);
});

test('a deprecated import counts once in source/config and retains its detailed evidence', () => {
  const deprecated = analyzeDeprecatedApis({ identity, references: [{ specifier: 'next/legacy/image', kind: 'import', filePath: 'src/page.tsx', line: 2, column: 1, snippet: 'import Image from "next/legacy/image"', usageId: 'trusted', referenceIndex: 0 }], sourceComplete: true });
  const value = analysis([{ analyzerId: 'project-source-scan', status: 'complete', findings: [] }, deprecated]);
  const summary = renderSummary(value);
  assert.equal((summary.match(/1 finding/g) ?? []).length, 1);
  assert.doesNotMatch(summary, /1 use to review|Deprecated APIs/);
  const details = renderDetails(value);
  assert.match(details, /Deprecated does not mean removed/);
  assert.match(details, /src\/page.tsx/);
  assert.match(details, /next\/legacy\/image/);
});

test('incomplete or failed deprecation checks still count as incomplete source coverage', () => {
  for (const status of ['partial', 'unavailable', 'cancelled']) {
    const value = analysis([
      { analyzerId: 'import-compatibility', status: 'complete', findings: [] },
      { analyzerId: 'deprecated-api-compatibility', status, findings: [], unavailableReason: 'project-source-scan-truncated' },
    ]);
    assert.match(renderSummary(value), /Checks incomplete/);
    assert.doesNotMatch(renderSummary(value), /No issues found/);
  }
});

test('cancelled, unknown, and combined limitations are safe and visible', () => {
  const value = analysis([
    { analyzerId: 'import-compatibility', status: 'partial', findings: [], unavailableReason: 'conditional-exports-unresolved|project-import-reference-limit' },
    { analyzerId: 'tooling-peer-alignment', status: 'cancelled', findings: [] },
    { analyzerId: 'runtime-compatibility', status: 'unavailable', findings: [], unavailableReason: '/private/secrets?auth=token' },
  ]);
  const details = renderDetails(value);
  assert.match(details, /export conditions/);
  assert.match(details, /more than 400 imports/);
  assert.match(details, /cancelled before it finished/);
  assert.doesNotMatch(details, /private|secrets|auth=token/);
  const pending = renderSummary(undefined);
  assert.doesNotMatch(pending, /View check details/);
  assert.match(pending, /Not checked/);
});

test('medium findings never imply the deep import check has finished', () => {
  const medium = analysis([{ analyzerId: 'project-source-scan', status: 'complete', findings: [] }]);
  const html = renderSummary(medium);
  assert.match(html, /Checking import paths/);
  assert.doesNotMatch(html, /No issues found/);
});
