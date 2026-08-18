/**
 * The Action column's full display decision — what the button says, what it
 * tells the host to do, and why there is no button at all when that's the
 * honest answer. Every branch here is presentational only: it reads
 * `PackageRow.upgradeTo`/`upgradeReason` (src/core/upgrade/candidate.ts) and
 * never re-derives eligibility — the same host-side validation
 * (src/core/upgrade/validate.ts) runs regardless of which label led here,
 * and every actionable state below sends the identical `{ type: 'upgrade',
 * package, target }` message through the identical preflight/confirm/
 * install pipeline. The label only changes what the user is told to expect.
 *
 * Lives here rather than under webview/src for the same reason as
 * severityDisplay.ts: webview/tsconfig.json has `noEmit: true`, so there is
 * no compiled `out/` counterpart to unit-test against if this lived there.
 */

import type { AttributedAdvisory, PackageRow, UnresolvableReason } from '../core/types.js';
import { rowHasUpdate } from './summaryMetrics.js';
import type { UpdateKind } from './updateClassification.js';
import { classifyRowUpdate } from './updateClassification.js';

export const UPGRADE_TOOLTIP =
  'Runs compatibility preflight, then a transactional npm/pnpm upgrade as a visible VS Code task after confirmation.';

/**
 * The result of a live "Analyze remediation" run (see
 * upgradeAssistantCoordinator.ts's handleAnalyzeRemediation), mirrored here
 * purely as a UI phase so `resolveActionState` stays a pure function of
 * `PackageRow` plus this one piece of session-local, non-persisted state —
 * it is never part of `PackageRow` itself since it is not a fact about the
 * dependency, only about whether this webview session has asked about it.
 * `'remains'`/`'unknown'` reuse SecurityOutcomeStatus's own vocabulary
 * (src/core/advisories/securityOutcome.ts) rather than inventing another.
 */
export type TransitiveRemediationUiState =
  | { phase: 'analyzing' }
  | { phase: 'done'; status: 'resolved' | 'remains' | 'unknown' };

export type ActionState =
  | { kind: 'security-fix'; target: string; label: string; tooltip: string }
  | { kind: 'update'; target: string; updateKind: UpdateKind; label: string; tooltip: string }
  | { kind: 'up-to-date'; tooltip: string }
  /** A transitive vulnerability with no direct upgrade target — not yet analyzed. Clicking triggers handleAnalyzeRemediation. */
  | { kind: 'transitive-remediation'; label: string; tooltip: string }
  | { kind: 'remediation-analyzing'; tooltip: string }
  /** A fresh, lockfile-free resolve already produces a non-vulnerable tree — see securityOutcome.ts. Analysis-only in this version: no execution action is offered, since safely reusing the upgrade-transaction pipeline for a "relock with no manifest change" is its own scoped feature. */
  | { kind: 'remediation-resolved'; tooltip: string }
  /** Either a direct-package vulnerability with no newer published version (no analysis needed), or a transitive one where a fresh resolve did not clear it. */
  | { kind: 'no-direct-fix'; tooltip: string }
  | { kind: 'remediation-unknown'; tooltip: string }
  /** Reserved for genuinely unsupported/unresolvable situations — see unavailableReasonText. Never used when a more specific remediation state applies. */
  | { kind: 'unavailable'; tooltip: string };

const UNRESOLVABLE_EXPLANATION: Record<UnresolvableReason, string> = {
  'workspace-link': 'This dependency is linked from a workspace package, not installed from the registry.',
  file: 'This dependency is installed from a local file path, not the registry.',
  git: 'This dependency is installed from a Git repository, not the registry.',
  alias: 'This dependency is installed through an npm alias.',
  tarball: 'This dependency is installed from a direct tarball URL.',
  'no-lockfile': 'No lockfile is present, so the installed version is unknown.',
};

function unavailableReasonText(row: PackageRow): string {
  if (row.current === null) {
    return row.unresolvable !== undefined
      ? UNRESOLVABLE_EXPLANATION[row.unresolvable]
      : 'This dependency has no resolved installed version to compare against.';
  }
  if (row.wanted === null && row.latest === null) {
    return 'Version information could not be fetched for this dependency.';
  }
  return 'No safe upgrade target could be determined for this dependency.';
}

/** The chain description for a transitive advisory, e.g. "sockjs-client → faye-websocket → websocket-driver". */
function pathText(advisory: AttributedAdvisory): string {
  return advisory.path.join(' → ');
}

/**
 * A vulnerability with no computed `upgradeTo` — every attributed advisory
 * on this row is direct (`path.length === 1`): the flaw is in the package's
 * own latest published version, not introduced through a nested dependency.
 * No live analysis can help here (re-resolving the tree cannot change what
 * the package's own newest release contains), so this is decided statically,
 * the same way `unavailableReasonText` decides its own branches.
 */
function directNoFixTooltip(): string {
  return 'A vulnerability is known for this dependency, but no newer published version fixes it yet.';
}

