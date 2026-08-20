import { useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, ReactElement } from 'react';

import { MAX_BULK_REMOVE_CHANGES, MAX_BULK_UPGRADE_CHANGES } from '../../../src/core/upgrade/validate.js';
import { rowIsMajorUpdate } from '../../../src/host/summaryMetrics.js';
import type { DependencyFinding } from '../../../src/core/hygiene/types.js';
import type { PackageRow } from '../../../src/core/types.js';
import type {
  HealthCriterion,
  SelectedCriteria,
  SeverityCriterion,
  TypeCriterion,
  UpdateCriterion,
} from '../../../src/host/dependencyCriteria.js';
import {
  criteriaCounts,
  criteriaPredicate,
  criteriaSummaryLines,
  emptyCriteria,
  hasAnyCriterionSelected,
  HEALTH_LABELS,
  matchReasonTags,
  SEVERITY_LABELS,
  TYPE_LABELS,
  UPDATE_LABELS,
} from '../../../src/host/dependencyCriteria.js';
import {
  IconBroom,
  IconFilter,
  IconPackage,
  IconRefresh,
  IconRoute,
  IconShield,
  IconTrendUp,
  IconX,
} from '../icons.js';

export interface BulkUpgradeCandidate {
  packageName: string;
  currentVersion: string;
  targetVersion: string;
  major: boolean;
}

type Step = 'select' | 'review';

/** A restrained, reused-elsewhere semantic accent per criterion — never a one-off color (see styles.css's own doc on these tokens). */
type Tone = 'amber' | 'danger' | 'warning' | 'info' | 'purple' | 'blue';

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function toggleIn<T>(set: ReadonlySet<T>, value: T): Set<T> {
  const next = new Set(set);
  if (!next.delete(value)) next.add(value);
  return next;
}

const SEVERITY_TONE: Record<SeverityCriterion, Tone> = {
  critical: 'danger',
  high: 'danger',
  moderate: 'warning',
  low: 'info',
};

function CriteriaChip<T extends string>({
  criterion,
  label,
  count,
  selected,
  tone,
  onToggle,
}: {
  criterion: T;
  label: string;
  count: number;
  selected: boolean;
  tone: Tone;
  onToggle: (criterion: T) => void;
}): ReactElement {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={selected}
      className="criteria-chip"
      data-selected={selected ? 'true' : undefined}
      data-tone={tone}
      // Never disable an already-selected chip just because its facet count
      // narrowed to 0 (another group's selection can do that) — the user
      // must always be able to click it again to deselect.
      disabled={count === 0 && !selected}
      onClick={() => onToggle(criterion)}
    >
      {label}
      <span className="criteria-chip__count">{count}</span>
    </button>
  );
}

function CriteriaGroup<T extends string>({
  icon,
  label,
  ids,
  labels,
  tone,
  counts,
  selected,
  onToggle,
  headerAction,
}: {
  icon: ReactElement;
  label: string;
  ids: readonly T[];
  labels: Record<T, string>;
  tone: Tone | Record<T, Tone>;
  counts: Record<T, number>;
  selected: ReadonlySet<T>;
  onToggle: (criterion: T) => void;
  headerAction?: ReactElement;
}): ReactElement {
  return (
    <div className="criteria-group">
      <div className="criteria-group__header">
        <span className="criteria-group__label">
          {icon}
          {label}
        </span>
        {headerAction}
      </div>
      <div className="criteria-chips" role="group" aria-label={`${label} criteria`}>
        {ids.map((criterion) => (
          <CriteriaChip
            key={criterion}
            criterion={criterion}
            label={labels[criterion]}
            count={counts[criterion]}
            selected={selected.has(criterion)}
            tone={typeof tone === 'string' ? tone : tone[criterion]}
            onToggle={onToggle}
          />
        ))}
      </div>
    </div>
  );
}

const HEALTH_IDS = Object.keys(HEALTH_LABELS) as HealthCriterion[];
const SEVERITY_IDS = Object.keys(SEVERITY_LABELS) as SeverityCriterion[];
const UPDATE_IDS = Object.keys(UPDATE_LABELS) as UpdateCriterion[];
const TYPE_IDS = Object.keys(TYPE_LABELS) as TypeCriterion[];

