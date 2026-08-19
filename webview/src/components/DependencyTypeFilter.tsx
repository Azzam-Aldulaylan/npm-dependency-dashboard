import type { ReactElement } from 'react';

import type {
  DependencyTypeFilter as DependencyTypeFilterValue,
  DependencyTypeFilterCounts,
} from '../../../src/host/dependencyTypeFilter.js';

export function DependencyTypeFilter({
  value,
  counts,
  onChange,
}: {
  value: DependencyTypeFilterValue;
  /** Faceted against whatever else is currently filtered — see dependencyTypeFilterCounts's own doc. */
  counts: DependencyTypeFilterCounts;
  onChange: (value: DependencyTypeFilterValue) => void;
}): ReactElement {
  const options: readonly { id: DependencyTypeFilterValue; label: string }[] = [
    { id: 'all', label: `All (${counts.all})` },
    { id: 'prod', label: `Production (${counts.prod})` },
    { id: 'dev', label: `Dev (${counts.dev})` },
  ];
  return (
    <div className="type-filter" role="radiogroup" aria-label="Filter by dependency type">
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          role="radio"
          aria-checked={value === option.id}
          className="type-filter__option"
          data-selected={value === option.id ? 'true' : undefined}
          onClick={() => {
            onChange(option.id);
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
