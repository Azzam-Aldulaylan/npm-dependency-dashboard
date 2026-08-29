import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import test from 'node:test';

const sourceUris = [
  { fsPath: '/workspace/src/oversized.ts' },
  { fsPath: '/workspace/src/unreadable.ts' },
];

const vscode = {
  RelativePattern: class RelativePattern {
    constructor(base, pattern) {
      this.base = base;
      this.pattern = pattern;
    }
  },
  workspace: {
    findFiles: async (pattern) => pattern.pattern.includes('*.{js,jsx,ts,tsx,mjs,cjs}') ? sourceUris : [],
    fs: {
      stat: async (uri) => ({ size: uri.fsPath.endsWith('oversized.ts') ? 3 * 1024 * 1024 : 10 }),
      readFile: async () => { throw new Error('permission denied'); },
    },
  },
  Uri: {
    joinPath: (base, ...parts) => ({ fsPath: [base.fsPath, ...parts].join('/') }),
  },
};

const originalLoad = Module._load;
Module._load = function loadWithVscodeMock(request, parent, isMain) {
  if (request === 'vscode') return vscode;
  return originalLoad.call(this, request, parent, isMain);
};
const require = createRequire(import.meta.url);
const { analyzeDependencyUsage } = require('../out/host/usage/usageAnalyzer.js');
Module._load = originalLoad;

test('oversized and unreadable eligible files make a zero-reference usage result incomplete', async () => {
  const results = await analyzeDependencyUsage({
    folder: { uri: { fsPath: '/workspace' }, name: 'workspace', index: 0 },
    dir: '',
    manifestText: '{}',
    packageNames: ['left-pad'],
    maxFiles: 10,
    token: { isCancellationRequested: false },
  });

  const result = results.get('left-pad');
  assert.notEqual(result, undefined);
  assert.deepEqual(result.references, []);
  assert.equal(result.truncated, true, 'missing evidence must never become a complete unused/low-risk result');
});
