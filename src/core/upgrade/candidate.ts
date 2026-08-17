/**
 * The single "what would clicking the Action button actually do" decision
 * for a direct dependency's row — composed from two independent questions
 * that the domain previously conflated into one:
 *
 *  - Security remediation: does resolveUpgradeTarget (aggregate.ts) find a
 *    version specifically verified not to carry this row's own known
 *    advisory forward? That verification (fixAvailable, or the self-computed
 *    range/vulnerable-versions check) is the one thing this codebase can
 *    actually vouch for, so it wins whenever it applies.
 *  - General upgrade candidate: is there simply a newer version than
 *    Current at all — Wanted (in-range) or, when it's ahead, Latest —
 *    independent of whether any advisory exists? A healthy package with a
 *    normal update available is just as real an upgrade as a security fix;
 *    it was only ever hidden because `upgradeTo` used to mean "security fix
 *    exists" instead of "there is something to upgrade to".
 *
 * `upgradeTo`/`upgradeReason` together are still the *entire* signal
 * src/core/upgrade/validate.ts trusts — it keys purely on `row.upgradeTo`
 * matching the webview's requested target, unchanged by this file. Nothing
 * here weakens that boundary; it only changes what feeds it.
 *
 * Nothing here may import 'vscode' — see types.ts.
 */

import { isSafeUpgradeTarget } from '../version/resolve.js';
import type { UpgradeReason } from '../types.js';

export interface UpgradeCandidate {
  target: string;
  reason: UpgradeReason;
}

/**
 * The newest version genuinely ahead of `current`, npm-outdated style:
 * Latest when it differs from Current (it is always >= Wanted), falling
 * back to Wanted for the rarer case where only the in-range version has
 * moved. Still passes through `isSafeUpgradeTarget` — the same downgrade-
 * trap guard the security path already relies on — so this can never offer
 * a version that isn't strictly ahead of what's installed, and never fires
 * at all without a real installed version to compare against.
 */
export function generalUpdateTarget(
  current: string | null,
  wanted: string | null,
  latest: string | null
): string | null {
  if (current === null) return null;
  const candidate =
    latest !== null && latest !== current ? latest : wanted !== null && wanted !== current ? wanted : null;
  return candidate !== null && isSafeUpgradeTarget(candidate, current) ? candidate : null;
}

export interface UpgradeCandidateOptions {
  /** resolveUpgradeTarget's own result — already advisory/fixAvailable-gated, passed through unchanged. */
  securityTarget: string | null;
  current: string | null;
  wanted: string | null;
  latest: string | null;
}

/** Security remediation wins when both a verified fix and a general update exist. */
export function resolveUpgradeCandidate(options: UpgradeCandidateOptions): UpgradeCandidate | null {
  if (options.securityTarget !== null) return { target: options.securityTarget, reason: 'security-fix' };
  const general = generalUpdateTarget(options.current, options.wanted, options.latest);
  return general === null ? null : { target: general, reason: 'update' };
}
