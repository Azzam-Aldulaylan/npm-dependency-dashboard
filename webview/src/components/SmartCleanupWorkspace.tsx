import { useEffect, useId, useMemo, useRef } from 'react';
import type { Dispatch, MouseEvent as ReactMouseEvent, ReactElement, ReactNode } from 'react';

import type { RemoveAnalysisPresentation } from '../../../src/host/webviewProtocol.js';
import {
  IconAlertTriangle,
  IconBroom,
  IconCheck,
  IconHelpCircle,
  IconHistory,
  IconRefresh,
  IconTrash,
  IconX,
  IconXCircle,
} from '../icons.js';
import {
  canCloseSmartCleanup,
  selectedSmartCleanupDedupeAction,
  selectedSmartCleanupRecommendations,
  SMART_CLEANUP_MAX_ACTIONS,
} from '../smartCleanupState.js';
import type {
  SmartCleanupAction,
  SmartCleanupConfidence,
  SmartCleanupDeprecatedFinding,
  SmartCleanupDuplicateFinding,
  SmartCleanupRemovalRecommendation,
  SmartCleanupResult,
  SmartCleanupResultAdvisory,
  SmartCleanupSecurityFinding,
  SmartCleanupState,
} from '../smartCleanupState.js';
import { SmartCleanupCategorySection } from './SmartCleanupCategorySection.js';
import { SmartCleanupFindingList } from './SmartCleanupFindingList.js';
import { DirectionalButton } from './DirectionalButton.js';
import type { ManageTabId } from './ManageDependencyModal.js';
import { SeverityBadge } from './SeverityBadge.js';
import { StatusBanner } from './StatusBanner.js';

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

const CONFIDENCE_LABEL: Record<SmartCleanupConfidence, string> = {
  safe: 'Recommended',
  review: 'Needs review',
  blocked: 'Blocked',
  unknown: 'Not verified',
};

const PHASE_TITLE: Record<SmartCleanupState['phase'], string> = {
  analyzing: 'Analyzing cleanup opportunities',
  partial: 'Cleanup plan is partially ready',
  ready: 'Review cleanup recommendations',
  stale: 'Project changed since analysis',
  cancelled: 'Cleanup analysis cancelled',
  empty: 'This project is already tidy',
  unsupported: 'Smart Cleanup is not available here',
  confirming: 'Confirm cleanup',
  executing: 'Applying cleanup',
  'rolling-back': 'Restoring project files',
  complete: 'Cleanup complete',
  'cancelled-rolled-back': 'Cleanup cancelled and restored',
  incomplete: 'Cleanup needs attention',
  failed: 'Cleanup analysis could not finish',
};

export interface SmartCleanupWorkspaceProps {
  state: SmartCleanupState;
  dispatch: Dispatch<SmartCleanupAction>;
  onClose: () => void;
  onAnalyze: () => void;
  onCancelAnalysis: () => void;
  removalPreflight: RemoveAnalysisPresentation | null;
  preflightBusy: boolean;
  onPrepareRemoval: (actionIds: readonly string[]) => void;
  onConfirmRemoval: (analysisId: string) => void;
  onKeepDependency: (actionId: string) => void;
  onBackToReview: () => void;
  onOpenDependencyReview: (packageName: string, tab: ManageTabId) => void;
  reviewEvidenceRefreshing?: boolean;
  onCancelExecution?: () => void;
}

function StatusIcon({ confidence }: { confidence: SmartCleanupConfidence }): ReactElement {
  if (confidence === 'safe') return <IconCheck />;
  if (confidence === 'review') return <IconAlertTriangle />;
  if (confidence === 'blocked') return <IconXCircle />;
  return <IconHelpCircle />;
}

