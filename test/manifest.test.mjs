/**
 * Manifest parsing and specifier classification.
 *
 * Every specifier classified as unresolvable is one that never reaches the
 * registry. Getting this wrong in either direction is visible to the user: a
 * missed classification shows a permanent red 404 on a healthy dependency, and
 * an over-eager one silently stops checking a package for updates.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseManifest, classifySpecifier } from '../out/core/manifest/parse.js';

test('ordinary registry ranges are resolvable', () => {
  for (const spec of ['^1.0.0', '~2.3.4', '1.2.3', '*', '', 'latest', '1.x', '>=1 <2']) {
    assert.equal(
      classifySpecifier(spec).unresolvable,
      undefined,
      `${JSON.stringify(spec)} should be resolvable`
    );
  }
});

test('file: and link: specifiers are tagged, not errored', () => {
  assert.equal(classifySpecifier('file:../sibling').unresolvable, 'file');
  assert.equal(classifySpecifier('link:../sibling').unresolvable, 'workspace-link');
  assert.equal(classifySpecifier('workspace:*').unresolvable, 'workspace-link');
});

test('git specifiers in all their forms are tagged git', () => {
  for (const spec of [
    'git://github.com/u/r.git',
    'git+ssh://git@github.com/u/r.git',
    'git+https://github.com/u/r.git',
    'github:user/repo',
    'gitlab:user/repo',
    'bitbucket:user/repo',
    'user/repo',
    'user/repo#v1.2.3',
  ]) {
    assert.equal(classifySpecifier(spec).unresolvable, 'git', `${spec} should be git`);
  }
});

test('npm: aliases are tagged and keep the real target name', () => {
  assert.deepEqual(classifySpecifier('npm:real-package@^1.0.0'), {
    unresolvable: 'alias',
    aliasTarget: 'real-package',
  });
  assert.deepEqual(classifySpecifier('npm:@scope/real@1.0.0'), {
    unresolvable: 'alias',
    aliasTarget: '@scope/real',
  });
});

test('remote tarball URLs are tagged', () => {
  assert.equal(classifySpecifier('https://example.com/pkg.tgz').unresolvable, 'tarball');
});

test('a scoped package range is not mistaken for GitHub shorthand', () => {
  // "@scope/name" looks path-like but is never a specifier value; the guard
  // exists so a range on a scoped package is not misread as a git repo.
  assert.equal(classifySpecifier('^1.0.0').unresolvable, undefined);
  assert.equal(classifySpecifier('@scope/thing').unresolvable, undefined);
});

test('dependencies, devDependencies and optionalDependencies are all collected', () => {
  const m = parseManifest(
    JSON.stringify({
      name: 'app',
      version: '1.0.0',
      dependencies: { react: '^18.0.0' },
      devDependencies: { typescript: '^5.0.0' },
      optionalDependencies: { fsevents: '^2.0.0' },
    })
  );

  assert.equal(m.name, 'app');
  const byName = Object.fromEntries(m.dependencies.map((d) => [d.name, d]));
  assert.equal(byName.react.dev, false);
  assert.equal(byName.typescript.dev, true);
  assert.equal(byName.fsevents.optional, true);
});

test('a package in both dependencies and devDependencies counts as prod', () => {
  const m = parseManifest(
    JSON.stringify({
      dependencies: { shared: '^2.0.0' },
      devDependencies: { shared: '^1.0.0' },
    })
  );
  const shared = m.dependencies.find((d) => d.name === 'shared');
  assert.equal(shared.dev, false);
  assert.equal(shared.range, '^2.0.0');
});

test('workspaces are read in both the array and object forms', () => {
  assert.deepEqual(
    parseManifest(JSON.stringify({ workspaces: ['packages/*'] })).workspaces,
    ['packages/*']
  );
  assert.deepEqual(
    parseManifest(JSON.stringify({ workspaces: { packages: ['libs/*'] } })).workspaces,
    ['libs/*']
  );
});

test('a manifest with no dependency blocks yields an empty list, not a throw', () => {
  const m = parseManifest(JSON.stringify({ name: 'empty' }));
  assert.deepEqual(m.dependencies, []);
});

test('invalid JSON throws; structurally odd JSON does not', () => {
  assert.throws(() => parseManifest('{not json'));
  assert.deepEqual(parseManifest('null').dependencies, []);
  assert.deepEqual(parseManifest('[]').dependencies, []);
});

test('__proto__ in a dependency block does not become a dependency', () => {
  const m = parseManifest('{"dependencies":{"__proto__":"^1.0.0","ok":"^1.0.0"}}');
  assert.deepEqual(
    m.dependencies.map((d) => d.name),
    ['ok']
  );
  assert.equal({}.polluted, undefined);
});
