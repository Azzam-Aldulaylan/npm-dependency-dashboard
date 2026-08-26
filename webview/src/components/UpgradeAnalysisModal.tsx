import { useEffect, useRef } from 'react';
import type { ReactElement } from 'react';

import type { UpgradeAnalysisPresentation } from '../../../src/host/webviewProtocol.js';
import { compatibilityOutcomeDisplay } from '../../../src/host/outcomeCopy.js';
import { IconX } from '../icons.js';
import { CompatibilitySection } from './CompatibilitySection.js';
import { FilesSection } from './FilesSection.js';
import { OutcomeStatus } from './OutcomeStatus.js';
import { SecuritySection } from './SecuritySection.js';
import { SmartPlanSection } from './SmartPlanSection.js';
import { UpgradeAnalysisLoading } from './UpgradeAnalysisLoading.js';
import { VerificationSection } from './VerificationSection.js';

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function primaryAction(
  analysis: UpgradeAnalysisPresentation
): { label: string; onClick: 'confirm' | 'use-smart-plan' } | null {
  if (analysis.compatibility.status === 'conflict') {
    return analysis.smartPlan !== null ? { label: 'Use coordinated upgrade', onClick: 'use-smart-plan' } : null;
  }
  return {
    label:
      analysis.changes.length > 1
        ? analysis.compatibility.status === 'compatible'
          ? `Upgrade ${analysis.changes.length} dependencies`
          : `Upgrade ${analysis.changes.length} anyway`
        : analysis.compatibility.status === 'compatible'
          ? `Upgrade to ${analysis.targetVersion}`
          : 'Upgrade anyway',
    onClick: 'confirm',
  };
}

/**
 * The one headline the whole modal commits to — everything else (the
 * Compatibility card's own findings, Security's own vulnerability list)
 * explains *why*, but never repeats *what the overall answer is*. Compare
 * CompatibilitySection, which used to render this same large status line a
 * second time inside its own card; this redesign moves it here instead,
 * directly under the header, as the one place a 2-second read answers
 * "is this upgrade OK".
 */
export function overallStatusDetail(analysis: { compatibility: UpgradeAnalysisPresentation['compatibility'] }): string | undefined {
  const { compatibility } = analysis;
  if (compatibility.completeness === 'partial') return 'Some compatibility checks could not be completed.';
  const nonCompatible = compatibility.findings.filter((finding) => finding.status !== 'compatible').length;
  if (compatibility.status === 'compatible') return 'No blocking dependency conflicts were detected.';
  if (compatibility.status === 'warning') {
    return `The dependency tree resolves, but ${nonCompatible} issue${nonCompatible === 1 ? '' : 's'} deserve${nonCompatible === 1 ? 's' : ''} review.`;
  }
  if (compatibility.status === 'conflict') return 'Another dependency blocks this upgrade.';
  return undefined;
}

/**
 * The loading-or-result body content shared by the standalone
 * UpgradeAnalysisModal (bulk upgrades, opened from the "Manage
 * dependencies" bulk flow) and the embedded Upgrade review tab inside
 * ManageDependencyModal (single-package upgrades, reviewed in place —
 * never a second, separate dialog). No modal chrome of its own: the caller
 * owns the dialog/tab wrapper, header, and footer actions.
 */
