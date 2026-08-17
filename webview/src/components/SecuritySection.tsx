import type { ReactElement } from 'react';

import { securityOutcomeDisplay } from '../../../src/host/outcomeCopy.js';
import type { SecurityOutcome } from '../../../src/host/webviewProtocol.js';
import { OutcomeStatus } from './OutcomeStatus.js';
import { VulnerabilityCard } from './VulnerabilityCard.js';

function overallDetail(security: SecurityOutcome): string | undefined {
  const resolvedCount = security.resolvedAdvisories.length;
  const remainingCount = security.remaining.filter((r) => r.status === 'remains').length;
  const unknownCount = security.remaining.filter((r) => r.status === 'unknown').length;

  if (security.status === 'resolved') {
    return resolvedCount === 1
      ? 'The 1 known vulnerability through this dependency is resolved by this upgrade.'
      : `All ${resolvedCount} known vulnerabilities through this dependency are resolved by this upgrade.`;
  }
  if (security.status === 'remains') {
    const parts: string[] = [];
    if (resolvedCount > 0) parts.push(`${resolvedCount} resolved`);
    parts.push(`${remainingCount} remain${remainingCount === 1 ? 's' : ''}`);
    if (unknownCount > 0) parts.push(`${unknownCount} undetermined`);
    return parts.join(', ') + '.';
  }
  if (security.status === 'unknown') {
    return 'Some vulnerabilities could not be confirmed as fixed or remaining without deeper resolver evidence.';
  }
  return undefined;
}

export function SecuritySection({
  security,
  rootPackageName,
  onOpenAdvisory,
}: {
  security: SecurityOutcome;
  rootPackageName: string;
  onOpenAdvisory: (packageName: string, advisoryId: string | number, path: string[]) => void;
}): ReactElement {
  const display = securityOutcomeDisplay(security.status);

  return (
    <section className="analysis-section" aria-labelledby="analysis-security-heading">
      <h3 className="analysis-section__title" id="analysis-security-heading">
        Security
      </h3>
      <OutcomeStatus label={display.label} className={display.className} detail={overallDetail(security)} size="large" />

      {security.remaining.length > 0 ? (
        <ul className="advisories analysis-section__vulnerabilities">
          {security.remaining.map((entry) => (
            <VulnerabilityCard
              advisory={entry.advisory}
              flaggedPackage={entry.flaggedPackage}
              path={entry.path}
              patchedVersion={entry.patchedVersion}
              resolvedVersion={entry.resolvedVersion}
              rootPackageName={rootPackageName}
              onOpenAdvisory={onOpenAdvisory}
              key={`${String(entry.advisory.id)}:${entry.flaggedPackage}`}
            />
          ))}
        </ul>
      ) : null}
    </section>
  );
}
