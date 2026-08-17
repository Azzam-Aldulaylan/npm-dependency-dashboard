import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  deprecatedFindingFor,
  directDeclarationCopy,
  introducedDuplicateFindings,
  ownDuplicateFinding,
} from '../out/host/dependencyDetailsCopy.js';

function row(overrides) {
  return { name: 'react', dev: false, range: '^18.0.0', ...overrides };
}

test('directDeclarationCopy names the production dependencies block', () => {
  assert.match(directDeclarationCopy(row({ dev: false })), /production dependency.*dependencies/);
});

test('directDeclarationCopy names the devDependencies block', () => {
  assert.match(directDeclarationCopy(row({ dev: true })), /development dependency.*devDependencies/);
});

const DEPRECATED_FINDING = {
  packageName: 'left-pad',
  kind: 'deprecated',
  confidence: 'high',
  severity: 'attention',
  summary: 'left-pad is deprecated',
  evidence: { kind: 'deprecated', message: 'no longer maintained' },
};

const OWN_DUPLICATE_FINDING = {
  packageName: 'lodash',
  kind: 'duplicate-version',
  severity: 'attention',
  summary: '2 versions of lodash are installed',
  evidence: {
    kind: 'duplicate-version',
    versions: [
      { version: '4.17.20', direct: { classification: 'prod' }, paths: [], totalPaths: 0, truncated: false },
      { version: '4.17.21', direct: null, paths: [['package-a', 'lodash']], totalPaths: 1, truncated: false },
    ],
  },
};

const INTRODUCED_DUPLICATE_FINDING = {
  packageName: 'js-tokens',
  kind: 'duplicate-version',
  severity: 'attention',
  summary: '2 versions of js-tokens are installed',
  evidence: {
    kind: 'duplicate-version',
    versions: [
      { version: '3.0.2', direct: null, paths: [['legacy-thing', 'js-tokens']], totalPaths: 1, truncated: false },
      { version: '4.0.0', direct: null, paths: [['react', 'loose-envify', 'js-tokens']], totalPaths: 1, truncated: false },
    ],
  },
};

test('deprecatedFindingFor finds a deprecated finding by package name', () => {
  assert.equal(deprecatedFindingFor([DEPRECATED_FINDING], 'left-pad'), DEPRECATED_FINDING);
  assert.equal(deprecatedFindingFor([DEPRECATED_FINDING], 'react'), undefined);
});

test('ownDuplicateFinding finds the duplicate-version finding about the package itself', () => {
  assert.equal(ownDuplicateFinding([OWN_DUPLICATE_FINDING], 'lodash'), OWN_DUPLICATE_FINDING);
  assert.equal(ownDuplicateFinding([OWN_DUPLICATE_FINDING], 'react'), undefined);
});

test('introducedDuplicateFindings finds findings this package introduces transitively', () => {
  const findings = introducedDuplicateFindings([INTRODUCED_DUPLICATE_FINDING], 'react');
  assert.deepEqual(findings, [INTRODUCED_DUPLICATE_FINDING]);
});

test('introducedDuplicateFindings excludes a package\'s own duplicate finding', () => {
  const findings = introducedDuplicateFindings([OWN_DUPLICATE_FINDING], 'lodash');
  assert.deepEqual(findings, []);
});

test('introducedDuplicateFindings finds nothing for an unrelated package', () => {
  assert.deepEqual(introducedDuplicateFindings([INTRODUCED_DUPLICATE_FINDING], 'left-pad'), []);
});
