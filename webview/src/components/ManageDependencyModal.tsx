import { useEffect, useRef } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, ReactElement, ReactNode } from 'react';

import type { PackageRow, Severity } from '../../../src/core/types.js';
import type { DependencyFinding } from '../../../src/core/hygiene/types.js';
import type { TransitiveRemediationUiState } from '../../../src/host/upgradeAction.js';
import type { RemoveAnalysisPresentation, UpgradeAnalysisPresentation, UpgradeResultPresentation } from '../../../src/host/webviewProtocol.js';
import type { UpgradeAnalysisSections } from '../../../src/host/upgradeAnalysisSections.js';
import {
  shouldQuarantineUpgradeDerivedData,
  shouldShowUpgradeVulnerabilitySeverity,
} from '../../../src/host/upgradeReviewUiState.js';
import type { UpgradeEnrichmentUiState } from '../../../src/host/upgradeReviewUiState.js';
import { CLASSIFICATION_LABEL, classificationOf } from '../dependencyClassification.js';
import { IconFolder, IconInfo, IconRefresh, IconShield, IconSliders, IconTrash, IconTrendUp, IconX } from '../icons.js';
import type { RemovalImpactState } from '../removalImpactState.js';
import { OverviewPanel } from './OverviewPanel.js';
import { PackageIcon } from './PackageIcon.js';
import { RemovalReviewPanel } from './RemovalReviewPanel.js';
import { StatusBadge } from './StatusBadge.js';
import { UpgradeReviewPanel } from './UpgradeReviewPanel.js';
import type { UpgradeTargetLoadState } from './UpgradeTargetSelector.js';
import { UsageReferencesPanel } from './UsageReferencesPanel.js';
import type { UsageRequestState } from './UsageReferencesPanel.js';
import { VulnerabilitiesPanel } from './VulnerabilitiesPanel.js';

