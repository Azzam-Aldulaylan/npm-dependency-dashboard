import assert from 'node:assert/strict';
import test from 'node:test';

import { pnpmInvocationCandidates, resolvePnpmInvocation } from '../out/host/pnpmResolver.js';

const npm = { node: '/trusted/node', npmCliJs: '/trusted/lib/node_modules/npm/bin/npm-cli.js' };

test('pnpm candidates are installation-owned JS entry points, never pnpm or pnpm.cmd shims', () => {
  assert.deepEqual(pnpmInvocationCandidates(npm), [
    { executable: '/trusted/node', prefixArgs: ['/trusted/lib/node_modules/pnpm/bin/pnpm.cjs'] },
    { executable: '/trusted/node', prefixArgs: ['/trusted/lib/node_modules/corepack/dist/corepack.js', 'pnpm'] },
    { executable: '/trusted/node', prefixArgs: ['/trusted/lib/node_modules/corepack/dist/corepack.cjs', 'pnpm'] },
  ]);
});

test('resolver validates candidates and can fall through to Corepack', () => {
  const probed = [];
  const result = resolvePnpmInvocation(npm, {
    exists: (candidate) => candidate.includes('pnpm.cjs') || candidate.endsWith('corepack.js'),
    probe: (_node, prefix) => {
      probed.push(prefix);
      return prefix[0].endsWith('corepack.js');
    },
  });
  assert.equal(result.prefixArgs.at(-1), 'pnpm');
  assert.equal(probed.length, 2);
});

test('missing or broken pnpm never falls back to a shell command', () => {
  assert.equal(resolvePnpmInvocation(npm, { exists: () => true, probe: () => false }), null);
});
