import type { ReactElement } from 'react';

import type { DependencyTypeFilter as DependencyTypeFilterValue } from '../../../src/host/dependencyTypeFilter.js';

const OPTIONS: readonly { id: DependencyTypeFilterValue; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'prod', label: 'Production' },
  { id: 'dev', label: 'Dev' },
];

export function DependencyTypeFilter({
  value,
  onChange,
}: {
  value: DependencyTypeFilterValue;
  onChange: (value: DependencyTypeFilterValue) => void;
}): ReactElement {
  return (
    <div className="type-filter" role="radiogroup" aria-label="Filter by dependency type">
      {OPTIONS.map((option) => (
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
