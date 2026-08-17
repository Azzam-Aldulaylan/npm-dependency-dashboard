/**
 * Pure display decision for the Available column.
 *
 * Wanted and Latest are the same value for most packages — the version list
 * is only fetched when they can differ — so the common case is a single
 * compact line. They diverge exactly when a newer release exists *outside*
 * the declared range: Latest becomes the strong, primary value (it is what
 * the user would actually get by widening the range or running an
 * out-of-range install) and Wanted survives as "the most a plain install
 * gets you today."
 *
 * See severityDisplay.ts for why this lives under src/host rather than
 * webview/src.
 */

import type { UnresolvableReason } from '../core/types.js';
import type { UpdateKind } from './updateClassification.js';
import { classifyUpdate } from './updateClassification.js';

export type AvailableVersionDisplay =
  | { kind: 'dash' }
  /** Wanted === Latest: nothing outside the current range to call out. */
  | { kind: 'single'; value: string; hasUpdate: boolean; updateKind: UpdateKind | null }
  /** Wanted !== Latest: a real release exists past what the declared range allows. */
  | { kind: 'split'; value: string; withinRange: string; updateKind: UpdateKind | null };

function classifyAgainst(current: string | null, target: string): UpdateKind | null {
  return current === null ? null : classifyUpdate(current, target);
}

export function availableVersionDisplay(
  current: string | null,
  wanted: string | null,
  latest: string | null
): AvailableVersionDisplay {
  if (wanted === null && latest === null) return { kind: 'dash' };

  if (wanted === latest) {
    // Both null is excluded above, and equal values can't be "one null, one
    // not" — so whichever local variable is read below is the shared,
    // non-null value itself.
    const value = wanted ?? latest ?? '—';
    const hasUpdate = current !== null && value !== current;
    return { kind: 'single', value, hasUpdate, updateKind: hasUpdate ? classifyAgainst(current, value) : null };
  }

  const value = latest ?? wanted ?? '—';
  const withinRange = wanted ?? '—';
  return { kind: 'split', value, withinRange, updateKind: classifyAgainst(current, value) };
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
