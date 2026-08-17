import { useEffect, useRef } from 'react';
import type { ReactElement } from 'react';

import type { PackageRow } from '../../../src/core/types.js';
import type { DependencyFinding, InstallPathVersionEntry } from '../../../src/core/hygiene/types.js';
import type { DependencyReference, DependencyUsageResult } from '../../../src/core/usage/types.js';
import {
  deprecatedFindingFor,
  directDeclarationCopy,
  introducedDuplicateFindings,
  ownDuplicateFinding,
} from '../../../src/host/dependencyDetailsCopy.js';
import { IconAlertTriangle, IconRefresh, IconTarget, IconX } from '../icons.js';

export type UsageRequestState =
  | { phase: 'analyzing' }
  | { phase: 'done'; usageId: string; result: DependencyUsageResult }
  | { phase: 'error'; message: string };

function VersionPaths({ entry }: { entry: InstallPathVersionEntry }): ReactElement {
  return (
    <li className="dependency-details__version">
      <p className="dependency-details__version-label">
        <span className="dependency-details__version-number">{entry.version}</span>
        {entry.direct !== null ? <span className="status-badge status-badge--neutral">Direct ({entry.direct.classification})</span> : null}
      </p>
      {entry.paths.length > 0 ? (
        <ul className="dependency-details__paths">
          {entry.paths.map((path, index) => (
            <li key={index} className="dependency-details__path">
              {path.join(' → ')}
            </li>
          ))}
        </ul>
      ) : null}
      {entry.totalPaths > entry.paths.length ? (
        <p className="dependency-details__more-paths">
          Showing {entry.paths.length} of {entry.truncated ? `${entry.totalPaths}+` : entry.totalPaths} paths
        </p>
      ) : null}
    </li>
  );
}

function referenceLocationLabel(reference: DependencyReference): string {
  if (reference.kind === 'script') return `package.json script: ${reference.context ?? ''}`;
  if (reference.kind === 'config') return `${reference.filePath} (${reference.context ?? 'config'})`;
  return `${reference.filePath}:${reference.line}`;
}

