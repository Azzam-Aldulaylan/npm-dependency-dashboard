import type { SecurityOutcome } from './webviewProtocol.js';

/**
 * Combines independently evaluated root-package outcomes for one coordinated
 * upgrade. A remaining advisory wins over unknown evidence, and unknown wins
 * over resolved. The details remain intact so the modal can attribute each
 * advisory to its original dependency path.
 */
export function combineSecurityOutcomes(outcomes: readonly SecurityOutcome[]): SecurityOutcome | null {
  const applicable = outcomes.filter((outcome) => outcome.status !== 'not-applicable');
  if (applicable.length === 0) return null;
  const status = applicable.some((outcome) => outcome.status === 'remains')
    ? 'remains'
    : applicable.some((outcome) => outcome.status === 'unknown')
      ? 'unknown'
      : 'resolved';
  return {
    status,
    resolvedAdvisories: applicable.flatMap((outcome) => outcome.resolvedAdvisories),
    remaining: applicable.flatMap((outcome) => outcome.remaining),
  };
}
