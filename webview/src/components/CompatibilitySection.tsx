import { useState } from 'react';
import type { ReactElement } from 'react';

import { findingCopy } from '../../../src/host/findingCopy.js';
import { compatibilityOutcomeDisplay, resolverOutcomeDisplay } from '../../../src/host/outcomeCopy.js';
import type { CompatibilityFinding, UpgradeAnalysisCompatibility } from '../../../src/host/webviewProtocol.js';
import { OutcomeStatus } from './OutcomeStatus.js';

const DEFAULT_VISIBLE_CAP = 4;

function FindingItem({ finding, context }: { finding: CompatibilityFinding; context: { package: string; currentVersion: string } }): ReactElement {
  const copy = findingCopy(finding, context);
  const display = compatibilityOutcomeDisplay(finding.status);
  return (
    <li className={`finding finding--${display.className}`}>
      <OutcomeStatus
        label={copy.label}
        className={display.className}
        detail={
          <>
            {copy.lines.map((entry, index) => (
              <span className="finding__line" key={index}>
                {entry.code === true ? <code>{entry.text}</code> : entry.text}
              </span>
            ))}
          </>
        }
      />
    </li>
  );
}

export function CompatibilitySection({
  compatibility,
  context,
}: {
  compatibility: UpgradeAnalysisCompatibility;
  context: { package: string; currentVersion: string };
}): ReactElement {
  const [expanded, setExpanded] = useState(false);

  const nonCompatible = compatibility.findings.filter((f) => f.status !== 'compatible');
  const conflicts = nonCompatible.filter((f) => f.status === 'conflict');
  const rest = nonCompatible.filter((f) => f.status !== 'conflict');
  // Every conflict is always shown — never hidden behind a collapsed
  // section (spec: blocking information is never collapsed by default).
  const restCap = Math.max(0, DEFAULT_VISIBLE_CAP - conflicts.length);
  const visibleRest = expanded ? rest : rest.slice(0, restCap);
  const visibleCompatible = expanded ? compatibility.findings.filter((f) => f.status === 'compatible') : [];
  const visible = [...conflicts, ...visibleRest, ...visibleCompatible];
  const hiddenCount = compatibility.findings.length - visible.length;

  const overall = compatibilityOutcomeDisplay(compatibility.status);
  const overallDetail =
    compatibility.completeness === 'partial'
      ? 'Some compatibility checks could not be completed.'
      : compatibility.status === 'compatible'
        ? 'No blocking dependency conflicts were detected.'
        : compatibility.status === 'warning'
          ? `The dependency tree resolves, but ${nonCompatible.length} issue${nonCompatible.length === 1 ? ' deserves' : 's deserve'} review.`
          : compatibility.status === 'conflict'
            ? 'This upgrade conflicts with another dependency.'
            : undefined;

  return (
    <section className="analysis-section" aria-labelledby="analysis-compatibility-heading">
      <h3 className="analysis-section__title" id="analysis-compatibility-heading">
        Compatibility
      </h3>
      <OutcomeStatus label={overall.label} className={overall.className} detail={overallDetail} size="large" />

      {compatibility.resolverVerification !== undefined ? (
        <OutcomeStatus
          label={resolverOutcomeDisplay(compatibility.resolverVerification.status).label}
          className={resolverOutcomeDisplay(compatibility.resolverVerification.status).className}
          detail={
            compatibility.resolverVerification.status === 'unknown'
              ? 'Static compatibility checks completed, but npm/pnpm verification was unavailable.'
              : `${compatibility.resolverVerification.packageManager} resolved the proposed dependency tree in an isolated temporary project.`
          }
        />
      ) : null}

      {visible.length > 0 ? (
        <ul className="finding-list">
          {visible.map((finding) => (
            <FindingItem finding={finding} context={context} key={finding.id} />
          ))}
        </ul>
      ) : null}

      {hiddenCount > 0 ? (
        <button type="button" className="button button--subtle analysis-section__more" onClick={() => setExpanded(true)}>
          Show {hiddenCount} more finding{hiddenCount === 1 ? '' : 's'}
        </button>
      ) : null}
    </section>
  );
}
