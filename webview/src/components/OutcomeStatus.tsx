import type { ReactElement, ReactNode } from 'react';

import { IconAlertTriangle, IconCheck, IconHelpCircle, IconXCircle } from '../icons.js';

/**
 * The one icon+colour vocabulary every outcome state in the Upgrade Analysis
 * modal reads from — compatibility's four statuses and security's four
 * statuses both resolve to one of these five `className`s (see
 * outcomeCopy.ts), so a user only has to learn "check/triangle/x/help" once
 * and can reapply it everywhere in the modal.
 */
function iconFor(className: string): ReactElement {
  switch (className) {
    case 'compatible':
    case 'resolved':
      return <IconCheck />;
    case 'warning':
      return <IconAlertTriangle />;
    case 'conflict':
    case 'remains':
      return <IconXCircle />;
    case 'not-applicable':
      return <IconCheck />;
    default:
      return <IconHelpCircle />;
  }
}

export function OutcomeStatus({
  label,
  className,
  detail,
  size = 'default',
}: {
  label: string;
  className: string;
  detail?: ReactNode;
  size?: 'default' | 'large';
}): ReactElement {
  return (
    <div className={`outcome-status outcome-status--${className}${size === 'large' ? ' outcome-status--large' : ''}`}>
      <span className="outcome-status__icon">{iconFor(className)}</span>
      <div className="outcome-status__text">
        <p className="outcome-status__label">{label}</p>
        {detail !== undefined && detail !== null ? <div className="outcome-status__detail">{detail}</div> : null}
      </div>
    </div>
  );
}
