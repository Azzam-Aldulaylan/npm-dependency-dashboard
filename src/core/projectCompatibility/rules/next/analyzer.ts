import type { ProjectCompatibilityAnalyzerResult } from '../../types.js';
import { runNextProjectCompatibilityRules } from './rules.js';
import type { NextRuleAnalysisInput, NextRuleProjectEvidence } from './types.js';

export function analyzeNextProjectCompatibility(
  input: NextRuleAnalysisInput,
  signal?: AbortSignal
): ProjectCompatibilityAnalyzerResult {
  if (signal?.aborted === true) {
    return { analyzerId: 'next-migration-rules', status: 'cancelled', findings: [] };
  }
  if (input.identity.packageName !== 'next') {
    return { analyzerId: 'next-migration-rules', status: 'complete', findings: [] };
  }
  return {
    analyzerId: 'next-migration-rules',
    status: 'complete',
    findings: runNextProjectCompatibilityRules(input),
  };
}
export function createNextProjectCompatibilityAnalyzer(evidence: NextRuleProjectEvidence) {
  return (context: { identity: NextRuleAnalysisInput['identity'] }, signal?: AbortSignal) =>
    analyzeNextProjectCompatibility({ ...evidence, identity: context.identity }, signal);
}
