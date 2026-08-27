import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  analyzeImportCompatibility,
  analyzePackageScripts,
  analyzeRuntimeCompatibility,
  analyzeToolingPeerAlignment,
  createProjectCompatibilityFinding,
  InvalidProjectCompatibilityIdentityError,
  MAX_PROJECT_COMPATIBILITY_FINDINGS,
  projectCompatibilityIdentityMatches,
  runProjectCompatibilityAnalyzers,
  validateProjectCompatibilityIdentity,
} from '../out/core/projectCompatibility/index.js';

const identity = {
  packageName: 'next',
  currentVersion: '14.2.35',
  targetVersion: '15.5.24',
  requestId: 'request-1',
  sourceFingerprint: 'source-1',
};

function reference(specifier, overrides = {}) {
  return {
    specifier,
    kind: overrides.kind ?? 'import',
    filePath: overrides.filePath ?? 'src/example.ts',
    line: overrides.line ?? 4,
    column: overrides.column ?? 18,
    snippet: overrides.snippet ?? `import value from '${specifier}';`,
    usageId: overrides.usageId ?? 'usage-1',
    referenceIndex: overrides.referenceIndex ?? 0,
  };
}

function surface(overrides = {}) {
  return {
    packageName: 'next',
    version: '15.5.24',
    exports: overrides.exports ?? { status: 'known', subpaths: ['.', './public', './features/*'] },
    ...(overrides.files === undefined ? {} : { files: overrides.files }),
    ...(overrides.privateSubpathPrefixes === undefined
      ? {}
      : { privateSubpathPrefixes: overrides.privateSubpathPrefixes }),
  };
}

test('a public package export remains compatible without a finding', () => {
  const result = analyzeImportCompatibility({
    identity,
    references: [reference('next/public'), reference('next/features/alpha')],
    targetSurface: surface(),
  });
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.findings, []);
});

test('a target exports map blocking a subpath is a confirmed incompatibility', () => {
  const result = analyzeImportCompatibility({
    identity,
    references: [reference('next/removed')],
    targetSurface: surface(),
  });
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].confidence, 'confirmed');
  assert.equal(result.findings[0].category, 'import');
  assert.equal(result.findings[0].ruleId, 'target-export-blocks-import');
  assert.equal(result.findings[0].evidence[0].usageId, 'usage-1');
  assert.equal(result.findings[0].evidence[0].referenceIndex, 0);
});

test('exact and most-specific wildcard null exports override broader exported patterns', () => {
  const exact = analyzeImportCompatibility({
    identity,
    references: [reference('next/removed')],
    targetSurface: surface({ exports: {
      status: 'known', subpaths: ['./*'], blockedSubpaths: ['./removed'],
    } }),
  });
  const wildcard = analyzeImportCompatibility({
    identity,
    references: [reference('next/features/public/card'), reference('next/features/private/secret')],
    targetSurface: surface({ exports: {
      status: 'known',
      subpaths: ['./features/*'],
      blockedSubpaths: ['./features/private/*'],
    } }),
  });
  assert.equal(exact.findings[0].ruleId, 'target-export-blocks-import');
  assert.deepEqual(wildcard.findings.map((finding) => finding.evidence[0].specifier), [
    'next/features/private/secret',
  ]);
});

test('a package root import is confirmed blocked when a complete exports map omits dot', () => {
  const result = analyzeImportCompatibility({
    identity,
    references: [reference('next')],
    targetSurface: surface({ exports: { status: 'known', subpaths: ['./server'] } }),
  });
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].ruleId, 'target-export-blocks-import');
});

test('a removed deep file is confirmed only from a complete target file inventory', () => {
  const complete = analyzeImportCompatibility({
    identity,
    references: [reference('next/dist/removed')],
    targetSurface: surface({
      exports: { status: 'absent', subpaths: [] },
      files: { completeness: 'complete', paths: ['dist/present.js'] },
    }),
  });
  const partial = analyzeImportCompatibility({
    identity,
    references: [reference('next/dist/removed')],
    targetSurface: surface({
      exports: { status: 'absent', subpaths: [] },
      files: { completeness: 'partial', paths: [] },
    }),
  });
  assert.equal(complete.findings[0].ruleId, 'target-package-file-missing');
  assert.equal(complete.findings[0].confidence, 'confirmed');
  assert.equal(partial.status, 'partial');
  assert.deepEqual(partial.findings, []);
});

