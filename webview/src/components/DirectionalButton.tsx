import type { ButtonHTMLAttributes, ReactElement, ReactNode } from 'react';

import { IconChevronLeft, IconChevronRight } from '../icons.js';

/**
 * Shared navigation affordance for multi-step reviews. The icon is part of
 * the component so Back/Continue actions never fall back to text glyphs with
 * inconsistent size, weight, or screen-reader behavior.
 */
export function DirectionalButton({
  direction,
  children,
  className = 'button button--secondary',
  type = 'button',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  direction: 'back' | 'forward';
  children: ReactNode;
}): ReactElement {
  return (
    <button type={type} className={className} {...props}>
      {direction === 'back' ? <IconChevronLeft aria-hidden="true" /> : null}
      <span>{children}</span>
      {direction === 'forward' ? <IconChevronRight aria-hidden="true" /> : null}
    </button>
  );
}
