import type { ReactElement } from 'react';

import type { AttributedAdvisory } from '../../../src/core/types.js';
import { VulnerabilityCard } from './VulnerabilityCard.js';

/**
 * The drilldown the spec's Vulnerability Scope calls for: which nested package
 * is actually flagged, the chain from the direct dependency down to it, the
 * versions actually affected, the first version known to fix it, and a way
 * to read the advisory itself. Each entry renders via VulnerabilityCard, the
 * same component the Upgrade Analysis modal's Security section uses, so a
 * vulnerability reads identically wherever it's shown.
 */
export function AdvisoryDetails({
  packageName,
  advisories,
  onOpenAdvisory,
}: {
  packageName: string;
  advisories: readonly AttributedAdvisory[];
  onOpenAdvisory: (packageName: string, advisoryId: string | number, path: string[]) => void;
}): ReactElement {
  return (
    <ul className="advisories">
      {advisories.map((entry) => (
        <VulnerabilityCard
          advisory={entry.advisory}
          flaggedPackage={entry.flaggedPackage}
          path={entry.path}
          patchedVersion={entry.patchedVersion}
          rootPackageName={packageName}
          onOpenAdvisory={onOpenAdvisory}
          key={`${String(entry.advisory.id)}:${entry.path.join('>')}`}
        />
      ))}
    </ul>
  );
}
