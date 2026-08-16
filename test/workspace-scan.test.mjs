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
  lockfileWatchPaths,
  lockfileWatchDirs,
  isExcluded,
  dirOf,
  SHRINKWRAP,
  PACKAGE_LOCK,
  PNPM_LOCK,
  packageManagerForLockfile,
  discoverProjectCandidates,
  deriveProjectId,
  isSameProjectReload,
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
  assert.equal(chooseLockfile([PNPM_LOCK]), PNPM_LOCK);
  assert.equal(chooseLockfile([PACKAGE_LOCK, PNPM_LOCK]), PACKAGE_LOCK);
  assert.equal(chooseLockfile([PACKAGE_LOCK, PNPM_LOCK], 'pnpm'), PNPM_LOCK);
  assert.equal(chooseLockfile(['README.md']), null);
});

test('lockfile names map to package-manager kinds', () => {
  assert.equal(packageManagerForLockfile(PACKAGE_LOCK), 'npm');
  assert.equal(packageManagerForLockfile(SHRINKWRAP), 'npm');
  assert.equal(packageManagerForLockfile(PNPM_LOCK), 'pnpm');
  assert.equal(packageManagerForLockfile('yarn.lock'), null);
});

test('a workspace member finds the root lockfile by walking up', () => {
  assert.equal(nearestLockfileDir('packages/app', ['']), '');
  assert.equal(nearestLockfileDir('packages/app/nested', ['', 'packages/app']), 'packages/app');
  assert.equal(nearestLockfileDir('packages/app', ['other']), null);
});

test('a lockfile beside the manifest wins over one further up', () => {
  assert.equal(nearestLockfileDir('packages/app', ['', 'packages/app']), 'packages/app');
});

// ------------------------------------------------ S7: lockfile topology

test('lockfileWatchPaths covers all supported filenames in every ancestor directory up to the workspace root', () => {
  assert.deepEqual(lockfileWatchPaths('packages/app'), [
    'packages/app/package-lock.json',
    'packages/app/npm-shrinkwrap.json',
    'packages/app/pnpm-lock.yaml',
    'packages/package-lock.json',
    'packages/npm-shrinkwrap.json',
    'packages/pnpm-lock.yaml',
    'package-lock.json',
    'npm-shrinkwrap.json',
    'pnpm-lock.yaml',
  ]);
});

test('lockfileWatchPaths at the workspace root itself is the supported root-level filenames', () => {
  assert.deepEqual(lockfileWatchPaths(''), ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml']);
});

test('lockfileWatchPaths exactly matches every directory nearestLockfileDir would check — a lockfile appearing at any watched path is one nearestLockfileDir would find', () => {
  const dir = 'packages/app/nested';
  const watched = lockfileWatchPaths(dir);
  const watchedDirs = new Set(watched.map((p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')));

  for (const candidateLockfileDir of ['packages/app/nested', 'packages/app', 'packages', '']) {
    assert.equal(nearestLockfileDir(dir, [candidateLockfileDir]), candidateLockfileDir);
    assert.equal(
      watchedDirs.has(candidateLockfileDir),
      true,
      `a lockfile appearing at ${candidateLockfileDir || '(root)'} would be resolved, so it must be watched`
    );
  }
});

test('lockfileWatchPaths includes npm-shrinkwrap.json alongside package-lock.json in the same directory, covering the precedence-flip case', () => {
  const paths = lockfileWatchPaths('packages/app');
  assert.equal(paths.includes('packages/app/package-lock.json'), true);
  assert.equal(paths.includes('packages/app/npm-shrinkwrap.json'), true);
});

test('lockfileWatchDirs returns every ancestor directory up to the workspace root, matching lockfileWatchPaths\' own directory set', () => {
  assert.deepEqual(lockfileWatchDirs('packages/app'), ['packages/app', 'packages', '']);
  assert.deepEqual(lockfileWatchDirs(''), ['']);
});

test('lockfileWatchDirs returns directory names completely unescaped and untransformed — a caller must treat each one as a literal URI path segment, never interpolate it into a glob', () => {
  // A directory containing glob metacharacters is entirely legal on every
  // major filesystem — `*`, `?`, `[`, `]`, `{`, `}`, and `,` are not
  // reserved in POSIX or NTFS path segments. If a caller built a single
  // glob pattern by joining these strings with commas (the bug this
  // function's design avoids — see its own doc comment), a directory named
  // `pkg{a,b}` would corrupt that glob's brace-group syntax, or a directory
  // named `pkg[1]` would be reinterpreted as a character class. Returning
  // the raw segments here, with no escaping applied, is deliberate: safety
  // comes from the *caller* using each one as a literal path base (as
  // `vscode.RelativePattern`'s first argument already is), not from this
  // function trying to sanitize a value it cannot safely round-trip through
  // glob syntax anyway.
  const weird = 'packages/pkg{a,b}[1]*?';
  assert.deepEqual(lockfileWatchDirs(weird), [weird, 'packages', '']);

  const withComma = 'pkg,other';
  assert.deepEqual(lockfileWatchDirs(withComma), [withComma, '']);

  const withBraces = 'a{b,c}/nested';
  assert.deepEqual(lockfileWatchDirs(withBraces), [withBraces, 'a{b,c}', '']);
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

test('isSameProjectReload is true only when a previously selected id matches the candidate being reloaded', () => {
  const idA = deriveProjectId('file:///workspace/frontend', 'package.json');
  const idB = deriveProjectId('file:///workspace/backend', 'package.json');

  assert.equal(isSameProjectReload(idA, idA), true, 'the same id is the same project');
  assert.equal(isSameProjectReload(idA, idB), false, 'a genuinely different id is a switch');
});

test('isSameProjectReload is false when nothing was previously selected — a first-ever load is never "the same project" as anything', () => {
  const idA = deriveProjectId('file:///workspace/frontend', 'package.json');
  assert.equal(isSameProjectReload(undefined, idA), false);
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
