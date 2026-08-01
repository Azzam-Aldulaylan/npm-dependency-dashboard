import { useState } from 'react';
import type { ReactElement } from 'react';

import type { PackageRow, UnresolvableReason } from '../../../src/core/types.js';
import { upgradeActionDisplay } from '../../../src/host/upgradeAction.js';
import { versionDisplay } from '../../../src/host/versionDisplay.js';
import { AdvisoryDetails } from './AdvisoryDetails.js';
import { SeverityBadge } from './SeverityBadge.js';

const UNRESOLVABLE_LABELS: Record<UnresolvableReason, string> = {
  'workspace-link': 'workspace',
  file: 'file:',
  git: 'git',
  alias: 'alias',
  tarball: 'tarball',
  'no-lockfile': 'unresolved',
};

function AvailableVersion({ row }: { row: PackageRow }): ReactElement {
  const display = versionDisplay(row.wanted, row.latest);
  if (display.kind === 'dash') return <span aria-hidden="true">—</span>;
  if (display.kind === 'single') return <span className="version-value">{display.value}</span>;
  return (
    <span className="version-lines">
      <span className="version-line">
        <span className="version-label">Wanted</span>
        <span className="version-value">{display.wanted}</span>
      </span>
      <span className="version-line">
        <span className="version-label">Latest</span>
        <span className="version-value">{display.latest}</span>
      </span>
    </span>
  );
}

function CurrentVersion({ row }: { row: PackageRow }): ReactElement {
  if (row.unresolvable === undefined) return <>{row.current ?? '—'}</>;
  return (
    <>
      {row.current ?? '—'} <span className="tag">{UNRESOLVABLE_LABELS[row.unresolvable]}</span>
    </>
  );
}

function UpgradeAction({ row }: { row: PackageRow }): ReactElement {
  const action = upgradeActionDisplay(row.upgradeTo);
  if (action === null) return <span aria-hidden="true">—</span>;
  return (
    <button className="button" type="button" disabled title={action.tooltip}>
      {action.label}
    </button>
  );
}

export function PackageTable({ rows }: { rows: readonly PackageRow[] }): ReactElement {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());

  const toggle = (name: string): void => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (!next.delete(name)) next.add(name);
      return next;
    });
  };

  return (
    <div className="packages-container">
      <table className="packages">
        <colgroup>
          <col className="col-disclosure" />
          <col className="col-package" />
          <col className="col-current" />
          <col className="col-available" />
          <col className="col-vulnerabilities" />
          <col className="col-action" />
        </colgroup>
        <thead>
          <tr>
            <th scope="col" className="packages__disclosure" />
            <th scope="col">Package</th>
            <th scope="col">Current</th>
            <th scope="col">Available</th>
            <th scope="col">Vulnerabilities</th>
            <th scope="col">Action</th>
          </tr>
        </thead>
        {rows.map((row) => {
          const expandable = row.advisories.length > 0;
          const isOpen = expandable && expanded.has(row.name);
          return (
            <tbody key={row.name}>
              <tr>
                <td className="packages__disclosure">
                  {expandable ? (
                    <button
                      className="disclosure"
                      type="button"
                      aria-expanded={isOpen}
                      aria-label={`${isOpen ? 'Hide' : 'Show'} advisories for ${row.name}`}
                      onClick={() => {
                        toggle(row.name);
                      }}
                    >
                      {isOpen ? '▾' : '▸'}
                    </button>
                  ) : null}
                </td>
                <th scope="row" className="packages__name">
                  <span className="packages__name-text">{row.name}</span>
                  {row.dev ? <span className="dev-badge">Dev</span> : null}
                </th>
                <td className="packages__wrap">
                  <CurrentVersion row={row} />
                </td>
                <td className="packages__wrap">
                  <AvailableVersion row={row} />
                </td>
                <td>
                  <SeverityBadge severity={row.worstSeverity} />
                </td>
                <td>
                  {/* Inert by design: the Upgrade action runs npm install and lands in a later slice. */}
                  <UpgradeAction row={row} />
                </td>
              </tr>
              {isOpen ? (
                <tr className="packages__details">
                  <td colSpan={6}>
                    <AdvisoryDetails advisories={row.advisories} />
                  </td>
                </tr>
              ) : null}
            </tbody>
          );
        })}
      </table>
    </div>
  );
}
