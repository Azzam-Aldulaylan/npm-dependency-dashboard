import type { ChangeEvent, ReactElement } from 'react';

import { IconSearch, IconX } from '../icons.js';

/**
 * Filters by package name and host-issued vulnerability facts (identifier,
 * title, flagged package, and dependency path), purely client-side against
 * rows already on screen. Typing never triggers a network request or scan.
 */
export function DependencySearch({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}): ReactElement {
  const handleChange = (event: ChangeEvent<HTMLInputElement>): void => {
    onChange(event.target.value);
  };

  return (
    <div className="search">
      <IconSearch className="search__icon" />
      <input
        type="text"
        className="search__input"
        placeholder="Search packages, vulnerability IDs, or paths…"
        aria-label="Search packages, vulnerability IDs, or dependency paths"
        value={value}
        onChange={handleChange}
      />
      {value.length > 0 ? (
        <button
          type="button"
          className="search__clear"
          aria-label="Clear search"
          onClick={() => {
            onChange('');
          }}
        >
          <IconX />
        </button>
      ) : null}
    </div>
  );
}
