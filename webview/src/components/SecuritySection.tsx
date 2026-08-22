import type { ReactElement } from 'react';

import { securityOutcomeDisplay } from '../../../src/host/outcomeCopy.js';
import type { SecurityOutcome } from '../../../src/host/webviewProtocol.js';
import { IconShield } from '../icons.js';
import { OutcomeStatus } from './OutcomeStatus.js';
import { VulnerabilityCard } from './VulnerabilityCard.js';

/** Exported for the Upgrade review tab's compact Security outcome card, which reuses this exact wording rather than composing its own. */
export function overallDetail(security: SecurityOutcome): string | undefined {
  const resolvedCount = security.resolvedAdvisories.length;
  const remainingCount = security.remaining.filter((r) => r.status === 'remains').length;
  const unknownCount = security.remaining.filter((r) => r.status === 'unknown').length;

  if (security.status === 'resolved') {
    return resolvedCount === 1
      ? '1 vulnerability resolved by this upgrade.'
      : `${resolvedCount} vulnerabilities resolved by this upgrade.`;
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

/**
 * `security === null` means this package had no known vulnerabilities
 * before this upgrade at all (see UpgradeAssistantCoordinator — the
 * evaluation only runs when there was something to evaluate) — rendered as
 * its own real "clean" card, the same 'not-applicable' status vocabulary
 * `outcomeCopy.ts` already defines, rather than the whole Security card
 * disappearing and silently breaking the Compatibility|Security /
 * Files|Verification grid pairing.
 *
 * `emphasize` gives the card the same visual weight bump the redesign spec
 * asks for ("Security status should have stronger visual priority than
 * Files/Verification when there is a vulnerability") — set only when a
 * vulnerability actually remains after the upgrade, never for a clean or
 * fully-resolved outcome, which need no extra urgency.
 */
export function SecuritySection({
  security,
  rootPackageName,
  onOpenAdvisory,
  emphasize,
}: {
  security: SecurityOutcome | null;
  rootPackageName: string;
  onOpenAdvisory: (packageName: string, advisoryId: string | number, path: string[]) => void;
  emphasize: boolean;
}): ReactElement {
  const display = securityOutcomeDisplay(security?.status ?? 'not-applicable');

  return (
    <section
      className={`analysis-card${emphasize ? ' analysis-card--emphasized' : ''}`}
      aria-labelledby="analysis-security-heading"
    >
      <h3 className="analysis-card__title" id="analysis-security-heading">
        <IconShield className="analysis-card__title-icon" />
        Security
      </h3>
      <OutcomeStatus label={display.label} className={display.className} detail={security === null ? undefined : overallDetail(security)} />

      {security !== null && security.remaining.length > 0 ? (
        <ul className="advisories analysis-card__vulnerabilities">
          {security.remaining.map((entry) => (
            <VulnerabilityCard
              advisory={entry.advisory}
              flaggedPackage={entry.flaggedPackage}
              path={entry.path}
              patchedVersion={entry.patchedVersion}
              resolvedVersion={entry.resolvedVersion}
              rootPackageName={entry.path[0] ?? rootPackageName}
              onOpenAdvisory={onOpenAdvisory}
              key={`${String(entry.advisory.id)}:${entry.flaggedPackage}`}
            />
          ))}
        </ul>
      ) : null}
    </section>
  );
}
