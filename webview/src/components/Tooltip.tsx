import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';

import { IconInfo } from '../icons.js';

/**
 * The one shared hover/focus/click tooltip-and-popover primitive the
 * webview uses everywhere something needs a real explanation instead of a
 * decorative icon that does nothing — the Available column's version
 * terminology, and every "why is there no normal Upgrade button" reason in
 * the Action column. A single component so every popover matches the VS
 * Code theme, clamps to the viewport, and behaves identically on hover,
 * focus, click, and Escape, rather than bespoke tooltip styling per
 * component.
 *
 * The trigger is always a real `<button>` with `aria-describedby` pointing
 * at the popover's own id, so the same explanation reaches a screen reader
 * that a sighted hover/click user gets — never the sole affordance being an
 * icon with a `title` attribute nothing else exposes.
 */
export function InfoTooltip({
  label,
  content,
  icon,
  className,
}: {
  /** Accessible name for the trigger button, e.g. "Version terminology" or "Why there is no upgrade button". */
  label: string;
  content: ReactNode;
  /** Defaults to the info glyph; callers with a different icon already in hand (e.g. a warning triangle) can override it. */
  icon?: ReactNode;
  className?: string;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const popoverId = useId();
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Click toggles a "pinned" open state that only Escape/outside-click/blur
  // clears — hover alone would otherwise dismiss it the instant the pointer
  // leaves, defeating the point of a click-to-open popover.
  const pinned = useRef(false);

  const clearCloseTimer = (): void => {
    if (closeTimer.current !== null) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };

  const show = (): void => {
    clearCloseTimer();
    setOpen(true);
  };

  // A short grace period, not an instant close, so moving the pointer from
  // the trigger into the popover itself (to select/copy text, say) doesn't
  // dismiss it mid-transit.
  const scheduleHide = (): void => {
    if (pinned.current) return;
    clearCloseTimer();
    closeTimer.current = setTimeout(() => {
      setOpen(false);
    }, 150);
  };

  const hideNow = (): void => {
    clearCloseTimer();
    pinned.current = false;
    setOpen(false);
  };

  useEffect(() => clearCloseTimer, []);

  // Outside click/focus closes a pinned popover — otherwise it would stay
  // open forever once the user has moved on to something else on the page.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) hideNow();
    };
    const onFocusIn = (event: FocusEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) hideNow();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('focusin', onFocusIn);
    };
  }, [open]);

  // `position: fixed`, positioned by hand from the trigger's own
  // viewport-relative rect, rather than `position: absolute` anchored to
  // this component's own DOM parent — the package table's own container
  // scrolls (`.packages-container { overflow-x/y: auto }`), which would
  // clip an absolutely-positioned popover the moment the row holding it
  // scrolls near an edge. `fixed` escapes that clipping entirely (nothing
  // in this table sets a `transform`/`filter` that would turn an ancestor
  // into `fixed`'s containing block instead of the viewport) and is
  // clamped below to the viewport itself, not just this table.
  useLayoutEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    const popover = popoverRef.current;
    if (trigger === null || popover === null) return;
    const margin = 8;
    const triggerRect = trigger.getBoundingClientRect();
    // Measure from the viewport margin, with the full available width.
    // Measuring beside a right-edge trigger shrink-wraps the popover; moving
    // it left then makes it wider again and invalidates the clamped position.
    popover.style.left = `${margin}px`;
    popover.style.top = `${margin}px`;
    const popoverRect = popover.getBoundingClientRect();
    const left = Math.min(
      Math.max(margin, triggerRect.left),
      Math.max(margin, window.innerWidth - margin - popoverRect.width)
    );
    const overflowsBelow = triggerRect.bottom + 6 + popoverRect.height > window.innerHeight - margin;
    const top = overflowsBelow
      ? Math.max(margin, triggerRect.top - popoverRect.height - 6)
      : triggerRect.bottom + 6;
    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;
  }, [open]);

  return (
    <span
      className={`info-tooltip${className === undefined ? '' : ` ${className}`}`}
      ref={rootRef}
      onMouseEnter={show}
      onMouseLeave={scheduleHide}
    >
      <button
        type="button"
        className="info-tooltip__trigger"
        aria-label={label}
        aria-describedby={popoverId}
        aria-expanded={open}
        ref={triggerRef}
        onFocus={show}
        onBlur={scheduleHide}
        onClick={(event) => {
          event.stopPropagation();
          pinned.current = !pinned.current;
          if (pinned.current) show();
          else hideNow();
        }}
        // Capture Escape before a parent dialog's native keydown listener.
        // Closing help must not also dismiss the review behind it.
        onKeyDownCapture={(event) => {
          if (event.key === 'Escape' && open) {
            event.preventDefault();
            event.stopPropagation();
            hideNow();
            triggerRef.current?.focus();
          }
        }}
      >
        {icon ?? <IconInfo />}
      </button>
      {open ? (
        <div
          className="info-tooltip__popover"
          role="tooltip"
          id={popoverId}
          ref={popoverRef}
          onMouseEnter={show}
          onMouseLeave={scheduleHide}
        >
          {content}
        </div>
      ) : null}
    </span>
  );
}
