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

function primaryAction(
  analysis: UpgradeAnalysisPresentation
): { label: string; onClick: 'confirm' | 'use-smart-plan' } | null {
  if (analysis.compatibility.status === 'conflict') {
    return analysis.smartPlan !== null ? { label: 'Use coordinated upgrade', onClick: 'use-smart-plan' } : null;
  }
  return {
    label: analysis.compatibility.status === 'compatible' ? `Upgrade to ${analysis.targetVersion}` : 'Upgrade anyway',
    onClick: 'confirm',
  };
}

/**
 * The Upgrade Analysis / confirmation experience — a centered dialog inside
 * the dashboard webview, replacing the native `showWarningMessage` modal.
 * `analysis === null` renders the loading phase; once it arrives, the modal
 * never mutates its own contents — it only ever echoes `analysis.analysisId`
 * back in confirm/cancel/use-smart-plan (see webviewProtocol.ts's own doc on
 * why the webview never constructs execution authority).
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
  const overall = analysis !== null ? compatibilityOutcomeDisplay(analysis.compatibility.status) : null;
  // Files/Verification always render once an analysis exists, so the
  // two-column pairing (Compatibility|Security, Files|Verification) is
  // worthwhile any time there's real content to lay out — not gated on
  // whether this particular analysis happens to have findings or a security
  // section.
  const wide = analysis !== null;

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
              {packageName}
            </h2>
            <p className="modal__version-line">
              {analysis?.currentVersion ?? '…'} <span aria-hidden="true">→</span> {targetVersion}
            </p>
            {analysis !== null ? (
              <div className="modal__badges">
                {analysis.majorUpdate ? <span className="status-badge status-badge--warning">Major update</span> : null}
                {overall !== null && analysis.compatibility.status !== 'compatible' ? (
                  <span className={`status-badge status-badge--${overall.className}`}>{overall.label}</span>
                ) : null}
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

        <div className={`modal__body${wide ? ' modal__body--wide' : ''}`}>
          {analysis === null ? (
            <UpgradeAnalysisLoading packageName={packageName} targetVersion={targetVersion} phase={analyzingPhase} />
          ) : (
            <>
              <CompatibilitySection
                compatibility={analysis.compatibility}
                context={{ package: analysis.package, currentVersion: analysis.currentVersion }}
              />
              {analysis.security !== null ? (
                <SecuritySection security={analysis.security} rootPackageName={analysis.package} onOpenAdvisory={onOpenAdvisory} />
              ) : null}
              {analysis.smartPlan !== null ? <SmartPlanSection smartPlan={analysis.smartPlan} /> : null}
              <FilesSection files={analysis.files} />
              <VerificationSection verification={analysis.verification} onConfigureVerification={onConfigureVerification} />
            </>
          )}
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
