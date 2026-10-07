"use client";

import { Ellipsis } from "lucide-react";
import { useCallback, useId, useRef, useState, type ReactNode } from "react";
import { Button, TOUCH } from "./ui";

export interface MenuItem {
  readonly id: string;
  readonly label: string;
  readonly icon?: ReactNode;
  readonly tone?: "danger";
  readonly disabled?: boolean;
  readonly onSelect: () => void;
}

/**
 * Where focus goes when an arrow key is pressed inside a menu of `count` enabled items with `current` focused (-1: none).
 * Down and Up wrap around; Home and End jump to the ends; anything else is not a menu key.
 */
export function menuStep(key: string, current: number, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case "ArrowDown": return (current + 1) % count;
    case "ArrowUp": return current <= 0 ? count - 1 : current - 1;
    case "Home": return 0;
    case "End": return count - 1;
    default: return null;
  }
}

/** Room a menu of this many rows needs, for deciding whether it opens below its button or above it. */
function menuHeight(count: number): number {
  return count * TOUCH + 12;
}

/**
 * The ⋯ button of a row and the menu it opens. The button is the popover's own invoker, so the browser does the opening,
 * closing on a second press, light dismissal (Escape, a click outside) and the top layer: the menu is never clipped by the
 * scrolling panel it opens from. What is left to do here is put it next to its button, focus the first item, let the arrow
 * keys move through the items, and give focus back to the button when it closes.
 */
export function RowMenu({ label, items }: { label: string; items: readonly MenuItem[] }): React.ReactElement {
  const menuId = useId();
  const button = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const count = items.length;

  const attach = useCallback((element: HTMLDivElement | null) => {
    if (!element) return;
    const place = (event: Event): void => {
      const anchor = button.current;
      if (!(event instanceof ToggleEvent) || event.newState !== "open" || !anchor) return;
      const box = anchor.getBoundingClientRect();
      const roomBelow = window.innerHeight - box.bottom;
      const downward = roomBelow >= menuHeight(count) || roomBelow >= box.top;
      element.style.top = downward ? `${box.bottom + 4}px` : "auto";
      element.style.bottom = downward ? "auto" : `${window.innerHeight - box.top + 4}px`;
      element.style.right = `${Math.max(8, window.innerWidth - box.right)}px`;
    };
    const follow = (event: Event): void => {
      if (!(event instanceof ToggleEvent)) return;
      setOpen(event.newState === "open");
      if (event.newState === "open") element.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus();
    };
    element.addEventListener("beforetoggle", place);
    element.addEventListener("toggle", follow);
  }, [count]);

  return (
    <>
      <Button
        buttonRef={button}
        tone="quiet"
        icon={<Ellipsis size={18} />}
        ariaLabel={label}
        title={label}
        haspopup="menu"
        expanded={open}
        controls={menuId}
        popoverTarget={menuId}
      />
      <div
        ref={attach}
        id={menuId}
        role="menu"
        aria-label={label}
        popover="auto"
        className="dv-menu"
        onKeyDown={(event) => {
          const enabled = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])')];
          const active = document.activeElement;
          const next = menuStep(event.key, active instanceof HTMLElement ? enabled.indexOf(active) : -1, enabled.length);
          if (next === null) return;
          event.preventDefault();
          enabled[next]?.focus();
        }}
      >
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            className="ui-focus-ring dv-menuitem"
            style={item.tone === "danger" ? { color: "var(--status-error)" } : undefined}
            onClick={(event) => {
              event.currentTarget.closest<HTMLElement>('[popover]')?.hidePopover();
              button.current?.focus();
              item.onSelect();
            }}
          >
            {item.icon && <span aria-hidden="true" style={{ display: "inline-flex", flexShrink: 0 }}>{item.icon}</span>}
            <span>{item.label}</span>
          </button>
        ))}
      </div>
    </>
  );
}
