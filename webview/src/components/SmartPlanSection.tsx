import type { ReactElement } from 'react';

import type { UpgradeAnalysisSmartPlan } from '../../../src/host/webviewProtocol.js';
import { IconRoute } from '../icons.js';

/**
 * Only ever rendered when the host already found and validated a coordinated
 * plan (`smartPlan !== null`) — the webview never constructs plan steps of
 * its own; `onUseSmartPlan` echoes back only the analysis id the host itself
 * issued, never plan contents (see webviewProtocol.ts's own doc on
 * use-smart-plan).
 */
/** Display-only — the "Use coordinated upgrade" action itself lives in the modal footer, so there's exactly one place to trigger it, not two. */
export function SmartPlanSection({ smartPlan }: { smartPlan: UpgradeAnalysisSmartPlan }): ReactElement {
  return (
    <section className="analysis-section analysis-section--smart-plan" aria-labelledby="analysis-smart-plan-heading">
      <h3 className="analysis-section__title" id="analysis-smart-plan-heading">
        <IconRoute className="analysis-section__title-icon" />
        Recommended coordinated upgrade
      </h3>
      <ol className="smart-plan__changes">
        {smartPlan.changes.map((change) => (
          <li className="smart-plan__change" key={change.packageName}>
            <span className="smart-plan__package">{change.packageName}</span>
            <span className="smart-plan__versions">
              {change.currentVersion} → {change.targetVersion}
            </span>
          </li>
        ))}
      </ol>
      <p className="analysis-section__hint">
        This upgrade alone conflicts with another dependency. Upgrading these packages together resolves it.
      </p>
    </section>
  );
}
