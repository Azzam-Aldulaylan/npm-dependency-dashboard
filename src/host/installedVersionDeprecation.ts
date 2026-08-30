/**
 * Exact installed-version deprecation evidence.
 *
 * The dashboard's ordinary row metadata is derived from `/<package>/latest`,
 * so it cannot answer whether an older installed version is deprecated. Smart
 * Cleanup instead asks the registry for the exact installed version and feeds
 * that host-owned response through this helper. A replacement is surfaced only
 * when the maintainer's own deprecation notice uses one of the deliberately
 * narrow phrasings accepted by `extractSuggestedReplacement`; this module
 * never recommends a package from names, download data, or similarity.
 */

import type { PackageVersionMetadata } from '../core/registry/versions.js';
import { extractSuggestedReplacement } from '../core/hygiene/deprecated.js';

export interface InstalledVersionDeprecation {
  packageName: string;
  installedVersion: string;
  /** Exact maintainer-published registry text, preserved verbatim. */
  message: string;
  /** Present only when the same maintainer-published text explicitly names it. */
  suggestedReplacement?: string;
}

/** Return exact-version deprecation evidence, or null when that version is not deprecated. */
export function installedVersionDeprecation(
  metadata: PackageVersionMetadata
): InstalledVersionDeprecation | null {
  const message = metadata.deprecated;
  if (message === undefined || message.trim() === '') return null;

  const suggestedReplacement = extractSuggestedReplacement(message);
  return {
    packageName: metadata.name,
    installedVersion: metadata.version,
    message,
    ...(suggestedReplacement === undefined ? {} : { suggestedReplacement }),
  };
}
