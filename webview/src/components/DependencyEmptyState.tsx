import type { ReactElement } from 'react';

import { IconFilter, IconPackage, IconSearch } from '../icons.js';

export type EmptyStateIcon = 'package' | 'search' | 'filter';

const ICONS: Record<EmptyStateIcon, (props: { className?: string }) => ReactElement> = {
  package: IconPackage,
  search: IconSearch,
  filter: IconFilter,
};

/**
 * A single presentational shape for every "the table has nothing to show"
 * case — an empty project, a search with no matches, or a summary-card/type
 * filter with no matches. Callers (App.tsx) decide which icon/copy fits;
 * this only lays it out consistently.
 */
export function DependencyEmptyState({
  icon,
  title,
  detail,
  onClearSearch,
}: {
  icon: EmptyStateIcon;
  title: string;
  detail?: string;
  onClearSearch?: () => void;
}): ReactElement {
  const Icon = ICONS[icon];
  return (
    <div className="empty-state">
      <Icon className="empty-state__icon" />
      <p className="empty-state__title">{title}</p>
      {detail !== undefined ? <p className="empty-state__detail">{detail}</p> : null}
      {onClearSearch !== undefined ? (
        <button type="button" className="button button--secondary" onClick={onClearSearch}>
          Clear search
        </button>
      ) : null}
    </div>
  );
}
