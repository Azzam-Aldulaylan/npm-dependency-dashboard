import type { SecurityOutcome } from './webviewProtocol.js';

export interface UpgradeSecuritySummary {
  beforeCount: number;
  confirmedRemainingCount: number;
  unknownCount: number;
  /** Honest after-state copy: zero is returned only when every advisory was proven resolved. */
  afterLabel: string;
}

/**
 * Builds the compact vulnerability counts used by Upgrade review. Unknown
 * resolver outcomes are not vulnerabilities proven absent, so they must never
 * collapse into a misleading zero-after-upgrade claim.
 */
export function summarizeUpgradeSecurity(security: SecurityOutcome): UpgradeSecuritySummary {
  const confirmedRemainingCount = security.remaining.filter((entry) => entry.status === 'remains').length;
  const unknownCount = security.remaining.filter((entry) => entry.status === 'unknown').length;
  const beforeCount = security.resolvedAdvisories.length + confirmedRemainingCount + unknownCount;

  let afterLabel: string;
  if (unknownCount > 0) {
    const unknownLabel = `${unknownCount} undetermined`;
    afterLabel = confirmedRemainingCount > 0 ? `${confirmedRemainingCount} remains, ${unknownLabel}` : unknownLabel;
  } else {
    afterLabel = String(confirmedRemainingCount);
  }

  return { beforeCount, confirmedRemainingCount, unknownCount, afterLabel };
}
