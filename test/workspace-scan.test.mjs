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
  discoverProjectCandidates,
  deriveProjectId,
  projectCandidateLabel,
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

// ------------------------------------------ S6: multi-root project discovery

const FOLDER_A = { folderId: 'file:///workspace/frontend', folderName: 'frontend' };
const FOLDER_B = { folderId: 'file:///workspace/backend', folderName: 'backend' };

test('zero sources (or sources with no manifests) discover zero candidates', () => {
  assert.deepEqual(discoverProjectCandidates([]), []);
  assert.deepEqual(
    discoverProjectCandidates([{ ...FOLDER_A, manifestPaths: [] }]),
    []
  );
});

test('one source with one manifest discovers exactly one candidate', () => {
  const found = discoverProjectCandidates([{ ...FOLDER_A, manifestPaths: ['package.json'] }]);
  assert.equal(found.length, 1);
  assert.equal(found[0].manifestPath, 'package.json');
  assert.equal(found[0].dir, '');
  assert.equal(found[0].folderId, FOLDER_A.folderId);
  assert.equal(found[0].folderName, FOLDER_A.folderName);
});

test('multiple candidates in one source are all discovered, root-first then alphabetical', () => {
  const found = discoverProjectCandidates([
    {
      ...FOLDER_A,
      manifestPaths: ['packages/zeta/package.json', 'packages/alpha/package.json', 'package.json'],
    },
  ]);
  assert.deepEqual(
    found.map((c) => c.manifestPath),
    ['package.json', 'packages/alpha/package.json', 'packages/zeta/package.json']
  );
});

test('multiple workspace folders each contribute their own candidates, folder order preserved', () => {
  const found = discoverProjectCandidates([
    { ...FOLDER_A, manifestPaths: ['package.json'] },
    { ...FOLDER_B, manifestPaths: ['package.json'] },
  ]);
  assert.deepEqual(
    found.map((c) => c.folderName),
    ['frontend', 'backend']
  );
});

test('the same relative manifest path in two different folders produces two distinct candidates', () => {
  const found = discoverProjectCandidates([
    { ...FOLDER_A, manifestPaths: ['packages/api/package.json'] },
    { ...FOLDER_B, manifestPaths: ['packages/api/package.json'] },
  ]);
  assert.equal(found.length, 2);
  assert.equal(found[0].manifestPath, found[1].manifestPath, 'same relative path in both');
  assert.notEqual(found[0].id, found[1].id, 'but distinct ids, since folderId differs');
  assert.notEqual(
    projectCandidateLabel(found[0]),
    projectCandidateLabel(found[1]),
    'and distinct labels, since folderName differs'
  );
});

test('deriveProjectId is deterministic: same folder + manifest path always produces the same id', () => {
  assert.equal(
    deriveProjectId('file:///workspace/frontend', 'package.json'),
    deriveProjectId('file:///workspace/frontend', 'package.json')
  );
});

test('deriveProjectId differs when either the folder or the manifest path differs', () => {
  const base = deriveProjectId('file:///workspace/frontend', 'package.json');
  assert.notEqual(base, deriveProjectId('file:///workspace/backend', 'package.json'));
  assert.notEqual(base, deriveProjectId('file:///workspace/frontend', 'packages/app/package.json'));
});

test('deriveProjectId does not collide when a delimiter-joined encoding would', () => {
  // A plain `${folderId}::${manifestPath}` join is ambiguous when either
  // input contains the delimiter itself: both of these pairs would produce
  // the identical string "file:///a::b::package.json" under that scheme.
  // The JSON-tuple encoding must keep them distinct.
  assert.notEqual(
    deriveProjectId('file:///a::b', 'package.json'),
    deriveProjectId('file:///a', 'b::package.json')
  );
});

test('discoverProjectCandidates ids match deriveProjectId directly', () => {
  const found = discoverProjectCandidates([{ ...FOLDER_A, manifestPaths: ['packages/app/package.json'] }]);
  assert.equal(found[0].id, deriveProjectId(FOLDER_A.folderId, 'packages/app/package.json'));
});

test('projectCandidateLabel is the folder name alone at the folder root, and "folder — dir" otherwise', () => {
  assert.equal(projectCandidateLabel({ folderName: 'frontend', dir: '' }), 'frontend');
  assert.equal(
    projectCandidateLabel({ folderName: 'frontend', dir: 'packages/app' }),
    'frontend — packages/app'
  );
});

test('discovery still excludes node_modules and other excluded directories per source', () => {
  const found = discoverProjectCandidates([
    { ...FOLDER_A, manifestPaths: ['node_modules/react/package.json', 'package.json'] },
  ]);
  assert.deepEqual(
    found.map((c) => c.manifestPath),
    ['package.json']
  );
});
