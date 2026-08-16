/**
 * Cache key derivation and credential stripping — pure.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { hasUrlCredentials, stripUrlCredentials, deriveProjectCacheKey } from '../out/core/cache/keys.js';
import { deriveProjectId } from '../out/core/workspace/scan.js';

test('hasUrlCredentials detects embedded userinfo and ignores a URL without any', () => {
  assert.equal(hasUrlCredentials('https://user:pass@registry.example/'), true);
  assert.equal(hasUrlCredentials('https://user@registry.example/'), true);
  assert.equal(hasUrlCredentials('https://registry.example/'), false);
  assert.equal(hasUrlCredentials('not a url at all'), false, 'unparseable falls back to false, never throws');
});

test('stripUrlCredentials removes userinfo but leaves an ordinary URL and an unparseable string alone', () => {
  assert.equal(stripUrlCredentials('https://user:pass@registry.example/path'), 'https://registry.example/path');
  assert.equal(stripUrlCredentials('https://registry.example/path'), 'https://registry.example/path');
  assert.equal(stripUrlCredentials('not a url at all'), 'not a url at all');
});

test('deriveProjectCacheKey differs when the project id differs, even for the same registry', () => {
  const a = deriveProjectCacheKey('project-a', 'https://registry.npmjs.org');
  const b = deriveProjectCacheKey('project-b', 'https://registry.npmjs.org');
  assert.notEqual(a, b);
});

test('deriveProjectCacheKey differs when only the registry differs, for the identical project id', () => {
  const a = deriveProjectCacheKey('project-a', 'https://registry.npmjs.org');
  const b = deriveProjectCacheKey('project-a', 'https://custom.registry.example/');
  assert.notEqual(a, b);
});

test('npm and pnpm scans of the same project never share a persisted project cache entry', () => {
  const npm = deriveProjectCacheKey('project-a', 'https://registry.npmjs.org', 'npm');
  const pnpm = deriveProjectCacheKey('project-a', 'https://registry.npmjs.org', 'pnpm');
  assert.notEqual(npm, pnpm);
});

test('the same relative manifest path in two different workspace folders never collides — folderId flows through deriveProjectId into the cache key', () => {
  const idInFolderOne = deriveProjectId('file:///workspace/one', 'package.json');
  const idInFolderTwo = deriveProjectId('file:///workspace/two', 'package.json');
  assert.notEqual(idInFolderOne, idInFolderTwo);

  const keyOne = deriveProjectCacheKey(idInFolderOne, 'https://registry.npmjs.org');
  const keyTwo = deriveProjectCacheKey(idInFolderTwo, 'https://registry.npmjs.org');
  assert.notEqual(keyOne, keyTwo);
});

test('a credentialed registry URL and its credential-stripped equivalent produce the same cache key — the persisted key itself never carries a credential', () => {
  const withCreds = deriveProjectCacheKey('project-a', 'https://user:pass@registry.example/');
  const stripped = deriveProjectCacheKey('project-a', 'https://registry.example/');
  assert.equal(withCreds, stripped);
  assert.equal(withCreds.includes('user'), false);
  assert.equal(withCreds.includes('pass'), false);
});
