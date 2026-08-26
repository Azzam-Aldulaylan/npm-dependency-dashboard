/**
 * Static import/require/dynamic-import detection — src/core/usage/importScan.ts.
 * The interesting cases are the false-positive protections: comments and
 * plain string literals must never count as usage.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { scanSourceForImportSpecifiers, scanSourceForImports } from '../out/core/usage/importScan.js';
import { importedPackageName, specifierMatchesPackage } from '../out/core/usage/packageNameMatch.js';

function names(matches) {
  return matches.map((m) => m.packageName);
}

test('import x from "foo" is detected', () => {
  const matches = scanSourceForImports(`import x from 'foo';`);
  assert.deepEqual(names(matches), ['foo']);
  assert.equal(matches[0].kind, 'import');
  assert.equal(matches[0].line, 1);
});

test('import { x } from "foo" is detected', () => {
  assert.deepEqual(names(scanSourceForImports(`import { x, y } from 'foo';`)), ['foo']);
});

test('side-effect import "foo" is detected', () => {
  const matches = scanSourceForImports(`import 'foo';`);
  assert.deepEqual(names(matches), ['foo']);
  assert.equal(matches[0].kind, 'import');
});

test('require("foo") is detected', () => {
  const matches = scanSourceForImports(`const x = require('foo');`);
  assert.deepEqual(names(matches), ['foo']);
  assert.equal(matches[0].kind, 'require');
});

test('dynamic import("foo") is detected', () => {
  const matches = scanSourceForImports(`const x = await import('foo');`);
  assert.deepEqual(names(matches), ['foo']);
  assert.equal(matches[0].kind, 'dynamic-import');
});

test('detailed import matches retain exact literal subpaths, including static template literals', () => {
  const matches = scanSourceForImportSpecifiers([
    `import x from 'next/public';`,
    'const y = import(`@scope/pkg/feature`);',
  ].join('\n'));
  assert.deepEqual(matches.map(({ packageName, specifier, kind }) => ({ packageName, specifier, kind })), [
    { packageName: 'next', specifier: 'next/public', kind: 'import' },
    { packageName: '@scope/pkg', specifier: '@scope/pkg/feature', kind: 'dynamic-import' },
  ]);
});

test('interpolated dynamic imports are not mistaken for exact target subpaths', () => {
  const source = 'const module = import(`next/${segment}`);';
  assert.deepEqual(scanSourceForImportSpecifiers(source), []);
  assert.deepEqual(scanSourceForImports(source), [],
    'the backward-compatible usage scan also avoids claiming a statically known package for this expression');
});

test('export ... from "foo" (re-export) is detected', () => {
  assert.deepEqual(names(scanSourceForImports(`export { x } from 'foo';`)), ['foo']);
});

test('a subpath import resolves to the base package name', () => {
  const matches = scanSourceForImports(`import get from 'lodash/get';`);
  assert.deepEqual(names(matches), ['lodash']);
});

test('a scoped package subpath resolves to the scoped base name', () => {
  const matches = scanSourceForImports(`import x from '@scope/foo/subpath';`);
  assert.deepEqual(names(matches), ['@scope/foo']);
});

test('a bare scoped package import resolves to itself', () => {
  assert.deepEqual(names(scanSourceForImports(`import x from '@scope/foo';`)), ['@scope/foo']);
});

test('a relative or absolute specifier is never treated as a package', () => {
  assert.deepEqual(scanSourceForImports(`import x from './local';`), []);
  assert.deepEqual(scanSourceForImports(`import x from '/abs/path';`), []);
  assert.deepEqual(scanSourceForImports(`import fs from 'node:fs';`), []);
});

test('a line comment mentioning a package name does not count', () => {
  assert.deepEqual(scanSourceForImports(`// import foo from 'foo';`), []);
});

test('a block comment mentioning a package name does not count', () => {
  assert.deepEqual(scanSourceForImports(`/* import foo from 'foo'; */`), []);
});

test('a plain string literal (not an import/require specifier) does not count as usage', () => {
  assert.deepEqual(scanSourceForImports(`const message = "please install foo";`), []);
  assert.deepEqual(scanSourceForImports(`const label = 'foo';`), []);
});

test('import-looking documentation strings, templates, and regexes do not become compatibility evidence', () => {
  const source = [
    `const docs = "import Close from 'next/dist/removed'";`,
    `const moreDocs = "require('next/dist/removed')";`,
    "const template = `import Close from 'next/dist/removed'`;",
    `const matcher = /require\\('next\\/dist\\/removed'\\)/;`,
  ].join('\n');
  assert.deepEqual(scanSourceForImportSpecifiers(source), []);
});

test('regex expressions in control-statement positions are not import evidence', () => {
  for (const source of [
    `if (ok) /import Close from 'next/dist/removed'/.test(text);`,
    `while (next()) /require('next/dist/removed')/.test(text);`,
    `for (; ok;) /import('next/dist/removed')/.test(text);`,
    `with (scope) /import X from 'next/dist/removed'/.test(text);`,
  ]) {
    assert.deepEqual(scanSourceForImportSpecifiers(source), []);
  }
});

test('line and column are reported for the specifier location', () => {
  const source = `\nimport x from 'foo';\n`;
  const [match] = scanSourceForImports(source);
  assert.equal(match.line, 2);
  assert.ok(match.column > 0);
});

test('multiple imports across multiple lines are all found with correct kinds', () => {
  const source = [
    `import a from 'alpha';`,
    `const b = require('beta');`,
    `const c = import('gamma');`,
  ].join('\n');
  const matches = scanSourceForImports(source);
  assert.deepEqual(
    matches.map((m) => [m.packageName, m.kind, m.line]),
    [
      ['alpha', 'import', 1],
      ['beta', 'require', 2],
      ['gamma', 'dynamic-import', 3],
    ]
  );
});

// --------------------------------------------------------- packageNameMatch

test('importedPackageName strips subpaths for plain and scoped packages', () => {
  assert.equal(importedPackageName('lodash'), 'lodash');
  assert.equal(importedPackageName('lodash/get'), 'lodash');
  assert.equal(importedPackageName('@scope/pkg'), '@scope/pkg');
  assert.equal(importedPackageName('@scope/pkg/sub'), '@scope/pkg');
});

test('importedPackageName rejects relative, absolute, and scheme specifiers', () => {
  assert.equal(importedPackageName('./x'), null);
  assert.equal(importedPackageName('/x'), null);
  assert.equal(importedPackageName('node:fs'), null);
  assert.equal(importedPackageName(''), null);
});

test('specifierMatchesPackage matches exact and subpath specifiers only', () => {
  assert.equal(specifierMatchesPackage('lodash', 'lodash'), true);
  assert.equal(specifierMatchesPackage('lodash/get', 'lodash'), true);
  assert.equal(specifierMatchesPackage('lodash-es', 'lodash'), false);
});
