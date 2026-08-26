import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  analyzeNextProjectCompatibility,
  runNextProjectCompatibilityRules,
} from '../out/core/projectCompatibility/rules/next/index.js';

const fixtureRoot = path.resolve('test/fixtures/project-compatibility-next15');
const identity = (overrides = {}) => ({
  packageName: 'next',
  currentVersion: '14.2.35',
  targetVersion: '15.5.24',
  requestId: 'request-next-15',
  sourceFingerprint: 'source-next-15',
  ...overrides,
});

const input = (overrides = {}) => ({
  identity: identity(),
  files: [],
  scripts: {},
  declaredDependencies: {},
  ...overrides,
});

test('the Next 14 to 15 fixture finds only evidence-backed framework migrations', async () => {
  const manifest = JSON.parse(await readFile(path.join(fixtureRoot, 'package.json'), 'utf8'));
  const filePaths = [
    'next.config.mjs',
    'app/users/[id]/page.tsx',
    'app/safe/[id]/page.tsx',
    'tsconfig.json',
    'src/components/UserSelector.tsx',
  ];
  const files = await Promise.all(filePaths.map(async (filePath) => ({
    filePath,
    content: await readFile(path.join(fixtureRoot, filePath), 'utf8'),
    usageId: 'usage-next-fixture',
    referenceIndex: filePaths.indexOf(filePath),
  })));

  const findings = runNextProjectCompatibilityRules(input({
    files,
    scripts: manifest.scripts,
    declaredDependencies: { ...manifest.dependencies, ...manifest.devDependencies },
  }));

  assert.deepEqual(findings.map((finding) => finding.ruleId).sort(), [
    'next-15-5-next-lint-deprecation',
    'next-15-async-route-params',
    'next-15-server-external-packages-rename',
    'next-eslint-config-major-alignment',
  ]);
  assert.equal(findings.some((finding) => finding.category === 'compiler'), false,
    'ES2017 syntax support is not evidence of a Next 15 TypeScript target requirement');
  assert.equal(findings.some((finding) => finding.category === 'import'), false,
    'target package-surface resolution belongs to the generic import analyzer');
});

test('the config rename is target-gated, supports real property keys, and ignores comments/strings', () => {
  const affected = {
    filePath: 'next.config.ts',
    content: `export default { experimental: { serverComponentsExternalPackages: ['sharp'] } }`,
  };
  const quoted = {
    filePath: 'next.config.js',
    content: `module.exports = { experimental: { 'serverComponentsExternalPackages': ['sharp'] } }`,
  };
  const commented = {
    filePath: 'next.config.mjs',
    content: `// serverComponentsExternalPackages: ['sharp']\nexport default { serverExternalPackages: ['sharp'] }`,
  };
  const stringOnly = {
    filePath: 'next.config.mjs',
    content: "const note = `serverComponentsExternalPackages: is old`; export default {};",
  };
  const unrelatedObject = {
    filePath: 'next.config.mjs',
    content: `const documentationExample = { experimental: { serverComponentsExternalPackages: ['sharp'] } };\nexport default { reactStrictMode: true };`,
  };
  const namedConfig = {
    filePath: 'next.config.mjs',
    content: `const nextConfig = { experimental: { serverComponentsExternalPackages: ['sharp'] } };\nexport default nextConfig;`,
  };
  const nestedMethodExample = {
    filePath: 'next.config.mjs',
    content: `export default { webpack() { const example = { serverComponentsExternalPackages: ['sharp'] }; return {}; } };`,
  };

  assert.equal(runNextProjectCompatibilityRules(input({ files: [affected] }))
    .filter((finding) => finding.ruleId === 'next-15-server-external-packages-rename').length, 1);
  assert.equal(runNextProjectCompatibilityRules(input({ files: [quoted] }))
    .filter((finding) => finding.ruleId === 'next-15-server-external-packages-rename').length, 1);
  assert.equal(runNextProjectCompatibilityRules(input({ files: [commented] }))
    .filter((finding) => finding.ruleId === 'next-15-server-external-packages-rename').length, 0);
  assert.equal(runNextProjectCompatibilityRules(input({ files: [stringOnly] }))
    .filter((finding) => finding.ruleId === 'next-15-server-external-packages-rename').length, 0);
  assert.equal(runNextProjectCompatibilityRules(input({ files: [unrelatedObject] }))
    .filter((finding) => finding.ruleId === 'next-15-server-external-packages-rename').length, 0,
  'an example object that is not exported is not project configuration evidence');
  assert.equal(runNextProjectCompatibilityRules(input({ files: [namedConfig] }))
    .filter((finding) => finding.ruleId === 'next-15-server-external-packages-rename').length, 1);
  assert.equal(runNextProjectCompatibilityRules(input({ files: [nestedMethodExample] }))
    .filter((finding) => finding.ruleId === 'next-15-server-external-packages-rename').length, 0,
  'a nested migration example inside an exported config method is not a config property');
  assert.equal(runNextProjectCompatibilityRules(input({
    identity: identity({ targetVersion: '14.2.36' }),
    files: [affected],
  })).length, 0);
});