function RecommendationItem({
  recommendation,
  selected,
  reviewed,
  selectionFull,
  onToggleSafe,
  onReview,
  onToggleReviewed,
}: {
  recommendation: SmartCleanupRemovalRecommendation;
  selected: boolean;
  reviewed: boolean;
  selectionFull: boolean;
  onToggleSafe: () => void;
  onReview: () => void;
  onToggleReviewed: () => void;
}): ReactElement {
  const reasonId = `${useId()}-reason`;
  const cannotSelect = recommendation.confidence === 'blocked' || recommendation.confidence === 'unknown';
  const needsReview = recommendation.confidence === 'review';
  const disabled = cannotSelect || (needsReview && !reviewed) || (selectionFull && !selected);
  const evidenceLabel = needsReview
    ? 'Evidence to review'
    : recommendation.confidence === 'blocked'
      ? 'Why removal is blocked'
      : recommendation.confidence === 'unknown'
        ? 'Why removal could not be verified'
        : 'Why removal is recommended';

  return (
    <li className="smart-cleanup-action" data-confidence={recommendation.confidence}>
      <div className="smart-cleanup-action__choice">
        <input
          className="smart-cleanup-action__checkbox"
          type="checkbox"
          checked={selected}
          disabled={disabled}
          aria-label={`Remove ${recommendation.packageName}`}
          aria-describedby={reasonId}
          onChange={needsReview ? onToggleReviewed : onToggleSafe}
        />
      </div>
      <div className="smart-cleanup-action__body">
        <div className="smart-cleanup-action__topline">
          <code className="smart-cleanup-action__package">{recommendation.packageName}</code>
          <span className="smart-cleanup-confidence" data-confidence={recommendation.confidence}>
            <StatusIcon confidence={recommendation.confidence} />
            {CONFIDENCE_LABEL[recommendation.confidence]}
          </span>
          <span className="smart-cleanup-action__type">{recommendation.dependencyType}</span>
        </div>
        <p className="smart-cleanup-action__reason" id={reasonId}>
          {recommendation.rationale}
          {cannotSelect ? ' This item cannot be included in cleanup.' : ''}
        </p>
        {needsReview ? (
          reviewed ? (
            <p className="smart-cleanup-action__reviewed"><IconCheck />Evidence reviewed. Use the checkbox to include this removal.</p>
          ) : (
            <button type="button" className="button button--small button--caution" onClick={onReview}>
              Review evidence
            </button>
          )
        ) : null}
        {recommendation.evidence.length > 0 ? (
          <details className="smart-cleanup-evidence" open={needsReview && reviewed ? true : undefined}>
            <summary>{evidenceLabel}</summary>
            <ul>
              {recommendation.evidence.map((evidence, index) => (
                <li key={`${index}:${evidence}`}>{evidence}</li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>
    </li>
  );
}

function InformationalList({ children }: { children: ReactNode }): ReactElement {
  return <ul className="smart-cleanup-information-list">{children}</ul>;
}

function DeprecatedItem({
  finding,
  onOpenDependencyReview,
}: {
  finding: SmartCleanupDeprecatedFinding;
  onOpenDependencyReview: (packageName: string, tab: ManageTabId) => void;
}): ReactElement {
  const action = finding.nextStep;
  const actionLabel = action.kind === 'review-removal'
    ? 'Review removal'
    : action.kind === 'review-upgrade'
      ? `Review upgrade to ${action.targetVersion}`
      : action.kind === 'review-related-upgrades'
        ? 'Review related dependencies'
        : null;
  const targetTab: ManageTabId = action.kind === 'review-removal'
    ? 'removal'
    : action.kind === 'review-upgrade'
      ? 'upgrade'
      : 'usage';
  return (
    <li className="smart-cleanup-information-item">
      <div>
        <code>{finding.packageName}</code>
        <span className="smart-cleanup-information-item__badge">
          Installed {finding.installedVersion ?? 'version unknown'}
        </span>
      </div>
      <p>{finding.message}</p>
      {finding.suggestedReplacement === undefined ? null : (
        <span className="smart-cleanup-information-item__meta">
          Maintainer suggests <code>{finding.suggestedReplacement}</code>
        </span>
      )}
      <div className="smart-cleanup-information-item__actions">
        {action.kind === 'review-related-upgrades' ? (
          action.upgrades.map(({ packageName, targetVersion }) => (
            <DirectionalButton
              key={packageName}
              direction="forward"
              className="button button--small button--secondary"
              onClick={() => onOpenDependencyReview(packageName, 'upgrade')}
            >
              Review {packageName} to {targetVersion}
            </DirectionalButton>
          ))
        ) : actionLabel === null ? null : (
          <DirectionalButton
            direction="forward"
            className="button button--small button--secondary"
            onClick={() => onOpenDependencyReview(finding.packageName, targetTab)}
          >
            {actionLabel}
          </DirectionalButton>
        )}
        <span>{action.reason}</span>
        {action.kind === 'review-removal' ? <span>Deprecation alone never authorizes removal.</span> : null}
      </div>
    </li>
  );
}

function DuplicateItem({
  finding,
  onOpenDependencyReview,
}: {
  finding: SmartCleanupDuplicateFinding;
  onOpenDependencyReview: (packageName: string, tab: ManageTabId) => void;
}): ReactElement {
  return (
    <li className="smart-cleanup-information-item smart-cleanup-duplicate">
      <div>
        <code>{finding.packageName}</code>
        <span className="smart-cleanup-information-item__badge">
          {finding.versions.length} installed {finding.versions.length === 1 ? 'version' : 'versions'}
        </span>
        <span className="smart-cleanup-information-item__badge">
          {finding.excessVersionCount} additional {finding.excessVersionCount === 1 ? 'version' : 'versions'}
        </span>
        <span className="smart-cleanup-information-item__badge">
          {finding.outcome === 'safe-convergence'
            ? `Can consolidate${finding.targetVersion === undefined ? '' : ` to ${finding.targetVersion}`}`
            : finding.outcome === 'keep-both' ? 'Keep current versions' : 'Not verified'}
        </span>
      </div>
      <p>{finding.reason}</p>
      <ol className="smart-cleanup-duplicate__versions">
        {finding.versions.map((version) => {
          const primaryPath = version.paths[0];
          const remainingPaths = version.paths.slice(1);
          return (
            <li key={version.version}>
              <div className="smart-cleanup-duplicate__version-heading">
                <code>{version.version}</code>
                {version.direct ? <span className="status-badge status-badge--neutral">Direct</span> : null}
                <span className="smart-cleanup-duplicate__path-count">
                  {version.truncated ? 'At least ' : ''}{version.totalPaths} dependency {version.totalPaths === 1 ? 'path' : 'paths'}
                </span>
              </div>
              <p>
                {primaryPath === undefined
                  ? version.direct ? 'Declared directly by this project.' : 'No complete introducing path was available.'
                  : primaryPath.join(' → ')}
              </p>
              {remainingPaths.length > 0 || version.truncated ? (
                <details className="smart-cleanup-duplicate__paths">
                  <summary>
                    {remainingPaths.length > 0 ? `${remainingPaths.length} more known path${remainingPaths.length === 1 ? '' : 's'}` : 'Path scan details'}
                  </summary>
                  {remainingPaths.length > 0 ? (
                    <ul>{remainingPaths.map((path) => <li key={path.join('\u0000')}><code>{path.join(' → ')}</code></li>)}</ul>
                  ) : null}
                  {version.truncated ? <small>Additional paths exist beyond the analysis limit.</small> : null}
                </details>
              ) : null}
            </li>
          );
        })}
      </ol>
      {finding.directRoots.length === 0 ? null : (
        <details className="smart-cleanup-duplicate__roots">
          <summary>Review {finding.directRoots.length} introducing direct {finding.directRoots.length === 1 ? 'dependency' : 'dependencies'}</summary>
          <div>
            {finding.directRoots.map((root) => (
              <DirectionalButton
                key={root.packageName}
                direction="forward"
                className="button button--small button--secondary"
                onClick={() => onOpenDependencyReview(root.packageName, root.upgradeAvailable ? 'upgrade' : 'overview')}
              >
                {root.upgradeAvailable ? `Review ${root.packageName} upgrade` : `Review ${root.packageName}`}
              </DirectionalButton>
            ))}
          </div>
        </details>
      )}
    </li>
  );
}

function SecurityItem({
  finding,
  selectedRoots,
}: {
  finding: SmartCleanupSecurityFinding;
  selectedRoots: readonly string[];
}): ReactElement {
  const selectedRootCount = selectedRoots.length;
  const allRootsSelected = selectedRootCount === finding.directRootCount;
  const remainingRoots = finding.directRoots.filter((packageName) => !selectedRoots.includes(packageName));
  return (
    <li className="smart-cleanup-information-item">
      <div className="smart-cleanup-security__heading">
        <strong>{finding.packageName}</strong>
        {finding.advisoryId === null ? null : <code>{finding.advisoryId}</code>}
        <SeverityBadge severity={finding.severity} />
      </div>
      <p>{finding.summary}</p>
      <dl className="smart-cleanup-security__paths">
        <div>
          <dt>Selected direct {selectedRootCount === 1 ? 'package' : 'packages'}</dt>
          <dd>{selectedRoots.map((packageName) => <code key={packageName}>{packageName}</code>)}</dd>
        </div>
        {remainingRoots.length === 0 ? null : (
          <div>
            <dt>Also introduced through</dt>
            <dd>{remainingRoots.map((packageName) => <code key={packageName}>{packageName}</code>)}</dd>
          </div>
        )}
      </dl>
      <span className="smart-cleanup-information-item__meta">
        {allRootsSelected
          ? `All ${finding.directRootCount} direct ${finding.directRootCount === 1 ? 'path is' : 'paths are'} selected, so this advisory is expected to leave the installed graph.`
          : `${selectedRootCount} of ${finding.directRootCount} direct paths are selected, so this advisory is expected to remain.`}
        {' '}The refreshed dashboard confirms the result after cleanup.
      </span>
    </li>
  );
}

function EmptyCategory({ children }: { children: ReactNode }): ReactElement {
  return <p className="smart-cleanup-category__empty">{children}</p>;
}

function AnalysisView({ state }: { state: SmartCleanupState }): ReactElement {
  return (
    <div className="smart-cleanup-analysis" aria-busy="true">
      <p>Checking the project in stages. Completed evidence appears as soon as it is available.</p>
      <ol className="smart-cleanup-analysis__steps">
        {state.analysisSteps.map((step) => (
          <li key={step.id} data-status={step.status}>
            <span className="smart-cleanup-analysis__step-icon" aria-hidden="true">
              {step.status === 'complete' ? <IconCheck /> : step.status === 'unavailable' ? <IconHelpCircle /> : <span />}
            </span>
            <span>
              <strong>{step.label}</strong>
              {step.detail === undefined ? null : <small>{step.detail}</small>}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function ReviewView({
  state,
  dispatch,
  onOpenDependencyReview,
}: {
  state: SmartCleanupState;
  dispatch: Dispatch<SmartCleanupAction>;
  onOpenDependencyReview: (packageName: string, tab: ManageTabId) => void;
}): ReactElement {
  const plan = state.plan;
  if (plan === null) return <EmptyCategory>No cleanup evidence is available.</EmptyCategory>;

  const safeRemovalCount = plan.recommendations.filter((recommendation) => recommendation.confidence === 'safe').length;
  const safe = safeRemovalCount + (plan.dedupeAction === null ? 0 : 1);
  const review = plan.recommendations.filter((recommendation) => recommendation.confidence === 'review').length;
  const blocked = plan.recommendations.filter(
    (recommendation) => recommendation.confidence === 'blocked' || recommendation.confidence === 'unknown'
  ).length;
  const selectedCount = state.selectedActionIds.size;
  const safeRemovalsSelected = plan.recommendations
    .filter((recommendation) => recommendation.confidence === 'safe')
    .slice(0, SMART_CLEANUP_MAX_ACTIONS)
    .every((recommendation) => state.selectedActionIds.has(recommendation.id));
  const safeSelected = safeRemovalsSelected && (
    plan.dedupeAction === null || state.selectedActionIds.has(plan.dedupeAction.id)
  );
  const actionableCount = safe + review;
  const duplicateExcessCount = plan.duplicates.reduce((count, finding) => count + finding.excessVersionCount, 0);
  const selectedSecurity = plan.security.flatMap((finding) => {
    const selectedActionIds = new Set(
      finding.directRootActionIds.filter((actionId) => state.selectedActionIds.has(actionId))
    );
    const selectedRoots = plan.recommendations
      .filter((recommendation) => selectedActionIds.has(recommendation.id))
      .map((recommendation) => recommendation.packageName)
      .sort((left, right) => left.localeCompare(right));
    return selectedRoots.length === 0 ? [] : [{ finding, selectedRoots }];
  });

  return (
    <>
      {state.phase === 'partial' || state.message !== null ? (
        <StatusBanner tone="warning">
          {state.message ?? 'Some checks were unavailable. Only recommendations with complete evidence can be selected.'}
        </StatusBanner>
      ) : null}

      <div className="smart-cleanup-outcome">
        <div className="smart-cleanup-outcome__headline">
          <strong>{safe} recommended</strong>
          <span>{review} need review</span>
        </div>
        <p>
          {actionableCount} direct removals available
          {plan.deprecated.length > 0 ? ` · ${plan.deprecated.length} deprecated` : ''}
          {plan.duplicates.length > 0 ? ` · ${plan.duplicates.length} duplicate groups` : ''}
          {plan.security.length > 0 ? ` · ${plan.security.length} advisory findings` : ''}
          {blocked > 0 ? ` · ${blocked} unavailable removals` : ''}
        </p>
      </div>

      <div className="smart-cleanup-selection-bar">
        <p>
          <strong>{selectedCount}</strong> selected
          {actionableCount > SMART_CLEANUP_MAX_ACTIONS ? ` · first batch is limited to ${SMART_CLEANUP_MAX_ACTIONS}` : ''}
        </p>
        <div>
          <button
            type="button"
            className="button button--small button--secondary"
            onClick={() => dispatch({ type: safeSelected ? 'clear-selection' : 'select-all-safe' })}
          >
            {safeSelected && selectedCount > 0 ? 'Clear selection' : 'Select all safe'}
          </button>
        </div>
      </div>

      <div className="smart-cleanup-categories">
        <SmartCleanupCategorySection
          category="unused"
          title="Unused"
          summary={`${plan.recommendations.length} assessed`}
          count={plan.recommendations.length}
          expanded={state.expandedCategories.has('unused')}
          onToggle={() => dispatch({ type: 'toggle-category', category: 'unused' })}
        >
          {plan.recommendations.length === 0 ? (
            <EmptyCategory>No unused direct dependencies were found.</EmptyCategory>
          ) : (
            <ul className="smart-cleanup-actions">
              {plan.recommendations.map((recommendation) => (
                <RecommendationItem
                  key={recommendation.id}
                  recommendation={recommendation}
                  selected={state.selectedActionIds.has(recommendation.id)}
                  reviewed={state.reviewedActionIds.has(recommendation.id)}
                  selectionFull={selectedCount >= SMART_CLEANUP_MAX_ACTIONS}
                  onToggleSafe={() => dispatch({ type: 'toggle-safe-action', actionId: recommendation.id })}
                  onReview={() => dispatch({ type: 'review-action', actionId: recommendation.id })}
                  onToggleReviewed={() => dispatch({ type: 'toggle-reviewed-action', actionId: recommendation.id })}
                />
              ))}
            </ul>
          )}
        </SmartCleanupCategorySection>

        <SmartCleanupCategorySection
          category="deprecated"
          title="Deprecated"
          summary="Publisher status and next steps"
          count={plan.deprecated.length}
          expanded={state.expandedCategories.has('deprecated')}
          onToggle={() => dispatch({ type: 'toggle-category', category: 'deprecated' })}
        >
          {plan.deprecated.length === 0 ? (
            <EmptyCategory>No deprecated direct dependencies were found.</EmptyCategory>
          ) : (
            <SmartCleanupFindingList
              items={plan.deprecated}
              getKey={(finding) => finding.id}
              getSearchText={(finding) => `${finding.packageName} ${finding.installedVersion ?? ''} ${finding.message} ${finding.suggestedReplacement ?? ''}`}
              renderItem={(finding) => <DeprecatedItem finding={finding} onOpenDependencyReview={onOpenDependencyReview} />}
              searchLabel="Search deprecated findings"
              emptyMessage="No deprecated dependency matches this search."
            />
          )}
        </SmartCleanupCategorySection>

        <SmartCleanupCategorySection
          category="duplicates"
          title="Duplicate versions"
          summary={`${duplicateExcessCount} additional resolved versions`}
          count={plan.duplicates.length}
          expanded={state.expandedCategories.has('duplicates')}
          onToggle={() => dispatch({ type: 'toggle-category', category: 'duplicates' })}
        >
          {plan.duplicates.length === 0 ? (
            <EmptyCategory>No duplicate-version findings were reported.</EmptyCategory>
          ) : (
            <>
              <p className="smart-cleanup-category__guidance">
                Dedupe is project-wide. Smart Cleanup offers one action only when an isolated package-manager preview
                explains every changed version set and leaves direct dependency resolutions unchanged.
              </p>
              {plan.dedupeAction === null ? null : (
                <label className="smart-cleanup-dedupe-action">
                  <input
                    type="checkbox"
                    checked={state.selectedActionIds.has(plan.dedupeAction.id)}
                    disabled={!state.selectedActionIds.has(plan.dedupeAction.id) && selectedCount >= SMART_CLEANUP_MAX_ACTIONS}
                    onChange={() => dispatch({ type: 'toggle-safe-action', actionId: plan.dedupeAction?.id ?? '' })}
                  />
                  <span>
                    <strong>Apply safe project deduplication</strong>
                    <small>
                      Expected to remove {plan.dedupeAction.expectedRemovedVersions} additional resolved {plan.dedupeAction.expectedRemovedVersions === 1 ? 'version' : 'versions'} across {plan.dedupeAction.affectedPackages.length} {plan.dedupeAction.affectedPackages.length === 1 ? 'package' : 'packages'}.
                    </small>
                  </span>
                </label>
              )}
              <SmartCleanupFindingList
                items={plan.duplicates}
                getKey={(finding) => finding.id}
                getSearchText={(finding) => [
                  finding.packageName,
                  ...finding.versions.flatMap((version) => [
                    version.version,
                    ...version.paths.map((path) => path.join(' ')),
                  ]),
                  ...finding.directRoots.map((root) => root.packageName),
                ].join(' ')}
                renderItem={(finding) => <DuplicateItem finding={finding} onOpenDependencyReview={onOpenDependencyReview} />}
                searchLabel="Search duplicate-version findings"
                emptyMessage="No duplicate-version finding matches this search."
              />
            </>
          )}
        </SmartCleanupCategorySection>

        <SmartCleanupCategorySection
          category="security"
          title="Security impact of selection"
          summary={selectedCount === 0 ? 'Select removals to preview' : 'Current graph estimate; verified afterward'}
          count={selectedSecurity.length}
          expanded={state.expandedCategories.has('security')}
          onToggle={() => dispatch({ type: 'toggle-category', category: 'security' })}
        >
          {selectedCount === 0 ? (
            <EmptyCategory>Select unused dependencies to preview which vulnerable dependency roots would be removed.</EmptyCategory>
          ) : selectedSecurity.length === 0 ? (
            <EmptyCategory>The selected dependencies do not currently introduce any known vulnerable dependency roots.</EmptyCategory>
          ) : (
            <InformationalList>
              {selectedSecurity.map(({ finding, selectedRoots }) => (
                <SecurityItem key={finding.id} finding={finding} selectedRoots={selectedRoots} />
              ))}
            </InformationalList>
          )}
        </SmartCleanupCategorySection>
      </div>
    </>
  );
}

function samePackageSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const expected = [...left].sort((a, b) => a.localeCompare(b));
  const actual = [...right].sort((a, b) => a.localeCompare(b));
  return expected.every((name, index) => name === actual[index]);
}

function preflightMatchesSelection(
  state: SmartCleanupState,
  preflight: RemoveAnalysisPresentation | null
): preflight is RemoveAnalysisPresentation {
  if (preflight === null) return false;
  const selectedNames = selectedSmartCleanupRecommendations(state).map((recommendation) => recommendation.packageName);
  const dedupeAction = selectedSmartCleanupDedupeAction(state);
  return samePackageSet(selectedNames, preflight.changes.map((change) => change.packageName)) &&
    preflight.dedupe?.actionId === dedupeAction?.id;
}

function ConfirmationView({
  state,
  onKeepDependency,
  removalPreflight,
  preflightBusy,
}: {
  state: SmartCleanupState;
  onKeepDependency: (actionId: string) => void;
  removalPreflight: RemoveAnalysisPresentation | null;
  preflightBusy: boolean;
}): ReactElement {
  const selected = selectedSmartCleanupRecommendations(state);
  const dedupeAction = selectedSmartCleanupDedupeAction(state);
  const preflightMatches = preflightMatchesSelection(state, removalPreflight);
  const checkedPreflight = preflightMatches ? removalPreflight : null;
  const warningCount = checkedPreflight?.changes.filter((change) => change.stillRequiredBy.length > 0).length ?? 0;
  const actionCount = selected.length + (dedupeAction === null ? 0 : 1);
  const dedupePreview = checkedPreflight?.dedupe ?? dedupeAction;

  return (
    <div className="smart-cleanup-confirmation">
      <div className="smart-cleanup-confirmation__summary">
        {dedupeAction === null ? <IconTrash /> : <IconBroom />}
        <div>
          <strong>Apply {actionCount} reviewed cleanup {actionCount === 1 ? 'action' : 'actions'}</strong>
          <p>Dependency removals and project deduplication run inside one restore boundary. The installed graph is checked before changes are kept.</p>
        </div>
      </div>
      <ul className="smart-cleanup-confirmation__packages">
        {selected.map((recommendation) => {
          const freshChange = checkedPreflight?.changes.find((change) => change.packageName === recommendation.packageName);
          const retainedTransitively = freshChange !== undefined && freshChange.stillRequiredBy.length > 0;
          return (
            <li key={recommendation.id} data-recheck={retainedTransitively ? 'required-transitively' : 'clear'}>
              <div>
                <code>{recommendation.packageName}</code>
                <p>{recommendation.rationale}</p>
                {retainedTransitively ? (
                  <p className="smart-cleanup-confirmation__fresh-warning">
                    The final check found that {freshChange.stillRequiredBy.join(', ')} still require this package transitively.
                    Cleanup would remove only its direct declaration; the package may remain installed.
                  </p>
                ) : null}
                {recommendation.evidence.length > 0 ? (
                  <ul className="smart-cleanup-confirmation__evidence">
                    {recommendation.evidence.map((evidence, index) => (
                      <li key={`${index}:${evidence}`}>{evidence}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
              <span>{retainedTransitively ? 'Still needed transitively' : CONFIDENCE_LABEL[recommendation.confidence]}</span>
            </li>
          );
        })}
      </ul>
      {dedupePreview === null || dedupePreview === undefined ? null : (
        <div className="smart-cleanup-confirmation__dedupe">
          <IconBroom />
          <div>
            <strong>Deduplicate the project</strong>
            <p>
              {checkedPreflight === null ? 'The initial review' : 'The final combined check'} covers {dedupePreview.affectedPackages.length} duplicate {dedupePreview.affectedPackages.length === 1 ? 'group' : 'groups'} and expects {dedupePreview.expectedRemovedVersions} excess {dedupePreview.expectedRemovedVersions === 1 ? 'version' : 'versions'} to be removed.
            </p>
          </div>
        </div>
      )}

      {checkedPreflight === null ? (
        <div className="smart-cleanup-final-check" role={preflightBusy ? 'status' : undefined} aria-live="polite">
          <IconRefresh />
          <div>
            <strong>{preflightBusy ? 'Checking the final cleanup plan…' : 'A final project check is required'}</strong>
            <p>
              {removalPreflight !== null && !preflightMatches
                ? 'The checked plan no longer matches this selection. Check the final plan again.'
                : 'This rereads the current dependency tree, simulates the selected actions together, and verifies project files before cleanup.'}
            </p>
          </div>
        </div>
      ) : (
        <section className="smart-cleanup-preflight" aria-labelledby="smart-cleanup-preflight-title">
          <div className="smart-cleanup-preflight__heading" role="status" aria-live="polite" aria-atomic="true">
            <IconCheck />
            <div>
              <h3 id="smart-cleanup-preflight-title">Final plan checked</h3>
              <p>
                {warningCount === 0
                  ? 'Nothing else in the current dependency tree references these packages.'
                  : `${warningCount} ${warningCount === 1 ? 'dependency has' : 'dependencies have'} fresh reference warnings. Review them before confirming.`}
              </p>
            </div>
          </div>
          <ul className="smart-cleanup-preflight__changes">
            {checkedPreflight.changes.map((change) => (
              <li key={change.packageName}>
                <div>
                  <code>{change.packageName}</code>
                  <span>{change.classification}</span>
                </div>
                {change.stillRequiredBy.length === 0 ? (
                  <p>No remaining direct dependency path references this package.</p>
                ) : (
                  <div className="smart-cleanup-preflight__decision">
                    <p className="smart-cleanup-preflight__warning">
                      <IconAlertTriangle /> Still required transitively by {change.stillRequiredBy.join(', ')}
                    </p>
                    <p>Removing this direct declaration will not necessarily remove the package from the installed graph.</p>
                    <button
                      type="button"
                      className="button button--small button--secondary"
                      onClick={() => {
                        const recommendation = selected.find((item) => item.packageName === change.packageName);
                        if (recommendation !== undefined) onKeepDependency(recommendation.id);
                      }}
                    >
                      Keep direct dependency
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
          {checkedPreflight.dedupe === undefined ? null : (
            <div className="smart-cleanup-preflight__dedupe">
              <IconCheck />
              <p>
                Project dedupe verified for {checkedPreflight.dedupe.affectedPackages.length} {checkedPreflight.dedupe.affectedPackages.length === 1 ? 'group' : 'groups'}, with {checkedPreflight.dedupe.expectedRemovedVersions} excess {checkedPreflight.dedupe.expectedRemovedVersions === 1 ? 'version' : 'versions'} expected to be removed.
              </p>
            </div>
          )}
          <dl className="smart-cleanup-preflight__facts">
            <div className="smart-cleanup-preflight__files">
              <dt>Dependency files</dt>
              <dd>
                <span><strong>Manifest</strong><code>{checkedPreflight.files.manifestPath}</code></span>
                <span><strong>Lockfile</strong><code>{checkedPreflight.files.lockfilePath}</code></span>
              </dd>
            </div>
            <div>
              <dt>Verification</dt>
              <dd>
                {checkedPreflight.verification.configured
                  ? checkedPreflight.verification.scriptNames.join(', ')
                  : 'No post-removal checks configured'}
              </dd>
            </div>
          </dl>
        </section>
      )}
      <div className="smart-cleanup-restore-note">
        <IconHistory />
        <p>
          {checkedPreflight?.files.rollbackAvailable === false
            ? 'No automatic restore point is available. Review source control before continuing.'
            : 'If cleanup fails, restoration of the project manifest and active lockfile is attempted automatically.'}
        </p>
      </div>
    </div>
  );
}

function ExecutionView({ state }: { state: SmartCleanupState }): ReactElement {
  const progress = state.execution;
  const value = progress === null || progress.total === 0 ? 0 : Math.round((progress.completed / progress.total) * 100);
  return (
    <div className="smart-cleanup-execution" aria-busy="true">
      <div className="smart-cleanup-execution__mark"><IconBroom /></div>
      <p>{state.phase === 'rolling-back' ? state.message : progress?.currentLabel ?? 'Preparing cleanup…'}</p>
      <progress max={100} value={value} aria-label="Cleanup progress">{value}%</progress>
      <span>{state.phase === 'rolling-back' ? 'Keep this workspace open while files are restored.' : `${progress?.completed ?? 0} of ${progress?.total ?? 0} actions completed`}</span>
      <p className="smart-cleanup-mutation-lock-note">Close is unavailable while project files are changing. It becomes available when cleanup or restoration finishes.</p>
    </div>
  );
}

function resultPackageName(actionId: string): string {
  const prefix = 'remove-direct:';
  if (actionId.startsWith(prefix)) return actionId.slice(prefix.length);
  return actionId.startsWith('dedupe:') ? 'Project deduplication' : actionId;
}

function ResultMetric({ metric }: { metric: SmartCleanupResult['metrics'][number] }): ReactElement {
  const maximum = Math.max(metric.before, metric.after, 1);
  const change = metric.before - metric.after;
  const changeLabel = change > 0 ? `${change} fewer` : change < 0 ? `${Math.abs(change)} more` : 'No change';
  return (
    <div className="smart-cleanup-metric" data-change={change > 0 ? 'improved' : change < 0 ? 'increased' : 'unchanged'}>
      <dt>{metric.label}</dt>
      <dd>
        <span>{metric.before}</span>
        <span aria-hidden="true">→</span>
        <strong>{metric.after}</strong>
        <em>{changeLabel}</em>
      </dd>
      <div className="smart-cleanup-metric__bars" aria-hidden="true">
        <span style={{ width: `${Math.max(4, (metric.before / maximum) * 100)}%` }} />
        <strong style={{ width: `${Math.max(4, (metric.after / maximum) * 100)}%` }} />
      </div>
      <small>{metric.detail}</small>
    </div>
  );
}

function ResultPackages({
  title,
  actionIds,
  tone,
}: {
  title: string;
  actionIds: readonly string[];
  tone: 'completed' | 'skipped' | 'failed';
}): ReactElement | null {
  if (actionIds.length === 0) return null;
  return (
    <section className="smart-cleanup-result-packages" data-tone={tone}>
      <h3>{title}</h3>
      <ul>
        {actionIds.map((actionId) => <li key={actionId}><code>{resultPackageName(actionId)}</code></li>)}
      </ul>
    </section>
  );
}

function ResultAdvisoryItem({ advisory, outcome }: { advisory: SmartCleanupResultAdvisory; outcome: 'resolved' | 'introduced' }): ReactElement {
  const identifiers = advisory.identifiers.join(' · ');
  return (
    <li className="smart-cleanup-result-advisory" data-outcome={outcome}>
      <div>
        {identifiers === '' ? <span>Advisory source</span> : <code>{identifiers}</code>}
        <SeverityBadge severity={advisory.severity} />
      </div>
      <strong>{advisory.flaggedPackage}</strong>
      <span>{advisory.title}</span>
    </li>
  );
}

function ResultView({ result, phase }: { result: SmartCleanupResult; phase: SmartCleanupState['phase'] }): ReactElement {
  const verified = phase === 'complete' && result.verification === 'passed';
  const rollbackLabel = result.rollback === 'restored'
    ? 'Project dependency files restored'
    : result.rollback === 'incomplete'
      ? 'Restoration needs attention'
      : 'Automatic restoration was not needed';
  const headline = verified
    ? 'Verified cleanup results'
    : phase === 'complete'
      ? 'Cleanup applied without verified checks'
    : phase === 'cancelled-rolled-back'
      ? 'Dependency files restored'
      : 'Review the incomplete cleanup';
  return (
    <div className="smart-cleanup-results">
      <div className="smart-cleanup-results__headline" data-verified={verified ? 'true' : undefined}>
        {verified ? <IconCheck /> : <IconAlertTriangle />}
        <strong>{headline}</strong>
      </div>
      <dl className="smart-cleanup-metrics">
        {result.metrics.map((metric) => <ResultMetric key={metric.id} metric={metric} />)}
      </dl>
      <div className="smart-cleanup-result-package-groups">
        <ResultPackages title="Removed dependencies" actionIds={result.completedActionIds} tone="completed" />
        <ResultPackages title="Skipped dependencies" actionIds={result.skippedActionIds} tone="skipped" />
        <ResultPackages title="Failed dependencies" actionIds={result.failedActionIds} tone="failed" />
      </div>
      {result.resolvedAdvisories.length > 0 ? (
        <section className="smart-cleanup-result-advisories" aria-labelledby="smart-cleanup-resolved-advisories">
          <h3 id="smart-cleanup-resolved-advisories">Resolved advisory findings</h3>
          <SmartCleanupFindingList
            items={result.resolvedAdvisories}
            getKey={(advisory) => `${advisory.sourceId}:${advisory.flaggedPackage}`}
            getSearchText={(advisory) => `${advisory.identifiers.join(' ')} ${advisory.flaggedPackage} ${advisory.title}`}
            renderItem={(advisory) => <ResultAdvisoryItem advisory={advisory} outcome="resolved" />}
            searchLabel="Search resolved advisories"
            emptyMessage="No resolved advisory matches this search."
            initialCount={6}
            searchThreshold={6}
          />
        </section>
      ) : null}
      {result.introducedAdvisories.length > 0 ? (
        <section className="smart-cleanup-result-advisories" aria-labelledby="smart-cleanup-introduced-advisories">
          <h3 id="smart-cleanup-introduced-advisories">New advisory findings requiring attention</h3>
          <SmartCleanupFindingList
            items={result.introducedAdvisories}
            getKey={(advisory) => `${advisory.sourceId}:${advisory.flaggedPackage}`}
            getSearchText={(advisory) => `${advisory.identifiers.join(' ')} ${advisory.flaggedPackage} ${advisory.title}`}
            renderItem={(advisory) => <ResultAdvisoryItem advisory={advisory} outcome="introduced" />}
            searchLabel="Search new advisories"
            emptyMessage="No new advisory matches this search."
            initialCount={6}
            searchThreshold={6}
          />
        </section>
      ) : null}
      <dl className="smart-cleanup-result-details">
        <div><dt>Completed</dt><dd>{result.completedActionIds.length}</dd></div>
        <div><dt>Skipped</dt><dd>{result.skippedActionIds.length}</dd></div>
        <div><dt>Failed</dt><dd>{result.failedActionIds.length}</dd></div>
        <div><dt>Verification</dt><dd>{result.verification}</dd></div>
        <div><dt>Restoration</dt><dd>{rollbackLabel}</dd></div>
      </dl>
      <div className="smart-cleanup-results__recovery">
        <IconHistory />
        <p>
          {result.rollback === 'restored'
            ? "The saved package.json and active lockfile were restored. node_modules and script side effects were not restored; run your package manager's install command before trying another cleanup."
            : result.rollback === 'incomplete'
              ? 'Automatic restoration could not be fully verified. Review package.json and the active lockfile before continuing.'
              : 'The cleanup changes were kept. Use source control if you need to reverse them later.'}
        </p>
      </div>
      {result.detail === undefined ? null : <p className="smart-cleanup-results__detail">{result.detail}</p>}
    </div>
  );
}

function TerminalView({ state }: { state: SmartCleanupState }): ReactElement {
  const icon = state.phase === 'empty' ? <IconCheck /> : state.phase === 'stale' ? <IconRefresh /> : <IconAlertTriangle />;
  return (
    <div className="smart-cleanup-terminal" data-phase={state.phase}>
      <span className="smart-cleanup-terminal__icon">{icon}</span>
      <p>{state.message ?? 'No additional details are available.'}</p>
      {state.phase === 'cancelled' && state.plan !== null ? <small>Completed evidence is retained for reference, but execution requires a fresh analysis.</small> : null}
    </div>
  );
}

function announcementForState(state: SmartCleanupState): string {
  if (state.phase === 'analyzing') {
    const completed = state.analysisSteps.filter((step) => step.status === 'complete').length;
    return `Cleanup analysis in progress. ${completed} of ${state.analysisSteps.length} checks complete.`;
  }
  if (state.phase === 'ready' || state.phase === 'partial') {
    const safe = state.plan?.recommendations.filter((recommendation) => recommendation.confidence === 'safe').length ?? 0;
    const review = state.plan?.recommendations.filter((recommendation) => recommendation.confidence === 'review').length ?? 0;
    return `Cleanup analysis ready. ${safe} recommended actions and ${review} actions need review.`;
  }
  if (state.phase === 'executing') return state.execution?.currentLabel ?? 'Cleanup is running.';
  if (state.phase === 'rolling-back') return 'Cleanup stopped. Restoring project files.';
  return PHASE_TITLE[state.phase];
}

export function SmartCleanupWorkspace({
  state,
  dispatch,
  onClose,
  onAnalyze,
  onCancelAnalysis,
  removalPreflight,
  preflightBusy,
  onPrepareRemoval,
  onConfirmRemoval,
  onKeepDependency,
  onBackToReview,
  onOpenDependencyReview,
  reviewEvidenceRefreshing = false,
  onCancelExecution,
}: SmartCleanupWorkspaceProps): ReactElement {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const previousPhase = useRef(state.phase);
  const previouslyFocused = useRef<Element | null>(null);
  const canClose = canCloseSmartCleanup(state);

  useEffect(() => {
    previouslyFocused.current = document.activeElement;
    headingRef.current?.focus();
    return () => {
      if (previouslyFocused.current instanceof HTMLElement) previouslyFocused.current.focus();
    };
  }, []);

  useEffect(() => {
    if (previousPhase.current === state.phase) return;
    previousPhase.current = state.phase;
    headingRef.current?.focus();
  }, [state.phase]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && canClose) {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (element) => element.offsetParent !== null
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (first === undefined || last === undefined) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    dialog.addEventListener('keydown', onKeyDown);
    return () => dialog.removeEventListener('keydown', onKeyDown);
  }, [canClose, onClose]);

  const onOverlayClick = (event: ReactMouseEvent<HTMLDivElement>): void => {
    if (canClose && event.target === event.currentTarget) onClose();
  };

  const showReview = state.phase === 'ready' || state.phase === 'partial';
  const showTerminal = ['stale', 'cancelled', 'empty', 'unsupported', 'failed'].includes(state.phase);

  return (
    <div className="modal-overlay smart-cleanup-overlay" onMouseDown={onOverlayClick}>
      <div
        className="modal smart-cleanup-workspace"
        role="dialog"
        aria-modal="true"
        aria-labelledby="smart-cleanup-title"
        aria-describedby="smart-cleanup-project"
        data-phase={state.phase}
        ref={dialogRef}
      >
        <header className="smart-cleanup-header">
          <span className="smart-cleanup-header__icon" aria-hidden="true"><IconBroom /></span>
          <div className="smart-cleanup-header__copy">
            <h2 id="smart-cleanup-title" tabIndex={-1} ref={headingRef}>{PHASE_TITLE[state.phase]}</h2>
            <p id="smart-cleanup-project">Smart Cleanup · {state.projectName}</p>
          </div>
          <button
            type="button"
            className="modal__close"
            aria-label={canClose ? 'Close Smart Cleanup' : 'Close unavailable while project files are changing'}
            aria-describedby={canClose ? undefined : 'smart-cleanup-close-reason'}
            disabled={!canClose}
            onClick={onClose}
          >
            <IconX />
          </button>
        </header>

        <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {announcementForState(state)}
        </p>
        {!canClose ? <p className="sr-only" id="smart-cleanup-close-reason">Wait for cleanup or restoration to finish before closing.</p> : null}

        <div className="smart-cleanup-body">
          {state.phase === 'analyzing' ? <AnalysisView state={state} /> : null}
          {showReview ? (
            <>
              {reviewEvidenceRefreshing ? (
                <StatusBanner
                  tone="info"
                  icon={<IconRefresh className="banner__icon--spin" />}
                >
                  Refreshing removal evidence after package review. Your selections are preserved.
                </StatusBanner>
              ) : null}
              <ReviewView state={state} dispatch={dispatch} onOpenDependencyReview={onOpenDependencyReview} />
            </>
          ) : null}
          {state.phase === 'confirming' ? (
            <ConfirmationView
              state={state}
              onKeepDependency={onKeepDependency}
              removalPreflight={removalPreflight}
              preflightBusy={preflightBusy}
            />
          ) : null}
          {state.phase === 'executing' || state.phase === 'rolling-back' ? <ExecutionView state={state} /> : null}
          {(state.phase === 'complete' || state.phase === 'cancelled-rolled-back' || state.phase === 'incomplete') && state.result !== null
            ? <ResultView result={state.result} phase={state.phase} />
            : null}
          {showTerminal ? <TerminalView state={state} /> : null}
        </div>

        <footer className="smart-cleanup-footer">
          {state.phase === 'analyzing' ? (
            <button type="button" className="button button--secondary" onClick={onCancelAnalysis}>Cancel analysis</button>
          ) : null}
          {showReview ? (
            <>
              <button type="button" className="button button--secondary" onClick={onClose}>Close</button>
              <button
                type="button"
                className="button button--primary"
                disabled={state.selectedActionIds.size === 0 || reviewEvidenceRefreshing}
                onClick={() => dispatch({ type: 'show-confirmation' })}
              >
                Review {state.selectedActionIds.size} selected
              </button>
            </>
          ) : null}
          {state.phase === 'confirming' ? (
            <>
              <DirectionalButton direction="back" onClick={onBackToReview}>Back</DirectionalButton>
              {preflightMatchesSelection(state, removalPreflight) ? (
                <button
                  type="button"
                  className="button button--danger"
                  disabled={preflightBusy}
                  onClick={() => onConfirmRemoval(removalPreflight.analysisId)}
                >
                  Confirm and clean {state.selectedActionIds.size} {state.selectedActionIds.size === 1 ? 'action' : 'actions'}
                </button>
              ) : (
                <button
                  type="button"
                  className="button button--primary"
                  disabled={preflightBusy}
                  onClick={() => onPrepareRemoval([...state.selectedActionIds].sort((left, right) => left.localeCompare(right)))}
                >
                  {preflightBusy ? 'Checking final plan…' : 'Check final plan'}
                </button>
              )}
            </>
          ) : null}
          {state.phase === 'executing' && onCancelExecution !== undefined ? (
            <button type="button" className="button button--secondary" onClick={onCancelExecution}>Cancel and restore</button>
          ) : null}
          {state.phase === 'rolling-back' ? <span className="smart-cleanup-footer__status">Restoration in progress…</span> : null}
          {showTerminal ? (
            <>
              <button type="button" className="button button--secondary" onClick={onClose}>Close</button>
              {state.phase !== 'empty' && state.phase !== 'unsupported' ? (
                <button type="button" className="button button--primary" onClick={onAnalyze}><IconRefresh />Analyze again</button>
              ) : null}
            </>
          ) : null}
          {state.phase === 'complete' || state.phase === 'cancelled-rolled-back' || state.phase === 'incomplete' ? (
            <>
              <button type="button" className="button button--secondary" onClick={onClose}>Close</button>
              <button type="button" className="button button--primary" onClick={onAnalyze}><IconRefresh />Analyze current project</button>
            </>
          ) : null}
        </footer>
      </div>
    </div>
  );
}
