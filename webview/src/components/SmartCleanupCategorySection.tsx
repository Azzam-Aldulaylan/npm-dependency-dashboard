import type { ReactElement, ReactNode } from 'react';

import { IconChevronRight } from '../icons.js';
import type { SmartCleanupCategory } from '../smartCleanupState.js';

export function SmartCleanupCategorySection({
  category,
  title,
  summary,
  count,
  expanded,
  onToggle,
  children,
}: {
  category: SmartCleanupCategory;
  title: string;
  summary: string;
  count: number;
  expanded: boolean;
  onToggle: () => void;
  children: ReactNode;
}): ReactElement {
  const panelId = `smart-cleanup-${category}-panel`;
  const triggerId = `smart-cleanup-${category}-trigger`;

  return (
    <section className="smart-cleanup-category" data-expanded={expanded ? 'true' : undefined}>
      <h3 className="smart-cleanup-category__heading">
        <button
          type="button"
          className="smart-cleanup-category__trigger"
          id={triggerId}
          aria-expanded={expanded}
          aria-controls={panelId}
          onClick={onToggle}
        >
          <IconChevronRight className="smart-cleanup-category__chevron" />
          <span className="smart-cleanup-category__title">{title}</span>
          <span className="smart-cleanup-category__summary">{summary}</span>
          <span className="smart-cleanup-category__count" aria-label={`${count} ${count === 1 ? 'finding' : 'findings'}`}>
            {count}
          </span>
        </button>
      </h3>
      {expanded ? (
        <div
          className="smart-cleanup-category__panel"
          id={panelId}
          role="region"
          aria-labelledby={triggerId}
        >
          {children}
        </div>
      ) : null}
    </section>
  );
}