function UsageReferenceList({
  packageName,
  usageId,
  result,
  onOpenReference,
}: {
  packageName: string;
  usageId: string;
  result: DependencyUsageResult;
  onOpenReference: (usageId: string, referenceIndex: number) => void;
}): ReactElement {
  if (result.references.length === 0) {
    return <p className="dependency-details__empty">No references to {packageName} were found in this scan.</p>;
  }
  return (
    <>
      <p className="dependency-details__usage-summary">
        Used in {result.references.length} location{result.references.length === 1 ? '' : 's'}
        {result.truncated ? ' (scan was capped — results may be incomplete)' : ''}
      </p>
      <ul className="dependency-details__references">
        {result.references.map((reference, index) => (
          <li key={index} className="dependency-details__reference">
            {reference.filePath !== 'package.json' && reference.kind !== 'config' ? (
              <button
                type="button"
                className="dependency-details__reference-open"
                onClick={() => {
                  onOpenReference(usageId, index);
                }}
              >
                {referenceLocationLabel(reference)}
              </button>
            ) : (
              <span className="dependency-details__reference-open dependency-details__reference-open--static">
                {referenceLocationLabel(reference)}
              </span>
            )}
            <code className="dependency-details__snippet">{reference.snippet}</code>
          </li>
        ))}
      </ul>
    </>
  );
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The row-level "Dependency details" drawer — deprecated status, duplicate-
 * version paths (this package's own, and any it introduces transitively),
 * why it's installed, and on-demand "Where is this used?" — all reusing
 * data the scan already produced, plus one explicit on-demand usage scan.
 * Never a redesign of the main table; opened only from RowActionsMenu.
 */
export function DependencyDetailsModal({
  row,
  hygieneFindings,
  usage,
  onRequestUsage,
  onOpenUsageReference,
  onClose,
}: {
  row: PackageRow;
  hygieneFindings: readonly DependencyFinding[];
  usage: UsageRequestState | undefined;
  onRequestUsage: (packageName: string) => void;
  onOpenUsageReference: (usageId: string, referenceIndex: number) => void;
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
  }, [onClose]);

  const deprecated = deprecatedFindingFor(hygieneFindings, row.name);
  const ownDuplicate = ownDuplicateFinding(hygieneFindings, row.name);
  const introduced = introducedDuplicateFindings(hygieneFindings, row.name);

  return (
    <div className="modal-overlay">
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="dependency-details-title" ref={dialogRef}>
        <header className="modal__header">
          <div className="modal__header-text">
            <p className="modal__eyebrow">Dependency details</p>
            <h2 className="modal__title" id="dependency-details-title">
              {row.name}
            </h2>
          </div>
          <button type="button" className="modal__close" onClick={onClose} ref={closeButtonRef} aria-label="Close dependency details">
            <IconX />
          </button>
        </header>

        <div className="modal__body">
          {deprecated?.evidence.kind === 'deprecated' ? (
            <section className="analysis-card" aria-labelledby="dependency-details-deprecated-heading">
              <h3 className="analysis-card__title" id="dependency-details-deprecated-heading">
                <IconAlertTriangle className="analysis-card__title-icon" />
                Deprecated
              </h3>
              <p className="dependency-details__deprecated-message">{deprecated.evidence.message}</p>
              {deprecated.evidence.suggestedReplacement !== undefined ? (
                <p className="dependency-details__suggested-replacement">
                  Possible replacement: <code>{deprecated.evidence.suggestedReplacement}</code>
                </p>
              ) : null}
              <p className="analysis-card__hint">Suggested action: review replacement / migration.</p>
            </section>
          ) : null}

          <section className="analysis-card" aria-labelledby="dependency-details-why-heading">
            <h3 className="analysis-card__title" id="dependency-details-why-heading">
              Why is this installed?
            </h3>
            <p>{directDeclarationCopy(row)}</p>
          </section>

          {ownDuplicate?.evidence.kind === 'duplicate-version' ? (
            <section className="analysis-card" aria-labelledby="dependency-details-duplicate-heading">
              <h3 className="analysis-card__title" id="dependency-details-duplicate-heading">
                Duplicate versions
              </h3>
              <ul className="dependency-details__version-list">
                {ownDuplicate.evidence.versions.map((entry) => (
                  <VersionPaths key={entry.version} entry={entry} />
                ))}
              </ul>
            </section>
          ) : null}

          {introduced.length > 0 ? (
            <section className="analysis-card" aria-labelledby="dependency-details-introduced-heading">
              <h3 className="analysis-card__title" id="dependency-details-introduced-heading">
                Introduces duplicate versions
              </h3>
              {introduced.map((finding) =>
                finding.evidence.kind === 'duplicate-version' ? (
                  <div key={finding.packageName} className="dependency-details__introduced">
                    <p className="dependency-details__introduced-name">{finding.packageName}</p>
                    <ul className="dependency-details__version-list">
                      {finding.evidence.versions.map((entry) => (
                        <VersionPaths key={entry.version} entry={entry} />
                      ))}
                    </ul>
                  </div>
                ) : null
              )}
            </section>
          ) : null}

          <section className="analysis-card" aria-labelledby="dependency-details-usage-heading">
            <h3 className="analysis-card__title" id="dependency-details-usage-heading">
              <IconTarget className="analysis-card__title-icon" />
              Where is this used?
            </h3>
            {usage === undefined ? (
              <button
                type="button"
                className="button button--secondary"
                onClick={() => {
                  onRequestUsage(row.name);
                }}
              >
                <IconTarget />
                Scan workspace
              </button>
            ) : usage.phase === 'analyzing' ? (
              <p className="dependency-details__usage-status">
                <IconRefresh className="dependency-details__usage-status-icon dependency-details__usage-status-icon--spin" />
                Scanning workspace…
              </p>
            ) : usage.phase === 'error' ? (
              <p className="dependency-details__usage-status dependency-details__usage-status--error">
                <IconAlertTriangle className="dependency-details__usage-status-icon" />
                {usage.message}
              </p>
            ) : (
              <UsageReferenceList
                packageName={row.name}
                usageId={usage.usageId}
                result={usage.result}
                onOpenReference={onOpenUsageReference}
              />
            )}
          </section>
        </div>

        <footer className="modal__footer">
          <button type="button" className="button button--secondary" onClick={onClose}>
            Close
          </button>
        </footer>
      </div>
    </div>
  );
}
