import type { DependencyGraph } from '../core/types.js';
import type { CompatibilityStatus, UpgradeProposal } from '../core/compatibility/types.js';

export interface UpgradeSecurityGraphMaterializer {
  materializeResolvedGraph(
    proposal: UpgradeProposal,
    signal?: AbortSignal
  ): Promise<{ ok: true; graph: DependencyGraph } | { ok: false }>;
}

/**
 * Best-effort proposed graph work for Upgrade Review security evidence.
 * Compatibility conflicts cannot be executed and therefore have no proposed
 * graph to inspect. Resolver failures remain uncertainty, never a hard
 * failure of the surrounding upgrade analysis.
 */
export async function materializeUpgradeSecurityGraph(input: {
  compatibilityStatus: CompatibilityStatus;
  proposal: UpgradeProposal;
  materializer: UpgradeSecurityGraphMaterializer | undefined;
  signal: AbortSignal;
}): Promise<DependencyGraph | undefined> {
  if (input.compatibilityStatus === 'conflict' || input.materializer === undefined || input.signal.aborted) {
    return undefined;
  }
  try {
    const result = await input.materializer.materializeResolvedGraph(input.proposal, input.signal);
    return result.ok ? result.graph : undefined;
  } catch {
    return undefined;
  }
}
