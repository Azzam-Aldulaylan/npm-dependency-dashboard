import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

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
};

/** Webview: browser target, no Node builtins. */
const webviewConfig = {
  entryPoints: ['webview/src/main.tsx'],
  bundle: true,
  outfile: 'dist/webview.js',
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

if (watch) {
  const contexts = await Promise.all([
    esbuild.context(extensionConfig),
    esbuild.context(webviewConfig),
  ]);
  await Promise.all(contexts.map((c) => c.watch()));
  console.log('watching...');
} else {
  await Promise.all([esbuild.build(extensionConfig), esbuild.build(webviewConfig)]);
}
