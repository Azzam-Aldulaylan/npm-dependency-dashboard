import assert from 'node:assert/strict';
import test from 'node:test';

import { buildVerificationScriptArgs, selectVerificationScripts } from '../out/host/verificationPolicy.js';

test('only explicitly configured scripts that exist in the host-read manifest are selected', () => {
  const manifest = JSON.stringify({ scripts: { test: 'node --test', build: 'tsc', inherited: 12 } });
  assert.deepEqual(selectVerificationScripts(manifest, ['test', 'missing', 'build', 'test', 'inherited']), [
    { id: 'package-script:test', scriptName: 'test' },
    { id: 'package-script:build', scriptName: 'build' },
  ]);
});

test('unsafe, malformed, and prototype-related script names are rejected', () => {
  const manifest = JSON.stringify({ scripts: { '-x': 'bad', 'a b': 'bad', ok: 'true' } });
  assert.deepEqual(selectVerificationScripts(manifest, ['-x', 'a b', '__proto__', 'ok']), [
    { id: 'package-script:ok', scriptName: 'ok' },
  ]);
});

test('malformed manifests select no verification work', () => {
  assert.deepEqual(selectVerificationScripts('{', ['test']), []);
  assert.deepEqual(selectVerificationScripts(JSON.stringify({ scripts: [] }), ['test']), []);
});

test('verification argv is structured per package manager', () => {
  assert.deepEqual(buildVerificationScriptArgs('npm', 'typecheck'), ['run-script', 'typecheck']);
  assert.deepEqual(buildVerificationScriptArgs('pnpm', 'typecheck'), ['run', 'typecheck']);
  assert.throws(() => buildVerificationScriptArgs('npm', '--help'), /Unsafe/);
});
