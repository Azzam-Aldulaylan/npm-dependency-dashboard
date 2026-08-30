/**
 * Resolving "open advisory source" requests against the host's own
 * last-trusted scan — the security boundary for Problem 4's external link.
 *
 * The webview never sends a URL, only an identifier (`package` +
 * `advisoryId` + `path`) naming which attributed advisory it means and,
 * optionally, one ID badge already shown for that advisory. This looks the
 * advisory up in host-owned rows, verifies the badge against the same trusted
 * record, and derives the NVD/GitHub destination locally. Requests without a
 * displayed public reference use only the URL the scan itself recorded. Every
 * returned destination is `https:`; `http:`, `javascript:`, `file:`, and
 * malformed values are refused.
 *
 * Nothing here may import 'vscode' — see types.ts.
 */

import type { AttributedAdvisory, PackageRow } from '../types.js';
import { vulnerabilityIdentifiers } from './identifiers.js';

export interface AdvisoryLookupRequest {
  package: string;
  advisoryId: string | number;
  /** Same disambiguator the UI already keys advisory rows by — id alone is not guaranteed unique within a row. */
  path: readonly string[];
  /** Optional human-facing ID badge. The host verifies it belongs to this exact trusted advisory before resolving a destination. */
  reference?: string;
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

function resolveTrustedReferenceUrl(entry: AttributedAdvisory, reference: string): string | null {
  const normalized = reference.trim().toUpperCase();
  const belongsToAdvisory = vulnerabilityIdentifiers(entry.advisory)
    .some((identifier) => identifier.toUpperCase() === normalized);
  if (!belongsToAdvisory) return null;

  if (/^CVE-\d{4}-\d{4,}$/.test(normalized)) {
    return `https://nvd.nist.gov/vuln/detail/${encodeURIComponent(normalized)}`;
  }
  if (/^GHSA-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(normalized)) {
    return `https://github.com/advisories/${encodeURIComponent(normalized)}`;
  }
  return null;
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
  if (request.reference !== undefined) return resolveTrustedReferenceUrl(entry, request.reference);
  return isSafeAdvisoryUrl(entry.advisory.url) ? entry.advisory.url : null;
}
