/**
 * Pure branch-topology reconciliation. The VS Code adapter owns discovery
 * and picking; this module only decides whether the previous selection is
 * still present and whether a replacement may be chosen without guessing.
 */

export interface ReconciliationCandidate {
  id: string;
  manifestPath: string;
  folderId: string;
}

export type ProjectReconciliation<T extends ReconciliationCandidate> =
  | { kind: 'preserve'; candidate: T }
  | { kind: 'auto-select'; candidate: T }
  | { kind: 'selection-required'; candidates: readonly T[] }
  | { kind: 'none' };

/**
 * Stable ids are authoritative. The manifest-relative fallback preserves a
 * selection when a workspace-folder object was recreated without changing
 * the actual project path. A moved manifest is only selected automatically
 * when it is the sole candidate; with several candidates the host must ask.
 */
export function reconcileProjectCandidates<T extends ReconciliationCandidate>(
  previous: ReconciliationCandidate | undefined,
  candidates: readonly T[]
): ProjectReconciliation<T> {
  if (previous !== undefined) {
    const exact = candidates.find((candidate) => candidate.id === previous.id);
    if (exact !== undefined) return { kind: 'preserve', candidate: exact };

    const sameManifest = candidates.find(
      (candidate) =>
        candidate.folderId === previous.folderId && candidate.manifestPath === previous.manifestPath
    );
    if (sameManifest !== undefined) return { kind: 'preserve', candidate: sameManifest };
  }

  if (candidates.length === 0) return { kind: 'none' };
  if (candidates.length === 1) return { kind: 'auto-select', candidate: candidates[0]! };
  return { kind: 'selection-required', candidates };
}
