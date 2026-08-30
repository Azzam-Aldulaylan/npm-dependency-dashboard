import type { ReactElement, ReactNode } from 'react';

import { IconAlertTriangle, IconInfo } from '../icons.js';

export type StatusBannerTone = 'info' | 'warning' | 'error';

export interface StatusBannerAction {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  icon?: ReactNode;
}

export function StatusBanner({
  tone,
  children,
  icon,
  action,
  className,
  role,
  live,
}: {
  tone: StatusBannerTone;
  children: ReactNode;
  icon?: ReactNode;
  action?: StatusBannerAction;
  className?: string;
  role?: 'alert' | 'status';
  live?: 'polite' | 'assertive';
}): ReactElement {
  const resolvedIcon = icon ?? (tone === 'info' ? <IconInfo /> : <IconAlertTriangle />);
  const resolvedRole = role ?? (tone === 'error' ? 'alert' : 'status');
  return (
    <div
      className={`banner banner--${tone}${className === undefined ? '' : ` ${className}`}`}
      role={resolvedRole}
      aria-live={live}
      aria-atomic={live === undefined ? undefined : true}
    >
      <span className="banner__icon" aria-hidden="true">{resolvedIcon}</span>
      <p className="banner__text">{children}</p>
      {action === undefined ? null : (
        <button
          className="button button--secondary banner__action"
          type="button"
          onClick={action.onClick}
          disabled={action.disabled}
        >
          {action.icon}
          {action.label}
        </button>
      )}
    </div>
  );
}
