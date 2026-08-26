import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { inspectAppliedUpgradeState } from '../out/core/upgrade/appliedState.js';

const here = dirname(fileURLToPath(import.meta.url));

test('npm local state confirms the exact requested direct version and returns fresh declaration facts', () => {
  const state = inspectAppliedUpgradeState(
    {
      root: '/workspace',
      packageManager: 'npm',
      importerId: '.',
      manifestText: JSON.stringify({ dependencies: { react: '^19.0.0' } }),
      lockfileText: JSON.stringify({
        lockfileVersion: 3,
        packages: { '': { dependencies: { react: '^19.0.0' } }, 'node_modules/react': { version: '19.0.0' } },
      }),
    },
    [{ packageName: 'react', currentVersion: '18.3.1', targetVersion: '19.0.0', classification: 'prod' }]
  );

  assert.equal(state.confirmed, true);
  assert.deepEqual(state.changes, [{
    packageName: 'react',
    previousVersion: '18.3.1',
    requestedVersion: '19.0.0',
    currentVersion: '19.0.0',
    declaredRange: '^19.0.0',
    classification: 'prod',
  }]);
});

test('successful command with a mismatched resolved version remains unconfirmed', () => {
  const state = inspectAppliedUpgradeState(
    {
      root: '/workspace',
      packageManager: 'npm',
      importerId: '.',
      manifestText: JSON.stringify({ devDependencies: { typescript: '^5.5.0' } }),
      lockfileText: JSON.stringify({
        lockfileVersion: 3,
        packages: { '': { devDependencies: { typescript: '^5.5.0' } }, 'node_modules/typescript': { version: '5.4.5' } },
      }),
    },
    [{ packageName: 'typescript', currentVersion: '5.4.5', targetVersion: '5.5.0', classification: 'dev' }]
  );

  assert.equal(state.confirmed, false);
  assert.equal(state.changes[0].currentVersion, '5.4.5');
  assert.equal(state.changes[0].classification, 'dev');
});

test('stale manifest range cannot confirm an exact newer lockfile resolution', () => {
  const state = inspectAppliedUpgradeState(
    {
      root: '/workspace',
      packageManager: 'npm',
      importerId: '.',
      manifestText: JSON.stringify({ dependencies: { react: '^18.0.0' } }),
      lockfileText: JSON.stringify({
        lockfileVersion: 3,
        packages: { '': { dependencies: { react: '^18.0.0' } }, 'node_modules/react': { version: '19.0.0' } },
      }),
    },
    [{ packageName: 'react', currentVersion: '18.3.1', targetVersion: '19.0.0', classification: 'prod' }]
  );

  assert.equal(state.confirmed, false);
  assert.equal(state.changes[0].currentVersion, '19.0.0');
  assert.equal(state.changes[0].declaredRange, '^18.0.0');
});

test('an orphan npm node cannot confirm without selected-importer direct declaration evidence', () => {
  const state = inspectAppliedUpgradeState(
    {
      root: '/workspace',
      packageManager: 'npm',
      importerId: '.',
      manifestText: JSON.stringify({ dependencies: { react: '^19.0.0' } }),
      lockfileText: JSON.stringify({
        lockfileVersion: 3,
        packages: { '': { dependencies: {} }, 'node_modules/react': { version: '19.0.0' } },
      }),
    },
    [{ packageName: 'react', currentVersion: '18.3.1', targetVersion: '19.0.0', classification: 'prod' }]
  );

  assert.equal(state.confirmed, false);
  assert.equal(state.changes[0].currentVersion, '19.0.0', 'the orphan is still a useful local display fact');
});

test('a stale npm importer range cannot vouch for an otherwise exact target node', () => {
  const state = inspectAppliedUpgradeState(
    {
      root: '/workspace',
      packageManager: 'npm',
      importerId: '.',
      manifestText: JSON.stringify({ dependencies: { react: '^19.0.0' } }),
      lockfileText: JSON.stringify({
        lockfileVersion: 3,
        packages: { '': { dependencies: { react: '^18.0.0' } }, 'node_modules/react': { version: '19.0.0' } },
      }),
    },
    [{ packageName: 'react', currentVersion: '18.3.1', targetVersion: '19.0.0', classification: 'prod' }]
  );

  assert.equal(state.confirmed, false);
});

