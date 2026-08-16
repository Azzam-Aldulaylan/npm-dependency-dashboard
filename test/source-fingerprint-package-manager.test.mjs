import assert from 'node:assert/strict';
import test from 'node:test';

import { computeSourceFingerprint, sourceFingerprintsMatch } from '../out/core/cache/sourceFingerprint.js';

const base = { manifestText: '{}', lockfileText: 'same text', lockfilePath: '/repo/lock' };

test('project fingerprints distinguish package managers and pnpm importers', () => {
  const npm = computeSourceFingerprint({ ...base, packageManager: 'npm', importerId: '.' });
  const pnpmRoot = computeSourceFingerprint({ ...base, packageManager: 'pnpm', importerId: '.' });
  const pnpmMember = computeSourceFingerprint({ ...base, packageManager: 'pnpm', importerId: 'packages/app' });
  assert.equal(sourceFingerprintsMatch(npm, pnpmRoot), false);
  assert.equal(sourceFingerprintsMatch(pnpmRoot, pnpmMember), false);
  assert.equal(sourceFingerprintsMatch(pnpmMember, { ...pnpmMember }), true);
});

test('legacy npm fingerprints without manager fields retain npm compatibility', () => {
  const current = computeSourceFingerprint({ ...base, packageManager: 'npm', importerId: '.' });
  const legacy = {
    manifestHash: current.manifestHash,
    lockfileHash: current.lockfileHash,
    lockfilePath: current.lockfilePath,
  };
  assert.equal(sourceFingerprintsMatch(current, legacy), true);
});