export type ManageTabId = 'overview' | 'vulnerabilities' | 'usage' | 'upgrade' | 'removal';

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface UpgradeReviewState {
  /** The upgrade target this row currently offers, or null when none. */
  targetVersion: string | null;
  targetState: UpgradeTargetLoadState;
  /** True exactly when this row's own upgrade is the one App.tsx currently has loaded. */
  active: boolean;
  analyzingPhase: 'compatibility' | 'smart-plan' | null;
  analysis: UpgradeAnalysisPresentation | null;
  /** Per-section progressive state, rendered while `analysis` is still null — see src/host/upgradeAnalysisSections.ts. */
  sections: UpgradeAnalysisSections;
  /** True when the host has flagged `analysis` as structurally stale (manifest/lockfile changed since it ran) — a non-authoritative UX hint that blocks Confirm/Use-smart-plan until Refresh. */
  hardStale: boolean;
  busy: boolean;
  error: string | null;
  onAnalyze: (target: string) => void;
  onTargetChange: (target: string) => void;
  onConfirm: () => void;
  onUseSmartPlan: () => void;
  onCancel: () => void;
  onConfigureVerification: () => void;
  /** Re-runs analysis for the same row/target — Cancel followed immediately by a fresh Analyze, not a new mechanism. */
  onRefresh: () => void;
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

function UpgradeResultPanel({
  result,
  enrichment,
  onRetryEnrichment,
}: {
  result: UpgradeResultPresentation;
  enrichment: UpgradeEnrichmentUiState | null;
  onRetryEnrichment: () => void;
}): ReactElement {
  const title =
    result.application === 'applied'
      ? result.verification === 'passed' ? 'Upgrade verified' : 'Upgrade applied'
      : result.application === 'rolled-back' ? 'Upgrade rolled back' : 'Upgrade not confirmed';
  const applicationLabel =
    result.application === 'applied'
      ? 'Requested dependency state confirmed'
      : result.application === 'rolled-back'
        ? 'Dependency files restored'
        : 'Resulting dependency state could not be confirmed';
  const verificationLabel =
    result.verification === 'passed'
      ? 'Passed'
      : result.verification === 'not-configured'
        ? 'Not configured'
        : result.verification === 'failed'
          ? 'Failed'
          : 'Not run';

  return (
    <div className="upgrade-tab" role="status" aria-live="polite">
      <section className="analysis-card analysis-card--full" aria-labelledby="upgrade-result-heading">
        <h3 className="analysis-card__title" id="upgrade-result-heading">{title}</h3>
        {result.changes.map((change) => (
          <p key={change.packageName} className="analysis-card__hint">
            <code>{change.packageName}</code>: <code>{change.previousVersion}</code> <span aria-hidden="true">→</span>{' '}
            <code>{change.currentVersion ?? 'not resolved'}</code>
          </p>
        ))}
        <dl className="manage-glance">
          <div className="manage-glance__row"><dt>Install</dt><dd>{result.install === 'succeeded' ? 'Succeeded' : 'Failed'}</dd></div>
          <div className="manage-glance__row"><dt>Applied state</dt><dd>{applicationLabel}</dd></div>
          <div className="manage-glance__row"><dt>Verification</dt><dd>{verificationLabel}</dd></div>
        </dl>
        {enrichment?.phase === 'refreshing' ? (
          <p className="analysis-card__pending-label">
            <IconRefresh className="banner__icon--spin" aria-hidden="true" /> Refreshing dependency security and update data…
          </p>
        ) : enrichment !== null ? (
          <div className="upgrade-enrichment-warning" role="alert">
            <p>
              <IconInfo aria-hidden="true" /> {enrichment.message} Confirmed local dependency facts are still shown.
            </p>
            {enrichment.phase === 'failed' ? (
              <button type="button" className="button button--secondary" onClick={onRetryEnrichment}>
                Retry dependency data refresh
              </button>
            ) : null}
          </div>
        ) : null}
      </section>
    </div>
  );
}

function DerivedDataQuarantinePanel({
  label,
  row,
  enrichment,
  onRetryEnrichment,
}: {
  label: string;
  row?: PackageRow | undefined;
  enrichment: UpgradeEnrichmentUiState;
  onRetryEnrichment: () => void;
}): ReactElement {
  return (
    <section
      className="analysis-card analysis-card--full"
      role={enrichment.phase === 'refreshing' ? 'status' : 'alert'}
      aria-live="polite"
    >
      <h3 className="analysis-card__title">
        {enrichment.phase === 'refreshing'
          ? 'Refreshing dependency data'
          : enrichment.phase === 'failed'
            ? 'Dependency data refresh failed'
            : 'Dependency data refresh superseded'}
      </h3>
      {row !== undefined ? (
        <dl className="manage-glance">
          <div className="manage-glance__row"><dt>Current version</dt><dd><code>{row.current ?? 'Not resolved'}</code></dd></div>
          <div className="manage-glance__row"><dt>Declared range</dt><dd><code>{row.range}</code></dd></div>
          <div className="manage-glance__row"><dt>Dependency type</dt><dd>{CLASSIFICATION_LABEL[classificationOf(row)]}</dd></div>
        </dl>
      ) : null}
      {enrichment.phase === 'refreshing' ? (
        <p className="analysis-card__pending-label">
          <IconRefresh className="banner__icon--spin" aria-hidden="true" /> {label}
        </p>
      ) : (
        <div className="upgrade-enrichment-warning">
          <p>
            <IconInfo aria-hidden="true" /> {enrichment.message} Registry and vulnerability details remain unavailable until a refresh succeeds.
          </p>
          {enrichment.phase === 'failed' ? (
            <button type="button" className="button button--secondary" onClick={onRetryEnrichment}>
              Retry dependency data refresh
            </button>
          ) : null}
        </div>
      )}
    </section>
  );
}

function TabButton({
  id,
  label,
  icon,
  active,
  dotTone,
  onSelect,
}: {
  id: ManageTabId;
  label: string;
  icon: ReactElement;
  active: boolean;
  /** A quiet, glanceable status dot — never a second announcement of information the tab's own content already states in full. Absent when there's nothing worth flagging. */
  dotTone?: 'neutral' | 'active' | Severity | undefined;
  onSelect: (id: ManageTabId) => void;
}): ReactElement {
  const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const tabList = event.currentTarget.closest<HTMLElement>('[role="tablist"]');
    if (tabList === null) return;
    const tabs = Array.from(tabList.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    const currentIndex = tabs.indexOf(event.currentTarget);
    if (currentIndex < 0) return;

    let nextIndex: number;
    if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = tabs.length - 1;
    else if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % tabs.length;
    else nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;

    const nextTab = tabs[nextIndex];
    if (nextTab === undefined) return;
    event.preventDefault();
    nextTab.focus();
    nextTab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    nextTab.click();
  };

  return (
    <button
      id={`manage-tab-${id}`}
      type="button"
      className={`manage-tabs__tab${active ? ' manage-tabs__tab--active' : ''}`}
      role="tab"
      aria-controls="manage-panel"
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      onClick={() => onSelect(id)}
      onKeyDown={onKeyDown}
    >
      <span className="manage-tabs__icon" aria-hidden="true">
        {icon}
      </span>
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
  upgradeDisabled,
  updateResolutionAvailable,
  advisoriesAvailable,
  blockClose,
  upgradeResult,
  upgradeEnrichment,
  upgrade,
  removal,
  onAnalyzeRemediation,
  onOpenAdvisory,
  onReanalyzeUsage,
  onOpenUsageReference,
  onRetryUpgradeEnrichment,
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
  /** Upgrade-only gate for incomplete Stage-1 update/advisory data. */
  upgradeDisabled: boolean;
  updateResolutionAvailable: boolean;
  advisoriesAvailable: boolean;
  /** True only while a protected, hard-to-reverse operation this modal itself started is actually running (a file-mutating install/removal, or the removal-impact scan) — X/Escape refuse to close until it settles, same discipline the modal already had. */
  blockClose: boolean;
  upgradeResult: UpgradeResultPresentation | null;
  upgradeEnrichment: UpgradeEnrichmentUiState | null;
  upgrade: UpgradeReviewState;
  removal: RemovalReviewState;
  onAnalyzeRemediation: (packageName: string) => void;
  onOpenAdvisory: (packageName: string, advisoryId: string | number, path: string[]) => void;
  onReanalyzeUsage: (packageName: string) => void;
  onOpenUsageReference: (usageId: string, referenceIndex: number) => void;
  onRetryUpgradeEnrichment: () => void;
  now: number;
  onClose: () => void;
}): ReactElement {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const previouslyFocused = useRef<Element | null>(null);

  useEffect(() => {
    previouslyFocused.current = document.activeElement;
    const closeButton = closeButtonRef.current;
    if (closeButton !== null && !closeButton.disabled) closeButton.focus();
    else {
      const activeTabButton = dialogRef.current?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]');
      if (activeTabButton !== undefined && activeTabButton !== null) activeTabButton.focus();
      else dialogRef.current?.focus();
    }
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

  const startUpgradeReview = (_packageName: string, _target: string): void => {
    // Target choice is now an explicit step inside Upgrade review. Overview
    // and Vulnerabilities navigate there without silently starting analysis
    // against the row's former one-size-fits-all target.
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
  const startTransitiveCheckFromVulnerabilities = (): void => {
    onAnalyzeRemediation(row.name);
    onChangeTab('overview');
  };

  const quarantineDerivedData = shouldQuarantineUpgradeDerivedData(upgradeEnrichment);
  let content: ReactNode;
  if (activeTab === 'overview' && upgradeEnrichment !== null) {
    content = (
      <DerivedDataQuarantinePanel
        row={row}
        enrichment={upgradeEnrichment}
        label="Refreshing security and available-version information…"
        onRetryEnrichment={onRetryUpgradeEnrichment}
      />
    );
  } else if (activeTab === 'overview') {
    content = (
      <OverviewPanel
        row={row}
        remediation={remediation}
        removalImpact={removalImpact}
        usage={usage}
        actionsDisabled={actionsDisabled}
        upgradeDisabled={upgradeDisabled}
        updateResolutionAvailable={quarantineDerivedData ? false : updateResolutionAvailable}
        advisoriesAvailable={quarantineDerivedData ? false : advisoriesAvailable}
        onStartUpgradeReview={startUpgradeReview}
        onStartRemovalReview={startRemovalReview}
        onAnalyzeRemediation={onAnalyzeRemediation}
        onChangeTab={onChangeTab}
      />
    );
  } else if (activeTab === 'vulnerabilities' && upgradeEnrichment !== null) {
    content = (
      <DerivedDataQuarantinePanel
        enrichment={upgradeEnrichment}
        label="Refreshing vulnerability data…"
        onRetryEnrichment={onRetryUpgradeEnrichment}
      />
    );
  } else if (activeTab === 'vulnerabilities') {
    content = (
      <VulnerabilitiesPanel
        row={row}
        remediation={remediation}
        actionsDisabled={upgradeDisabled}
        updateResolutionAvailable={quarantineDerivedData ? false : updateResolutionAvailable}
        advisoriesAvailable={quarantineDerivedData ? false : advisoriesAvailable}
        onOpenAdvisory={onOpenAdvisory}
        onStartUpgradeReview={(target) => startUpgradeReview(row.name, target)}
        onStartTransitiveCheck={startTransitiveCheckFromVulnerabilities}
      />
    );
  } else if (activeTab === 'usage') {
    content = (
      <UsageReferencesPanel
        row={row}
        hygieneFindings={hygieneFindings}
        usage={usage}
        updateResolutionAvailable={quarantineDerivedData ? false : updateResolutionAvailable}
        advisoriesAvailable={quarantineDerivedData ? false : advisoriesAvailable}
        onReanalyzeUsage={onReanalyzeUsage}
        onOpenUsageReference={onOpenUsageReference}
        onChangeTab={onChangeTab}
        now={now}
      />
    );
  } else if (activeTab === 'upgrade' && upgradeResult !== null) {
    content = (
      <UpgradeResultPanel
        result={upgradeResult}
        enrichment={upgradeEnrichment}
        onRetryEnrichment={onRetryUpgradeEnrichment}
      />
    );
  } else if (activeTab === 'upgrade') {
    content = (
      <UpgradeReviewPanel
        row={row}
        active={upgrade.active}
        targetVersion={upgrade.targetVersion}
        targetState={upgrade.targetState}
        analyzingPhase={upgrade.analyzingPhase}
        analysis={upgrade.analysis}
        sections={upgrade.sections}
        hardStale={upgrade.hardStale}
        now={now}
        busy={upgrade.busy}
        error={upgrade.error}
        disabled={upgradeDisabled}
        usage={usage}
        advisoriesAvailable={quarantineDerivedData ? false : advisoriesAvailable}
        onAnalyzeUpgrade={upgrade.onAnalyze}
        onTargetChange={upgrade.onTargetChange}
        onConfirm={upgrade.onConfirm}
        onUseSmartPlan={upgrade.onUseSmartPlan}
        onCancel={cancelUpgradeReview}
        onConfigureVerification={upgrade.onConfigureVerification}
        onRefresh={upgrade.onRefresh}
        onChangeTab={onChangeTab}
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
        advisoriesAvailable={quarantineDerivedData ? false : advisoriesAvailable}
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
    <div className="modal-overlay modal-overlay--manage" onClick={onOverlayClick}>
      <div
        className={`modal manage-modal${activeTab === 'upgrade' || activeTab === 'removal' ? ' manage-modal--decision-review' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="manage-dependency-title"
        tabIndex={-1}
        ref={dialogRef}
      >
        <header className="modal__header">
          <div className="modal__header-text">
            <span className="manage-modal__header-icon" aria-hidden="true">
              <IconSliders />
            </span>
            <div className="manage-modal__header-copy">
              <h2 className="modal__title" id="manage-dependency-title">
                Manage dependency
              </h2>
              <p className="modal__subtitle">Choose an action or review package details.</p>
              <div className="manage-modal__identity">
                <PackageIcon name={row.name} />
                <span className="manage-modal__identity-name">{row.name}</span>
                <StatusBadge label={row.current ?? row.range} />
                <StatusBadge label={CLASSIFICATION_LABEL[classificationOf(row)]} tone="accent" />
              </div>
              {row.description !== undefined ? (
                <p className="manage-modal__identity-description">{row.description}</p>
              ) : null}
            </div>
          </div>
          <button type="button" className="modal__close" onClick={onClose} ref={closeButtonRef} aria-label="Close" disabled={blockClose}>
            <IconX />
          </button>
        </header>

        <nav className="manage-tabs" role="tablist" aria-label="Manage dependency sections" aria-orientation="horizontal">
          <TabButton id="overview" label="Overview" icon={<IconInfo />} active={activeTab === 'overview'} onSelect={onChangeTab} />
          <TabButton
            id="vulnerabilities"
            label="Vulnerabilities"
            icon={<IconShield />}
            active={activeTab === 'vulnerabilities'}
            dotTone={shouldShowUpgradeVulnerabilitySeverity(upgradeEnrichment) ? worstSeverity ?? undefined : undefined}
            onSelect={onChangeTab}
          />
          <TabButton
            id="usage"
            label="Usage & references"
            icon={<IconFolder />}
            active={activeTab === 'usage'}
            dotTone={usageChecking ? 'active' : undefined}
            onSelect={onChangeTab}
          />
          <TabButton
            id="upgrade"
            label="Upgrade review"
            icon={<IconTrendUp />}
            active={activeTab === 'upgrade'}
            dotTone={upgrade.active ? 'active' : undefined}
            onSelect={onChangeTab}
          />
          <TabButton
            id="removal"
            label="Removal review"
            icon={<IconTrash />}
            active={activeTab === 'removal'}
            dotTone={removal.active ? 'active' : undefined}
            onSelect={onChangeTab}
          />
        </nav>

        <div
          className="manage-modal__body"
          id="manage-panel"
          role="tabpanel"
          aria-labelledby={`manage-tab-${activeTab}`}
        >
          {content}
        </div>

        {(activeTab === 'upgrade' && upgrade.analysis !== null) || (activeTab === 'removal' && removal.analysis !== null) ? null : (
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
        )}
      </div>
    </div>
  );
}
