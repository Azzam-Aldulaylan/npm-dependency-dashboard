import type { ReactElement } from 'react';

import type { PackageRow } from '../../../src/core/types.js';
import { filterDashboardAdvisoryContexts } from '../../../src/host/vulnerabilityUiState.js';
import { VulnerabilityCard } from './VulnerabilityCard.js';

/**
 * The drilldown the spec's Vulnerability Scope calls for: which nested package
 * is actually flagged, the chain from the direct dependency down to it, the
 * versions actually affected, the first version known to fix it, and a way
 * to read the advisory itself. Multiple graph paths to the same exact
 * advisory/package/version are grouped into one card with an expandable path
 * list, rather than repeating the whole advisory for every route through the
 * tree. Each context still renders via VulnerabilityCard, the same component
 * the Upgrade Analysis modal's Security section uses.
 */
export function AdvisoryDetails({
  row,
  searchQuery,
  onOpenAdvisory,
}: {
  row: PackageRow;
  searchQuery: string;
  onOpenAdvisory: (packageName: string, advisoryId: string | number, path: string[]) => void;
}): ReactElement {
  const contexts = filterDashboardAdvisoryContexts(row, searchQuery);
  return (
    <ul className="advisories">
      {contexts.map((context) => (
        <VulnerabilityCard
          advisory={context.advisory}
          flaggedPackage={context.flaggedPackage}
          path={context.primaryPath}
          paths={context.paths}
          pathsTruncated={context.pathsTruncated}
          patchedVersion={context.patchedVersion}
          rootPackageName={row.name}
          onOpenAdvisory={onOpenAdvisory}
          key={`${String(context.advisory.id)}:${context.flaggedPackage}`}
        />
      ))}
    </ul>
  );
}
