/**
 * Project compatibility source/config evidence is advisory, but an
 * actionable retained review must not silently mix findings from one source
 * snapshot with another. A null expected fingerprint means source collection
 * was unavailable and therefore produced no source-backed authority.
 */
export function projectCompatibilityEvidenceIsCurrent(
  expectedFingerprint: string | null,
  observedFingerprint: string | null
): boolean {
  return expectedFingerprint === null || observedFingerprint === expectedFingerprint;
}

/**
 * A final evidence read is authoritative only when no matching watcher event
 * advanced while that read was in flight and its consumed evidence still
 * matches the analysis snapshot. This pure predicate is intentionally shared
 * with race tests so watcher ordering remains an explicit contract.
 */
export function projectCompatibilityFinalReadIsCurrent(input: {
  generationBeforeRead: number;
  generationAfterRead: number;
  expectedFingerprint: string | null;
  observedFingerprint: string | null;
}): boolean {
  return input.generationAfterRead === input.generationBeforeRead &&
    projectCompatibilityEvidenceIsCurrent(input.expectedFingerprint, input.observedFingerprint);
}
