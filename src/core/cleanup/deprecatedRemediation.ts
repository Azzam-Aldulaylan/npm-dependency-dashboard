export type DeprecatedRemediation =
  | { kind: 'review-removal'; actionId: string; reason: string }
  | { kind: 'review-upgrade'; targetVersion: string; reason: string }
  | { kind: 'review-related-upgrades'; upgrades: readonly { packageName: string; targetVersion: string }[]; reason: string }
  | { kind: 'guidance'; reason: string };

export interface ResolveDeprecatedRemediationOptions {
  removalAction?: {
    id: string;
    confidence: 'safe' | 'review' | 'blocked' | 'unknown';
  };
  upgradeTarget: string | null;
  requiredBy: readonly string[];
  relatedUpgrades: readonly { packageName: string; targetVersion: string }[];
  suggestedReplacement?: string;
}

/**
 * Selects the next useful step for a deprecated direct dependency.
 *
 * Deprecation never grants mutation authority. Removal is offered only when
 * the independently-produced unused/removal assessment is selectable; a
 * blocked peer requirement is routed toward its owners instead of a removal
 * flow that the host must reject later.
 */
export function resolveDeprecatedRemediation(
  options: ResolveDeprecatedRemediationOptions
): DeprecatedRemediation {
  const removal = options.removalAction;
  if (removal?.confidence === 'safe') {
    return {
      kind: 'review-removal',
      actionId: removal.id,
      reason: 'A separate unused-dependency assessment found that removal may be appropriate.',
    };
  }

  if (options.upgradeTarget !== null) {
    return {
      kind: 'review-upgrade',
      targetVersion: options.upgradeTarget,
      reason: `A newer direct version (${options.upgradeTarget}) is available for compatibility review.`,
    };
  }

  if (removal?.confidence === 'review') {
    return {
      kind: 'review-removal',
      actionId: removal.id,
      reason: 'A separate unused-dependency assessment found that removal may be appropriate, but the evidence needs review.',
    };
  }

  const packageNames = [...new Set(options.requiredBy.filter((name) => name.trim() !== ''))]
    .sort((left, right) => left.localeCompare(right));
  const upgrades = [...new Map(
    options.relatedUpgrades
      .filter((upgrade) => upgrade.packageName.trim() !== '' && upgrade.targetVersion.trim() !== '')
      .map((upgrade) => [upgrade.packageName, upgrade])
  ).values()].sort((left, right) => left.packageName.localeCompare(right.packageName));
  if (upgrades.length > 0) {
    return {
      kind: 'review-related-upgrades',
      upgrades,
      reason: `This package is still required as a peer dependency by ${packageNames.join(', ')}. Review those dependencies before changing it.`,
    };
  }

  return {
    kind: 'guidance',
    reason: options.suggestedReplacement === undefined
      ? packageNames.length > 0
        ? `No safe automated step was verified. This package is still required by ${packageNames.join(', ')}.`
        : 'No safe automated step was verified. Review the deprecation notice and project usage before changing this dependency.'
      : `The maintainer suggests ${options.suggestedReplacement}, but replacing a package may require source changes and is not automated by Smart Cleanup.`,
  };
}
