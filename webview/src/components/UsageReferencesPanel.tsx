import type { ReactElement } from 'react';

import type { PackageRow } from '../../../src/core/types.js';
import type { DependencyFinding, InstallPathVersionEntry } from '../../../src/core/hygiene/types.js';
import type { DependencyReference, DependencyUsageResult } from '../../../src/core/usage/types.js';
import {
  dependencyDescriptionCopy,
  deprecatedFindingFor,
  introducedDuplicateFindings,
  ownDuplicateFinding,
} from '../../../src/host/dependencyDetailsCopy.js';
import { IconAlertTriangle, IconRefresh, IconTarget } from '../icons.js';

export type UsageRequestState =
  | { phase: 'analyzing' }
  | { phase: 'done'; usageId: string; result: DependencyUsageResult; cacheExpiresAt: string; fromCache: boolean }
  | { phase: 'error'; message: string };

function analyzedAge(scannedAt: string, now: number): string {
  const timestamp = Date.parse(scannedAt);
  if (!Number.isFinite(timestamp)) return 'Analyzed previously';
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
  if (minutes === 0) return 'Analyzed just now';
  if (minutes === 1) return 'Analyzed 1 minute ago';
  return `Analyzed ${minutes} minutes ago`;
}

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
  cacheExpiresAt,
  fromCache,
  now,
  onReanalyze,
  onOpenReference,
}: {
  packageName: string;
  usageId: string;
  result: DependencyUsageResult;
  cacheExpiresAt: string;
  fromCache: boolean;
  now: number;
  onReanalyze: () => void;
  onOpenReference: (usageId: string, referenceIndex: number) => void;
}): ReactElement {
  const expiresAt = Date.parse(cacheExpiresAt);
  const stale = Number.isFinite(expiresAt) && now >= expiresAt;
  return (
    <>
      <div className="dependency-details__usage-meta">
        <p className="dependency-details__usage-summary">
          {analyzedAge(result.scannedAt, now)}
          {fromCache ? ' · cached' : ''}
          {stale ? ' · stale' : ''}
        </p>
        <button type="button" className="button button--secondary" onClick={onReanalyze}>
          <IconRefresh />
          Re-analyze
        </button>
      </div>
      {result.references.length === 0 ? (
        <p className="dependency-details__empty">No references to {packageName} were found in this scan.</p>
      ) : (
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
      )}
    </>
  );
}

/**
 * The Usage & references tab — everything the old row-level "Dependency
 * details" drawer used to own (full advisories moved to VulnerabilitiesPanel
 * instead — see the Manage-vs-tabs split in ManageDependencyModal.tsx's own
 * doc): registry description, deprecated status, duplicate-version paths
 * (this package's own, and any it introduces transitively), and "Where is
 * this used?" — reusing exactly the usage-analysis state Overview's glance
 * row already summarizes, never a second analyzer.
 */
export function UsageReferencesPanel({
  row,
  hygieneFindings,
  usage,
  onReanalyzeUsage,
  onOpenUsageReference,
  now,
}: {
  row: PackageRow;
  hygieneFindings: readonly DependencyFinding[];
  usage: UsageRequestState | undefined;
  onReanalyzeUsage: (packageName: string) => void;
  onOpenUsageReference: (usageId: string, referenceIndex: number) => void;
  now: number;
}): ReactElement {
  const deprecated = deprecatedFindingFor(hygieneFindings, row.name);
  const ownDuplicate = ownDuplicateFinding(hygieneFindings, row.name);
  const introduced = introducedDuplicateFindings(hygieneFindings, row.name);
  const unusedFinding = hygieneFindings.find(
    (finding) => finding.kind === 'likely-unused' && finding.packageName === row.name
  );

  return (
    <div className="usage-panel">
      <section className="analysis-card" aria-labelledby="usage-panel-usage-heading">
        <h3 className="analysis-card__title" id="usage-panel-usage-heading">
          <IconTarget className="analysis-card__title-icon" />
          Where is this used?
        </h3>
        {usage === undefined || usage.phase === 'analyzing' ? (
          <p className="dependency-details__usage-status">
            <IconRefresh className="dependency-details__usage-status-icon dependency-details__usage-status-icon--spin" />
            Checking usage…
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
            cacheExpiresAt={usage.cacheExpiresAt}
            fromCache={usage.fromCache}
            now={now}
            onReanalyze={() => {
              onReanalyzeUsage(row.name);
            }}
            onOpenReference={onOpenUsageReference}
          />
        )}
      </section>

      <section className="analysis-card" aria-labelledby="usage-panel-about-heading">
        <h3 className="analysis-card__title" id="usage-panel-about-heading">
          About
        </h3>
        <p>{dependencyDescriptionCopy(row)}</p>
      </section>

      {deprecated?.evidence.kind === 'deprecated' ||
      ownDuplicate?.evidence.kind === 'duplicate-version' ||
      introduced.length > 0 ||
      unusedFinding !== undefined ? (
        <section className="analysis-card" aria-labelledby="usage-panel-hygiene-heading">
          <h3 className="analysis-card__title" id="usage-panel-hygiene-heading">
            <IconAlertTriangle className="analysis-card__title-icon" />
            Hygiene
          </h3>

          {deprecated?.evidence.kind === 'deprecated' ? (
            <div className="usage-panel__hygiene-item">
              <p className="dependency-details__deprecated-message">Deprecated: {deprecated.evidence.message}</p>
              {deprecated.evidence.suggestedReplacement !== undefined ? (
                <p className="dependency-details__suggested-replacement">
                  Possible replacement: <code>{deprecated.evidence.suggestedReplacement}</code>
                </p>
              ) : null}
            </div>
          ) : null}

          {unusedFinding?.evidence.kind === 'likely-unused' ? (
            <div className="usage-panel__hygiene-item">
              <p>
                {unusedFinding.confidence === 'high' ? 'Likely unused' : 'Possibly unused'}: {unusedFinding.evidence.reason}
              </p>
            </div>
          ) : null}

          {ownDuplicate?.evidence.kind === 'duplicate-version' ? (
            <div className="usage-panel__hygiene-item">
              <p className="dependency-details__version-list-heading">Duplicate versions</p>
              <ul className="dependency-details__version-list">
                {ownDuplicate.evidence.versions.map((entry) => (
                  <VersionPaths key={entry.version} entry={entry} />
                ))}
              </ul>
            </div>
          ) : null}

          {introduced.length > 0
            ? introduced.map((finding) =>
                finding.evidence.kind === 'duplicate-version' ? (
                  <div key={finding.packageName} className="usage-panel__hygiene-item dependency-details__introduced">
                    <p className="dependency-details__introduced-name">Introduces duplicate versions of {finding.packageName}</p>
                    <ul className="dependency-details__version-list">
                      {finding.evidence.versions.map((entry) => (
                        <VersionPaths key={entry.version} entry={entry} />
                      ))}
                    </ul>
                  </div>
                ) : null
              )
            : null}
        </section>
      ) : null}
    </div>
  );
}
