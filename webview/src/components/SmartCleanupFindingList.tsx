import { Fragment, useEffect, useMemo, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';

export interface SmartCleanupFindingListProps<Item> {
  items: readonly Item[];
  getKey: (item: Item) => string;
  getSearchText: (item: Item) => string;
  renderItem: (item: Item) => ReactNode;
  searchLabel: string;
  emptyMessage: string;
  initialCount?: number;
  searchThreshold?: number;
}

/**
 * Shared bounded disclosure for evidence-heavy cleanup categories. Keeping
 * search and progressive rendering here prevents every category from growing
 * its own subtly different list controls as new finding types are added.
 */
export function SmartCleanupFindingList<Item>({
  items,
  getKey,
  getSearchText,
  renderItem,
  searchLabel,
  emptyMessage,
  initialCount = 8,
  searchThreshold = 8,
}: SmartCleanupFindingListProps<Item>): ReactElement {
  const [query, setQuery] = useState('');
  const [visibleCount, setVisibleCount] = useState(initialCount);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredItems = useMemo(
    () => normalizedQuery.length === 0
      ? items
      : items.filter((item) => getSearchText(item).toLocaleLowerCase().includes(normalizedQuery)),
    [getSearchText, items, normalizedQuery]
  );
  const visibleItems = filteredItems.slice(0, visibleCount);
  const remaining = Math.max(0, filteredItems.length - visibleItems.length);

  useEffect(() => setVisibleCount(initialCount), [initialCount, normalizedQuery]);

  return (
    <div className="smart-cleanup-finding-list">
      {items.length >= searchThreshold ? (
        <label className="smart-cleanup-finding-list__search">
          <span>{searchLabel}</span>
          <input
            type="search"
            value={query}
            placeholder="Package, version, or dependency path…"
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        </label>
      ) : null}

      {visibleItems.length === 0 ? (
        <p className="smart-cleanup-category__empty">{emptyMessage}</p>
      ) : (
        <ul className="smart-cleanup-information-list">
          {visibleItems.map((item) => <Fragment key={getKey(item)}>{renderItem(item)}</Fragment>)}
        </ul>
      )}

      {remaining > 0 ? (
        <button
          type="button"
          className="button button--small button--secondary smart-cleanup-finding-list__more"
          onClick={() => setVisibleCount((count) => count + initialCount)}
        >
          Show {Math.min(initialCount, remaining)} more · {remaining} remaining
        </button>
      ) : null}
    </div>
  );
}
