/**
 * Packages commonly loaded through a framework/tooling naming convention
 * rather than a static import/require/script/config reference this scanner
 * can see — an ESLint config extending `"plugin:react/recommended"`, a
 * PostCSS plugin listed only by its config-object key, a Babel preset
 * resolved by convention, and so on. A package matching one of these
 * patterns that produces zero references is downgraded to "possibly
 * unused, low confidence" rather than reported as a confident finding —
 * see unused.ts.
 *
 * Deliberately pattern-based, not an exhaustive name list: new plugins are
 * published constantly, and a naming convention generalizes far better than
 * trying to enumerate every known package.
 */

const CONVENTION_PATTERNS: RegExp[] = [
  /^eslint-(plugin|config)-/,
  /^@[^/]+\/eslint-(plugin|config)/,
  /^babel-(plugin|preset)-/,
  /^@babel\//,
  /^postcss-/,
  /^@postcss-plugins\//,
  /^stylelint-/,
  /-loader$/,
  /^webpack-/,
  /^vite-plugin-/,
  /^rollup-plugin-/,
  /^@rollup\//,
  /^remark-/,
  /^rehype-/,
  /^unplugin-/,
  /^react-native-/,
  /^@react-native\//,
  /^@react-native-community\//,
];

/** Well-known CLI/tooling packages, invoked by convention (a config file, a `bin` script) more often than a static import. */
const KNOWN_TOOLING_NAMES: ReadonlySet<string> = new Set([
  'typescript',
  'eslint',
  'prettier',
  'jest',
  'vitest',
  'mocha',
  'webpack',
  'vite',
  'rollup',
  'babel',
  'husky',
  'lint-staged',
  'nodemon',
  'ts-node',
  'tsx',
  'cross-env',
  'rimraf',
  'concurrently',
  'npm-run-all',
  'esbuild',
  'tailwindcss',
  'postcss',
  'stylelint',
]);

export function isFrameworkConventionPackage(packageName: string): boolean {
  if (KNOWN_TOOLING_NAMES.has(packageName)) return true;
  return CONVENTION_PATTERNS.some((pattern) => pattern.test(packageName));
}
