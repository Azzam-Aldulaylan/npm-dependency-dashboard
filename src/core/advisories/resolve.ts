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
  const requestedId = String(request.advisoryId).trim().toUpperCase();
  return advisories.find((entry) =>
    pathsEqual(entry.path, request.path) &&
    (
      entry.advisory.id === request.advisoryId ||
      vulnerabilityIdentifiers(entry.advisory).some((identifier) => identifier.toUpperCase() === requestedId)
    )
  );
}

function deterministicPublicReferenceUrl(reference: string): string | null {
  const normalized = reference.trim().toUpperCase();
  if (/^CVE-\d{4}-\d{4,}$/.test(normalized)) {
    return `https://nvd.nist.gov/vuln/detail/${encodeURIComponent(normalized)}`;
  }
  if (/^GHSA-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(normalized)) {
    return `https://github.com/advisories/${encodeURIComponent(normalized)}`;
  }
  return null;
}

function resolveTrustedReferenceUrl(entry: AttributedAdvisory, reference: string): string | null {
  const normalized = reference.trim().toUpperCase();
  const belongsToAdvisory = vulnerabilityIdentifiers(entry.advisory)
    .some((identifier) => identifier.toUpperCase() === normalized);
  if (!belongsToAdvisory) return null;

  return deterministicPublicReferenceUrl(normalized);
}

/**
 * `null` covers every failure alike — package not in the last scan, an
 * unrecognized identifier, or a URL that failed the https: check — so callers
 * have exactly one thing to do on `null`: nothing, silently. A public CVE/GHSA
 * badge from a just-completed remediation result is the sole stale-data
 * exception: when the row remains but the fixed advisory is gone, its fixed
 * NVD/GitHub destination can still be derived without trusting a webview URL.
 */
export function resolveTrustedAdvisoryUrl(
  rows: readonly PackageRow[],
  request: AdvisoryLookupRequest
): string | null {
  const row = rows.find((r) => r.name === request.package);
  if (row === undefined) return null;
  const entry = findAttributedAdvisory(row.advisories, request);
  if (entry === undefined) {
    // A just-remediated advisory is intentionally absent from the refreshed
    // rows while its host-issued result remains visible. In that one bounded
    // case, a matching public id/reference can still open only the fixed NVD
    // or GitHub advisory host; no URL ever crosses from the webview.
    return request.reference !== undefined && String(request.advisoryId).toUpperCase() === request.reference.toUpperCase()
      ? deterministicPublicReferenceUrl(request.reference)
      : null;
  }
  if (request.reference !== undefined) return resolveTrustedReferenceUrl(entry, request.reference);
  return isSafeAdvisoryUrl(entry.advisory.url) ? entry.advisory.url : null;
}
