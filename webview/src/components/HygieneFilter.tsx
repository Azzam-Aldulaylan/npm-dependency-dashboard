import type { ReactElement } from 'react';

import type { HygieneFilterId } from '../../../src/host/hygieneFilter.js';

/**
 * Same segmented-button pattern as DependencyTypeFilter — the two toolbar
 * filters read as one consistent control language rather than a button
 * group next to an unrelated-looking dropdown.
 */
export function HygieneFilter({
  value,
  likelyUnusedCount,
  duplicateCount,
  onChange,
}: {
  value: HygieneFilterId;
  likelyUnusedCount: number;
  duplicateCount: number;
  onChange: (value: HygieneFilterId) => void;
}): ReactElement {
  const options: readonly { id: HygieneFilterId; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'likely-unused', label: `Likely unused (${likelyUnusedCount})` },
    { id: 'duplicate-version', label: `Duplicate versions (${duplicateCount})` },
  ];
  return (
    <div className="type-filter" role="radiogroup" aria-label="Filter by dependency finding">
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
