import type {
  ProjectCompatibilityAnalysis,
  ProjectCompatibilityConfidence,
  ProjectCompatibilityFinding,
} from './webviewProtocol.js';

export interface ProjectCompatibilitySummary {
  confirmed: number;
  likely: number;
  review: number;
  total: number;
  runtimeStatus: 'complete' | 'partial' | 'unavailable' | 'cancelled' | 'missing';
  incompleteAnalyzers: Array<{
    analyzerId: string;
    status: 'partial' | 'unavailable' | 'cancelled';
    reason?: string;
  }>;
}

const CONFIDENCE_ORDER: readonly ProjectCompatibilityConfidence[] = ['confirmed', 'likely', 'review'];

export function groupProjectCompatibilityFindings(
  analysis: ProjectCompatibilityAnalysis
): Array<{ confidence: ProjectCompatibilityConfidence; findings: ProjectCompatibilityFinding[] }> {
  return CONFIDENCE_ORDER.map((confidence) => ({
    confidence,
    findings: analysis.findings
      .filter((finding) => finding.confidence === confidence)
      .sort((left, right) => left.category.localeCompare(right.category) || left.title.localeCompare(right.title) || left.id.localeCompare(right.id)),
  })).filter((group) => group.findings.length > 0);
}

export function summarizeProjectCompatibility(analysis: ProjectCompatibilityAnalysis): ProjectCompatibilitySummary {
  const confirmed = analysis.findings.filter((finding) => finding.confidence === 'confirmed').length;
  const likely = analysis.findings.filter((finding) => finding.confidence === 'likely').length;
  const review = analysis.findings.filter((finding) => finding.confidence === 'review').length;
  const runtime = analysis.analyzers.find((analyzer) => analyzer.analyzerId === 'runtime-compatibility');
  const incompleteAnalyzers = analysis.analyzers.flatMap((analyzer) => {
    if (analyzer.status === 'complete') return [];
    return [{
      analyzerId: analyzer.analyzerId,
      status: analyzer.status,
      ...(analyzer.unavailableReason === undefined ? {} : { reason: analyzer.unavailableReason }),
    }];
  });
  return {
    confirmed,
    likely,
    review,
    total: confirmed + likely + review,
    runtimeStatus: runtime?.status ?? 'missing',
    incompleteAnalyzers,
  };
}