export function UpgradeAnalysisBody({
  packageName,
  targetVersion,
  analyzingPhase,
  analysis,
  onOpenAdvisory,
  onConfigureVerification,
  pendingChanges,
}: {
  packageName: string;
  targetVersion: string;
  analyzingPhase: 'compatibility' | 'smart-plan' | null;
  analysis: UpgradeAnalysisPresentation | null;
  onOpenAdvisory: (packageName: string, advisoryId: string | number, path: string[]) => void;
  onConfigureVerification: () => void;
  pendingChanges?: readonly { packageName: string; targetVersion: string }[] | undefined;
}): ReactElement {
  const overall = analysis !== null ? compatibilityOutcomeDisplay(analysis.compatibility.status) : null;
  const securityNeedsAttention = analysis?.security?.status === 'remains';
  const displayedChanges = analysis?.changes ?? pendingChanges ?? [{ packageName, targetVersion }];

  if (analysis === null) {
    return (
      <UpgradeAnalysisLoading
        packageName={packageName}
        targetVersion={targetVersion}
        changeCount={displayedChanges.length}
        phase={analyzingPhase}
      />
    );
  }

  return (
    <>
      {overall !== null ? (
        <OutcomeStatus
          label={overall.label}
          className={overall.className}
          detail={overallStatusDetail(analysis)}
          size="large"
        />
      ) : null}

      {analysis.smartPlan !== null ? <SmartPlanSection smartPlan={analysis.smartPlan} /> : null}

      {analysis.changes.length > 1 ? (
        <section className="analysis-card analysis-card--full" aria-labelledby="analysis-selected-upgrades-heading">
          <h3 className="analysis-card__title" id="analysis-selected-upgrades-heading">Selected upgrades</h3>
          <ol className="smart-plan__changes">
            {analysis.changes.map((change) => (
              <li className="smart-plan__change" key={change.packageName}>
                <span className="smart-plan__package">{change.packageName}</span>
                <span className="smart-plan__versions">{change.currentVersion} → {change.targetVersion}</span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      <div className="modal__grid">
        <CompatibilitySection
          compatibility={analysis.compatibility}
          context={{ package: analysis.package, currentVersion: analysis.currentVersion }}
        />
        <SecuritySection
          security={analysis.security}
          rootPackageName={analysis.package}
          onOpenAdvisory={onOpenAdvisory}
          emphasize={securityNeedsAttention}
        />
        <FilesSection files={analysis.files} />
        <VerificationSection verification={analysis.verification} onConfigureVerification={onConfigureVerification} />
      </div>
    </>
  );
}

/**
 * The Upgrade Analysis / confirmation experience — a centered dialog inside
 * the dashboard webview, replacing the native `showWarningMessage` modal.
 * `analysis === null` renders the loading phase; once it arrives, the modal
 * never mutates its own contents — it only ever echoes `analysis.analysisId`
 * back in confirm/cancel/use-smart-plan (see webviewProtocol.ts's own doc on
 * why the webview never constructs execution authority). Used only for the
 * bulk-upgrade flow (opened from the "Manage dependencies" bulk actions
 * modal) — a single-package upgrade reviewed from Manage dependency renders
 * this same content inline via UpgradeAnalysisBody instead, see
 * UpgradeReviewPanel.tsx.
 */
export function UpgradeAnalysisModal({
  packageName,
  targetVersion,
  analyzingPhase,
  analysis,
  busy,
  onConfirm,
  onUseSmartPlan,
  onCancel,
  onConfigureVerification,
  onOpenAdvisory,
  pendingChanges,
}: {
  packageName: string;
  targetVersion: string;
  analyzingPhase: 'compatibility' | 'smart-plan' | null;
  analysis: UpgradeAnalysisPresentation | null;
  busy: boolean;
  onConfirm: () => void;
  onUseSmartPlan: () => void;
  onCancel: () => void;
  onConfigureVerification: () => void;
  onOpenAdvisory: (packageName: string, advisoryId: string | number, path: string[]) => void;
  pendingChanges?: readonly { packageName: string; targetVersion: string }[];
}): ReactElement {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const previouslyFocused = useRef<Element | null>(null);

  // Focus trap + initial focus + restoration — a hand-rolled dialog pattern
  // rather than a library: this is the one interactive overlay in the whole
  // webview, and the CSP already forbids pulling in a remote dependency.
  useEffect(() => {
    previouslyFocused.current = document.activeElement;
    closeButtonRef.current?.focus();
    return () => {
      if (previouslyFocused.current instanceof HTMLElement) previouslyFocused.current.focus();
    };
  }, []);

  useEffect(() => {
    const node = dialogRef.current;
    if (node === null) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        // Never closable mid-execution — a Task is already running and
        // rollback semantics, not a client-side dismiss, own that outcome.
        if (!busy) {
          event.preventDefault();
          onCancel();
        }
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (el) => el.offsetParent !== null
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    node.addEventListener('keydown', onKeyDown);
    return () => node.removeEventListener('keydown', onKeyDown);
  }, [busy, onCancel]);

  const action = analysis !== null ? primaryAction(analysis) : null;
  const displayedChanges = analysis?.changes ?? pendingChanges ?? [{ packageName, targetVersion }];
  const bulk = displayedChanges.length > 1;
  const majorCount = analysis?.changes.filter((change) => change.majorUpdate).length ?? 0;

  return (
    <div className="modal-overlay">
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="upgrade-analysis-title"
        ref={dialogRef}
      >
        <header className="modal__header">
          <div className="modal__header-text">
            <p className="modal__eyebrow">Review upgrade</p>
            <h2 className="modal__title" id="upgrade-analysis-title">
              {bulk ? `${displayedChanges.length} dependency upgrades` : packageName}
            </h2>
            {!bulk ? <p className="modal__version-line">
              <span className="modal__version modal__version--from">{analysis?.currentVersion ?? '…'}</span>
              <span className="modal__version-arrow" aria-hidden="true">
                →
              </span>
              <span className="modal__version modal__version--to">{targetVersion}</span>
            </p> : null}
            {majorCount > 0 || analysis?.majorUpdate === true ? (
              <div className="modal__badges">
                <span className="status-badge status-badge--warning">
                  {bulk ? `${majorCount} major update${majorCount === 1 ? '' : 's'}` : 'Major update'}
                </span>
              </div>
            ) : null}
          </div>
          <button
            type="button"
            className="modal__close"
            onClick={onCancel}
            disabled={busy}
            ref={closeButtonRef}
            aria-label="Cancel upgrade"
          >
            <IconX />
          </button>
        </header>

        <div className="modal__body">
          <UpgradeAnalysisBody
            packageName={packageName}
            targetVersion={targetVersion}
            analyzingPhase={analyzingPhase}
            analysis={analysis}
            onOpenAdvisory={onOpenAdvisory}
            onConfigureVerification={onConfigureVerification}
            pendingChanges={pendingChanges}
          />
        </div>

        <footer className="modal__footer">
          <button type="button" className="button button--secondary" onClick={onCancel} disabled={busy}>
            {analysis !== null && analysis.compatibility.status === 'conflict' && analysis.smartPlan === null
              ? 'Close'
              : 'Cancel'}
          </button>
          {action !== null ? (
            <button
              type="button"
              className={`button${analysis?.compatibility.status === 'warning' || analysis?.compatibility.status === 'unknown' ? ' button--subtle' : ''}`}
              onClick={action.onClick === 'confirm' ? onConfirm : onUseSmartPlan}
              disabled={busy || analysis === null}
            >
              {action.label}
            </button>
          ) : null}
        </footer>
      </div>
    </div>
  );
}
