"use client";

import { useRef, type KeyboardEvent, type ReactNode } from "react";

export interface SegmentedOption<V extends string> {
  value: V;
  label: string;
  icon?: ReactNode;
}

export interface SegmentedProps<V extends string> {
  value: V;
  onChange: (value: V) => void;
  options: SegmentedOption<V>[];
  "aria-label": string;
  size?: "sm" | "md";
}

/**
 * A short row of mutually exclusive choices (period, Cost/Tokens). One tab stop
 * for the whole group; the arrow keys move between the choices and pick as they
 * go, which is how a radio group behaves everywhere else.
 */
export function Segmented<V extends string>({ value, onChange, options, "aria-label": ariaLabel, size = "md" }: SegmentedProps<V>) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (options.length === 0) return;
    const current = options.findIndex((option) => option.value === value);
    let next: number;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (current + 1) % options.length;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (current - 1 + options.length) % options.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = options.length - 1;
    else return;
    event.preventDefault();
    onChange(options[next].value);
    buttons.current[next]?.focus();
  };

  return (
    <div className="stats-seg" data-size={size} role="radiogroup" aria-label={ariaLabel} onKeyDown={onKeyDown}>
      {options.map((option, index) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            ref={(element) => {
              buttons.current[index] = element;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            className="stats-seg-btn ui-focus-ring"
            data-selected={selected ? "true" : undefined}
            onClick={() => onChange(option.value)}
          >
            {option.icon}
            <span>{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
