/**
 * Workspace scanning — the pure decisions.
 *
 * The lockfile-precedence and nearest-lockfile rules are the ones with teeth:
 * an npm-workspaces monorepo keeps one lockfile at the root covering every
 * member, so looking beside a member's package.json finds nothing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  toProjectCandidates,
  chooseLockfile,
  nearestLockfileDir,
  isExcluded,
  dirOf,
  SHRINKWRAP,
  PACKAGE_LOCK,
} from '../out/core/workspace/scan.js';

test('node_modules and build output are excluded from the scan', () => {
  assert.equal(isExcluded('node_modules/react/package.json'), true);
  assert.equal(isExcluded('packages/app/node_modules/x/package.json'), true);
  assert.equal(isExcluded('dist/package.json'), true);
  assert.equal(isExcluded('.git/package.json'), true);
  assert.equal(isExcluded('packages/app/package.json'), false);
  assert.equal(isExcluded('package.json'), false);
});

test('a directory named like an excluded one in the FILENAME is not excluded', () => {
  // Only directory segments are tested, never the filename itself.
  assert.equal(isExcluded('package.json'), false);
});

test('dirOf returns "" for a root-level file', () => {
  assert.equal(dirOf('package.json'), '');
  assert.equal(dirOf('packages/app/package.json'), 'packages/app');
});

test('candidates are root-first then alphabetical', () => {
  const found = toProjectCandidates([
    'packages/zeta/package.json',
    'packages/alpha/package.json',
    'package.json',
  ]);
  assert.deepEqual(
    found.map((c) => c.manifestPath),
    ['package.json', 'packages/alpha/package.json', 'packages/zeta/package.json']
  );
});

test('candidates drop excluded paths, duplicates, and non-manifests', () => {
  const found = toProjectCandidates([
    'package.json',
    './package.json',
    'node_modules/react/package.json',
    'packages/app/tsconfig.json',
  ]);
  assert.deepEqual(
    found.map((c) => c.manifestPath),
    ['package.json']
  );
});

test('windows separators are normalized at the boundary', () => {
  const found = toProjectCandidates(['packages\\app\\package.json']);
  assert.deepEqual(
    found.map((c) => c.manifestPath),
    ['packages/app/package.json']
  );
  assert.equal(found[0].dir, 'packages/app');
});

test('npm-shrinkwrap.json takes precedence over package-lock.json', () => {
  assert.equal(chooseLockfile([PACKAGE_LOCK, SHRINKWRAP]), SHRINKWRAP);
  assert.equal(chooseLockfile([SHRINKWRAP]), SHRINKWRAP);
  assert.equal(chooseLockfile([PACKAGE_LOCK]), PACKAGE_LOCK);
  assert.equal(chooseLockfile(['README.md']), null);
});

test('a workspace member finds the root lockfile by walking up', () => {
  assert.equal(nearestLockfileDir('packages/app', ['']), '');
  assert.equal(nearestLockfileDir('packages/app/nested', ['', 'packages/app']), 'packages/app');
  assert.equal(nearestLockfileDir('packages/app', ['other']), null);
});

test('a lockfile beside the manifest wins over one further up', () => {
  assert.equal(nearestLockfileDir('packages/app', ['', 'packages/app']), 'packages/app');
});
