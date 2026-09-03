import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  dependencyDescriptionCopy,
  deprecatedFindingFor,
  introducedDuplicateFindings,
  ownDuplicateFinding,
  usageSignificanceCopy,
  usageScopeLabel,
  usageSummaryCounts,
} from '../out/host/dependencyDetailsCopy.js';

function row(overrides) {
  return { name: 'react', dev: false, range: '^18.0.0', ...overrides };
}

test('dependencyDescriptionCopy uses the registry description', () => {
  assert.equal(dependencyDescriptionCopy(row({ description: 'A library for building interfaces.' })), 'A library for building interfaces.');
});

test('dependencyDescriptionCopy has an honest fallback when no description is published', () => {
  assert.equal(dependencyDescriptionCopy(row({})), 'No package description is published for this dependency.');
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

const REFERENCES = [
  { filePath: 'src/api/client.ts', line: 1, column: 1, snippet: "import axios from 'axios'", kind: 'import' },
  { filePath: 'src/services/auth.service.ts', line: 3, column: 1, snippet: "import axios from 'axios'", kind: 'import' },
  { filePath: 'src/hooks/useUser.ts', line: 27, column: 12, snippet: "await axios.get('/me')", kind: 'require' },
  { filePath: 'package.json', line: 0, column: 0, snippet: 'build', kind: 'script', context: 'build' },
  { filePath: 'webpack.config.js', line: 4, column: 1, snippet: 'externals: ["axios"]', kind: 'config', context: 'webpack' },
];

test('usageSummaryCounts tallies each reference kind independently, never inventing an unrepresented category', () => {
  assert.deepEqual(usageSummaryCounts(REFERENCES), {
    referencedInFiles: 5,
    importStatements: 3,
    dynamicImports: 0,
    scripts: 1,
    configReferences: 1,
    testReferences: 0,
    nonTestReferences: 5,
  });
});

test('usageSummaryCounts counts a file only once no matter how many references it has', () => {
  const counts = usageSummaryCounts([REFERENCES[0], { ...REFERENCES[0], line: 2 }]);
  assert.equal(counts.referencedInFiles, 1);
  assert.equal(counts.importStatements, 2);
});

test('usageSummaryCounts on no references is all zero', () => {
  assert.deepEqual(usageSummaryCounts([]), {
    referencedInFiles: 0,
    importStatements: 0,
    dynamicImports: 0,
    scripts: 0,
    configReferences: 0,
    testReferences: 0,
    nonTestReferences: 0,
  });
});

test('usageSignificanceCopy: analysis not finished yet', () => {
  assert.equal(usageSignificanceCopy(row({}), null), "Usage analysis for react hasn't finished yet.");
});

test('usageSignificanceCopy: real source usage', () => {
  const counts = usageSummaryCounts(REFERENCES);
  assert.equal(usageSignificanceCopy(row({}), counts), 'react is referenced directly by application code and is actively used by this project.');
});

test('usageSignificanceCopy: script/config only, no source import', () => {
  const counts = usageSummaryCounts([REFERENCES[3], REFERENCES[4]]);
  assert.equal(
    usageSignificanceCopy(row({}), counts),
    "react isn't imported by application code, but is referenced from package.json scripts or configuration."
  );
});

test('usageSignificanceCopy: nothing found at all', () => {
  assert.equal(
    usageSignificanceCopy(row({}), usageSummaryCounts([])),
    'No direct source references to react were found. Review its scripts, configuration, and dependency paths before removing it.'
  );
});

test('test-only references are identified without changing the reference protocol', () => {
  const counts = usageSummaryCounts([
    { filePath: 'src/components/Button.test.tsx', line: 2, column: 1, snippet: "import x from 'react'", kind: 'import' },
    { filePath: 'package.json', line: 0, column: 0, snippet: 'test', kind: 'script', context: 'test:coverage' },
    { filePath: 'jest.config.js', line: 0, column: 0, snippet: 'jest.config.js', kind: 'config', context: 'jest.config.js' },
  ]);

  assert.equal(counts.testReferences, 3);
  assert.equal(counts.nonTestReferences, 0);
  assert.equal(usageScopeLabel(counts), 'Tests only');
  assert.equal(
    usageSignificanceCopy(row({}), counts),
    'react is referenced only by tests or test tooling. Removing it may break test coverage even when the application build succeeds.'
  );
});

test('mixed application and test references are labeled distinctly', () => {
  const counts = usageSummaryCounts([
    REFERENCES[0],
    { filePath: '__tests__/client.ts', line: 1, column: 1, snippet: "import axios from 'axios'", kind: 'import' },
  ]);

  assert.equal(usageScopeLabel(counts), 'Application and tests');
  assert.equal(counts.testReferences, 1);
  assert.equal(counts.nonTestReferences, 1);
});
