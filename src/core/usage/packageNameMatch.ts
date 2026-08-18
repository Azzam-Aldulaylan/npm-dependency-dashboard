/**
 * Specifier <-> package-name matching. Shared by import scanning, script
 * scanning, and config scanning so "does this specifier count as usage of
 * package X" is answered identically everywhere.
 */

/**
 * The bare package name a module specifier resolves to, or null when the
 * specifier can't be an npm package (relative, absolute, or a URL-like
 * scheme such as `node:`/`http:`). Handles subpaths: `lodash/get` -> `lodash`,
 * `@scope/pkg/sub` -> `@scope/pkg`.
 */
export function importedPackageName(specifier: string): string | null {
  if (specifier === '' || specifier.startsWith('.') || specifier.startsWith('/')) return null;
  // node:, file:, http(s):, data: — never an npm package specifier.
  if (/^[a-z][a-z0-9+.-]*:/i.test(specifier)) return null;

  if (specifier.startsWith('@')) {
    const parts = specifier.split('/');
    return parts.length >= 2 && parts[0] !== '' && parts[1] !== '' ? `${parts[0]}/${parts[1]}` : null;
  }
  const slash = specifier.indexOf('/');
  return slash === -1 ? specifier : specifier.slice(0, slash);
}

/** True when `specifier` is exactly `packageName`, or a subpath of it (`packageName/...`). */
export function specifierMatchesPackage(specifier: string, packageName: string): boolean {
  return specifier === packageName || specifier.startsWith(`${packageName}/`);
}