test('npm workspace importer evidence is read from the selected importer entry', () => {
  const state = inspectAppliedUpgradeState(
    {
      root: '/workspace/packages/app',
      packageManager: 'npm',
      importerId: 'packages/app',
      manifestText: JSON.stringify({ dependencies: { react: '^19.0.0' } }),
      lockfileText: JSON.stringify({
        lockfileVersion: 3,
        packages: {
          '': { dependencies: {} },
          'packages/app': { dependencies: { react: '^19.0.0' } },
          'node_modules/react': { version: '19.0.0' },
        },
      }),
    },
    [{ packageName: 'react', currentVersion: '18.3.1', targetVersion: '19.0.0', classification: 'prod' }]
  );

  assert.equal(state.confirmed, true);
});

test('npm v1 fails closed when asked to confirm a non-root workspace importer', () => {
  const state = inspectAppliedUpgradeState(
    {
      root: '/workspace/packages/app',
      packageManager: 'npm',
      importerId: 'packages/app',
      manifestText: JSON.stringify({ dependencies: { react: '^19.0.0' } }),
      lockfileText: JSON.stringify({
        lockfileVersion: 1,
        dependencies: { react: { version: '19.0.0' } },
      }),
    },
    [{ packageName: 'react', currentVersion: '18.3.1', targetVersion: '19.0.0', classification: 'prod' }]
  );

  assert.equal(state.confirmed, false);
  assert.equal(state.changes[0].currentVersion, null);
});

test('npm workspace resolution prefers the selected importer local node_modules entry', () => {
  const state = inspectAppliedUpgradeState(
    {
      root: '/workspace/packages/app',
      packageManager: 'npm',
      importerId: 'packages/app',
      manifestText: JSON.stringify({ dependencies: { react: '^19.0.0' } }),
      lockfileText: JSON.stringify({
        lockfileVersion: 3,
        packages: {
          '': {},
          'packages/app': { dependencies: { react: '^19.0.0' } },
          'packages/app/node_modules/react': { version: '19.0.0' },
          'node_modules/react': { version: '18.3.1' },
        },
      }),
    },
    [{ packageName: 'react', currentVersion: '18.3.1', targetVersion: '19.0.0', classification: 'prod' }]
  );

  assert.equal(state.confirmed, true);
  assert.equal(state.changes[0].currentVersion, '19.0.0');
});

test('npm workspace resolution walks ancestor hoist locations before the lock root', () => {
  const state = inspectAppliedUpgradeState(
    {
      root: '/workspace/packages/apps/app',
      packageManager: 'npm',
      importerId: 'packages/apps/app',
      manifestText: JSON.stringify({ dependencies: { react: '^19.0.0' } }),
      lockfileText: JSON.stringify({
        lockfileVersion: 3,
        packages: {
          '': {},
          'packages/apps/app': { dependencies: { react: '^19.0.0' } },
          'packages/node_modules/react': { version: '19.0.0' },
          'node_modules/react': { version: '18.3.1' },
        },
      }),
    },
    [{ packageName: 'react', currentVersion: '18.3.1', targetVersion: '19.0.0', classification: 'prod' }]
  );

  assert.equal(state.confirmed, true);
  assert.equal(state.changes[0].currentVersion, '19.0.0');
});

test('a nearer npm workspace resolution shadows a matching root hoist', () => {
  const state = inspectAppliedUpgradeState(
    {
      root: '/workspace/packages/app',
      packageManager: 'npm',
      importerId: 'packages/app',
      manifestText: JSON.stringify({ dependencies: { react: '^19.0.0' } }),
      lockfileText: JSON.stringify({
        lockfileVersion: 3,
        packages: {
          '': {},
          'packages/app': { dependencies: { react: '^19.0.0' } },
          'packages/app/node_modules/react': { version: '18.3.1' },
          'node_modules/react': { version: '19.0.0' },
        },
      }),
    },
    [{ packageName: 'react', currentVersion: '18.3.1', targetVersion: '19.0.0', classification: 'prod' }]
  );

  assert.equal(state.confirmed, false);
  assert.equal(state.changes[0].currentVersion, '18.3.1');
});

test('pnpm importer evidence must use the expected direct dependency classification', () => {
  const state = inspectAppliedUpgradeState(
    {
      root: '/workspace',
      packageManager: 'pnpm',
      importerId: '.',
      manifestText: JSON.stringify({ dependencies: { react: '^19.0.0' } }),
      lockfileText: [
        "lockfileVersion: '9.0'",
        'importers:',
        '  .:',
        '    devDependencies:',
        '      react:',
        '        specifier: ^19.0.0',
        '        version: 19.0.0',
        'packages:',
        '  react@19.0.0: {}',
        'snapshots:',
        '  react@19.0.0: {}',
      ].join('\n'),
    },
    [{ packageName: 'react', currentVersion: '18.3.1', targetVersion: '19.0.0', classification: 'prod' }]
  );

  assert.equal(state.confirmed, false);
  assert.equal(state.changes[0].currentVersion, '19.0.0');
});

