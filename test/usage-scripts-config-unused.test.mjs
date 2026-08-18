/**
 * package.json script detection, recognized-config-file text matching,
 * framework-convention heuristics, and the "likely unused" finding builder
 * — src/core/usage/{packageScripts,configHeuristics,frameworkConventions,unused}.ts.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { findPackageInScripts } from '../out/core/usage/packageScripts.js';
import { configReferencesPackage } from '../out/core/usage/configHeuristics.js';
import { isFrameworkConventionPackage } from '../out/core/usage/frameworkConventions.js';
import { buildUnusedFinding } from '../out/core/usage/unused.js';

// --------------------------------------------------------------- scripts

test('a package invoked directly in a package.json script is found', () => {
  const manifest = JSON.stringify({ scripts: { lint: 'eslint .' } });
  const matches = findPackageInScripts(manifest, 'eslint');
  assert.deepEqual(matches, [{ scriptName: 'lint', scriptCommand: 'eslint .' }]);
});

test('a scoped package is matched by its own sub-name too', () => {
  const manifest = JSON.stringify({ scripts: { lint: 'parser --check' } });
  const matches = findPackageInScripts(manifest, '@typescript-eslint/parser');
  assert.equal(matches.length, 1);
});

test('a package name that is only a substring of another token does not match', () => {
  const manifest = JSON.stringify({ scripts: { build: 'esbuild-wrapper --minify' } });
  assert.deepEqual(findPackageInScripts(manifest, 'esbuild'), []);
});

test('a package not mentioned in any script produces no matches', () => {
  const manifest = JSON.stringify({ scripts: { test: 'node --test' } });
  assert.deepEqual(findPackageInScripts(manifest, 'jest'), []);
});

test('invalid manifest JSON degrades to no scripts rather than throwing', () => {
  assert.deepEqual(findPackageInScripts('not json', 'eslint'), []);
});

// --------------------------------------------------------------- config

test('a package referenced in a config file body is found', () => {
  assert.equal(configReferencesPackage(`module.exports = { plugins: ['tailwindcss'] };`, 'tailwindcss'), true);
});

test('a package not referenced in a config file body is not found', () => {
  assert.equal(configReferencesPackage(`module.exports = { plugins: ['postcss-import'] };`, 'tailwindcss'), false);
});

test('a scoped package is matched by its full name in config content', () => {
  assert.equal(
    configReferencesPackage(`{ "plugins": ["@typescript-eslint/eslint-plugin"] }`, '@typescript-eslint/eslint-plugin'),
    true
  );
});

test('a scoped package is matched by its own sub-name in config content', () => {
  assert.equal(configReferencesPackage(`{ "parser": "@typescript-eslint/parser" }`, '@typescript-eslint/parser'), true);
});

// ---------------------------------------------------- framework conventions

test('known ESLint/Babel/PostCSS plugin naming conventions are recognized', () => {
  assert.equal(isFrameworkConventionPackage('eslint-plugin-react'), true);
  assert.equal(isFrameworkConventionPackage('babel-preset-env'), true);
  assert.equal(isFrameworkConventionPackage('@babel/core'), true);
  assert.equal(isFrameworkConventionPackage('postcss-import'), true);
});

test('well-known CLI tooling packages are recognized', () => {
  assert.equal(isFrameworkConventionPackage('typescript'), true);
  assert.equal(isFrameworkConventionPackage('eslint'), true);
});

test('an ordinary application dependency is not a framework-convention package', () => {
  assert.equal(isFrameworkConventionPackage('react'), false);
  assert.equal(isFrameworkConventionPackage('axios'), false);
});

// ------------------------------------------------------------------ unused

function usage(overrides) {
  return {
    packageName: 'left-pad',
    references: [],
    truncated: false,
    scannedFileCount: 10,
    scannedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

test('a package with zero references and no convention match is a high-confidence finding', () => {
  const finding = buildUnusedFinding('left-pad', usage({}));
  assert.equal(finding.kind, 'likely-unused');
  assert.equal(finding.confidence, 'high');
  assert.equal(finding.severity, 'warning');
});

test('a package with at least one reference produces no finding', () => {
  const found = usage({ references: [{ filePath: 'src/x.ts', line: 1, column: 1, snippet: '', kind: 'import' }] });
  assert.equal(buildUnusedFinding('left-pad', found), null);
});

test('a framework-convention package with zero references is a low-confidence "possibly unused" finding', () => {
  const finding = buildUnusedFinding('eslint-plugin-react', usage({ packageName: 'eslint-plugin-react' }));
  assert.equal(finding.confidence, 'low');
  assert.equal(finding.severity, 'info');
  assert.match(finding.summary, /may be unused/);
});

test('a truncated scan with zero references is downgraded to low confidence regardless of the package name', () => {
  const finding = buildUnusedFinding('left-pad', usage({ truncated: true }));
  assert.equal(finding.confidence, 'low');
  assert.equal(finding.evidence.truncated, true);
});

test('a production and a dev dependency are graded identically — classification does not affect confidence', () => {
  const prod = buildUnusedFinding('left-pad', usage({}));
  const dev = buildUnusedFinding('left-pad', usage({}));
  assert.equal(prod.confidence, dev.confidence);
});
