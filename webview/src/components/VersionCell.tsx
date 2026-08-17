import type { ReactElement } from 'react';

import type { PackageRow } from '../../../src/core/types.js';
import type { UpdateKind } from '../../../src/host/updateClassification.js';
import type { CurrentVersionTag } from '../../../src/host/versionDisplay.js';
import { availableVersionDisplay, currentVersionDisplay } from '../../../src/host/versionDisplay.js';
import { StatusBadge } from './StatusBadge.js';
import { InfoTooltip } from './Tooltip.js';

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

const CLASSIFICATION_LABEL: Record<UpdateKind, string> = { major: 'Major', minor: 'Minor', patch: 'Patch' };
/** Only Major gets a colour accent — routine minor/patch bumps stay neutral so the row isn't shouting. */
const CLASSIFICATION_TONE: Record<UpdateKind, 'neutral' | 'warning'> = {
  major: 'warning',
  minor: 'neutral',
  patch: 'neutral',
};

function ClassificationBadge({ kind }: { kind: UpdateKind | null }): ReactElement | null {
  if (kind === null) return null;
  return <StatusBadge label={CLASSIFICATION_LABEL[kind]} tone={CLASSIFICATION_TONE[kind]} />;
}

export function CurrentVersionCell({ row }: { row: PackageRow }): ReactElement {
  const display = currentVersionDisplay(row.current, row.range, row.unresolvable);
  const text = display.kind === 'dash' ? '—' : display.value;
  if (display.tag === null) return <>{text}</>;
  return (
    <>
      {text} <StatusBadge label={TAG_LABELS[display.tag]} />
    </>
  );
}

/**
 * The Available column's compact rendering — see availableVersionDisplay
 * for the underlying decision. Wanted === Latest collapses to one line;
 * otherwise Latest is the strong, primary value with Wanted demoted to a
 * muted "within current range" caption, matching the redesign's intent
 * that a user is never told "you're behind" when a plain install already
 * gets them nothing more.
 */
export function AvailableVersionCell({ row }: { row: PackageRow }): ReactElement {
  const display = availableVersionDisplay(row.current, row.wanted, row.latest);

  if (display.kind === 'dash') return <span aria-hidden="true">—</span>;

  if (display.kind === 'single') {
    return (
      <span className="version-cell">
        <span className="version-cell__row">
          <span className="version-cell__value">{display.value}</span>
          <ClassificationBadge kind={display.updateKind} />
        </span>
        {display.hasUpdate ? <span className="version-cell__caption">Latest · within range</span> : null}
      </span>
    );
  }

  return (
    <span className="version-cell">
      <span className="version-cell__row">
        <span className="version-cell__value version-cell__value--primary">{display.value}</span>
        <ClassificationBadge kind={display.updateKind} />
      </span>
      <span className="version-cell__caption">Latest</span>
      <span className="version-cell__caption version-cell__caption--muted">
        Within current range: {display.withinRange}
      </span>
    </span>
  );
}

/**
 * Header *content* only — never a `<th>` itself. PackageTable's sortable
 * header wraps every column's label in a `<button>` to carry the click
 * handler, and a `<button>` cannot contain another interactive element
 * (the Available column's info trigger below), so that trigger has to be
 * a sibling passed separately rather than nested inside this label.
 */
export function CurrentHeaderLabel(): ReactElement {
  return (
    <span title={CURRENT_EXPLANATION} aria-label={`Current: ${CURRENT_EXPLANATION}`}>
      Current
    </span>
  );
}

export function AvailableHeaderLabel(): ReactElement {
  return <>Available</>;
}

/**
 * The Available column's terminology affordance — a single icon covering
 * Current/Wanted/Latest together, since the compact cell above no longer
 * always shows a "Wanted"/"Latest" text label to hang a tooltip off of
 * directly. Rendered as PackageTable's sortable header's sibling `extra`,
 * not nested inside the sort button — see this file's header-label doc.
 * Opens on hover *or* click/keyboard (see InfoTooltip) — previously this was
 * a plain `title`-only button that did nothing on click or keyboard focus.
 */
export function AvailableHeaderInfo(): ReactElement {
  return (
    <InfoTooltip
      label="Version terminology"
      content={
        <dl>
          <dt>Current</dt>
          <dd>{CURRENT_EXPLANATION}</dd>
          <dt>Wanted</dt>
          <dd>{WANTED_EXPLANATION}</dd>
          <dt>Latest</dt>
          <dd>{LATEST_EXPLANATION}</dd>
        </dl>
      }
    />
  );
}
