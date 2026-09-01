import type { ReactElement } from 'react';

import type {
  TransitiveRemediationAdvisorySummary,
  TransitiveRemediationChange,
  TransitiveRemediationPlanSummary,
  TransitiveRemediationProgressPhase,
} from '../../../src/host/webviewProtocol.js';
import type { TransitiveFixUiState } from '../transitiveRemediationState.js';
import {
  IconAlertTriangle,
  IconCheck,
  IconFile,
  IconHelpCircle,
  IconInfo,
  IconListChecks,
  IconRefresh,
  IconRoute,
  IconShield,
  IconXCircle,
} from '../icons.js';
import { DirectionalButton } from './DirectionalButton.js';
import { SeverityBadge } from './SeverityBadge.js';
import { StatusBanner } from './StatusBanner.js';
import { VulnerabilityIdentifierLinks } from './VulnerabilityCard.js';
import type { OpenAdvisoryHandler } from './VulnerabilityCard.js';

const PROGRESS_LABEL: Record<TransitiveRemediationProgressPhase, string> = {
  preparing: 'Preparing the reviewed lockfile change…',
  installing: 'Installing the reviewed dependency tree…',
  'verifying-security': 'Checking that the vulnerabilities are resolved…',
  'verifying-project': 'Running project verification…',
  'rolling-back': 'Restoring the previous dependency state…',
};

function versionSet(versions: readonly string[], emptyLabel: string): string {
  return versions.length === 0 ? emptyLabel : versions.join(', ');
}

function ChangeSummary({ change }: { change: TransitiveRemediationChange }): ReactElement {
  return (
    <li className="transitive-review__change">
      <div className="transitive-review__change-line">
        <code>{change.packageName}</code>
        <span className="transitive-review__version"><code>{versionSet(change.fromVersions, 'Not installed')}</code></span>
        <span aria-hidden="true">→</span>
        <span className="transitive-review__version transitive-review__version--target"><code>{versionSet(change.toVersions, 'Removed')}</code></span>
        {change.targeted ? <span className="status-badge">Security target</span> : null}
      </div>
      {change.affectedPaths.length > 0 ? (
        <details className="transitive-review__paths">
          <summary>{change.affectedPaths.length} affected dependency {change.affectedPaths.length === 1 ? 'path' : 'paths'}</summary>
          <ul>
            {change.affectedPaths.map((path) => <li key={path.join('\u0000')}><code>{path.join(' → ')}</code></li>)}
          </ul>
        </details>
      ) : (
        <p className="transitive-review__related-change">Additional lockfile change</p>
      )}
    </li>
  );
}