test('a private import that still resolves is review recommended, not a confirmed failure', () => {
  const result = analyzeImportCompatibility({
    identity,
    references: [reference('next/dist/present')],
    targetSurface: surface({
      exports: { status: 'absent', subpaths: [] },
      files: { completeness: 'complete', paths: ['dist/present.js'] },
      privateSubpathPrefixes: ['./dist/'],
    }),
  });
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].category, 'private-api');
  assert.equal(result.findings[0].confidence, 'review');
});

test('conditional exports and an absent root entry remain unverified rather than falsely compatible', () => {
  const conditional = analyzeImportCompatibility({
    identity,
    references: [reference('next')],
    targetSurface: surface({
      exports: { status: 'known', subpaths: [], conditionalSubpaths: ['.'] },
    }),
  });
  const absentRoot = analyzeImportCompatibility({
    identity,
    references: [reference('next')],
    targetSurface: surface({ exports: { status: 'absent', subpaths: [] } }),
  });
  assert.equal(conditional.status, 'partial');
  assert.equal(absentRoot.status, 'partial');
  assert.deepEqual(conditional.findings, []);
  assert.deepEqual(absentRoot.findings, []);
});

test('scoped and dynamic subpath imports are matched against their exact package surface', () => {
  const scopedIdentity = { ...identity, packageName: '@scope/framework' };
  const result = analyzeImportCompatibility({
    identity: scopedIdentity,
    references: [reference('@scope/framework/removed', { kind: 'dynamic-import' }), reference('@scope/other/removed')],
    targetSurface: {
      packageName: '@scope/framework',
      version: '15.5.24',
      exports: { status: 'known', subpaths: ['.'] },
    },
  });
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].evidence[0].specifier, '@scope/framework/removed');
});

test('target surface evidence is rejected when its identity does not match the selected target', () => {
  const result = analyzeImportCompatibility({
    identity,
    references: [reference('next/removed')],
    targetSurface: { ...surface(), version: '15.5.23' },
  });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.unavailableReason, 'target-surface-identity-mismatch');
});

test('compatible Node engine evidence produces no incompatibility', () => {
  const result = analyzeRuntimeCompatibility({
    identity,
    evidence: {
      packageName: 'next',
      targetVersion: '15.5.24',
      targetNodeRange: '>=18.18.0',
      projectNodeRange: '>=18.20.0',
      runtimeNodeVersion: '20.11.1',
    },
  });
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.findings, []);
});

test('incompatible runtime and disjoint project engine ranges are separately confirmed', () => {
  const result = analyzeRuntimeCompatibility({
    identity,
    evidence: {
      packageName: 'next',
      targetVersion: '15.5.24',
      targetNodeRange: '>=20.9.0',
      projectNodeRange: '^18.18.0',
      runtimeNodeVersion: '18.20.4',
    },
  });
  assert.deepEqual(result.findings.map((finding) => finding.ruleId), [
    'runtime-node-version-incompatible',
    'project-node-engine-incompatible',
  ]);
  assert.ok(result.findings.every((finding) => finding.confidence === 'confirmed'));
});

test('unknown project/runtime information remains partial and is not invented as a mismatch', () => {
  const result = analyzeRuntimeCompatibility({
    identity,
    evidence: {
      packageName: 'next',
      targetVersion: '15.5.24',
      targetNodeRange: '>=18.18.0',
      projectNodeRange: null,
      runtimeNodeVersion: null,
    },
  });
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.findings, []);
});

