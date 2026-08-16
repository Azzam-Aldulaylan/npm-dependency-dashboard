/**
 * Cache key derivation — pure, no vscode.
 *
 * `src/core/registry/npmrc.ts` already refuses to resolve any registry URL
 * containing embedded userinfo (`isUsableRegistryUrl` rejects
 * `url.username !== '' || url.password !== ''`), so a credentialed registry
 * should never actually reach here. The checks in this file are deliberate
 * defense in depth — a second, independent guard in the one place a
 * credential would do real damage (written to disk) — not the primary
 * control.
 */

/** True if `url` parses and carries embedded userinfo (`user:pass@host`). */
export function hasUrlCredentials(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.username !== '' || parsed.password !== '';
  } catch {
    return false;
  }
}

/** `url` with any embedded userinfo stripped. Falls back to the raw value if it doesn't parse as a URL at all — still deterministic, just not credential-strippable. */
export function stripUrlCredentials(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * The project-specific persisted-cache key: a project's own deterministic
 * S6 identity (`deriveProjectId`, folder + manifest path) plus a
 * credential-stripped registry — two projects with the same identity but
 * different effective registries (e.g. one still resolves the public
 * registry, another has since started resolving a private mirror via
 * `.npmrc`) must not share a cache entry, since the cached rows' available-
 * version data is registry-specific.
 *
 * Encoded as `JSON.stringify([...])`, matching `deriveProjectId`'s own
 * fix for the same reason: a delimiter-joined string is ambiguous whenever
 * either input could itself contain the delimiter.
 */
export function deriveProjectCacheKey(
  projectId: string,
  registry: string,
  packageManager: 'npm' | 'pnpm' = 'npm'
): string {
  return JSON.stringify([projectId, stripUrlCredentials(registry), packageManager]);
}
