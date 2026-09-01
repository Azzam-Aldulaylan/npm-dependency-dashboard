import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeDeprecatedApis } from '../out/core/projectCompatibility/deprecatedApis.js';
import { analyzeImportCompatibility, analyzeRuntimeCompatibility, runProjectCompatibilityAnalyzers } from '../out/core/projectCompatibility/index.js';
import { scanSourceForImportSpecifiers } from '../out/core/usage/importScan.js';
import { projectCompatibilityLimitations } from '../out/host/projectCompatibilityCoverage.js';
import { analyzeProjectCompatibilityMedium, appendProjectCompatibilityImportAnalysis } from '../out/host/projectCompatibility/projectCompatibilityAnalysis.js';

const identity = { packageName: 'next', currentVersion: '15.5.0', targetVersion: '16.0.0', requestId: 'coverage', sourceFingerprint: 'coverage-source' };
const reference = (specifier) => ({ specifier, kind: 'import', filePath: 'src/page.tsx', line: 1, column: 1, snippet: `import x from '${specifier}'`, usageId: 'trusted', referenceIndex: 3 });

test('classic root imports are verified only against a published runtime entry', () => {
  for (const [main, paths, status] of [
    ['./dist/main.js', ['dist/main.js'], 'complete'],
    [null, ['index.js'], 'complete'],
    ['dist/main', ['dist/main.js'], 'complete'],
    ['dist/main.mjs', ['dist/main.mjs'], 'complete'],
    ['dist/main.cjs', ['./dist/main.cjs'], 'complete'],
    [undefined, ['index.js'], 'partial'],
    [null, ['index.d.ts'], 'partial'],
    ['index.d.ts', ['index.d.ts'], 'partial'],
    ['index.d.mts', ['index.d.mts'], 'partial'],
    ['index.ts', ['index.ts'], 'partial'],
    ['missing.js', ['index.js'], 'partial'],
    ['dist', ['dist/index.js', 'dist/package.json'], 'partial'],
    ['../outside.js', ['../outside.js'], 'partial'],
    ['/outside.js', ['/outside.js'], 'partial'],
    ['file:main.js', ['file:main.js'], 'partial'],
  ]) {
    const result = analyzeImportCompatibility({ identity, references: [reference('next')], targetSurface: {
      packageName: 'next', version: identity.targetVersion, main,
      exports: { status: 'absent', subpaths: [] }, files: { completeness: 'complete', paths },
    } });
    assert.equal(result.status, status, `main ${main}`);
    assert.deepEqual(result.findings, [], 'unproven is not a confirmed break');
    if (status === 'partial') assert.equal(result.unavailableReason, 'root-entry-point-unverified');
  }
});

test('unknown exports cannot be bypassed by a valid classic main', () => {
  const result = analyzeImportCompatibility({ identity, references: [reference('next')], targetSurface: {
    packageName: 'next', version: identity.targetVersion, main: 'index.js',
    exports: { status: 'unknown', subpaths: [] }, files: { completeness: 'complete', paths: ['index.js'] },
  } });
  assert.equal(result.status, 'partial');
});

test('conditional imports retain a distinct reason rather than pretending environment compatibility', () => {
  const result = analyzeImportCompatibility({ identity, references: [reference('next')], targetSurface: {
    packageName: 'next', version: identity.targetVersion,
    exports: { status: 'known', subpaths: [], conditionalSubpaths: ['.'] },
  } });
  assert.equal(result.unavailableReason, 'conditional-exports-unresolved');
});

test('runtime coverage identifies active-runtime and declared-range limitations independently', () => {
  for (const [projectNodeRange, runtimeNodeVersion, expected] of [
    ['>=20.9', null, ['runtime-node-version-unknown']],
    [null, null, ['runtime-node-version-unknown', 'project-node-range-missing']],
    ['bad range', 'bad version', ['runtime-node-version-invalid', 'project-node-range-invalid']],
    [null, '22.1.0', ['project-node-range-missing']],
    ['>=20.9', '22.1.0', []],
  ]) {
    const result = analyzeRuntimeCompatibility({ identity, evidence: {
      packageName: identity.packageName, targetVersion: identity.targetVersion,
      targetNodeRange: '>=20.9', projectNodeRange, runtimeNodeVersion,
    } });
    assert.deepEqual(result.unavailableReason?.split('|') ?? [], expected);
    assert.equal(result.status, expected.length > 0 ? 'partial' : 'complete');
  }
});

