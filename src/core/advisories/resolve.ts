/**
 * Resolving "open advisory source" requests against the host's own
 * last-trusted scan — the security boundary for Problem 4's external link.
 *
 * The webview never sends a URL, only an identifier (`package` +
 * `advisoryId` + `path`) naming which attributed advisory it means; this
 * looks that identifier up in `rows` (host-owned, from the last completed
 * scan — see DashboardController.lastResult) and returns the URL *that scan
 * itself recorded*, never anything the webview supplied. A URL is returned
 * only when it is a well-formed `https:` link — `http:`, `javascript:`,
 * `file:`, and malformed strings are all refused, regardless of source.
 *
 * Nothing here may import 'vscode' — see types.ts.
 */

import type { AttributedAdvisory, PackageRow } from '../types.js';

export interface AdvisoryLookupRequest {
  package: string;
  advisoryId: string | number;
  /** Same disambiguator the UI already keys advisory rows by — id alone is not guaranteed unique within a row. */
  path: readonly string[];
}

export function isSafeAdvisoryUrl(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

function pathsEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((segment, index) => segment === b[index]);
}

function findAttributedAdvisory(
  advisories: readonly AttributedAdvisory[],
  request: AdvisoryLookupRequest
): AttributedAdvisory | undefined {
  return advisories.find((entry) => entry.advisory.id === request.advisoryId && pathsEqual(entry.path, request.path));
}

/**
 * `null` covers every failure alike — package not in the last scan, advisory
 * id/path not present on that row, or a URL that failed the https: check —
 * so callers have exactly one thing to do on `null`: nothing, silently.
 * There is no user-facing difference between "forged" and "stale" here; both
 * are just "this cannot be opened".
 */
export function resolveTrustedAdvisoryUrl(
  rows: readonly PackageRow[],
  request: AdvisoryLookupRequest
): string | null {
  const row = rows.find((r) => r.name === request.package);
  if (row === undefined) return null;
  const entry = findAttributedAdvisory(row.advisories, request);
  if (entry === undefined) return null;
  return isSafeAdvisoryUrl(entry.advisory.url) ? entry.advisory.url : null;
}
