import type { ReactElement } from 'react';

/**
 * Compact badge for the table's non-severity states: Dev, Major update,
 * and the current-version source tags (Workspace, File, Git, Unresolved,
 * ...). See SeverityBadge for the vulnerability-severity badge, which keeps
 * its own dedicated styling since color there communicates a ranked scale
 * rather than a flat category.
 */
export function StatusBadge({
  label,
  tone = 'neutral',
  title,
}: {
  label: string;
  tone?: 'neutral' | 'warning';
  title?: string;
}): ReactElement {
  return (
    <span className={`status-badge status-badge--${tone}`} title={title}>
      {label}
    </span>
  );
}