test('missing and unsuitable declarations cannot confirm an exact lockfile resolution', () => {
  for (const declaration of [
    undefined,
    null,
    19,
    '',
    'latest',
    'not a range',
    'npm:preact@^10.0.0',
    'workspace:^19.0.0',
    'link:../react',
    'file:../react',
    'git+https://example.test/react.git',
    'https://example.test/react.tgz',
  ]) {
    const dependencies = declaration === undefined ? {} : { react: declaration };
    const state = inspectAppliedUpgradeState(
      {
        root: '/workspace',
        packageManager: 'npm',
        importerId: '.',
        manifestText: JSON.stringify({ dependencies }),
        lockfileText: JSON.stringify({
          lockfileVersion: 3,
          packages: { '': { dependencies }, 'node_modules/react': { version: '19.0.0' } },
        }),
      },
      [{ packageName: 'react', currentVersion: '18.3.1', targetVersion: '19.0.0', classification: 'prod' }]
    );

    assert.equal(state.confirmed, false, `declaration ${String(declaration)} must not confirm`);
  }
});

test('a suitable exact manifest declaration cannot confirm without an active lockfile resolution', () => {
  const state = inspectAppliedUpgradeState(
    {
      root: '/workspace',
      packageManager: 'npm',
      importerId: '.',
      manifestText: JSON.stringify({ dependencies: { react: '^19.0.0' } }),
      lockfileText: null,
    },
    [{ packageName: 'react', currentVersion: '18.3.1', targetVersion: '19.0.0', classification: 'prod' }]
  );

  assert.equal(state.confirmed, false);
  assert.equal(state.changes[0].currentVersion, null);
});

test('a declaration in the wrong classification cannot confirm an exact lockfile resolution', () => {
  const state = inspectAppliedUpgradeState(
    {
      root: '/workspace',
      packageManager: 'npm',
      importerId: '.',
      manifestText: JSON.stringify({ devDependencies: { react: '^19.0.0' } }),
      lockfileText: JSON.stringify({
        lockfileVersion: 3,
        packages: { '': { devDependencies: { react: '^19.0.0' } }, 'node_modules/react': { version: '19.0.0' } },
      }),
    },
    [{ packageName: 'react', currentVersion: '18.3.1', targetVersion: '19.0.0', classification: 'prod' }]
  );

  assert.equal(state.confirmed, false);
  assert.equal(state.changes[0].classification, 'dev');
});

test('pnpm local state uses the active importer and confirms optional dependency classification', () => {
  const state = inspectAppliedUpgradeState(
    {
      root: '/workspace',
      packageManager: 'pnpm',
      importerId: '.',
      manifestText: JSON.stringify({ optionalDependencies: { 'optional-root': '^2.0.0' } }),
      lockfileText: readFileSync(join(here, 'fixtures', 'pnpm-lock-v9.yaml'), 'utf8'),
    },
    [{ packageName: 'optional-root', currentVersion: '1.0.0', targetVersion: '2.0.0', classification: 'optional' }]
  );

  assert.equal(state.confirmed, true);
  assert.equal(state.changes[0].currentVersion, '2.0.0');
  assert.equal(state.changes[0].classification, 'optional');
});

test('every coordinated change must be confirmed', () => {
  const state = inspectAppliedUpgradeState(
    {
      root: '/workspace',
      packageManager: 'npm',
      importerId: '.',
      manifestText: JSON.stringify({ dependencies: { react: '^19.0.0', scheduler: '^0.24.0' } }),
      lockfileText: JSON.stringify({
        lockfileVersion: 3,
        packages: {
          '': { dependencies: { react: '^19.0.0', scheduler: '^0.24.0' } },
          'node_modules/react': { version: '19.0.0' },
          'node_modules/scheduler': { version: '0.23.0' },
        },
      }),
    },
    [
      { packageName: 'react', currentVersion: '18.3.1', targetVersion: '19.0.0', classification: 'prod' },
      { packageName: 'scheduler', currentVersion: '0.23.0', targetVersion: '0.24.0', classification: 'prod' },
    ]
  );

  assert.equal(state.confirmed, false);
});
