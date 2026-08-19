import * as esbuild from 'esbuild';
import { existsSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

/**
 * The webview lands in a later slice. Until its entry point exists, building it
 * would fail the whole build — so it is bundled only when present, and the
 * extension host bundle stands on its own.
 */
const WEBVIEW_ENTRY = 'webview/src/main.tsx';

/** Extension host: Node target, vscode is provided by the runtime. */
const extensionConfig = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
  // Stamped once per build invocation, not per activation — the dashboard
  // footer shows this so a dev pressing F5 can tell a rebuild actually took
  // effect, rather than looking at a stale Extension Development Host.
  define: { __BUILD_TIME__: JSON.stringify(new Date().toISOString()) },
};

/**
 * Webview: browser target, no Node builtins.
 *
 * The CSS imported by main.tsx is emitted as a sibling dist/webview.css, which
 * the panel loads via <link> — the CSP forbids inline <style>, so the
 * stylesheet has to be a real file.
 *
 * `define` is not optional: React branches on process.env.NODE_ENV, and there
 * is no `process` in a browser bundle, so without this the webview throws on
 * load rather than at build time.
 */
const webviewConfig = {
  entryPoints: [WEBVIEW_ENTRY],
  bundle: true,
  outfile: 'dist/webview.js',
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': production ? '"production"' : '"development"' },
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

const configs = [extensionConfig];
if (existsSync(WEBVIEW_ENTRY)) {
  configs.push(webviewConfig);
} else {
  console.log(`skipping webview bundle: ${WEBVIEW_ENTRY} does not exist yet`);
}

if (watch) {
  const contexts = await Promise.all(configs.map((c) => esbuild.context(c)));
  await Promise.all(contexts.map((c) => c.watch()));
  console.log('watching...');
} else {
  await Promise.all(configs.map((c) => esbuild.build(c)));
}
