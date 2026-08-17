import type { ReactElement, ReactNode } from 'react';

import { IconFolder, IconRefresh } from '../icons.js';

function countLabel(visible: number, total: number): string {
  const noun = total === 1 ? 'dependency' : 'dependencies';
  if (visible === total) return `${total} ${noun}`;
  return `${visible} of ${total} ${noun}`;
}

/**
 * The control row above the table: how many rows the current search/card
 * filter leaves visible plus `children` (the dependency-type filter) on the
 * left, project switching and refresh on the right. Both actions keep their
 * existing disabled-while-busy behavior — this only rearranges where they
 * render.
 */
export function DashboardToolbar({
  visibleCount,
  totalCount,
  canChangeProject,
  onChangeProject,
  onRefresh,
  disabled,
  children,
}: {
  visibleCount: number;
  totalCount: number;
  canChangeProject: boolean;
  onChangeProject: () => void;
  onRefresh: () => void;
  disabled: boolean;
  children?: ReactNode;
}): ReactElement {
  return (
    <div className="toolbar">
      <div className="toolbar__leading">
        <p className="toolbar__count">{countLabel(visibleCount, totalCount)}</p>
        {children}
      </div>
      <div className="toolbar__actions">
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
