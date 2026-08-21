import type { ReactElement } from 'react';

import type { PackageRow, Severity } from '../../../src/core/types.js';
import { sortAdvisoriesBySeverity } from '../../../src/host/severityDisplay.js';
import { IconCheck, IconShield } from '../icons.js';
import { VulnerabilityCard } from './VulnerabilityCard.js';

const SEVERITY_ORDER: readonly Severity[] = ['critical', 'high', 'moderate', 'low', 'info'];
const SEVERITY_HEADING: Record<Severity, string> = {
  critical: 'Critical',
  high: 'High',
  moderate: 'Moderate',
  low: 'Low',
  info: 'Info',
};

/**
 * The full advisory list for one dependency — worst severity first
 * (sortAdvisoriesBySeverity's own stable tie-break by flagged package/title
 * carries through within each group), grouped under a heading per severity
 * present. This is the "tell me everything" counterpart to Overview's
 * compact summary (see OverviewPanel.tsx) — never duplicated as a second
 * full list anywhere else in the Manage workspace. Each entry renders via
 * the same VulnerabilityCard the Upgrade review tab's Security section uses,
 * so a vulnerability reads identically everywhere it appears.
 */
export function VulnerabilitiesPanel({
  row,
  onOpenAdvisory,
}: {
  row: PackageRow;
  onOpenAdvisory: (packageName: string, advisoryId: string | number, path: string[]) => void;
}): ReactElement {
  if (row.advisories.length === 0) {
    return (
      <div className="manage-panel-empty">
        <IconCheck className="manage-panel-empty__icon manage-panel-empty__icon--ok" />
        <p>No known vulnerabilities for {row.name}.</p>
      </div>
    );
  }

  const sorted = sortAdvisoriesBySeverity(row.advisories);
  const groups = SEVERITY_ORDER.map((severity) => ({
    severity,
    entries: sorted.filter((entry) => entry.advisory.severity === severity),
  })).filter((group) => group.entries.length > 0);

  return (
    <div className="vulnerabilities-panel">
      {groups.map((group) => (
        <section
          className="vulnerabilities-panel__group"
          key={group.severity}
          aria-labelledby={`vulnerabilities-group-${group.severity}`}
        >
          <h3 className={`vulnerabilities-panel__group-heading severity--${group.severity}`} id={`vulnerabilities-group-${group.severity}`}>
            <IconShield className="vulnerabilities-panel__group-icon" />
            {SEVERITY_HEADING[group.severity]}
            <span className="vulnerabilities-panel__group-count">{group.entries.length}</span>
          </h3>
          <ul className="advisories">
            {group.entries.map((entry, index) => (
              <VulnerabilityCard
                advisory={entry.advisory}
                flaggedPackage={entry.flaggedPackage}
                path={entry.path}
                patchedVersion={entry.patchedVersion}
                rootPackageName={row.name}
                onOpenAdvisory={onOpenAdvisory}
                key={`${String(entry.advisory.id)}:${entry.path.join('>')}:${index}`}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
