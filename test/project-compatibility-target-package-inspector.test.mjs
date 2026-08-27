import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TargetPackageInspector,
  TargetPackageSurfaceCache,
  buildTargetPackagePackArgs,
  parseTargetPackagePackOutput,
} from '../out/host/projectCompatibility/targetPackageInspector.js';

test('target surface cache reuses exactly one target identity and deterministically evicts the previous one', () => {
  const cache = new TargetPackageSurfaceCache();
  const first = { packageName: 'next', version: '15.5.24', files: ['dist/index.js'] };
  const second = { packageName: 'react', version: '19.1.1', files: ['index.js'] };
  assert.equal(cache.get('registry:next:15.5.24'), undefined);
  cache.set('registry:next:15.5.24', first);
  assert.equal(cache.get('registry:next:15.5.24'), first, 'same exact target is a cache hit');
  assert.equal(cache.get('registry:next:15.5.23'), undefined, 'a different target cannot reuse the inventory');
  cache.set('registry:react:19.1.1', second);
  assert.equal(cache.get('registry:next:15.5.24'), undefined, 'the one-entry cache evicts the previous target');
  assert.equal(cache.get('registry:react:19.1.1'), second);
});

test('target package pack arguments are fixed, script-free, and exact-version scoped', () => {
  assert.deepEqual(
    buildTargetPackagePackArgs({
      packageName: '@scope/pkg',
      version: '2.3.4',
      registry: 'https://registry.example.test/npm',
      destination: '/safe/temp',
    }),
    [
      'pack',
      '@scope/pkg@2.3.4',
      '--json',
      '--ignore-scripts',
      '--pack-destination',
      '/safe/temp',
      '--registry=https://registry.example.test/npm',
    ]
  );
});

test('target package inventory validates identity and normalizes safe paths', () => {
  const surface = parseTargetPackagePackOutput(
    JSON.stringify([
      {
        name: 'next',
        version: '15.5.24',
        files: [
          { path: 'dist/client/public.js' },
          { path: './dist/client/public.js' },
          { path: 'dist\\private\\internal.js' },
          { path: '../escape.js' },
        ],
      },
    ]),
    { packageName: 'next', version: '15.5.24' }
  );
  assert.deepEqual(surface.files, ['dist/client/public.js', 'dist/private/internal.js']);
});

test('target package inspector always cleans up and rejects a failed pack', async () => {
  let invoked = false;
  const inspector = new TargetPackageInspector(
    { executable: '/node', prefixArgs: ['/npm-cli.js'], version: '10.0.0' },
    'https://registry.npmjs.org/',
    {
      async run(_invocation, args, cwd) {
        invoked = true;
        assert.equal(args[0], 'pack');
        assert.match(cwd, /dependency-dashboard-target-package-/);
        return { exitCode: 1, stdout: '', stderr: 'failure' };
      },
    }
  );
  await assert.rejects(() => inspector.inspect('next', '15.5.24'), /could not be materialized/);
  assert.equal(invoked, true);
});

test('target package inspection propagates cancellation to in-flight materialization', async () => {
  let observedSignal;
  const inspector = new TargetPackageInspector(
    { executable: '/node', prefixArgs: ['/npm-cli.js'], version: '10.0.0' },
    'https://registry.npmjs.org/',
    {
      async run(_invocation, _args, _cwd, signal) {
        observedSignal = signal;
        await new Promise((resolve, reject) => {
          const abort = () => {
            const error = new Error('cancelled');
            error.name = 'AbortError';
            reject(error);
          };
          if (signal?.aborted) abort();
          else signal?.addEventListener('abort', abort, { once: true });
        });
      },
    }
  );
  const controller = new AbortController();
  const pending = inspector.inspect('next', '15.5.24', controller.signal);
  controller.abort();
  await assert.rejects(pending, (error) => error?.name === 'AbortError');
  assert.equal(observedSignal, controller.signal);
  assert.equal(observedSignal.aborted, true);
});

test('target package inventory rejects mismatched published identity', () => {
  assert.throws(
    () =>
      parseTargetPackagePackOutput(
        JSON.stringify([{ name: 'other', version: '1.0.0', files: [] }]),
        { packageName: 'next', version: '15.5.24' }
      ),
    /identity did not match/
  );
});