/**
 * The "Manage dependencies" entry point — a two-step SELECT → REVIEW
 * workflow. Step 1 builds a selection by toggling criteria chips (health /
 * security / updates / type) and shows only a live match count, never the
 * bulk actions themselves — a destructive Remove in particular should never
 * be one click away before the user has seen exactly what it affects. Step 2
 * lists precisely what matched with individual checkboxes, and only there do
 * Upgrade/Remove/Check-fixes appear, scoped to whatever is still checked.
 *
 * Both `selected` (the criteria) and `deselected` (individually unchecked
 * packages) live in this component's own state, above the step branching —
 * so "← Back" only changes which step renders, never resets either. The
 * whole thing resets for free on next open because App.tsx unmounts this
 * component entirely when it closes (see onClose in App.tsx).
 */
export function ManageDependenciesModal({
  rows,
  hygieneFindings,
  remediationEligibleNames,
  cleanupBusy,
  onRecheckHealth,
  onBulkUpgrade,
  onBulkRemove,
  onAnalyzeRemediations,
  onClose,
}: {
  rows: readonly PackageRow[];
  hygieneFindings: readonly DependencyFinding[];
  remediationEligibleNames: ReadonlySet<string>;
  cleanupBusy: boolean;
  onRecheckHealth: () => void;
  onBulkUpgrade: (changes: readonly BulkUpgradeCandidate[]) => void;
  onBulkRemove: (packageNames: readonly string[], matchTags: ReadonlyMap<string, readonly string[]>) => void;
  onAnalyzeRemediations: (packages: readonly string[]) => void;
  onClose: () => void;
}): ReactElement {
  const [step, setStep] = useState<Step>('select');
  const [selected, setSelected] = useState<SelectedCriteria>(emptyCriteria());
  // Packages the user has individually unchecked on the review step — an
  // opt-out set, not an opt-in one, so a package newly entering the match
  // (criteria changed via Back, then Continue again) defaults to selected,
  // while one that was already unchecked stays unchecked if it's still in
  // the new match. See matched/reviewRows below.
  const [deselected, setDeselected] = useState<ReadonlySet<string>>(() => new Set());
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const previouslyFocused = useRef<Element | null>(null);

  useEffect(() => {
    previouslyFocused.current = document.activeElement;
    closeRef.current?.focus();
    return () => {
      if (previouslyFocused.current instanceof HTMLElement) previouslyFocused.current.focus();
    };
  }, []);

  useEffect(() => {
    const node = dialogRef.current;
    if (node === null) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      // Escape always closes the whole modal, on either step — "closing and
      // navigating backward are different actions" (Back is a separate,
      // explicit footer button on step 2, not something Escape triggers).
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
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
    node.addEventListener('keydown', onKeyDown);
    return () => node.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const counts = useMemo(
    () => criteriaCounts(rows, hygieneFindings, selected),
    [rows, hygieneFindings, selected]
  );
  const anySelected = hasAnyCriterionSelected(selected);
  const summaryLines = useMemo(() => criteriaSummaryLines(selected), [selected]);
  const matched = useMemo(
    () => (anySelected ? rows.filter(criteriaPredicate(selected, hygieneFindings)) : []),
    [rows, hygieneFindings, selected, anySelected]
  );
  const matchTags = useMemo(
    () => new Map(matched.map((row) => [row.name, matchReasonTags(row, hygieneFindings, selected)])),
    [matched, hygieneFindings, selected]
  );
  // The individually-checked subset of `matched` — what Step 2's own
  // Upgrade/Remove/Check-fixes actions actually operate on, never the full
  // match a user may have already unchecked part of.
  const reviewRows = useMemo(() => matched.filter((row) => !deselected.has(row.name)), [matched, deselected]);
  const upgradeCandidates = useMemo<readonly BulkUpgradeCandidate[]>(
    () =>
      reviewRows.flatMap((row) =>
        row.current !== null && row.upgradeTo !== null
          ? [{ packageName: row.name, currentVersion: row.current, targetVersion: row.upgradeTo, major: rowIsMajorUpdate(row) }]
          : []
      ),
    [reviewRows]
  );
  const remediationNames = useMemo(
    () => reviewRows.filter((row) => remediationEligibleNames.has(row.name)).map((row) => row.name),
    [reviewRows, remediationEligibleNames]
  );

  const toggleHealth = (criterion: HealthCriterion): void =>
    setSelected((previous) => ({ ...previous, health: toggleIn(previous.health, criterion) }));
  const toggleType = (criterion: TypeCriterion): void =>
    setSelected((previous) => ({ ...previous, type: toggleIn(previous.type, criterion) }));
  const toggleSeverity = (criterion: SeverityCriterion): void =>
    setSelected((previous) => ({ ...previous, severity: toggleIn(previous.severity, criterion) }));
  const toggleUpdates = (criterion: UpdateCriterion): void =>
    setSelected((previous) => ({ ...previous, updates: toggleIn(previous.updates, criterion) }));

  const toggleRow = (name: string): void => setDeselected((previous) => toggleIn(previous, name));
  const selectAll = (): void => setDeselected(new Set());
  const clearSelection = (): void => setDeselected(new Set(matched.map((row) => row.name)));

  const submitUpgrade = (): void => {
    onClose();
    onBulkUpgrade(upgradeCandidates.slice(0, MAX_BULK_UPGRADE_CHANGES));
  };
  const submitRemove = (): void => {
    onClose();
    onBulkRemove(reviewRows.slice(0, MAX_BULK_REMOVE_CHANGES).map((row) => row.name), matchTags);
  };
  const submitRemediation = (): void => {
    onClose();
    onAnalyzeRemediations(remediationNames.slice(0, MAX_BULK_UPGRADE_CHANGES));
  };

  // Backdrop dismissal only when the backdrop itself, not the dialog inside
  // it, was the actual click target — a click that starts and ends inside
  // the dialog never reaches this handler with `target === currentTarget`.
  const onOverlayClick = (event: ReactMouseEvent<HTMLDivElement>): void => {
    if (event.target === event.currentTarget) onClose();
  };

  return (
    <div className="modal-overlay" onClick={onOverlayClick}>
      <div
        className="modal bulk-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="manage-dependencies-title"
        aria-describedby="manage-dependencies-step"
        ref={dialogRef}
      >
        <header className="modal__header">
          <div className="modal__header-text">
            <p className="modal__eyebrow">Project maintenance</p>
            <h2 className="modal__title" id="manage-dependencies-title">
              {step === 'select' ? 'Manage dependencies' : 'Review dependencies'}
            </h2>
            {step === 'review' ? (
              <p className="modal__subtitle">
                {matched.length} dependenc{matched.length === 1 ? 'y matches' : 'ies match'} your criteria
              </p>
            ) : null}
          </div>
          <button type="button" className="modal__close" onClick={onClose} ref={closeRef} aria-label="Close">
            <IconX />
          </button>
        </header>

        <ol className="bulk-modal__steps" id="manage-dependencies-step">
          <li className="bulk-modal__step" data-active={step === 'select' ? 'true' : undefined}>
            <span className="bulk-modal__step-num">1</span>
            Select criteria
          </li>
          <li className="bulk-modal__step" data-active={step === 'review' ? 'true' : undefined}>
            <span className="bulk-modal__step-num">2</span>
            Review dependencies
          </li>
        </ol>

        {step === 'select' ? (
          <div className="modal__body">
            <div className="criteria-groups">
              <CriteriaGroup
                icon={<IconBroom className="criteria-group__icon" />}
                label="Health"
                ids={HEALTH_IDS}
                labels={HEALTH_LABELS}
                tone="amber"
                counts={counts.health}
                selected={selected.health}
                onToggle={toggleHealth}
                headerAction={
                  <button
                    type="button"
                    className="button button--secondary criteria-group__recheck"
                    onClick={onRecheckHealth}
                    disabled={cleanupBusy}
                  >
                    <IconRefresh className={cleanupBusy ? 'banner__icon--spin' : undefined} />
                    {cleanupBusy ? 'Checking…' : 'Re-check'}
                  </button>
                }
              />

              <CriteriaGroup
                icon={<IconShield className="criteria-group__icon" />}
                label="Security"
                ids={SEVERITY_IDS}
                labels={SEVERITY_LABELS}
                tone={SEVERITY_TONE}
                counts={counts.severity}
                selected={selected.severity}
                onToggle={toggleSeverity}
              />

              <CriteriaGroup
                icon={<IconTrendUp className="criteria-group__icon" />}
                label="Updates"
                ids={UPDATE_IDS}
                labels={UPDATE_LABELS}
                tone="purple"
                counts={counts.updates}
                selected={selected.updates}
                onToggle={toggleUpdates}
              />

              <CriteriaGroup
                icon={<IconPackage className="criteria-group__icon" />}
                label="Type"
                ids={TYPE_IDS}
                labels={TYPE_LABELS}
                tone="blue"
                counts={counts.type}
                selected={selected.type}
                onToggle={toggleType}
              />
            </div>

            {!anySelected ? (
              <div className="bulk-modal__empty">
                <IconFilter className="bulk-modal__empty-icon" />
                <p className="bulk-modal__empty-text">
                  Select one or more criteria to find dependencies that need maintenance.
                </p>
              </div>
            ) : (
              <div className="bulk-modal__summary">
                {summaryLines.length > 0 ? (
                  <dl className="bulk-modal__summary-lines">
                    {summaryLines.map((line) => (
                      <div className="bulk-modal__summary-line" key={line.group}>
                        <dt>{line.group}</dt>
                        <dd>{line.text}</dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
                <p className="bulk-modal__match-count">
                  {matched.length === 0
                    ? 'No dependencies match these criteria — try widening your selection.'
                    : `${matched.length} dependenc${matched.length === 1 ? 'y' : 'ies'} match`}
                  {matched.length > MAX_BULK_REMOVE_CHANGES ? (
                    <span className="bulk-modal__match-cap"> · showing the first {MAX_BULK_REMOVE_CHANGES}</span>
                  ) : null}
                </p>
              </div>
            )}
          </div>
        ) : (
          <div className="modal__body">
            <div className="review-controls">
              <div className="review-controls__buttons">
                <button type="button" className="button button--secondary" onClick={selectAll}>
                  Select all
                </button>
                <button type="button" className="button button--secondary" onClick={clearSelection}>
                  Clear selection
                </button>
              </div>
              <p className="review-controls__count">
                {reviewRows.length} of {matched.length} selected
              </p>
            </div>

            <ul className="review-list" aria-label="Matched dependencies">
              {matched.map((row) => {
                const tags = matchTags.get(row.name) ?? [];
                const checked = !deselected.has(row.name);
                return (
                  <li className="review-list__item" key={row.name}>
                    <label className="review-list__label">
                      <input
                        type="checkbox"
                        className="review-list__checkbox"
                        checked={checked}
                        onChange={() => toggleRow(row.name)}
                      />
                      <span className="review-list__content">
                        <span className="review-list__name">{row.name}</span>
                        {tags.length > 0 ? <span className="review-list__tags">{tags.join(' · ')}</span> : null}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        <footer className={`modal__footer${step === 'review' ? ' modal__footer--split' : ''}`}>
          {step === 'select' ? (
            <button type="button" className="button" onClick={() => setStep('review')} disabled={matched.length === 0}>
              Review {matched.length > 0 ? `${matched.length} ` : ''}dependencies →
            </button>
          ) : (
            <>
              <button type="button" className="button button--secondary" onClick={() => setStep('select')}>
                ← Back
              </button>
              <div className="bulk-modal__step-actions">
                <button
                  type="button"
                  className="button button--secondary"
                  onClick={submitRemediation}
                  disabled={remediationNames.length === 0}
                >
                  <IconRoute />
                  Check {remediationNames.length > 0 ? `${remediationNames.length} ` : ''}fixes
                </button>
                <button
                  type="button"
                  className="button button--danger"
                  onClick={submitRemove}
                  disabled={reviewRows.length === 0}
                >
                  Remove {reviewRows.length > 0 ? reviewRows.length : ''}
                </button>
                <button
                  type="button"
                  className="button"
                  onClick={submitUpgrade}
                  disabled={upgradeCandidates.length === 0}
                >
                  <IconTrendUp />
                  Upgrade {upgradeCandidates.length > 0 ? upgradeCandidates.length : ''}
                </button>
              </div>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}