test('deprecated import detector uses real imports, includes re-exports/require/dynamic, ignores text', async () => {
  const source = [
    'import Image from "next/legacy/image";',
    'export { default as LegacyImage } from "next/legacy/image";',
    'const Legacy = require("next/legacy/image");',
    'const load = () => import("next/legacy/image");',
    '// import Image from "next/legacy/image";',
    'const text = `import Image from "next/legacy/image"`;',
    'const regex = /next\\/legacy\\/image/;',
    'import ModernImage from "next/image";',
  ].join('\n');
  const references = scanSourceForImportSpecifiers(source).map((match, index) => ({ ...match, filePath: 'src/page.tsx', usageId: 'trusted', referenceIndex: index }));
  const result = analyzeDeprecatedApis({ identity, references, sourceComplete: true });
  assert.equal(result.status, 'complete');
  assert.equal(result.findings.length, 4);
  for (const finding of result.findings) {
    assert.equal(finding.ruleId, 'next-16-legacy-image-deprecated');
    assert.equal(finding.confidence, 'review');
    assert.equal(finding.source, 'framework-rule');
    assert.equal(finding.packageName, identity.packageName);
    assert.equal(finding.targetVersion, identity.targetVersion);
    assert.equal(finding.evidence[0].kind, 'source-reference');
    assert.equal(finding.evidence[0].usageId, 'trusted');
    assert.match(finding.migrationHint, /next\/image/);
  }
  assert.equal(new Set(result.findings.map(finding => finding.id)).size, 4);
  const analysis = await runProjectCompatibilityAnalyzers({ identity, analyzers: [() => result] });
  assert.equal(analysis.findings.length, 4, 'findings survive identity validation and correlation');
});

test('deprecated rule scope is explicit and does not invent support for other packages or versions', () => {
  for (const [packageName, targetVersion] of [['next', '15.5.24'], ['next', '17.0.0'], ['next', '16.0.0-canary.1'], ['next', 'bad'], ['other', '16.0.0']]) {
    const result = analyzeDeprecatedApis({ identity: { ...identity, packageName, targetVersion }, references: [reference('next/legacy/image')], sourceComplete: true });
    assert.equal(result.status, 'unavailable');
    assert.equal(result.unavailableReason, 'deprecated-api-rules-unavailable');
    assert.deepEqual(result.findings, []);
  }
  const noMatches = analyzeDeprecatedApis({ identity, references: [reference('next/image')], sourceComplete: true });
  assert.equal(noMatches.status, 'complete');
  assert.deepEqual(noMatches.findings, []);
  const truncated = analyzeDeprecatedApis({ identity, references: [], sourceComplete: false });
  assert.equal(truncated.status, 'partial');
  assert.equal(truncated.unavailableReason, 'project-source-scan-truncated');
});

test('source coverage reasons survive medium and deep phases without losing findings or export limitations', async () => {
  const project = { scripts: {}, declaredDependencies: {}, projectNodeRange: null, imports: [reference('next/legacy/image')], ruleFiles: [], scannedFileCount: 1, truncated: true, scanLimitations: ['project-import-reference-limit'], evidenceFingerprint: 'fixture' };
  const medium = await analyzeProjectCompatibilityMedium({ identity, project, toolingPackages: [], toolingMetadataIncomplete: false });
  assert.equal(medium.analyzers.find(entry => entry.analyzerId === 'deprecated-api-compatibility').unavailableReason, 'project-import-reference-limit');
  assert.equal(medium.analyzers.find(entry => entry.analyzerId === 'project-source-scan').unavailableReason, 'project-import-reference-limit');
  for (const conditional of [false, true]) {
    const deep = await appendProjectCompatibilityImportAnalysis({ analysis: medium, project, targetSurface: {
      packageName: 'next', version: identity.targetVersion,
      exports: conditional ? { status: 'known', subpaths: [], conditionalSubpaths: ['./legacy/image'] } : { status: 'known', subpaths: ['./legacy/image'] },
    } });
    const imports = deep.analyzers.find(entry => entry.analyzerId === 'import-compatibility');
    assert.equal(imports.status, 'partial');
    assert.match(imports.unavailableReason, /project-import-reference-limit/);
    if (conditional) assert.match(imports.unavailableReason, /conditional-exports-unresolved/);
    assert.equal(deep.findings.length, medium.findings.length);
  }
});

test('coverage messages are actionable, deduplicated and never echo raw failures', () => {
  const messages = projectCompatibilityLimitations('project-node-range-missing|runtime-node-version-unknown|project-node-range-missing', 'partial');
  assert.equal(messages.length, 2);
  assert.match(messages[0].reason, /engines.node/);
  assert.match(messages[1].nextStep, /Refresh alone cannot/);
  const unknown = JSON.stringify(projectCompatibilityLimitations('failed: /private/secrets auth=token', 'unavailable'));
  assert.doesNotMatch(unknown, /private|secrets|auth|token/);
  assert.match(unknown, /Next|nextStep/);
  assert.match(projectCompatibilityLimitations('runtime-node-version-unknown', 'cancelled')[0].reason, /cancelled/);
  assert.match(projectCompatibilityLimitations('__proto__', 'unavailable')[0].reason, /could not verify/);
});
