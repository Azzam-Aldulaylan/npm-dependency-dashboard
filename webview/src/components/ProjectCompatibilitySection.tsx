import type { ReactElement } from 'react';

import type {
  ProjectCompatibilityAnalysis,
  ProjectCompatibilityCategory,
  ProjectCompatibilityConfidence,
  ProjectCompatibilityEvidence,
  ProjectCompatibilityFinding,
} from '../../../src/host/webviewProtocol.js';
import { groupProjectCompatibilityFindings, summarizeProjectCompatibility } from '../../../src/host/projectCompatibilityUiState.js';
import { IconAlertTriangle, IconCheck, IconExternalLink, IconHelpCircle, IconRoute } from '../icons.js';

interface ConfidencePresentation {
  label: string;
  emptyLabel: string;
  className: string;
}

const CONFIDENCE_ORDER: readonly ProjectCompatibilityConfidence[] = ['confirmed', 'likely', 'review'];

const CONFIDENCE_PRESENTATION: Record<ProjectCompatibilityConfidence, ConfidencePresentation> = {
  confirmed: {
    label: 'Confirmed incompatibilities',
    emptyLabel: 'Confirmed',
    className: 'project-compat__confidence--confirmed',
  },
  likely: {
    label: 'Likely migrations',
    emptyLabel: 'Migrations',
    className: 'project-compat__confidence--likely',
  },
  review: {
    label: 'Review recommended',
    emptyLabel: 'Review',
    className: 'project-compat__confidence--review',
  },
};

const CATEGORY_LABEL: Record<ProjectCompatibilityCategory, string> = {
  import: 'Import',
  'private-api': 'Private API',
  runtime: 'Runtime',
  config: 'Configuration',
  script: 'Package script',
  tooling: 'Tooling',
  compiler: 'Compiler',
  'framework-migration': 'Framework migration',
};

const ANALYZER_LABEL: Record<string, string> = {
  'import-compatibility': 'Import compatibility',
  'runtime-compatibility': 'Runtime requirements',
  'package-script-compatibility': 'Package scripts',
  'tooling-peer-alignment': 'Related tooling',
  'next-migration-rules': 'Next.js migration rules',
};

function confidenceIcon(confidence: ProjectCompatibilityConfidence): ReactElement {
  if (confidence === 'confirmed') return <IconAlertTriangle />;
  if (confidence === 'likely') return <IconRoute />;
  return <IconHelpCircle />;
}

function evidencePrimary(evidence: ProjectCompatibilityEvidence): string {
  if (evidence.filePath !== undefined) {
    const position = evidence.line !== undefined ? `:${evidence.line}${evidence.column !== undefined ? `:${evidence.column}` : ''}` : '';
    return `${evidence.filePath}${position}`;
  }
  if (evidence.specifier !== undefined) return evidence.specifier;
  if (evidence.context !== undefined) return evidence.context;
  return 'Analyzer evidence';
}

function EvidenceItem({
  evidence,
  onOpenUsageReference,
}: {
  evidence: ProjectCompatibilityEvidence;
  onOpenUsageReference?: ((usageId: string, referenceIndex: number) => void) | undefined;
}): ReactElement {
  const usageId = evidence.usageId;
  const referenceIndex = evidence.referenceIndex;
  const canOpen = usageId !== undefined && referenceIndex !== undefined && onOpenUsageReference !== undefined;
  const primary = evidencePrimary(evidence);

  return (
    <li className="project-compat__evidence">
      <div className="project-compat__evidence-main">
        {canOpen ? (
          <button
            type="button"
            className="project-compat__source"
            onClick={() => {
              if (usageId !== undefined && referenceIndex !== undefined) onOpenUsageReference?.(usageId, referenceIndex);
            }}
            aria-label={`Open ${primary}`}
          >
            <code>{primary}</code>
            <IconExternalLink />
          </button>
        ) : (
          <code>{primary}</code>
        )}
      </div>
      {evidence.specifier !== undefined && evidence.specifier !== primary ? (
        <div className="project-compat__specifier"><code>{evidence.specifier}</code></div>
      ) : null}
      {evidence.snippet !== undefined ? <pre className="project-compat__snippet">{evidence.snippet}</pre> : null}
    </li>
  );
}

