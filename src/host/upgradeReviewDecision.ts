import type { OutcomeDisplay } from './outcomeCopy.js';
import type { ProjectCompatibilityAnalysis, SecurityOutcome, UpgradeAnalysisCompatibility } from './webviewProtocol.js';

export type UpgradeProjectReviewState = 'confirmed' | 'review' | 'incomplete' | 'missing' | 'checked';

export interface UpgradeReviewDecisionInput {
  compatibility: UpgradeAnalysisCompatibility;
  projectCompatibility?: ProjectCompatibilityAnalysis | undefined;
  security?: SecurityOutcome | null | undefined;
}

export interface UpgradeReviewDecision {
  headline: OutcomeDisplay;
  /** Presentation caution, not execution authority or a claim that upgrading is safe. */
  caution: boolean;
  projectState: UpgradeProjectReviewState;
  recommendation: string;
}

type ProjectCoverageState = 'missing' | 'incomplete' | 'checked';

function projectCoverageState(project: ProjectCompatibilityAnalysis | undefined): ProjectCoverageState {
  if (project === undefined || project.analyzers.length === 0) return 'missing';
  // Missing legacy evidence is not a completed check. These two analyzers
  // represent the runtime and source coverage the summary promises to review.
  if (!['runtime-compatibility', 'import-compatibility'].every((id) => project.analyzers.some((entry) => entry.analyzerId === id))) {
    return 'incomplete';
  }
  const incomplete = project.analyzers.some((entry) => entry.status !== 'complete' && !(
    entry.analyzerId === 'deprecated-api-compatibility' &&
    entry.status === 'unavailable' && entry.unavailableReason === 'deprecated-api-rules-unavailable'
  ));
  return incomplete ? 'incomplete' : 'checked';
}

function projectReviewState(project: ProjectCompatibilityAnalysis | undefined, coverage: ProjectCoverageState): UpgradeProjectReviewState {
  if (project?.findings.some((finding) => finding.confidence === 'confirmed')) return 'confirmed';
  if (project !== undefined && project.findings.length > 0) return 'review';
  return coverage;
}

function securityRecommendation(security: SecurityOutcome | null | undefined): string {
  if (security == null) return 'Security impact was not assessed.';
  const resolved = security.resolvedAdvisories.length;
  const remaining = security.remaining.filter((entry) => entry.status === 'remains').length;
  const unknown = security.remaining.some((entry) => entry.status === 'unknown') || security.status === 'unknown';
  const parts: string[] = [];
  if (resolved > 0) parts.push(`${resolved} known vulnerabilit${resolved === 1 ? 'y is' : 'ies are'} confirmed resolved by this plan.`);
  if (remaining > 0) parts.push(`${remaining} known vulnerabilit${remaining === 1 ? 'y remains' : 'ies remain'}. Review Security outcome.`);
  if (unknown) parts.push('Some security outcomes could not be verified. Review Security outcome.');
  if (parts.length === 0) {
    parts.push(security.status === 'not-applicable'
      ? 'No known vulnerabilities were reported for this review.'
      : 'Security impact could not be confirmed. Review Security outcome.');
  }
  return parts.join(' ');
}

/**
 * One scoped conclusion for the summary, recommendation and confirmation
 * action. Dependency resolution never certifies application compatibility;
 * completed static checks never certify every API or deployment runtime.
 */
export function deriveUpgradeReviewDecision(
  analysis: UpgradeReviewDecisionInput,
  coordinated = false
): UpgradeReviewDecision {
  const coverage = projectCoverageState(analysis.projectCompatibility);
  const projectState = projectReviewState(analysis.projectCompatibility, coverage);
  const dependencyIncomplete = analysis.compatibility.status === 'unknown' || analysis.compatibility.completeness !== 'complete';
  const conflict = analysis.compatibility.status === 'conflict';
  const caution = analysis.compatibility.status !== 'compatible' || dependencyIncomplete || projectState !== 'checked';
  let headline: OutcomeDisplay;
  let dependencyMessage: string;
  if (conflict) {
    headline = { label: 'Dependency conflict requires a plan', className: 'conflict' };
    dependencyMessage = coordinated
      ? 'Review the coordinated plan for dependency conflicts. It does not make source or configuration changes.'
      : 'A coordinated resolution could not be confirmed by this analysis. Choose another target or resolve the dependency conflict first.';
    if (dependencyIncomplete) dependencyMessage += ' Some dependency checks could not be completed; review them before upgrading.';
  } else if (dependencyIncomplete) {
    headline = { label: 'Compatibility checks incomplete', className: 'unknown' };
    dependencyMessage = 'Dependency compatibility could not be fully verified. Review the incomplete checks before upgrading.';
  } else if (analysis.compatibility.status === 'warning') {
    headline = { label: 'Dependency warnings need review', className: 'warning' };
    dependencyMessage = 'Review the dependency warnings before upgrading.';
  } else {
    headline = { label: 'No compatibility issues found in completed checks', className: 'compatible' };
    dependencyMessage = 'No dependency conflicts were found.';
  }

  let projectMessage: string;
  if (projectState === 'confirmed') {
    if (!conflict) headline = { label: 'Confirmed project compatibility issues', className: 'warning' };
    projectMessage = 'Review the confirmed findings and required project changes in Project compatibility details before upgrading.';
  } else if (projectState === 'review') {
    if (!conflict && !dependencyIncomplete) headline = { label: 'Project findings need review', className: 'warning' };
    projectMessage = 'Review the project findings and migration guidance before upgrading.';
  } else if (projectState === 'missing' || projectState === 'incomplete') {
    if (!conflict && analysis.compatibility.status === 'compatible') headline = { label: 'Project checks incomplete', className: 'unknown' };
    projectMessage = projectState === 'missing'
      ? 'Project compatibility was not checked. Analyze again and verify your build and runtime before upgrading.'
      : 'Some project checks could not be completed. Review their reasons and verify your build and runtime before upgrading.';
  } else {
    projectMessage = 'Completed project checks found no issues; coverage is limited. Run your build and tests after upgrading.';
  }
  // Findings and coverage are independent facts: a confirmed issue must not
  // conceal that other source files or checks could not be inspected.
  if ((projectState === 'confirmed' || projectState === 'review') && coverage !== 'checked') {
    projectMessage += ' Some project checks could not be completed. Review their reasons and verify your build and runtime before upgrading.';
  }
  return { headline, caution, projectState, recommendation: [dependencyMessage, projectMessage, securityRecommendation(analysis.security)].join(' ') };
}
