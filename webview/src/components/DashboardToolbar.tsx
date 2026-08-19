import type { ReactElement, ReactNode } from 'react';

import { IconFolder, IconRefresh } from '../icons.js';

/**
 * The control row above the table: `children` (the dependency-type and
 * hygiene filters — each already carries its own counts, e.g. "All (139)")
 * on the left, project switching and refresh on the right. There is
 * deliberately no separate "N dependencies" count here anymore — it only
 * ever duplicated the "All (N)" filter option right next to it.
 */
export function DashboardToolbar({
  canChangeProject,
  onChangeProject,
  onRefresh,
  disabled,
  children,
  trailingActions,
}: {
  canChangeProject: boolean;
  onChangeProject: () => void;
  onRefresh: () => void;
  disabled: boolean;
  children?: ReactNode;
  /** Rendered before "Change project"/"Refresh" — see App.tsx's "Analyze cleanup" button. */
  trailingActions?: ReactNode;
}): ReactElement {
  return (
    <div className="toolbar">
      <div className="toolbar__leading">{children}</div>
      <div className="toolbar__actions">
        {trailingActions}
        {canChangeProject ? (
          <button className="button button--secondary" type="button" onClick={onChangeProject} disabled={disabled}>
            <IconFolder />
            Change project
          </button>
        ) : null}
        <button className="button button--secondary" type="button" onClick={onRefresh} disabled={disabled}>
          <IconRefresh />
          Refresh
        </button>
      </div>
    </div>
  );
}
