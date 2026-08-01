import type { ReactElement } from 'react';

import type { AttributedAdvisory } from '../../../src/core/types.js';
import { SeverityBadge } from './SeverityBadge.js';

/**
 * The drilldown the spec's Vulnerability Scope calls for: which nested package
 * is actually flagged, and the chain from the direct dependency down to it.
 * `path` already ends at `flaggedPackage`, but the flagged package is named
 * separately too — the chain can be long, and "what is actually vulnerable" is
 * the question this view exists to answer.
 */
export function AdvisoryDetails({
  advisories,
}: {
  advisories: readonly AttributedAdvisory[];
}): ReactElement {
  return (
    <ul className="advisories">
      {advisories.map((entry) => (
        <li className="advisory" key={`${String(entry.advisory.id)}:${entry.path.join('>')}`}>
          <div className="advisory__head">
            <SeverityBadge severity={entry.advisory.severity} />
            <span className="advisory__title">{entry.advisory.title}</span>
          </div>
          <dl className="advisory__meta">
            <dt>Flagged package</dt>
            <dd>
              <code>{entry.flaggedPackage}</code>
            </dd>
            <dt>Path</dt>
            <dd className="advisory__path">{entry.path.join(' → ')}</dd>
          </dl>
        </li>
      ))}
    </ul>
  );
}