test('a malformed target engine is unavailable rather than compatible', () => {
  const result = analyzeRuntimeCompatibility({
    identity,
    evidence: {
      packageName: 'next',
      targetVersion: '15.5.24',
      targetNodeRange: 'definitely-not-semver',
      projectNodeRange: '>=20',
      runtimeNodeVersion: '20.11.0',
    },
  });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.unavailableReason, 'invalid-target-node-engine');
});

test('package scripts detect direct, wrapped, compound, and quoted subcommands without executing them', () => {
  const commands = [{
    executable: 'next',
    subcommand: 'lint',
    status: 'unsupported',
    explanation: 'The target no longer supports this command.',
    migrationHint: 'Run ESLint directly.',
  }];
  const result = analyzePackageScripts({
    identity,
    scripts: {
      lint: 'next "lint" && echo done',
      ci: 'NODE_ENV=test npx --no-install next lint',
      multiline: 'node prepare.js\nnext lint',
      unrelated: 'echo "next lint"',
    },
    targetCommands: commands,
  });
  assert.deepEqual(result.findings.map((finding) => finding.evidence[0].context), ['ci', 'lint', 'multiline']);
  assert.ok(result.findings.every((finding) => finding.confidence === 'confirmed'));
});

test('supported commands and unrelated scripts do not produce findings', () => {
  const result = analyzePackageScripts({
    identity,
    scripts: { lint: 'next lint', test: 'node --test' },
    targetCommands: [{
      executable: 'next',
      subcommand: 'lint',
      status: 'supported',
      explanation: 'Supported.',
    }],
  });
  assert.deepEqual(result.findings, []);
});

test('deprecated commands are likely migrations rather than confirmed failures', () => {
  const result = analyzePackageScripts({
    identity,
    scripts: { lint: 'pnpm exec next lint' },
    targetCommands: [{
      executable: 'next',
      subcommand: 'lint',
      status: 'deprecated',
      explanation: 'This command is deprecated for the target.',
    }],
  });
  assert.equal(result.findings[0].confidence, 'likely');
});

test('resolved TypeScript-ESLint peer mismatch is a confirmed tooling finding', () => {
  const result = analyzeToolingPeerAlignment({
    identity,
    packages: [
      {
        name: '@typescript-eslint/eslint-plugin',
        resolvedVersion: '6.21.0',
        declaredRange: '^6.21.0',
        peerDependencies: { '@typescript-eslint/parser': '^6.0.0' },
      },
      {
        name: '@typescript-eslint/parser',
        resolvedVersion: '7.18.0',
        declaredRange: '^7.18.0',
        peerDependencies: {},
      },
    ],
  });
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].ruleId, 'tooling-peer-version-incompatible');
  assert.match(result.findings[0].explanation, /parser@\^6\.0\.0/);
});

test('compatible tooling peers and absent optional peers produce no findings', () => {
  const result = analyzeToolingPeerAlignment({
    identity,
    packages: [
      {
        name: 'plugin',
        resolvedVersion: '2.0.0',
        declaredRange: '^2',
        peerDependencies: { parser: '^7', optionalHost: '^1' },
        optionalPeers: ['optionalHost'],
      },
      { name: 'parser', resolvedVersion: '7.18.0', declaredRange: '^7', peerDependencies: {} },
    ],
  });
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.findings, []);
});

test('disjoint declared peer ranges prove incompatibility when a resolved version is unavailable', () => {
  const result = analyzeToolingPeerAlignment({
    identity,
    packages: [
      { name: 'plugin', resolvedVersion: '2.0.0', declaredRange: '^2', peerDependencies: { parser: '^6' } },
      { name: 'parser', resolvedVersion: null, declaredRange: '^7', peerDependencies: {} },
    ],
  });
  assert.equal(result.findings[0].ruleId, 'tooling-peer-range-incompatible');
});

test('malformed peer metadata makes the tooling analyzer partial, never falsely compatible', () => {
  const result = analyzeToolingPeerAlignment({
    identity,
    packages: [
      { name: 'plugin', resolvedVersion: '2.0.0', declaredRange: '^2', peerDependencies: { parser: 'bad range' } },
      { name: 'parser', resolvedVersion: '7.0.0', declaredRange: '^7', peerDependencies: {} },
    ],
  });
  assert.equal(result.status, 'partial');
  assert.equal(result.unavailableReason, 'tooling-metadata-incomplete');
  assert.deepEqual(result.findings, []);
});

