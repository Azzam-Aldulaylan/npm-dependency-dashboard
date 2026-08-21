import { useEffect, useRef } from 'react';
import type { MouseEvent as ReactMouseEvent, ReactElement, ReactNode } from 'react';

import type { PackageRow, Severity } from '../../../src/core/types.js';
import type { DependencyFinding } from '../../../src/core/hygiene/types.js';
import type { TransitiveRemediationUiState } from '../../../src/host/upgradeAction.js';
import type { RemoveAnalysisPresentation, UpgradeAnalysisPresentation } from '../../../src/host/webviewProtocol.js';
import { IconShield, IconSliders, IconX } from '../icons.js';
import type { RemovalImpactState } from '../removalImpactState.js';
import { OverviewPanel } from './OverviewPanel.js';
import { PackageIcon } from './PackageIcon.js';
import { RemovalReviewPanel } from './RemovalReviewPanel.js';
import { UpgradeReviewPanel } from './UpgradeReviewPanel.js';
import { UsageReferencesPanel } from './UsageReferencesPanel.js';
import type { UsageRequestState } from './UsageReferencesPanel.js';
import { VulnerabilitiesPanel } from './VulnerabilitiesPanel.js';

export type ManageTabId = 'overview' | 'vulnerabilities' | 'usage' | 'upgrade' | 'removal';

const CLASSIFICATION_LABEL: Record<'prod' | 'dev' | 'optional', string> = {
  prod: 'Production',
  dev: 'Development',
  optional: 'Optional',
};