function FindingItem({
  finding,
  onOpenUsageReference,
}: {
  finding: ProjectCompatibilityFinding;
  onOpenUsageReference?: ((usageId: string, referenceIndex: number) => void) | undefined;
}): ReactElement {
  return (
    <li className="project-compat__finding">
      <div className="project-compat__finding-head">
        <span className="project-compat__category">{CATEGORY_LABEL[finding.category]}</span>
        <strong>{finding.title}</strong>
      </div>
      <p className="project-compat__explanation">{finding.explanation}</p>
      {finding.evidence.length > 0 ? (
        <ul className="project-compat__evidence-list">
          {finding.evidence.map((evidence, index) => (
            <EvidenceItem
              evidence={evidence}
              onOpenUsageReference={onOpenUsageReference}
              key={`${finding.id}:evidence:${index}`}
            />
          ))}
        </ul>
      ) : null}
      {finding.migrationHint !== undefined ? (
        <p className="project-compat__migration"><span>Migration:</span> {finding.migrationHint}</p>
      ) : null}
    </li>
  );
}

function analyzerLabel(analyzerId: string): string {
  return ANALYZER_LABEL[analyzerId] ?? analyzerId.replaceAll('-', ' ');
}

/**
 * A confidence-first evidence ledger for host-owned project compatibility
 * findings. The webview groups and presents facts, but never derives new
 * compatibility claims from versions, paths, or source text.
 */
export function ProjectCompatibilitySection({
  analysis,
  onOpenUsageReference,
}: {
  analysis: ProjectCompatibilityAnalysis;
  onOpenUsageReference?: ((usageId: string, referenceIndex: number) => void) | undefined;
}): ReactElement {
  const groups = groupProjectCompatibilityFindings(analysis);
  const grouped = new Map(groups.map((group) => [group.confidence, group.findings]));
  const summary = summarizeProjectCompatibility(analysis);
  const incomplete = summary.incompleteAnalyzers;
  const allCompleted = analysis.analyzers.length > 0 && incomplete.length === 0;
  const noFindings = analysis.findings.length === 0;

  return (
    <section className="analysis-card analysis-card--full project-compat" aria-labelledby="project-compat-heading">
      <div className="project-compat__heading-row">
        <h3 className="analysis-card__title" id="project-compat-heading">
          <IconRoute className="analysis-card__title-icon" />
          Project compatibility
        </h3>
        <span className="project-compat__target">Target <code>{analysis.identity.targetVersion}</code></span>
      </div>

      <div className="project-compat__confidence-rail" aria-label="Project compatibility finding counts">
        {CONFIDENCE_ORDER.map((confidence) => {
          const presentation = CONFIDENCE_PRESENTATION[confidence];
          const count = grouped.get(confidence)?.length ?? 0;
          return (
            <div className={`project-compat__confidence ${presentation.className}`} key={confidence}>
              <span className="project-compat__confidence-icon" aria-hidden="true">{count === 0 ? <IconCheck /> : confidenceIcon(confidence)}</span>
              <span className="project-compat__confidence-count">{count}</span>
              <span className="project-compat__confidence-label">{presentation.emptyLabel}</span>
            </div>
          );
        })}
      </div>

      {noFindings ? (
        <p className={`project-compat__empty${allCompleted ? ' project-compat__empty--complete' : ''}`}>
          {allCompleted
            ? 'Completed checks found no project compatibility issues for this target.'
            : 'No issues were found by the checks that completed. Some compatibility checks are unavailable.'}
        </p>
      ) : (
        <div className="project-compat__groups">
          {CONFIDENCE_ORDER.map((confidence) => {
            const findings = grouped.get(confidence) ?? [];
            if (findings.length === 0) return null;
            const presentation = CONFIDENCE_PRESENTATION[confidence];
            return (
              <details className={`project-compat__group ${presentation.className}`} open={confidence === 'confirmed'} key={confidence}>
                <summary>
                  <span className="project-compat__confidence-icon" aria-hidden="true">{confidenceIcon(confidence)}</span>
                  <span>{presentation.label}</span>
                  <span className="project-compat__group-count">{findings.length}</span>
                </summary>
                <ul className="project-compat__finding-list">
                  {findings.map((finding) => (
                    <FindingItem finding={finding} onOpenUsageReference={onOpenUsageReference} key={finding.id} />
                  ))}
                </ul>
              </details>
            );
          })}
        </div>
      )}

      {incomplete.length > 0 ? (
        <div className="project-compat__unavailable" role="status">
          <IconHelpCircle aria-hidden="true" />
          <div>
            <strong>Some checks could not be completed</strong>
            <ul>
              {incomplete.map((analyzer) => (
                <li key={analyzer.analyzerId}>
                  {analyzerLabel(analyzer.analyzerId)}: {analyzer.status === 'cancelled' ? 'cancelled' : analyzer.status === 'partial' ? 'partially checked' : 'could not verify'}
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}
    </section>
  );
}
