import { performance } from 'node:perf_hooks';

import { validateProjectCompatibilityIdentity } from './findings.js';
import type {
  ProjectCompatibilityAnalysis,
  ProjectCompatibilityAnalyzer,
  ProjectCompatibilityAnalyzerResult,
  ProjectCompatibilityIdentity,
} from './types.js';

export const MAX_PROJECT_COMPATIBILITY_FINDINGS = 400;

export function limitProjectCompatibilityAnalyzerResults(
  results: readonly ProjectCompatibilityAnalyzerResult[],
  maxFindings = MAX_PROJECT_COMPATIBILITY_FINDINGS
): ProjectCompatibilityAnalyzerResult[] {
  let remaining = Math.max(0, Math.floor(maxFindings));
  return results.map((result) => {
    const findings = result.findings.slice(0, remaining);
    remaining -= findings.length;
    if (findings.length === result.findings.length) return { ...result, findings };
    return {
      ...result,
      status: 'partial',
      findings,
      unavailableReason: 'finding-limit-reached',
    };
  });
}

function cancelled(cause: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true || (cause instanceof Error && cause.name === 'AbortError');
}

/**
 * Runs analyzers independently: a target-package extraction failure must not
 * erase successful engine, script, or framework findings.
 */
export async function runProjectCompatibilityAnalyzers(input: {
  identity: ProjectCompatibilityIdentity;
  analyzers: readonly ProjectCompatibilityAnalyzer[];
  signal?: AbortSignal;
  now?: () => Date;
}): Promise<ProjectCompatibilityAnalysis> {
  validateProjectCompatibilityIdentity(input.identity);
  const now = input.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const analyzers: ProjectCompatibilityAnalyzerResult[] = [];

  for (let index = 0; index < input.analyzers.length; index += 1) {
    const analyzer = input.analyzers[index];
    if (analyzer === undefined) continue;
    const started = performance.now();
    try {
      if (input.signal?.aborted === true) {
        analyzers.push({
          analyzerId: `analyzer-${index}`,
          status: 'cancelled',
          findings: [],
          durationMs: performance.now() - started,
        });
        continue;
      }
      const result = await analyzer({ identity: input.identity }, input.signal);
      if (
        result.findings.some(
          (finding) =>
            finding.packageName !== input.identity.packageName ||
            finding.targetVersion !== input.identity.targetVersion
        )
      ) {
        analyzers.push({
          analyzerId: result.analyzerId,
          status: 'unavailable',
          findings: [],
          unavailableReason: 'analyzer-output-identity-mismatch',
          durationMs: performance.now() - started,
        });
        continue;
      }
      analyzers.push({ ...result, durationMs: performance.now() - started });
    } catch (cause) {
      analyzers.push({
        analyzerId: `analyzer-${index}`,
        status: cancelled(cause, input.signal) ? 'cancelled' : 'unavailable',
        findings: [],
        unavailableReason: cancelled(cause, input.signal) ? 'cancelled' : 'analyzer-failed',
        durationMs: performance.now() - started,
      });
    }
  }

  const limitedAnalyzers = limitProjectCompatibilityAnalyzerResults(analyzers);
  return {
    identity: input.identity,
    analyzers: limitedAnalyzers,
    findings: limitedAnalyzers.flatMap((result) => result.findings),
    startedAt,
    completedAt: now().toISOString(),
  };
}

export function projectCompatibilityIdentityMatches(
  left: ProjectCompatibilityIdentity,
  right: ProjectCompatibilityIdentity
): boolean {
  return (
    left.packageName === right.packageName &&
    left.currentVersion === right.currentVersion &&
    left.targetVersion === right.targetVersion &&
    left.requestId === right.requestId &&
    left.sourceFingerprint === right.sourceFingerprint
  );
}
