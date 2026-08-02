import { useState } from 'react';
import type { ReactElement } from 'react';

import type { PackageRow } from '../../../src/core/types.js';
import { upgradeActionDisplay } from '../../../src/host/upgradeAction.js';
import type { CurrentVersionTag } from '../../../src/host/versionDisplay.js';
import { currentVersionDisplay, versionDisplay } from '../../../src/host/versionDisplay.js';
import { AdvisoryDetails } from './AdvisoryDetails.js';
import { SeverityBadge } from './SeverityBadge.js';

const TAG_LABELS: Record<CurrentVersionTag, string> = {
  'workspace-link': 'workspace',
  file: 'file:',
  git: 'git',
  alias: 'alias',
  tarball: 'tarball',
  'no-lockfile': 'unresolved',
  unresolved: 'unresolved',
};

/**
 * Same terminology `npm outdated` uses for its own Current/Wanted/Latest
 * columns, so the meanings carry over for anyone already familiar with it.
 */
const CURRENT_EXPLANATION = 'Version installed according to the lockfile.';
const WANTED_EXPLANATION = 'Newest version allowed by the range in package.json.';
const LATEST_EXPLANATION = 'Newest stable version published to npm.';

function AvailableVersion({ row }: { row: PackageRow }): ReactElement {
  const display = versionDisplay(row.wanted, row.latest);
  if (display.kind === 'dash') return <span aria-hidden="true">—</span>;
  if (display.kind === 'single') return <span className="version-value">{display.value}</span>;
  return (
    <span className="version-lines">
      <span className="version-line">
        <span
          className="version-label"
          title={WANTED_EXPLANATION}
          aria-label={`Wanted: ${WANTED_EXPLANATION}`}
        >
          Wanted
        </span>
        <span className="version-value">{display.wanted}</span>
      </span>
      <span className="version-line">
        <span
          className="version-label"
          title={LATEST_EXPLANATION}
          aria-label={`Latest: ${LATEST_EXPLANATION}`}
        >
          Latest
        </span>
        <span className="version-value">{display.latest}</span>
      </span>
    </span>
  );
}

function CurrentVersion({ row }: { row: PackageRow }): ReactElement {
  const display = currentVersionDisplay(row.current, row.range, row.unresolvable);
  const text = display.kind === 'dash' ? '—' : display.value;
  if (display.tag === null) return <>{text}</>;
  return (
    <>
      {text} <span className="tag">{TAG_LABELS[display.tag]}</span>
    </>
  );
}

function UpgradeAction({
  row,
  activeUpgrade,
  onUpgrade,
  upgradesDisabled,
}: {
  row: PackageRow;
  /** The one package this webview asked to upgrade, or null. The host allows only one upgrade at a time for the whole panel, so every button is disabled while this is set — not just the row it names. */
  activeUpgrade: string | null;
  onUpgrade: (packageName: string, target: string) => void;
  /** UX only — the host rejects the request either way (see PackageTable's own doc). */
  upgradesDisabled: boolean;
}): ReactElement {
  const { upgradeTo } = row;
  if (upgradeTo === null) return <span aria-hidden="true">—</span>;
  const action = upgradeActionDisplay(upgradeTo);
  if (action === null) return <span aria-hidden="true">—</span>;
  const isThisRowUpgrading = activeUpgrade === row.name;
  const disabled = activeUpgrade !== null || upgradesDisabled;
  return (
    <button
      className="button"
      type="button"
      disabled={disabled}
      title={
        isThisRowUpgrading
          ? 'Upgrade in progress…'
          : upgradesDisabled
            ? 'Dependency data is being refreshed — try again once it finishes.'
            : action.tooltip
      }
      onClick={() => {
        onUpgrade(row.name, upgradeTo);
      }}
    >
      {isThisRowUpgrading ? 'Upgrading…' : action.label}
    </button>
  );
}

export function PackageTable({
  rows,
  activeUpgrade,
  onUpgrade,
  upgradesDisabled,
}: {
  rows: readonly PackageRow[];
  activeUpgrade: string | null;
  onUpgrade: (packageName: string, target: string) => void;
  /**
   * True whenever the host is displaying stale/revalidating data — a UX
   * nicety, not the security boundary: `DashboardController.isEligible`
   * independently rejects any Upgrade request the host itself considers
   * stale, regardless of what this prop says.
   */
  upgradesDisabled: boolean;
}): ReactElement {
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
            <th scope="col" title={CURRENT_EXPLANATION} aria-label={`Current: ${CURRENT_EXPLANATION}`}>
              Current
            </th>
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
                  <UpgradeAction
                    row={row}
                    activeUpgrade={activeUpgrade}
                    onUpgrade={onUpgrade}
                    upgradesDisabled={upgradesDisabled}
                  />
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
