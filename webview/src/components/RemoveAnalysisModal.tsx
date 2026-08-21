import { useEffect, useRef } from 'react';
import type { ReactElement } from 'react';

import type { RemoveAnalysisPresentation } from '../../../src/host/webviewProtocol.js';
import { IconAlertTriangle, IconX } from '../icons.js';
import { LoadingRing } from './DependencyLoadingState.js';
import { FilesSection } from './FilesSection.js';
import { OutcomeStatus } from './OutcomeStatus.js';
import { StatusBadge } from './StatusBadge.js';
import { VerificationSection } from './VerificationSection.js';

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function stillRequiredByDetail(count: number): string {
  return count === 1
    ? '1 package is still referenced elsewhere in the dependency tree.'
    : `${count} packages are still referenced elsewhere in the dependency tree.`;
}

/**
 * The removal review/confirm experience — same loading-then-review shell as
 * UpgradeAnalysisModal, kept as its own component rather than a branch
 * inside that one: a removal has no compatibility preflight, smart plan, or
 * security outcome, so forcing it through that component's shape would mean
 * more conditionals than content. `analysis === null` renders the loading
 * phase; once it arrives, the modal only ever echoes `analysis.analysisId`
 * back in confirm/cancel, same discipline as the upgrade flow.
 */
export function RemoveAnalysisModal({
  packages,
  analysis,
  matchTags,
  busy,
  onConfirm,
  onCancel,
  onBack,
  onConfigureVerification,
}: {
  packages: readonly string[];
  analysis: RemoveAnalysisPresentation | null;
  /** Per-package "why matched" tags from the criteria picker's own selection — display-only, never sent to or trusted from the host. */
  matchTags: ReadonlyMap<string, readonly string[]>;
  busy: boolean;
  onConfirm: () => void;
  /** X and Escape always call this — closes the entire flow (releases the host's removal lock), regardless of `onBack`. */
  onCancel: () => void;
  /**
   * Present only when this review was opened from the Manage dependency
   * modal (App.tsx's requestRemoveFromManage) — replaces the footer's
   * "Cancel" with "← Back", returning to Manage instead of the dashboard.
   * Manage's own state (removal-impact preview, the package being managed)
   * is never cleared by starting this flow, so there is nothing extra to
   * restore here; going back is simply closing this modal.
   */
  onBack?: () => void;
  onConfigureVerification: () => void;
}): ReactElement {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const previouslyFocused = useRef<Element | null>(null);

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

  const displayedPackages = analysis?.changes.map((change) => change.packageName) ?? packages;
  const bulk = displayedPackages.length > 1;
  const impactedCount = analysis?.changes.filter((change) => change.stillRequiredBy.length > 0).length ?? 0;

  return (
    <div className="modal-overlay">
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="remove-analysis-title" ref={dialogRef}>
        <header className="modal__header">
          <div className="modal__header-text">
            <p className="modal__eyebrow">Review removal</p>
            <h2 className="modal__title" id="remove-analysis-title">
              {bulk ? `Remove ${displayedPackages.length} dependencies` : `Remove ${displayedPackages[0] ?? ''}`}
            </h2>
            {impactedCount > 0 ? (
              <div className="modal__badges">
                <span className="status-badge status-badge--warning">
                  {impactedCount === 1 ? 'Still referenced elsewhere' : `${impactedCount} still referenced elsewhere`}
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
            aria-label="Cancel removal"
          >
            <IconX />
          </button>
        </header>

        {analysis === null ? (
          <div className="modal__body">
            <div className="analysis-loading" role="status" aria-live="polite">
              <LoadingRing progress={undefined} />
              <p className="analysis-loading__title">
                {displayedPackages.length > 1 ? `Checking ${displayedPackages.length} dependencies` : `Checking ${displayedPackages[0] ?? ''}`}
              </p>
              <p className="analysis-loading__detail">Looking for anything else that still depends on them…</p>
            </div>
          </div>
        ) : (
          <div className="modal__body">
            <OutcomeStatus
              label={impactedCount === 0 ? 'Nothing else depends on these packages' : 'Some packages are still depended on'}
              className={impactedCount === 0 ? 'compatible' : 'warning'}
              detail={
                impactedCount === 0
                  ? 'Safe to remove based on the current dependency tree.'
                  : stillRequiredByDetail(impactedCount)
              }
              size="large"
            />

            <section className="analysis-card analysis-card--full" aria-labelledby="remove-selected-heading">
              <h3 className="analysis-card__title" id="remove-selected-heading">Selected for removal</h3>
              <ul className="remove-list">
                {analysis.changes.map((change) => {
                  const tags = matchTags.get(change.packageName) ?? [];
                  return (
                    <li className="remove-list__item" key={change.packageName}>
                      <span className="remove-list__name">
                        {change.packageName}
                        {change.classification !== 'prod' ? <StatusBadge label={change.classification} /> : null}
                      </span>
                      {tags.length > 0 ? <span className="remove-list__tags">{tags.join(' · ')}</span> : null}
                      {change.stillRequiredBy.length > 0 ? (
                        <span className="remove-list__warning">
                          <IconAlertTriangle />
                          Still required by {change.stillRequiredBy.join(', ')}
                        </span>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </section>

            <div className="modal__grid">
              <FilesSection files={analysis.files} />
              <VerificationSection
                verification={analysis.verification}
                onConfigureVerification={onConfigureVerification}
                configuredLabel="Post-removal checks configured"
              />
            </div>
          </div>
        )}

        <footer className="modal__footer">
          <button type="button" className="button button--secondary" onClick={onBack ?? onCancel} disabled={busy}>
            {onBack ? '← Back' : 'Cancel'}
          </button>
          <button
            type="button"
            className="button button--danger"
            onClick={onConfirm}
            disabled={busy || analysis === null}
          >
            {bulk ? `Remove ${displayedPackages.length} dependencies` : `Remove ${displayedPackages[0] ?? ''}`}
          </button>
        </footer>
      </div>
    </div>
  );
}
