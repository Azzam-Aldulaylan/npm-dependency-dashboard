import type {
  CleanupActionOutcome,
  CleanupMetric,
  CleanupReport,
  CleanupReportMetrics,
} from './types.js';

export interface CleanupMetricInput {
  before: number | null;
  after: number | null;
  unavailableReason?: string;
}

export interface BuildCleanupReportOptions {
  generatedAt: string;
  metrics: {
    directDependencies: CleanupMetricInput;
    deprecatedDirectDependencies: CleanupMetricInput;
    duplicateVersionGroups: CleanupMetricInput;
    vulnerabilities: CleanupMetricInput;
  };
  actions: readonly CleanupActionOutcome[];
}

function metric(input: CleanupMetricInput): CleanupMetric {
  if (input.before === null || input.after === null) {
    return {
      status: 'unavailable',
      reason: input.unavailableReason ?? 'This outcome could not be verified.',
    };
  }
  return {
    status: 'verified',
    before: input.before,
    after: input.after,
    improvedBy: Math.max(0, input.before - input.after),
    regressedBy: Math.max(0, input.after - input.before),
  };
}

function outcomeHeadlineParts(
  metrics: CleanupReportMetrics,
  actions: readonly CleanupActionOutcome[]
): string[] {
  const parts: string[] = [];
  if (metrics.directDependencies.status === 'verified' && metrics.directDependencies.improvedBy > 0) {
    const count = metrics.directDependencies.improvedBy;
    parts.push(`${count} direct ${count === 1 ? 'dependency' : 'dependencies'} removed`);
  }
  if (metrics.duplicateVersionGroups.status === 'verified' && metrics.duplicateVersionGroups.improvedBy > 0) {
    const count = metrics.duplicateVersionGroups.improvedBy;
    parts.push(`${count} duplicate-version ${count === 1 ? 'group' : 'groups'} reduced`);
  }
  if (metrics.vulnerabilities.status === 'verified' && metrics.vulnerabilities.improvedBy > 0) {
    const count = metrics.vulnerabilities.improvedBy;
    parts.push(`${count} ${count === 1 ? 'vulnerability' : 'vulnerabilities'} resolved`);
  }
  if (metrics.deprecatedDirectDependencies.status === 'verified' && metrics.deprecatedDirectDependencies.improvedBy > 0) {
    const count = metrics.deprecatedDirectDependencies.improvedBy;
    parts.push(`${count} deprecated direct ${count === 1 ? 'dependency' : 'dependencies'} removed`);
  }

  if (metrics.vulnerabilities.status === 'verified' && metrics.vulnerabilities.regressedBy > 0) {
    const count = metrics.vulnerabilities.regressedBy;
    parts.push(`${count} ${count === 1 ? 'vulnerability' : 'vulnerabilities'} introduced`);
  }

  const failed = actions.filter((action) => action.status === 'failed').length;
  if (failed > 0) parts.push(`${failed} cleanup ${failed === 1 ? 'action' : 'actions'} failed`);

  if (parts.length === 0) {
    const completed = actions.filter((action) => action.status === 'completed').length;
    if (completed > 0) parts.push(`${completed} cleanup ${completed === 1 ? 'action' : 'actions'} completed`);
  }
  if (parts.length === 0) parts.push('No verified cleanup change');
  return parts;
}

export function buildCleanupReport(options: BuildCleanupReportOptions): CleanupReport {
  const metrics: CleanupReportMetrics = {
    directDependencies: metric(options.metrics.directDependencies),
    deprecatedDirectDependencies: metric(options.metrics.deprecatedDirectDependencies),
    duplicateVersionGroups: metric(options.metrics.duplicateVersionGroups),
    vulnerabilities: metric(options.metrics.vulnerabilities),
  };
  const actions = [...options.actions];
  const headlineParts = outcomeHeadlineParts(metrics, actions);
  return {
    generatedAt: options.generatedAt,
    metrics,
    actions,
    headlineParts,
    headline: headlineParts.join(' · '),
  };
}
