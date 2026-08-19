import type { ReactElement } from 'react';

import type { UpgradeAnalysisVerification } from '../../../src/host/webviewProtocol.js';
import { IconGear, IconListChecks } from '../icons.js';
import { OutcomeStatus } from './OutcomeStatus.js';

export function VerificationSection({
  verification,
  onConfigureVerification,
  configuredLabel = 'Post-upgrade checks configured',
}: {
  verification: UpgradeAnalysisVerification;
  onConfigureVerification: () => void;
  /** Override for a flow other than an upgrade — e.g. a removal's "Post-removal checks configured". */
  configuredLabel?: string;
}): ReactElement {
  return (
    <section className="analysis-card" aria-labelledby="analysis-verification-heading">
      <h3 className="analysis-card__title" id="analysis-verification-heading">
        <IconListChecks className="analysis-card__title-icon" />
        Verification
      </h3>
      {verification.configured ? (
        <>
          <OutcomeStatus label={configuredLabel} className="compatible" />
          <ul className="verification__scripts">
            {verification.scriptNames.map((name) => (
              <li key={name}>
                <code>{name}</code>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <>
          <OutcomeStatus
            label="Application verification is not configured"
            className="warning"
            detail="The dependency installation can be verified, but the application's build/tests will not run automatically."
          />
          <button type="button" className="button button--secondary verification__configure" onClick={onConfigureVerification}>
            <IconGear />
            Configure verification
          </button>
        </>
      )}
    </section>
  );
}
