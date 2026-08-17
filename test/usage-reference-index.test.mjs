import { test } from 'node:test';
import assert from 'node:assert/strict';

import { UsageReferenceIndex } from '../out/core/usage/referenceIndex.js';
import { scanSourceForImports } from '../out/core/usage/importScan.js';

test('cleanup indexes one source scan for all direct dependencies, not one scan per dependency', () => {
  const packageNames = Array.from({ length: 125 }, (_, index) => `pkg-${index}`);
  let scans = 0;
  const index = new UsageReferenceIndex(packageNames, (text) => {
    scans += 1;
    return scanSourceForImports(text);
  });

  index.addSourceFile('src/app.ts', `import first from 'pkg-0';\nimport last from 'pkg-124/subpath';`);

  assert.equal(scans, 1, 'one source file is parsed once even when 125 packages are requested');
  assert.equal(index.forPackage('pkg-0').length, 1);
  assert.equal(index.forPackage('pkg-124').length, 1);
  assert.equal(index.forPackage('pkg-62').length, 0);
});

test('usage indexing keeps per-package references isolated', () => {
  const index = new UsageReferenceIndex(['alpha', 'beta']);
  index.addSourceFile('src/a.ts', `import 'alpha'; import 'unrequested';`);
  index.addSourceFile('src/b.ts', `const beta = require('beta');`);

  assert.deepEqual(index.forPackage('alpha').map((reference) => reference.filePath), ['src/a.ts']);
  assert.deepEqual(index.forPackage('beta').map((reference) => reference.filePath), ['src/b.ts']);
});
