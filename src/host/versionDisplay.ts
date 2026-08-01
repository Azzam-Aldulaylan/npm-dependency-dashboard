/**
 * Pure display decision for the Available column: whether Wanted and Latest
 * collapse to one line or need to be shown separately.
 *
 * See severityDisplay.ts for why this lives under src/host rather than
 * webview/src.
 */

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
