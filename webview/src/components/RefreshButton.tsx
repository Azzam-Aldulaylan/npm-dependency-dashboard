import type { ReactElement } from 'react';

export function RefreshButton({
  onRefresh,
  disabled,
}: {
  onRefresh: () => void;
  disabled: boolean;
}): ReactElement {
  return (
    <button className="button" type="button" onClick={onRefresh} disabled={disabled}>
      Refresh
    </button>
  );
}
