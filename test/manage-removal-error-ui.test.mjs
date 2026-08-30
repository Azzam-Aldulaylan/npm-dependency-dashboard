import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

const app = await readFile(join(process.cwd(), 'webview/src/App.tsx'), 'utf8');
const manage = await readFile(join(process.cwd(), 'webview/src/components/ManageDependencyModal.tsx'), 'utf8');
const review = await readFile(join(process.cwd(), 'webview/src/components/RemovalReviewPanel.tsx'), 'utf8');

test('Manage dependency routes removal failures into the open Removal Review', () => {
  assert.match(app, /removeOrigin === 'manage-dependency' && removeError\?\.package === row\.name/);
  assert.match(app, /removeError !== null && removeOrigin !== 'manage-dependency'/);
  assert.match(manage, /error=\{removal\.error\}/);
  assert.match(review, /error: \{ code: string; message: string \} \| null/);
  assert.match(review, /Removal blocked by a peer dependency/);
  assert.match(review, /Keep this package, or remove the package that requires it/);
});
