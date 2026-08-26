import { readFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';

import { scanSourceForImportSpecifiers } from '../out/core/usage/importScan.js';
import {
  appendProjectCompatibilityImportAnalysis,
  analyzeProjectCompatibilityMedium,
  removedTargetPackageCommands,
  targetExportsEvidence,
} from '../out/host/projectCompatibility/projectCompatibilityAnalysis.js';

const fixtureRoot = path.resolve('test/fixtures/project-compatibility-next15');

const identity = {
  packageName: 'next',
  currentVersion: '14.2.35',
  targetVersion: '15.5.24',
  requestId: 'request-1',
  sourceFingerprint: 'fingerprint-1',
};

const project = {
  scripts: { lint: 'next lint' },
  declaredDependencies: { next: '^14.2.35', 'eslint-config-next': '^14.2.35' },
  projectNodeRange: '>=16 <18',
  imports: [{
    specifier: 'next/dist/removed', kind: 'import', filePath: 'src/a.ts', line: 1, column: 20,
    snippet: "import x from 'next/dist/removed'",
  }],
  ruleFiles: [],
  scannedFileCount: 1,
  truncated: false,
  evidenceFingerprint: 'fixture-fingerprint',
};

test('medium project analysis preserves independent runtime, tooling, and framework outcomes', async () => {
  const analysis = await analyzeProjectCompatibilityMedium({
    identity,
    project,
    targetMetadata: {
      name: 'next', version: '15.5.24', dependencies: {}, optionalDependencies: {},
      peerDependencies: {}, peerDependenciesMeta: {}, engines: { node: '^18.18.0 || >=20' },
    },
    toolingPackages: [],
    toolingMetadataIncomplete: false,
  });
  assert.equal(analysis.findings.some((finding) => finding.category === 'runtime'), true);
  assert.equal(analysis.findings.some((finding) => finding.ruleId === 'next-15-5-next-lint-deprecation'), true);
});

test('deep import failure is isolated and never converts missing evidence to compatible', async () => {
  const medium = await analyzeProjectCompatibilityMedium({
    identity, project, toolingPackages: [], toolingMetadataIncomplete: true,
  });
  const complete = await appendProjectCompatibilityImportAnalysis({
    analysis: medium,
    project,
    unavailableReason: 'target-pack-failed',
  });
  const imports = complete.analyzers.find((entry) => entry.analyzerId === 'import-compatibility');
  assert.equal(imports.status, 'unavailable');
  assert.equal(imports.unavailableReason, 'target-pack-failed');
});

test('exports evidence distinguishes absent maps, root sugar, and explicit subpaths', () => {
  assert.deepEqual(targetExportsEvidence(undefined), { status: 'absent', subpaths: [] });
  assert.deepEqual(targetExportsEvidence('./index.js'), { status: 'known', subpaths: ['.'] });
  assert.deepEqual(targetExportsEvidence({ '.': './index.js', './server': './server.js' }), {
    status: 'known', subpaths: ['.', './server'],
  });
  assert.deepEqual(targetExportsEvidence({ './*': './*.js', './removed': null }), {
    status: 'known', subpaths: ['./*'], blockedSubpaths: ['./removed'],
  });
  assert.deepEqual(targetExportsEvidence({ import: null, require: null }), {
    status: 'known', subpaths: [], blockedSubpaths: ['.'],
  });
});

test('Next 14.2.35 to 15.5.24 acceptance fixture predicts only evidence-backed project breakage', async () => {
  const manifestText = await readFile(path.join(fixtureRoot, 'package.json'), 'utf8');
  const manifest = JSON.parse(manifestText);
  const importPath = 'src/components/UserSelector.tsx';
  const importSource = await readFile(path.join(fixtureRoot, importPath), 'utf8');
  const importMatch = scanSourceForImportSpecifiers(importSource)[0];
  assert.ok(importMatch, 'fixture contains the private Next.js import under test');

  const rulePaths = [
    'next.config.mjs',
    'app/users/[id]/page.tsx',
    'app/safe/[id]/page.tsx',
    // This is deliberately available as evidence but has no asserted Next 15
    // minimum. ES2017 is not turned into a framework claim without proof.
    'tsconfig.json',
  ];
  const ruleFiles = await Promise.all(rulePaths.map(async (filePath, referenceIndex) => ({
    filePath,
    content: await readFile(path.join(fixtureRoot, filePath), 'utf8'),
    usageId: 'fixture-usage',
    referenceIndex,
  })));
  const fixtureProject = {
    scripts: manifest.scripts,
    declaredDependencies: { ...manifest.dependencies, ...manifest.devDependencies },
    projectNodeRange: manifest.engines.node,
    imports: [{
      specifier: importMatch.specifier,
      kind: importMatch.kind,
      filePath: importPath,
      line: importMatch.line,
      column: importMatch.column,
      snippet: importMatch.snippet,
      usageId: 'fixture-usage',
      referenceIndex: rulePaths.length,
    }],
    ruleFiles,
    scannedFileCount: 3,
    truncated: false,
  };

  const medium = await analyzeProjectCompatibilityMedium({
    identity,
    project: fixtureProject,
    targetMetadata: {
      name: 'next',
      version: '15.5.24',
      dependencies: {},
      optionalDependencies: {},
      peerDependencies: {},
      peerDependenciesMeta: {},
      // Exact published Next 15.5.24 metadata. In particular this is not the
      // >=20.9 requirement from a different Next release.
      engines: { node: '^18.18.0 || ^19.8.0 || >=20.0.0' },
    },
    toolingPackages: [
      {
        name: '@typescript-eslint/eslint-plugin',
        resolvedVersion: '6.21.0',
        declaredRange: '6.21.0',
        peerDependencies: { '@typescript-eslint/parser': '^6.0.0' },
      },
      {
        name: '@typescript-eslint/parser',
        resolvedVersion: '7.18.0',
        declaredRange: '7.18.0',
        peerDependencies: {},
      },
    ],
    toolingMetadataIncomplete: false,
  });

  assert.deepEqual(new Set(medium.findings.map((finding) => finding.ruleId)), new Set([
    'project-node-engine-incompatible',
    'tooling-peer-version-incompatible',
    'next-15-server-external-packages-rename',
    'next-15-5-next-lint-deprecation',
    'next-15-async-route-params',
    'next-eslint-config-major-alignment',
  ]));
  assert.equal(medium.findings.some((finding) => finding.category === 'compiler'), false);
  assert.equal(medium.findings.some((finding) => /useParams\(\)/.test(finding.title)), false,
    'the fixture route rule does not invent a generic useParams migration');
  assert.equal(medium.findings.some((finding) => />=20\.9/.test(finding.explanation)), false,
    'the exact target metadata must not inherit a Node requirement from another release');

  const deep = await appendProjectCompatibilityImportAnalysis({
    analysis: medium,
    project: fixtureProject,
    targetSurface: {
      packageName: 'next',
      version: '15.5.24',
      exports: { status: 'absent', subpaths: [] },
      files: {
        completeness: 'complete',
        // Representative complete-evidence assertion: the exact imported file
        // is absent while an adjacent published file proves this is not an
        // empty/failed inventory being mistaken for absence.
        paths: ['dist/client/index.js', 'dist/client/components/react-dev-overlay/index.js'],
      },
      privateSubpathPrefixes: ['./dist/'],
    },
  });

  const removedImport = deep.findings.find((finding) => finding.ruleId === 'target-package-file-missing');
  assert.ok(removedImport);
  assert.equal(removedImport.confidence, 'confirmed');
  assert.equal(removedImport.evidence[0].specifier,
    'next/dist/client/components/react-dev-overlay/internal/icons/CloseIcon');
  assert.equal(removedImport.evidence[0].usageId, 'fixture-usage');
  assert.equal(removedImport.evidence[0].referenceIndex, rulePaths.length);
  assert.equal(deep.findings.length, medium.findings.length + 1,
    'deep import settlement preserves every medium finding and adds exactly the proven removed import');
});

test('medium analyzer unavailability is isolated from framework findings', async () => {
  const isolated = await analyzeProjectCompatibilityMedium({
    identity,
    project,
    toolingPackages: [],
    toolingMetadataIncomplete: true,
  });
  assert.equal(isolated.analyzers.find((entry) => entry.analyzerId === 'runtime-compatibility')?.status, 'unavailable');
  assert.equal(isolated.analyzers.find((entry) => entry.analyzerId === 'tooling-peer-alignment')?.status, 'partial');
  assert.equal(isolated.findings.some((finding) => finding.ruleId === 'next-15-5-next-lint-deprecation'), true,
    'independent Next.js rules remain visible when target/tooling metadata is unavailable');
});

test('generic CLI evidence only reports executables proven removed from the exact target', () => {
  const base = {
    name: 'tool', version: '1.0.0', dependencies: {}, optionalDependencies: {},
    peerDependencies: {}, peerDependenciesMeta: {},
  };
  assert.deepEqual(removedTargetPackageCommands({
    packageName: 'tool',
    currentMetadata: { ...base, bin: { 'tool-old': './old.js', shared: './shared.js' } },
    targetMetadata: { ...base, version: '2.0.0', bin: { shared: './shared.js', 'tool-new': './new.js' } },
  }), [{
    executable: 'tool-old',
    status: 'unsupported',
    explanation: 'tool 2.0.0 no longer publishes the tool-old executable.',
    migrationHint: 'Replace scripts that invoke tool-old with a command supported by the target package.',
  }]);
  assert.deepEqual(removedTargetPackageCommands({
    packageName: 'tool',
    currentMetadata: { ...base, bin: './cli.js' },
    targetMetadata: { ...base, version: '2.0.0', bin: './cli-v2.js' },
  }), [], 'a string bin retains the package-owned executable even when its published file moves');
  assert.equal(removedTargetPackageCommands({ packageName: 'tool', currentMetadata: base }), undefined,
    'missing exact target metadata cannot prove a command was removed');
});

test('medium project analysis emits a removed executable finding without inventing one for retained commands', async () => {
  const scriptProject = {
    ...project,
    scripts: { migrate: 'tool-old --fix', retained: 'shared build' },
    ruleFiles: [],
    imports: [],
  };
  const commands = removedTargetPackageCommands({
    packageName: 'next',
    currentMetadata: {
      name: 'next', version: '14.2.35', dependencies: {}, optionalDependencies: {},
      peerDependencies: {}, peerDependenciesMeta: {}, bin: { 'tool-old': './old.js', shared: './shared.js' },
    },
    targetMetadata: {
      name: 'next', version: '15.5.24', dependencies: {}, optionalDependencies: {},
      peerDependencies: {}, peerDependenciesMeta: {}, bin: { shared: './shared.js' },
    },
  });
  const analysis = await analyzeProjectCompatibilityMedium({
    identity,
    project: scriptProject,
    toolingPackages: [],
    toolingMetadataIncomplete: false,
    targetCommands: commands,
  });
  const scriptFindings = analysis.findings.filter((finding) => finding.category === 'script');
  assert.deepEqual(scriptFindings.map((finding) => finding.ruleId), ['unsupported-package-command']);
  assert.match(scriptFindings[0].explanation, /migrate invokes tool-old/);
  assert.equal(scriptFindings.some((finding) => /shared/.test(finding.explanation)), false);
  assert.equal(analysis.analyzers.find((entry) => entry.analyzerId === 'package-script-compatibility')?.status, 'complete');
});
