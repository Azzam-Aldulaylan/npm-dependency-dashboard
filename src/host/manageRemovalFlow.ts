/**
 * The Manage workspace must finish its read-only removal-impact scan before
 * starting the host removal preflight. The preflight reserves the shared
 * upgrade/removal coordinator, after which the host correctly refuses a
 * concurrent impact scan. Kept pure so stale and unrelated results are
 * covered without rendering React.
 */
export function manageRemovalReadyPackage(
  pendingPackage: string | null,
  impact: { phase: string; assessments?: { has(packageName: string): boolean } }
): string | null {
  if (pendingPackage === null || impact.phase !== 'done') return null;
  return impact.assessments?.has(pendingPackage) === true ? pendingPackage : null;
}
