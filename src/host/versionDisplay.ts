/**
 * Pure display decision for the Available column: whether Wanted and Latest
 * collapse to one line or need to be shown separately.
 *
 * See severityDisplay.ts for why this lives under src/host rather than
 * webview/src.
 */

import type { UnresolvableReason } from '../core/types.js';

export type VersionDisplay =
  | { kind: 'dash' }
  | { kind: 'single'; value: string }
  | { kind: 'split'; wanted: string; latest: string };

/**
 * Wanted and Latest are the same value for most packages — the version list
 * is only fetched when they can differ — so they collapse to one number
 * unless they actually disagree.
 */
export function versionDisplay(wanted: string | null, latest: string | null): VersionDisplay {
  if (wanted === null && latest === null) return { kind: 'dash' };
  if (wanted === latest) return { kind: 'single', value: wanted ?? latest ?? '—' };
  return { kind: 'split', wanted: wanted ?? '—', latest: latest ?? '—' };
}

/**
 * A row's tag can be a real `UnresolvableReason` (workspace link, file:/
 * git:/npm:-alias/tarball specifier, or genuinely no lockfile at all) or the
 * generic `'unresolved'` marker used for a row that has none of those
 * reasons but still has no resolved version — a dependency declared in
 * package.json but missing from an otherwise-present lockfile (not yet
 * installed, or the lockfile has drifted). Deliberately a distinct value
 * from `UnresolvableReason` rather than reusing `'no-lockfile'`: this row's
 * `unresolvable` field itself stays undefined, so pipeline fetching (Wanted/
 * Latest) is never skipped for it — only the display layer needs to know
 * "no resolved version" to decide whether to tag it.
 */
export type CurrentVersionTag = UnresolvableReason | 'unresolved';

export type CurrentVersionDisplay =
  | { kind: 'resolved'; value: string; tag: CurrentVersionTag | null }
  | { kind: 'declared-range'; value: string; tag: CurrentVersionTag }
  | { kind: 'dash'; tag: CurrentVersionTag };

/**
 * The Current column's display decision — display only, never a stand-in
 * for `PackageRow.current` itself: a `'declared-range'` result is a
 * package.json spec/range (e.g. "^18.2.0" or "file:../x"), not a real
 * installed version, and must never be treated as one (upgrade eligibility
 * in particular keys off `current` staying null; see that field's own doc).
 *
 * Falls back to the declared range only when there's no resolved version at
 * all — the common case this covers is a workspace link, an unresolvable
 * specifier, or no lockfile, all of which pair `current: null` with a
 * non-empty `range` the caller already has for free from `PackageRow`.
 *
 * The tag is shown whenever there's a reason to (an explicit
 * `unresolvable`) OR whenever `current` is null at all — even when
 * `unresolvable` is undefined, a null `current` means whatever is shown is
 * NOT a real installed version, and must never be presented as if it were
 * one. Without this, a declared dependency merely missing from an
 * otherwise-present lockfile would show its bare range with no tag,
 * indistinguishable from a real lockfile-resolved version.
 */
export function currentVersionDisplay(
  current: string | null,
  range: string,
  unresolvable: UnresolvableReason | undefined
): CurrentVersionDisplay {
  if (current !== null) return { kind: 'resolved', value: current, tag: unresolvable ?? null };
  const tag: CurrentVersionTag = unresolvable ?? 'unresolved';
  if (range !== '') return { kind: 'declared-range', value: range, tag };
  return { kind: 'dash', tag };
}
