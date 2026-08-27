/**
 * Pure, deterministic planning for a workspace analysis pass.
 *
 * Source/config discovery is host-owned, but the two result sets can overlap
 * (for example `eslint.config.js`).  Planning once lets the host read such a
 * file once while still applying both source-import and configuration rules.
 */

export interface WorkspaceAnalysisFile {
  key: string;
  source: boolean;
  config: boolean;
}

export function planWorkspaceAnalysisFiles(
  sourceKeys: readonly string[],
  configKeys: readonly string[]
): WorkspaceAnalysisFile[] {
  const byKey = new Map<string, WorkspaceAnalysisFile>();
  for (const key of sourceKeys) byKey.set(key, { key, source: true, config: false });
  for (const key of configKeys) {
    const existing = byKey.get(key);
    if (existing === undefined) byKey.set(key, { key, source: false, config: true });
    else existing.config = true;
  }
  return [...byKey.values()].sort((left, right) => left.key.localeCompare(right.key));
}
