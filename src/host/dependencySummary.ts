/**
 * Pure display decision for the dashboard footer's dependency count.
 *
 * See severityDisplay.ts for why this lives under src/host rather than
 * webview/src.
 */

export function dependencyCountLabel(count: number): string {
  return count === 1 ? '1 dependency checked' : `${count} dependencies checked`;
}