function transitiveAnalyzeTooltip(transitiveAdvisories: readonly AttributedAdvisory[]): string {
  const first = transitiveAdvisories[0];
  const subject = first === undefined ? 'the affected dependency' : first.flaggedPackage;
  return `Checks whether npm/pnpm can re-resolve ${subject} to a fixed version without changing this package's own version. Runs the same isolated preflight resolver used for upgrades — nothing on disk is touched.`;
}

function transitiveResolvedTooltip(transitiveAdvisories: readonly AttributedAdvisory[]): string {
  const first = transitiveAdvisories[0];
  if (first === undefined) return 'A fresh dependency resolution no longer includes the vulnerable version.';
  return `The dependency tree can resolve ${first.flaggedPackage} to a non-vulnerable version without changing this package's own version. Introduced through: ${pathText(first)}.`;
}

function transitiveNoFixTooltip(transitiveAdvisories: readonly AttributedAdvisory[]): string {
  const first = transitiveAdvisories[0];
  if (first === undefined) return 'No validated remediation is currently known for this vulnerability.';
  return `This dependency is already at its latest direct version. The vulnerability is introduced through: ${pathText(first)}. No validated dependency change is currently known to remove the vulnerable version.`;
}

function remediationUnknownTooltip(): string {
  return 'Remediation could not be determined — the resolver check did not complete. Try analyzing again.';
}

/**
 * The single decision the Action cell renders from. `upgradeTo`/
 * `upgradeReason` already carry a real, host-validated target whenever one
 * exists (see PackageRow's own doc) — everything below is purely about
 * choosing honest words for whichever state that leaves.
 *
 * `remediation` is the one piece of state this function accepts beyond
 * `PackageRow` itself — the webview session's own record of whether it has
 * asked the host to analyze this row's transitive vulnerability, and what
 * came back. It is never persisted server-side and never survives a fresh
 * scan (see App.tsx, which clears it whenever new dashboard data arrives) —
 * purely a UI phase, not a fact about the dependency.
 */
export function resolveActionState(row: PackageRow, remediation?: TransitiveRemediationUiState): ActionState {
  if (row.upgradeTo !== null && row.upgradeReason === 'security-fix') {
    return {
      kind: 'security-fix',
      target: row.upgradeTo,
      label: 'Review upgrade',
      tooltip: `Reviews an upgrade to ${row.upgradeTo}, which resolves the reported vulnerability. ${UPGRADE_TOOLTIP}`,
    };
  }

  if (row.upgradeTo !== null && row.upgradeReason === 'update') {
    const updateKind = classifyRowUpdate(row) ?? 'patch';
    const isMajor = updateKind === 'major';
    return {
      kind: 'update',
      target: row.upgradeTo,
      updateKind,
      label: 'Review upgrade',
      tooltip: isMajor ? `${row.upgradeTo} is a major version bump. ${UPGRADE_TOOLTIP}` : UPGRADE_TOOLTIP,
    };
  }

  // upgradeTo === null past this point — every branch below is about
  // choosing the honest reason, checked in order from "most specifically
  // knowable" to "genuinely nothing newer exists".
  if (row.current === null) return { kind: 'unavailable', tooltip: unavailableReasonText(row) };

  if (row.worstSeverity !== null) {
    const transitiveAdvisories = row.advisories.filter((entry) => entry.path.length > 1);
    if (transitiveAdvisories.length === 0) {
      // Every advisory on this row is against the direct package itself,
      // already at its newest published version — see resolveRemediationRequest
      // for why this case is never offered "Analyze remediation".
      return { kind: 'no-direct-fix', tooltip: directNoFixTooltip() };
    }
    if (remediation === undefined) {
      return { kind: 'transitive-remediation', label: 'Check transitive fix', tooltip: transitiveAnalyzeTooltip(transitiveAdvisories) };
    }
    if (remediation.phase === 'analyzing') {
      return { kind: 'remediation-analyzing', tooltip: 'Analyzing whether this vulnerability can be remediated…' };
    }
    if (remediation.status === 'resolved') {
      return { kind: 'remediation-resolved', tooltip: transitiveResolvedTooltip(transitiveAdvisories) };
    }
    if (remediation.status === 'unknown') {
      return { kind: 'remediation-unknown', tooltip: remediationUnknownTooltip() };
    }
    return { kind: 'no-direct-fix', tooltip: transitiveNoFixTooltip(transitiveAdvisories) };
  }

  if (row.wanted === null && row.latest === null) {
    return { kind: 'unavailable', tooltip: unavailableReasonText(row) };
  }
  if (rowHasUpdate(row)) {
    // Wanted/Latest show something newer than Current, yet no safe target
    // was resolved — the isSafeUpgradeTarget downgrade-trap guard tripped,
    // or another defensive edge case. Rare, but never silently a dash.
    return { kind: 'unavailable', tooltip: unavailableReasonText(row) };
  }
  return { kind: 'up-to-date', tooltip: 'Already at the newest version allowed by its range.' };
}