test('next lint is labeled deprecated for 15.5, not falsely removed', () => {
  const findings = runNextProjectCompatibilityRules(input({
    scripts: {
      lint: 'NODE_ENV=test next lint --dir src && echo done',
      quoted: `echo "next lint"`,
      unrelated: 'next build',
    },
  })).filter((finding) => finding.ruleId === 'next-15-5-next-lint-deprecation');

  assert.equal(findings.length, 1);
  assert.equal(findings[0].confidence, 'likely');
  assert.match(findings[0].explanation, /still runs/i);
  assert.match(findings[0].explanation, /removed in Next\.js 16/i);

  assert.equal(runNextProjectCompatibilityRules(input({
    identity: identity({ targetVersion: '15.4.9' }),
    scripts: { lint: 'next lint' },
  })).some((finding) => finding.ruleId === 'next-15-5-next-lint-deprecation'), false);
});

test('only narrow synchronous App Router params usage produces a migration finding', () => {
  const files = [
    {
      filePath: 'app/blog/[slug]/page.tsx',
      content: `export default function Page({ params }) { return <p>{params.slug}</p> }`,
    },
    {
      filePath: 'app/safe/[slug]/page.tsx',
      content: `export default async function Page({ params }) { const { slug } = await params; return <p>{slug}</p> }`,
    },
    {
      filePath: 'components/card.tsx',
      content: `export function Card({ params }) { return <p>{params.slug}</p> }`,
    },
    {
      filePath: 'app/client/page.tsx',
      content: `'use client'; import { useParams } from 'next/navigation'; export default function Page() { const params = useParams(); return <p>{params.slug}</p> }`,
    },
    {
      filePath: 'app/unrelated/page.tsx',
      content: `export default function Page() { const params = getTelemetryParams(); return <p>{params.slug}</p> }`,
    },
    {
      filePath: 'app/string-only/[slug]/page.tsx',
      content: 'export default function Page({ params }) { const note = `params.slug`; return <p>ok</p> }',
    },
  ];

  const findings = runNextProjectCompatibilityRules(input({ files }))
    .filter((finding) => finding.ruleId === 'next-15-async-route-params');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].confidence, 'likely');
  assert.match(findings[0].explanation, /temporarily supported/i);
  assert.equal(findings[0].evidence[0].filePath, 'app/blog/[slug]/page.tsx');
});

test('eslint-config-next is compared against the selected target without requiring exact equality', () => {
  const mismatched = runNextProjectCompatibilityRules(input({
    declaredDependencies: { 'eslint-config-next': '^14.2.0' },
  })).filter((finding) => finding.ruleId === 'next-eslint-config-major-alignment');
  assert.equal(mismatched.length, 1);
  assert.equal(mismatched[0].confidence, 'likely');

  assert.equal(runNextProjectCompatibilityRules(input({
    declaredDependencies: { 'eslint-config-next': '^15.0.0' },
  })).some((finding) => finding.ruleId === 'next-eslint-config-major-alignment'), false);
  assert.equal(runNextProjectCompatibilityRules(input({
    declaredDependencies: { 'eslint-config-next': 'latest' },
  })).some((finding) => finding.ruleId === 'next-eslint-config-major-alignment'), false,
  'tags are unknown rather than forced into a mismatch');
});

test('analyzer cancellation and non-Next packages return deterministic empty outcomes', () => {
  const controller = new AbortController();
  controller.abort();
  assert.equal(analyzeNextProjectCompatibility(input(), controller.signal).status, 'cancelled');

  const result = analyzeNextProjectCompatibility(input({
    identity: identity({ packageName: 'react' }),
    scripts: { lint: 'next lint' },
  }));
  assert.deepEqual(result, {
    analyzerId: 'next-migration-rules',
    status: 'complete',
    findings: [],
  });
});
