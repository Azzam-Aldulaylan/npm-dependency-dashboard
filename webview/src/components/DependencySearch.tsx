import type { ChangeEvent, ReactElement } from 'react';

import { IconSearch, IconX } from '../icons.js';

/**
 * Filters by package name only, purely client-side against rows already on
 * screen — no postMessage, no re-scan, so nothing here can trigger a
 * network request while the user types.
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
        placeholder="Search dependencies…"
        aria-label="Search dependencies"
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
