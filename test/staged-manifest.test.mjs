import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildStagedManifest, buildStagedManifestForRemoval, StagedManifestError } from '../out/core/upgrade/stagedManifest.js';

test('mixed classifications are updated in place with exact versions', () => {
  const source = JSON.stringify({
    name: 'fixture',
    dependencies: { react: '^18.0.0', untouched: '^1.0.0' },
    devDependencies: { typescript: '~5.0.0' },
    optionalDependencies: { fsevents: '^2.0.0' },
  }, null, 2) + '\n';

  const staged = buildStagedManifest(source, [
    { packageName: 'react', target: '19.0.0', classification: 'prod' },
    { packageName: 'typescript', target: '6.0.0', classification: 'dev' },
    { packageName: 'fsevents', target: '3.0.0', classification: 'optional' },
  ]);
  const parsed = JSON.parse(staged);

  assert.equal(parsed.dependencies.react, '19.0.0');
  assert.equal(parsed.devDependencies.typescript, '6.0.0');
  assert.equal(parsed.optionalDependencies.fsevents, '3.0.0');
  assert.equal(parsed.dependencies.untouched, '^1.0.0');
  assert.ok(staged.endsWith('\n'));
  assert.match(staged, /\n  "dependencies"/);
});

test('minified and CRLF manifests retain their broad formatting convention', () => {
  assert.equal(
    buildStagedManifest('{"dependencies":{"react":"^18"}}', [
      { packageName: 'react', target: '19.0.0', classification: 'prod' },
    ]),
    '{"dependencies":{"react":"19.0.0"}}'
  );

  const crlf = '{\r\n\t"devDependencies": {\r\n\t\t"typescript": "^5"\r\n\t}\r\n}\r\n';
  const staged = buildStagedManifest(crlf, [
    { packageName: 'typescript', target: '6.0.0', classification: 'dev' },
  ]);
  assert.equal(staged.includes('\n') && !staged.includes('\r\n'), false);
  assert.ok(staged.endsWith('\r\n'));
  assert.match(staged, /\r\n\t"devDependencies"/);
});

test('missing, misclassified, and duplicate changes are rejected', () => {
  const source = JSON.stringify({
    dependencies: { react: '^18', duplicate: '^1' },
    devDependencies: { typescript: '^5', duplicate: '^1' },
  });

  const cases = [
    {
      code: 'MISSING_DECLARATION',
      changes: [{ packageName: 'missing', target: '1.0.0', classification: 'prod' }],
    },
    {
      code: 'MISSING_DECLARATION',
      changes: [{ packageName: 'react', target: '19.0.0', classification: 'dev' }],
    },
    {
      code: 'DUPLICATE_CHANGE',
      changes: [
        { packageName: 'react', target: '19.0.0', classification: 'prod' },
        { packageName: 'react', target: '19.1.0', classification: 'prod' },
      ],
    },
  ];

  for (const fixture of cases) {
    assert.throws(
      () => buildStagedManifest(source, fixture.changes),
      (error) => error instanceof StagedManifestError && error.code === fixture.code
    );
  }
});

test('only the authoritative classified block changes when a declaration is shadowed', () => {
  const staged = JSON.parse(buildStagedManifest(JSON.stringify({
    dependencies: { shared: '^2.0.0' },
    devDependencies: { shared: '^1.0.0', optional: '^1.0.0' },
    optionalDependencies: { optional: '^2.0.0' },
  }), [
    { packageName: 'shared', target: '3.0.0', classification: 'prod' },
    { packageName: 'optional', target: '3.0.0', classification: 'optional' },
  ]));

  assert.equal(staged.dependencies.shared, '3.0.0');
  assert.equal(staged.devDependencies.shared, '^1.0.0');
  assert.equal(staged.optionalDependencies.optional, '3.0.0');
  assert.equal(staged.devDependencies.optional, '^1.0.0');
});

test('unsafe identifiers, non-exact versions, malformed blocks, and prototype keys are rejected', () => {
  for (const change of [
    { packageName: 'react;echo injected', target: '19.0.0', classification: 'prod' },
    { packageName: 'react', target: '^19.0.0', classification: 'prod' },
    { packageName: '__proto__', target: '1.0.0', classification: 'prod' },
  ]) {
    assert.throws(
      () => buildStagedManifest('{"dependencies":{"react":"^18","__proto__":"^1"}}', [change]),
      (error) => error instanceof StagedManifestError && error.code === 'INVALID_CHANGE'
    );
  }

  assert.throws(
    () => buildStagedManifest('{"dependencies":[]}', [
      { packageName: 'react', target: '19.0.0', classification: 'prod' },
    ]),
    (error) => error instanceof StagedManifestError && error.code === 'INVALID_MANIFEST'
  );
});

test('buildStagedManifestForRemoval deletes the removed keys and leaves every sibling untouched', () => {
  const source = JSON.stringify({
    name: 'fixture',
    dependencies: { react: '^18.0.0', untouched: '^1.0.0' },
    devDependencies: { typescript: '~5.0.0' },
    optionalDependencies: { fsevents: '^2.0.0' },
  }, null, 2) + '\n';

  const staged = JSON.parse(buildStagedManifestForRemoval(source, [
    { packageName: 'react', classification: 'prod' },
    { packageName: 'typescript', classification: 'dev' },
    { packageName: 'fsevents', classification: 'optional' },
  ]));

  assert.equal(Object.hasOwn(staged.dependencies, 'react'), false);
  assert.equal(Object.hasOwn(staged.devDependencies, 'typescript'), false);
  assert.equal(Object.hasOwn(staged.optionalDependencies, 'fsevents'), false);
  assert.equal(staged.dependencies.untouched, '^1.0.0');
});

test('buildStagedManifestForRemoval preserves formatting the same way buildStagedManifest does', () => {
  assert.equal(
    buildStagedManifestForRemoval('{"dependencies":{"react":"^18","untouched":"^1"}}', [
      { packageName: 'react', classification: 'prod' },
    ]),
    '{"dependencies":{"untouched":"^1"}}'
  );
});

test('buildStagedManifestForRemoval rejects missing, misclassified, duplicate, and unsafe removals', () => {
  const source = JSON.stringify({
    dependencies: { react: '^18', duplicate: '^1' },
    devDependencies: { typescript: '^5', duplicate: '^1' },
  });

  const cases = [
    { code: 'MISSING_DECLARATION', removals: [{ packageName: 'missing', classification: 'prod' }] },
    { code: 'MISSING_DECLARATION', removals: [{ packageName: 'react', classification: 'dev' }] },
    {
      code: 'DUPLICATE_CHANGE',
      removals: [
        { packageName: 'react', classification: 'prod' },
        { packageName: 'react', classification: 'prod' },
      ],
    },
    { code: 'INVALID_CHANGE', removals: [{ packageName: 'react;echo injected', classification: 'prod' }] },
    { code: 'INVALID_CHANGE', removals: [{ packageName: '__proto__', classification: 'prod' }] },
  ];

  for (const fixture of cases) {
    assert.throws(
      () => buildStagedManifestForRemoval(source, fixture.removals),
      (error) => error instanceof StagedManifestError && error.code === fixture.code
    );
  }

  assert.throws(
    () => buildStagedManifestForRemoval(source, []),
    (error) => error instanceof StagedManifestError && error.code === 'INVALID_CHANGE'
  );
});