function classificationOf(row: PackageRow): 'prod' | 'dev' | 'optional' {
  return row.dev ? 'dev' : 'prod';
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface UpgradeReviewState {
  /** The upgrade target this row currently offers, or null when none. */
  targetVersion: string | null;
  /** True exactly when this row's own upgrade is the one App.tsx currently has loaded. */
  active: boolean;
  analyzingPhase: 'compatibility' | 'smart-plan' | null;
  analysis: UpgradeAnalysisPresentation | null;
  busy: boolean;
  onAnalyze: (target: string) => void;
  onConfirm: () => void;
  onUseSmartPlan: () => void;
  onCancel: () => void;
  onConfigureVerification: () => void;
}

interface RemovalReviewState {
  /** True exactly when this row's own removal is the one App.tsx currently has loaded. */
  active: boolean;
  analysis: RemoveAnalysisPresentation | null;
  busy: boolean;
  onAnalyze: () => void;
  onConfirm: () => void;
  onConfigureVerification: () => void;
}

function TabButton({
  id,
  label,
  active,
  dotTone,
  onSelect,
}: {
  id: ManageTabId;
  label: string;
  active: boolean;
  /** A quiet, glanceable status dot — never a second announcement of information the tab's own content already states in full. Absent when there's nothing worth flagging. */
  dotTone?: 'neutral' | 'active' | Severity | undefined;
  onSelect: (id: ManageTabId) => void;
}): ReactElement {
  return (
    <button
      type="button"
      className={`manage-tabs__tab${active ? ' manage-tabs__tab--active' : ''}`}
      role="tab"
      aria-selected={active}
      onClick={() => onSelect(id)}
    >
      {label}
      {dotTone !== undefined ? <span className={`manage-tabs__dot manage-tabs__dot--${dotTone}`} aria-hidden="true" /> : null}
    </button>
  );
}

/**
 * The unified "Manage dependency" workspace — one modal shell hosting five
 * sections (Overview, Vulnerabilities, Usage & references, Upgrade review,
 * Removal review) rather than a grid of action cards plus a separate
 * "Dependency details" drawer. Switching sections never closes or reopens
 * the modal, and never re-triggers analysis that already ran this session —
 * see OverviewPanel.tsx's own doc on how each action card hands off to its
 * dedicated tab instead of a second dialog.
 *
 * Every mutating flow this workspace offers reuses an existing, unchanged
 * host-owned pipeline end to end — this shell only ever routes to a tab and
 * forwards a callback, never re-derives eligibility or constructs a second
 * analyzer:
 *  - Upgrade review: the same `{ type: 'upgrade' }` preflight/confirm
 *    pipeline the row's own former button already used, rendered inline via
 *    UpgradeAnalysisBody instead of a separate UpgradeAnalysisModal.
 *  - Removal review: the same analyze-removal-impact preview plus the real
 *    bulk-remove/confirm-remove transaction (one package), rendered inline
 *    via RemoveAnalysisBody instead of a separate RemoveAnalysisModal.
 *  - Vulnerabilities / Usage & references: the scan's own advisory and
 *    usage-analysis data, the same VulnerabilityCard/usage-reference
 *    rendering the old row-level Dependency details drawer used.
 */
export function ManageDependencyModal({
  row,
  remediation,
  removalImpact,
  usage,
  hygieneFindings,
  activeTab,
  onChangeTab,
  actionsDisabled,
  blockClose,
  upgrade,
  removal,
  onAnalyzeRemediation,
  onOpenAdvisory,
  onReanalyzeUsage,
  onOpenUsageReference,
  now,
  onClose,
}: {
  row: PackageRow;
  remediation: TransitiveRemediationUiState | undefined;
  removalImpact: RemovalImpactState;
  usage: UsageRequestState | undefined;
  hygieneFindings: readonly DependencyFinding[];
  activeTab: ManageTabId;
  onChangeTab: (tab: ManageTabId) => void;
  /** True while another upgrade/removal/remediation holds the panel-wide lock elsewhere — disables mutating CTAs, never the modal itself (opening Manage is always fast). */
  actionsDisabled: boolean;
  /** True only while a protected, hard-to-reverse operation this modal itself started is actually running (a file-mutating install/removal, or the removal-impact scan) — X/Escape refuse to close until it settles, same discipline the modal already had. */
  blockClose: boolean;
  upgrade: UpgradeReviewState;
  removal: RemovalReviewState;
  onAnalyzeRemediation: (packageName: string) => void;
  onOpenAdvisory: (packageName: string, advisoryId: string | number, path: string[]) => void;
  onReanalyzeUsage: (packageName: string) => void;
  onOpenUsageReference: (usageId: string, referenceIndex: number) => void;
  now: number;
  onClose: () => void;
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
        if (blockClose) return;
        event.preventDefault();
        onClose();
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
  }, [blockClose, onClose]);

  const onOverlayClick = (event: ReactMouseEvent<HTMLDivElement>): void => {
    if (event.target === event.currentTarget && !blockClose) onClose();
  };

  const startUpgradeReview = (_packageName: string, target: string): void => {
    upgrade.onAnalyze(target);
    onChangeTab('upgrade');
  };
  const startRemovalReview = (_packageName: string): void => {
    removal.onAnalyze();
    onChangeTab('removal');
  };
  const cancelUpgradeReview = (): void => {
    upgrade.onCancel();
    onChangeTab('overview');
  };

  let content: ReactNode;
  if (activeTab === 'overview') {
    content = (
      <OverviewPanel
        row={row}
        remediation={remediation}
        removalImpact={removalImpact}
        usage={usage}
        actionsDisabled={actionsDisabled}
        onStartUpgradeReview={startUpgradeReview}
        onStartRemovalReview={startRemovalReview}
        onAnalyzeRemediation={onAnalyzeRemediation}
        onChangeTab={onChangeTab}
      />
    );
  } else if (activeTab === 'vulnerabilities') {
    content = <VulnerabilitiesPanel row={row} onOpenAdvisory={onOpenAdvisory} />;
  } else if (activeTab === 'usage') {
    content = (
      <UsageReferencesPanel
        row={row}
        hygieneFindings={hygieneFindings}
        usage={usage}
        onReanalyzeUsage={onReanalyzeUsage}
        onOpenUsageReference={onOpenUsageReference}
        now={now}
      />
    );
  } else if (activeTab === 'upgrade') {
    content = (
      <UpgradeReviewPanel
        row={row}
        active={upgrade.active}
        targetVersion={upgrade.targetVersion}
        analyzingPhase={upgrade.analyzingPhase}
        analysis={upgrade.analysis}
        busy={upgrade.busy}
        onAnalyzeUpgrade={upgrade.onAnalyze}
        onConfirm={upgrade.onConfirm}
        onUseSmartPlan={upgrade.onUseSmartPlan}
        onCancel={cancelUpgradeReview}
        onConfigureVerification={upgrade.onConfigureVerification}
        onOpenAdvisory={onOpenAdvisory}
      />
    );
  } else {
    content = (
      <RemovalReviewPanel
        row={row}
        active={removal.active}
        analysis={removal.analysis}
        busy={removal.busy}
        removalImpact={removalImpact}
        usage={usage}
        onAnalyzeRemoval={removal.onAnalyze}
        onConfirm={removal.onConfirm}
        onViewReferences={() => onChangeTab('usage')}
        onConfigureVerification={removal.onConfigureVerification}
      />
    );
  }

  const worstSeverity = row.worstSeverity;
  const usageChecking = usage === undefined || usage.phase === 'analyzing';

  return (
    <div className="modal-overlay" onClick={onOverlayClick}>
      <div
        className="modal manage-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="manage-dependency-title"
        ref={dialogRef}
      >
        <header className="modal__header">
          <div className="modal__header-text">
            <span className="manage-modal__header-icon" aria-hidden="true">
              <IconSliders />
            </span>
            <div>
              <h2 className="modal__title" id="manage-dependency-title">
                Manage dependency
              </h2>
              <p className="modal__subtitle manage-modal__breadcrumb">
                <PackageIcon name={row.name} />
                {row.name} · {row.current ?? row.range} · {CLASSIFICATION_LABEL[classificationOf(row)]}
              </p>
            </div>
          </div>
          <button type="button" className="modal__close" onClick={onClose} ref={closeButtonRef} aria-label="Close" disabled={blockClose}>
            <IconX />
          </button>
        </header>

        <nav className="manage-tabs" role="tablist" aria-label="Manage dependency sections">
          <TabButton id="overview" label="Overview" active={activeTab === 'overview'} onSelect={onChangeTab} />
          <TabButton
            id="vulnerabilities"
            label="Vulnerabilities"
            active={activeTab === 'vulnerabilities'}
            dotTone={worstSeverity ?? undefined}
            onSelect={onChangeTab}
          />
          <TabButton
            id="usage"
            label="Usage & references"
            active={activeTab === 'usage'}
            dotTone={usageChecking ? 'active' : undefined}
            onSelect={onChangeTab}
          />
          <TabButton
            id="upgrade"
            label="Upgrade review"
            active={activeTab === 'upgrade'}
            dotTone={upgrade.active ? 'active' : undefined}
            onSelect={onChangeTab}
          />
          <TabButton
            id="removal"
            label="Removal review"
            active={activeTab === 'removal'}
            dotTone={removal.active ? 'active' : undefined}
            onSelect={onChangeTab}
          />
        </nav>

        <div className="manage-modal__body" role="tabpanel">
          {content}
        </div>

        <footer className="modal__footer">
          <p className="manage-modal__footer-note">
            <IconShield className="manage-modal__footer-note-icon" aria-hidden="true" />
            Analysis does not modify your project. Registry metadata and the local package manager may be used during
            analysis.
          </p>
          <button type="button" className="button button--secondary" onClick={onClose} disabled={blockClose}>
            Close
          </button>
        </footer>
      </div>
    </div>
  );
}