test('the analyzer runner isolates failure and preserves a later successful analyzer', async () => {
  const analysis = await runProjectCompatibilityAnalyzers({
    identity,
    analyzers: [
      async () => { throw new Error('sensitive raw failure'); },
      async () => ({ analyzerId: 'engine', status: 'complete', findings: [] }),
    ],
    now: () => new Date('2026-08-26T12:00:00.000Z'),
  });
  assert.equal(analysis.analyzers[0].status, 'unavailable');
  assert.equal(analysis.analyzers[0].unavailableReason, 'analyzer-failed');
  assert.equal(analysis.analyzers[1].analyzerId, 'engine');
  assert.equal(analysis.completedAt, '2026-08-26T12:00:00.000Z');
});

test('the analyzer runner deterministically bounds findings before protocol presentation', async () => {
  const requested = MAX_PROJECT_COMPATIBILITY_FINDINGS + 25;
  const findings = Array.from({ length: requested }, (_, index) =>
    createProjectCompatibilityFinding(identity, {
      ruleId: 'bounded-test-finding',
      category: 'import',
      confidence: 'review',
      title: 'Bounded finding',
      explanation: `Finding ${index}`,
      evidence: [],
      discriminator: [index],
    }));
  const analysis = await runProjectCompatibilityAnalyzers({
    identity,
    analyzers: [async () => ({ analyzerId: 'many', status: 'complete', findings })],
  });
  assert.equal(analysis.findings.length, MAX_PROJECT_COMPATIBILITY_FINDINGS);
  assert.equal(analysis.analyzers[0].status, 'partial');
  assert.equal(analysis.analyzers[0].unavailableReason, 'finding-limit-reached');
  assert.equal(analysis.findings.at(-1).explanation, `Finding ${MAX_PROJECT_COMPATIBILITY_FINDINGS - 1}`);
});

test('the analyzer runner quarantines findings for a different selected target', async () => {
  const analysis = await runProjectCompatibilityAnalyzers({
    identity,
    analyzers: [async () => ({
      analyzerId: 'wrong-target',
      status: 'complete',
      findings: [{
        id: 'wrong',
        category: 'runtime',
        confidence: 'confirmed',
        packageName: 'next',
        targetVersion: '16.0.0',
        title: 'Wrong target',
        explanation: 'Must not escape correlation.',
        evidence: [],
        source: 'generic',
      }],
    })],
  });
  assert.equal(analysis.analyzers[0].status, 'unavailable');
  assert.equal(analysis.analyzers[0].unavailableReason, 'analyzer-output-identity-mismatch');
  assert.deepEqual(analysis.findings, []);
});

test('target and source/request identity changes do not correlate', () => {
  assert.equal(projectCompatibilityIdentityMatches(identity, { ...identity }), true);
  assert.equal(projectCompatibilityIdentityMatches(identity, { ...identity, packageName: 'react' }), false);
  assert.equal(projectCompatibilityIdentityMatches(identity, { ...identity, currentVersion: '14.2.36' }), false);
  assert.equal(projectCompatibilityIdentityMatches(identity, { ...identity, targetVersion: '16.0.0' }), false);
  assert.equal(projectCompatibilityIdentityMatches(identity, { ...identity, requestId: 'request-2' }), false);
  assert.equal(projectCompatibilityIdentityMatches(identity, { ...identity, sourceFingerprint: 'source-2' }), false);
});

test('malformed target identities are rejected before analyzers can run', () => {
  assert.throws(
    () => validateProjectCompatibilityIdentity({ ...identity, targetVersion: 'latest' }),
    InvalidProjectCompatibilityIdentityError
  );
  assert.throws(
    () => validateProjectCompatibilityIdentity({ ...identity, packageName: '../next' }),
    InvalidProjectCompatibilityIdentityError
  );
});
