/**
 * Recognized JS/TS tooling config files, and the plain word-boundary text
 * check used against their content — a package named as an ESLint/Babel/
 * PostCSS/Tailwind/webpack/Vite/Next.js plugin, or referenced from
 * `tsconfig.json`'s `extends`, is real usage the import scanner can never
 * see (none of these are JS import statements).
 *
 * The glob list is host-owned (src/host/usage/configFiles.ts uses it to
 * enumerate candidate files); this module only owns the *content* check,
 * which is pure and independently testable.
 */

export const CONFIG_FILE_GLOBS: readonly string[] = [
  '.eslintrc',
  '.eslintrc.*',
  'eslint.config.*',
  'babel.config.*',
  '.babelrc',
  '.babelrc.*',
  'postcss.config.*',
  'tailwind.config.*',
  'webpack.config.*',
  'vite.config.*',
  'next.config.*',
  'jest.config.*',
  'vitest.config.*',
  'rollup.config.*',
  'tsconfig.json',
  'tsconfig.*.json',
];

function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function candidateTokens(packageName: string): string[] {
  if (!packageName.startsWith('@')) return [packageName];
  const slash = packageName.indexOf('/');
  return slash === -1 ? [packageName] : [packageName, packageName.slice(slash + 1)];
}

/** True when `packageName` appears in `content` as a whole word — e.g. inside a quoted plugin/preset/extends entry. */
export function configReferencesPackage(content: string, packageName: string): boolean {
  const tokens = candidateTokens(packageName);
  const pattern = new RegExp(`(?:^|[^\\w@./-])(${tokens.map(escapeForRegex).join('|')})(?:[^\\w./-]|$)`);
  return pattern.test(content);
}
