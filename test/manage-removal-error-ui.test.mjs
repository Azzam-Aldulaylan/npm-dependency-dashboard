import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const require = createRequire(import.meta.url);

const app = await readFile(join(process.cwd(), 'webview/src/App.tsx'), 'utf8');
const manage = await readFile(join(process.cwd(), 'webview/src/components/ManageDependencyModal.tsx'), 'utf8');
const review = await readFile(join(process.cwd(), 'webview/src/components/RemovalReviewPanel.tsx'), 'utf8');
const styles = await readFile(join(process.cwd(), 'webview/src/styles.css'), 'utf8');

const bundle = await build({
  stdin: {
    contents: 'export { RemovalReviewPanel } from "./webview/src/components/RemovalReviewPanel.tsx";',
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [{
    name: 'shared-react',
    setup(plugin) {
      plugin.onResolve({ filter: /^react(?:\/.*)?$/ }, (args) => ({
        path: pathToFileURL(require.resolve(args.path)).href,
        external: true,
      }));
    },
  }],
});
const { RemovalReviewPanel } = await import(
  `data:text/javascript;base64,${Buffer.from(`${bundle.outputFiles[0].text}\n//# sourceURL=removal-review-copy.fixture.js`).toString('base64')}`
);

test('Manage dependency routes removal failures into the open Removal Review', () => {
  assert.match(app, /removeOrigin === 'manage-dependency' && removeError\?\.package === row\.name/);
  assert.match(app, /removeError !== null && removeOrigin !== 'manage-dependency'/);
  assert.match(manage, /error=\{removal\.error\}/);
  assert.match(review, /error: \{ code: string; message: string \} \| null/);
  assert.match(review, /Removal blocked by a peer dependency/);
  assert.match(review, /Keep this package, or remove the package that requires it/);
});

test('the untouched removal state explains the analysis and confirmation boundary', () => {
  const noop = () => {};
  const html = renderToStaticMarkup(createElement(RemovalReviewPanel, {
    row: { name: 'react-native', range: '^0.86.0', current: '0.86.0', advisories: [], worstSeverity: 'none' },
    active: false,
    analysis: null,
    busy: false,
    error: null,
    removalImpact: { phase: 'idle' },
    usage: undefined,
    advisoriesAvailable: true,
    now: Date.now(),
    onAnalyzeRemoval: noop,
    onConfirm: noop,
    onViewReferences: noop,
    onConfigureVerification: noop,
  }));

  assert.match(html, /Checks source usage, configuration references, scripts, and dependency relationships/);
  assert.match(html, /Nothing changes unless you review and confirm the removal/);
  assert.doesNotMatch(html, /Not analyzed yet/);
});

test('a peer blocker names the requiring package and requested range', () => {
  const noop = () => {};
  const assessment = {
    status: 'blocked',
    evidence: [{
      kind: 'peer-requirement',
      summary: 'react-native-svg requires react-native as a peer dependency',
      requiredBy: 'react-native-svg',
      requestedRange: '>=0.80',
      optional: false,
    }],
  };
  const html = renderToStaticMarkup(createElement(RemovalReviewPanel, {
    row: {
      name: 'react-native',
      range: '^0.86.0',
      current: '0.86.0',
      advisories: [],
      worstSeverity: 'none',
    },
    active: true,
    analysis: {
      analysisId: 'removal-review',
      analyzedAt: '2026-08-01T09:00:00.000Z',
      expiresAt: '2026-08-01T11:00:00.000Z',
      package: 'react-native',
      changes: [{ packageName: 'react-native', classification: 'prod', stillRequiredBy: [] }],
      files: { manifestPath: '/fixture/package.json', lockfilePath: '/fixture/package-lock.json', rollbackAvailable: true },
      verification: { configured: false },
    },
    busy: false,
    error: null,
    removalImpact: {
      phase: 'done',
      requestId: 'removal',
      packages: ['react-native'],
      assessments: new Map([['react-native', { assessment, usageId: 'usage' }]]),
      generatedAt: new Date(0).toISOString(),
    },
    usage: undefined,
    advisoriesAvailable: true,
    now: Date.parse('2026-08-01T09:30:00.000Z'),
    onAnalyzeRemoval: noop,
    onConfirm: noop,
    onViewReferences: noop,
    onConfigureVerification: noop,
  }));

  assert.match(html, /Blocked by react-native-svg/);
  assert.match(html, /react-native-svg requires react-native as a peer dependency matching &gt;=0\.80/);
  assert.doesNotMatch(html, /Resolve the required peer dependency before removing this package/);
});

test('an old removal review stays visible with refresh guidance and an expired review cannot confirm', () => {
  const noop = () => {};
  const baseProps = {
    row: { name: 'react-native', range: '^0.86.0', current: '0.86.0', advisories: [], worstSeverity: 'none' },
    active: true,
    busy: false,
    error: null,
    removalImpact: { phase: 'done', requestId: 'removal', packages: ['react-native'], assessments: new Map(), generatedAt: '2026-08-01T09:00:00.000Z' },
    usage: undefined,
    advisoriesAvailable: true,
    onAnalyzeRemoval: noop,
    onConfirm: noop,
    onViewReferences: noop,
    onConfigureVerification: noop,
  };
  const analysis = {
    analysisId: 'review', package: 'react-native', analyzedAt: '2026-08-01T09:00:00.000Z', expiresAt: '2026-08-01T11:00:00.000Z',
    changes: [{ packageName: 'react-native', classification: 'prod', stillRequiredBy: [] }],
    files: { manifestPath: '/fixture/package.json', lockfilePath: '/fixture/package-lock.json', rollbackAvailable: true },
    verification: { configured: false },
  };
  const oldHtml = renderToStaticMarkup(createElement(RemovalReviewPanel, { ...baseProps, analysis, now: Date.parse('2026-08-01T10:05:00.000Z') }));
  assert.match(oldHtml, /Removal review is more than one hour old/);
  assert.match(oldHtml, />Refresh</);

  const expiredHtml = renderToStaticMarkup(createElement(RemovalReviewPanel, { ...baseProps, analysis, now: Date.parse('2026-08-01T11:00:00.000Z') }));
  assert.match(expiredHtml, /This removal review expired/);
  assert.match(expiredHtml, /disabled=""/);
});

test('Removal Review and Manage tabs use semantic accents without changing tab behavior', () => {
  assert.match(manage, /manage-tabs__tab--\$\{id\}/);
  for (const id of ['overview', 'vulnerabilities', 'usage', 'upgrade', 'removal']) {
    assert.match(styles, new RegExp(`\\.manage-tabs__tab--${id}\\s*\\{`));
  }
  for (const modifier of ['glance', 'checks', 'package', 'impact', 'files', 'verification']) {
    assert.match(review, new RegExp(`removal-card--${modifier}`));
  }
  assert.match(styles, /\.removal-summary-card--compatible/);
  assert.match(styles, /\.removal-summary-card--warning/);
  assert.match(styles, /\.removal-summary-card--conflict/);
  assert.match(styles, /\.removal-check__item--ok/);
  assert.match(styles, /\.removal-check__item--warning/);
  assert.match(styles, /\.removal-check__item--blocked/);
});
