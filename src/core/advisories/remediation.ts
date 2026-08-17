/**
 * Wires "first patched version" onto already-attributed advisories.
 *
 * Named `remediation.ts`, not `resolve.ts` — that name is already taken by
 * the advisory-URL-trust module in this same directory, which answers an
 * unrelated question (is this URL safe to open) rather than this one (what
 * version fixes this vulnerability).
 *
 * `attributeAdvisories` (attribution.ts) has no registry access, so every
 * `AttributedAdvisory` it produces starts with `patchedVersion: { status:
 * 'unknown' }`. This module fills that in from a caller-supplied packument
 * lookup — the network fetch itself belongs to pipeline.ts, which already
 * owns every other registry call in this pipeline.
 */

import { resolveFirstPatchedVersion } from '../version/resolve.js';
import type { AttributedAdvisory } from '../types.js';

/**
 * Rewrites `patchedVersion` on every entry from the version list the caller
 * fetched for that entry's own `flaggedPackage`. A package missing from
 * `packumentsByPackage` (fetch failed, or was never requested) resolves to
 * `unknown` — `resolveFirstPatchedVersion` already treats an empty version
 * list as unprovable rather than "no fix exists".
 */
export function attachPatchedVersions(
  attributedByRoot: ReadonlyMap<string, readonly AttributedAdvisory[]>,
  packumentsByPackage: ReadonlyMap<string, readonly string[]>
): Map<string, AttributedAdvisory[]> {
  const result = new Map<string, AttributedAdvisory[]>();
  for (const [root, entries] of attributedByRoot) {
    result.set(
      root,
      entries.map((entry) => ({
        ...entry,
        patchedVersion: resolveFirstPatchedVersion(
          packumentsByPackage.get(entry.flaggedPackage) ?? [],
          entry.advisory.vulnerableVersions,
          null
        ),
      }))
    );
  }
  return result;
}

/** Every distinct flagged package across an attribution map — the fetch list for `attachPatchedVersions`. */
export function distinctFlaggedPackages(
  attributedByRoot: ReadonlyMap<string, readonly AttributedAdvisory[]>
): Set<string> {
  const names = new Set<string>();
  for (const entries of attributedByRoot.values()) {
    for (const entry of entries) names.add(entry.flaggedPackage);
  }
  return names;
}
