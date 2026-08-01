import type { ReactElement } from 'react';

import type { Severity } from '../../../src/core/types.js';

/**
 * The spec leaves the exact colour scale to be finalized visually, so the
 * palette in styles.css is a sensible placeholder ordered by severity, not a
 * design decision. Only the ordering (critical worst, none best) is meaningful.
 */
export function SeverityBadge({ severity }: { severity: Severity | null }): ReactElement {
  const label = severity ?? 'none';
  return <span className={`severity severity--${label}`}>{label}</span>;
}