function AdvisoryList({
  title,
  advisories,
  tone,
  rootPackage,
  onOpenAdvisory,
}: {
  title: string;
  advisories: readonly TransitiveRemediationAdvisorySummary[];
  tone: 'resolved' | 'remaining' | 'introduced';
  rootPackage: string;
  onOpenAdvisory: OpenAdvisoryHandler;
}): ReactElement | null {
  if (advisories.length === 0) return null;
  return (
    <section className={`transitive-review__advisories transitive-review__advisories--${tone}`}>
      <h5>{title} <span>{advisories.length}</span></h5>
      <ul>
        {advisories.map((advisory) => (
          <li key={`${advisory.advisoryId}:${advisory.flaggedPackage}`}>
            <SeverityBadge severity={advisory.severity} />
            <span className="transitive-review__advisory-copy">
              <VulnerabilityIdentifierLinks
                identifiers={advisory.identifiers}
                onOpen={(identifier) => onOpenAdvisory(
                  rootPackage,
                  identifier,
                  advisory.affectedPaths[0] ?? [rootPackage],
                  identifier
                )}
              />
              <span>{advisory.flaggedPackage} — {advisory.title}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function SafetyFacts({ plan }: { plan: TransitiveRemediationPlanSummary }): ReactElement {
  return (
    <div className="transitive-review__facts">
      <section>
        <h5><IconShield /> Safety checks</h5>
        <dl>
          <div><dt>Direct dependency</dt><dd><code>{plan.rootPackage}@{plan.currentVersion}</code> unchanged</dd></div>
          <div><dt>New vulnerabilities</dt><dd>{plan.introducedAdvisories.length === 0 ? 'None found' : plan.introducedAdvisories.length}</dd></div>
        </dl>
      </section>
      <section>
        <h5><IconFile /> Files</h5>
        <dl>
          <div><dt>{plan.files.manifestPath}</dt><dd>{plan.files.manifestChanged ? 'Changes' : 'Unchanged'}</dd></div>
          <div><dt>{plan.files.lockfilePath}</dt><dd>{plan.files.lockfileChanged ? 'Changes' : 'Unchanged'}</dd></div>
        </dl>
      </section>
      <section>
        <h5><IconListChecks /> Verification</h5>
        <p>
          {plan.verification.configured
            ? `Security rescan plus ${plan.verification.scriptNames.join(', ')}`
            : 'Security rescan; no project verification scripts configured'}
        </p>
        <p>
          Installed packages will be reconciled to the reviewed lockfile. Lifecycle scripts are{' '}
          {plan.lifecycleScriptsEnabled ? 'enabled' : 'disabled'}.
        </p>
      </section>
    </div>
  );
}

function DetailedPlan({
  plan,
  onOpenAdvisory,
}: {
  plan: TransitiveRemediationPlanSummary;
  onOpenAdvisory: OpenAdvisoryHandler;
}): ReactElement {
  return (
    <div className="transitive-review__details">
      <section>
        <h4>Dependency changes</h4>
        <ul className="transitive-review__changes">
          {plan.changes.map((change) => <ChangeSummary key={`${change.packageName}:${change.affectedPaths.map((path) => path.join('>')).join('|')}`} change={change} />)}
        </ul>
      </section>
      <section>
        <h4>Security impact</h4>
        <div className="transitive-review__advisory-groups">
          <AdvisoryList title="Resolved" advisories={plan.resolvedAdvisories} tone="resolved" rootPackage={plan.rootPackage} onOpenAdvisory={onOpenAdvisory} />
          <AdvisoryList title="Still present" advisories={plan.remainingAdvisories} tone="remaining" rootPackage={plan.rootPackage} onOpenAdvisory={onOpenAdvisory} />
          <AdvisoryList title="Introduced" advisories={plan.introducedAdvisories} tone="introduced" rootPackage={plan.rootPackage} onOpenAdvisory={onOpenAdvisory} />
        </div>
      </section>
      <SafetyFacts plan={plan} />
    </div>
  );
}

function PlanUnavailable({
  plan,
  onRetry,
  onOpenAdvisory,
  disabled,
}: {
  plan: TransitiveRemediationPlanSummary;
  onRetry: (analysisId: string) => void;
  disabled: boolean;
  onOpenAdvisory: OpenAdvisoryHandler;
}): ReactElement {
  const unsafe = plan.outcome === 'unsafe';
  return (
    <div className="transitive-review__outcome">
      <StatusBanner
        tone={unsafe ? 'warning' : 'info'}
        icon={unsafe ? <IconAlertTriangle /> : plan.outcome === 'unavailable' ? <IconHelpCircle /> : <IconXCircle />}
        action={{ label: 'Check again', onClick: () => onRetry(plan.analysisId), disabled, icon: <IconRefresh /> }}
      >
        <strong>{unsafe ? 'Automatic fix blocked' : plan.outcome === 'unavailable' ? 'Could not verify a fix' : 'No compatible fix found'}</strong>
        <span>{plan.explanation}</span>
      </StatusBanner>
      {plan.blockingReasons.length > 0 ? (
        <ul className="transitive-review__reasons">
          {plan.blockingReasons.map((reason) => <li key={reason}>{reason}</li>)}
        </ul>
      ) : null}
      {plan.changes.length > 0 ? <DetailedPlan plan={plan} onOpenAdvisory={onOpenAdvisory} /> : null}
    </div>
  );
}

export function TransitiveFixReview({
  rootPackage,
  subject,
  dependencyPath,
  state,
  disabled,
  onAnalyze,
  onReview,
  onApply,
  onCancel,
  onRetry,
  onOpenAdvisory,
}: {
  rootPackage: string;
  subject: string;
  dependencyPath: readonly string[];
  state: TransitiveFixUiState | undefined;
  disabled: boolean;
  onAnalyze: () => void;
  onReview: (analysisId: string) => void;
  onApply: (analysisId: string) => void;
  onCancel: (analysisId: string) => void;
  onRetry: (analysisId: string) => void;
  onOpenAdvisory: OpenAdvisoryHandler;
}): ReactElement {
  if (state === undefined) {
    return (
      <div className="transitive-review">
        <p className="transitive-review__context"><code>{subject}</code> is introduced through <code>{dependencyPath.join(' → ')}</code>.</p>
        <DirectionalButton direction="forward" className="button button--primary transitive-review__primary" disabled={disabled} onClick={onAnalyze}>
          Check transitive fixes
        </DirectionalButton>
      </div>
    );
  }

  if (state.phase === 'analyzing') {
    return (
      <div className="transitive-review" role="status" aria-live="polite">
        <p className="transitive-review__progress"><IconRefresh className="banner__icon--spin" /> Checking compatible lockfile changes and security impact…</p>
      </div>
    );
  }

  if (state.phase === 'error') {
    return (
      <div className="transitive-review">
        <StatusBanner tone="error" action={{ label: 'Try again', onClick: onAnalyze, disabled, icon: <IconRefresh /> }}>
          <strong>Couldn’t check transitive fixes</strong>
          <span>{state.message}</span>
        </StatusBanner>
      </div>
    );
  }

  if (state.phase === 'not-needed') {
    return (
      <div className="transitive-review">
        <StatusBanner tone="info" icon={<IconCheck />}>
          <strong>No transitive fix needed</strong>
          <span>{state.message}</span>
        </StatusBanner>
      </div>
    );
  }

  if (state.phase === 'legacy-result') {
    return (
      <div className="transitive-review">
        <StatusBanner
          tone="warning"
          icon={<IconRefresh />}
        >
          <strong>Reload the Extension Development Host</strong>
          <span>
            This panel received the older transitive-check response for <code>{rootPackage}</code>. Reload the development host,
            reopen the dashboard, and check the fix again to build an actionable plan.
          </span>
        </StatusBanner>
      </div>
    );
  }

  const plan = state.plan;
  if (state.phase === 'stale') {
    return (
      <div className="transitive-review">
        <StatusBanner tone="warning" action={{ label: 'Re-check fix', onClick: () => onRetry(plan.analysisId), disabled, icon: <IconRefresh /> }}>
          <strong>Fix review is out of date</strong>
          <span>{state.message}</span>
        </StatusBanner>
      </div>
    );
  }

  if (state.phase === 'applying') {
    return (
      <div className="transitive-review">
        <p className="transitive-review__progress" role="status" aria-live="polite">
          <IconRefresh className="banner__icon--spin" />
          {state.cancelRequested ? 'Stopping at a safe point, then restoring if needed…' : PROGRESS_LABEL[state.progress]}
        </p>
        <DetailedPlan plan={plan} onOpenAdvisory={onOpenAdvisory} />
        <button type="button" className="button button--secondary" disabled={state.cancelRequested} onClick={() => onCancel(plan.analysisId)}>
          {state.cancelRequested ? 'Cancelling…' : 'Cancel fix'}
        </button>
      </div>
    );
  }

  if (state.phase === 'result') {
    const result = state.result;
    const success = result.outcome === 'verified';
    const caution = result.outcome === 'partial';
    const recheckAvailable = result.outcome !== 'recovery-required';
    return (
      <div className="transitive-review">
        <StatusBanner
          tone={result.outcome === 'recovery-required' ? 'error' : success ? 'info' : 'warning'}
          icon={success ? <IconCheck /> : result.outcome === 'recovery-required' || caution ? <IconAlertTriangle /> : <IconInfo />}
          {...(recheckAvailable
            ? { action: { label: 'Check again', onClick: onAnalyze, disabled, icon: <IconRefresh /> } }
            : {})}
        >
          <strong>{
            result.outcome === 'verified' ? 'Transitive fix applied and verified'
              : result.outcome === 'partial' ? 'Partial transitive fix applied'
                : result.outcome === 'rolled-back' ? 'Changes rolled back'
                  : result.outcome === 'cancelled' ? 'Fix cancelled'
                    : result.outcome === 'unverified' ? 'Fix applied but not verified'
                      : 'Recovery required'
          }</strong>
          <span>{result.message}</span>
        </StatusBanner>
        <dl className="transitive-review__result-facts">
          <div><dt>Security verification</dt><dd>{result.verification.replaceAll('-', ' ')}</dd></div>
          <div><dt>Rollback</dt><dd>{result.rollback.replaceAll('-', ' ')}</dd></div>
        </dl>
        {result.outcome === 'recovery-required' ? (
          <section className="transitive-review__recovery">
            <h5>Recover the installed dependency state</h5>
            <p>
              Review <code>{plan.files.manifestPath}</code> and <code>{plan.files.lockfilePath}</code>, then run{' '}
              <code>{plan.packageManager === 'pnpm' ? 'pnpm install --frozen-lockfile' : 'npm ci'}</code> from the project root.
              Refresh the dashboard after it succeeds.
            </p>
          </section>
        ) : null}
        <AdvisoryList title="Resolved" advisories={result.resolvedAdvisories} tone="resolved" rootPackage={plan.rootPackage} onOpenAdvisory={onOpenAdvisory} />
        <AdvisoryList title="Still present" advisories={result.remainingAdvisories} tone="remaining" rootPackage={plan.rootPackage} onOpenAdvisory={onOpenAdvisory} />
        <AdvisoryList title="Introduced" advisories={result.introducedAdvisories} tone="introduced" rootPackage={plan.rootPackage} onOpenAdvisory={onOpenAdvisory} />
      </div>
    );
  }

  if (plan.outcome === 'no-fix' || plan.outcome === 'unsafe' || plan.outcome === 'unavailable') {
    return <PlanUnavailable plan={plan} onRetry={onRetry} disabled={disabled} onOpenAdvisory={onOpenAdvisory} />;
  }

  const targeted = plan.changes.filter((change) => change.targeted);
  const headlineChanges = targeted.length > 0 ? targeted : plan.changes;
  return (
    <div className="transitive-review">
      <StatusBanner tone={plan.outcome === 'partial' ? 'warning' : 'info'} icon={plan.outcome === 'partial' ? <IconAlertTriangle /> : <IconRoute />}>
        <strong>{plan.outcome === 'partial' ? 'Partial transitive fix available' : 'Transitive fix available'}</strong>
        <span>
          {headlineChanges.map((change) => `${change.packageName} ${versionSet(change.fromVersions, 'not installed')} → ${versionSet(change.toVersions, 'removed')}`).join('; ')}.
          {' '}This does not change <code>{plan.rootPackage}</code> from <code>{plan.currentVersion}</code>.
        </span>
      </StatusBanner>
      {state.reviewed ? (
        <>
          <DetailedPlan plan={plan} onOpenAdvisory={onOpenAdvisory} />
          <div className="transitive-review__actions">
            <button type="button" className="button button--secondary" disabled={disabled} onClick={() => onRetry(plan.analysisId)}>
              <IconRefresh /> Re-check plan
            </button>
            <DirectionalButton direction="forward" className="button button--primary" disabled={disabled} onClick={() => onApply(plan.analysisId)}>
              {plan.outcome === 'partial' ? 'Apply partial fix' : 'Apply fix'}
            </DirectionalButton>
          </div>
        </>
      ) : (
        <DirectionalButton direction="forward" className="button button--primary transitive-review__primary" disabled={disabled} onClick={() => onReview(plan.analysisId)}>
          Review fix
        </DirectionalButton>
      )}
    </div>
  );
}
