import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';

import { IconMoreHorizontal } from '../icons.js';

export interface RowActionsMenuItem {
  key: string;
  label: string;
  icon?: ReactElement;
  onSelect: () => void;
  disabled?: boolean;
}

/**
 * The secondary, overflow row-actions menu — "Where is this used?",
 * "Dependency details" — kept out of the main Action column so Upgrade/
 * Analyze stays the one primary, always-visible action per row (see the
 * redesign brief's own "Suggested Row Actions").
 *
 * `position: fixed`, computed and viewport-clamped from the trigger's own
 * rect — same technique as Tooltip.tsx's `InfoTooltip`, for the identical
 * reason: `.packages-container` scrolls, and a `position: absolute` menu
 * anchored to this row would clip the moment the row scrolls near an edge.
 */
export function RowActionsMenu({ label, items }: { label: string; items: readonly RowActionsMenuItem[] }): ReactElement {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    const menu = menuRef.current;
    if (trigger === null || menu === null) return;
    const margin = 8;
    const triggerRect = trigger.getBoundingClientRect();
    menu.style.left = `${triggerRect.right}px`;
    menu.style.top = `${triggerRect.bottom + 4}px`;
    const menuRect = menu.getBoundingClientRect();
    const left = Math.min(
      Math.max(margin, triggerRect.right - menuRect.width),
      Math.max(margin, window.innerWidth - margin - menuRect.width)
    );
    const overflowsBelow = triggerRect.bottom + 4 + menuRect.height > window.innerHeight - margin;
    const top = overflowsBelow ? Math.max(margin, triggerRect.top - menuRect.height - 4) : triggerRect.bottom + 4;
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  }, [open]);

  return (
    <div className="row-menu" ref={rootRef}>
      <button
        type="button"
        className="row-menu__trigger"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        ref={triggerRef}
        onClick={() => {
          setOpen((previous) => !previous);
        }}
      >
        <IconMoreHorizontal />
      </button>
      {open ? (
        <div className="row-menu__popover" role="menu" ref={menuRef}>
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              className="row-menu__item"
              disabled={item.disabled}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
