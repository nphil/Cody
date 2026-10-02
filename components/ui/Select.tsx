"use client";

import { Combobox } from "@base-ui/react/combobox";
import { Select as BaseSelect } from "@base-ui/react/select";
import { Check, ChevronDown, Search } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { useIsCoarsePointer } from "@/hooks/useIsCoarsePointer";

/**
 * The one dropdown Cody draws. A native `<select>` is painted by the
 * browser — a different popup on every platform, and one that ignores the
 * theme — so every choice control renders through this instead: a trigger
 * on the design tokens and a popup on the same `dropdown-surface` /
 * `dropdown-item` classes the composer's Smart/reasoning menus use, so the
 * whole app opens the same menu. Built on base-ui's Select for the parts a
 * hand-rolled popup always gets wrong (keyboard navigation, typeahead,
 * positioning that flips at the viewport edge, focus return, a portal that
 * escapes overflow:hidden ancestors).
 *
 * `search` turns the same control into a filterable one for lists too long
 * to scan (the world's time zones): a text field above the options. base-ui's
 * Select has no text field, so that path is built on its Combobox — the
 * filterable select it documents ("input inside popup") — wearing the same
 * trigger, popup and rows, so the two cannot drift apart.
 */

export interface SelectOption<V extends string = string> {
  value: V;
  label: ReactNode;
  /** Secondary muted line under the label. */
  description?: ReactNode;
  disabled?: boolean;
}

export interface SelectGroup<V extends string = string> {
  label: ReactNode;
  options: readonly SelectOption<V>[];
}

/** The words of a searchable Select, supplied by the caller so they follow its language. */
export interface SelectSearch {
  /** Hint inside the empty filter field. */
  placeholder: string;
  /** Shown in place of the list when nothing matches what was typed. */
  empty: string;
}

interface SelectProps<V extends string> {
  value: V | null;
  onChange: (value: V) => void;
  /** Flat options, or grouped sections; groups render a muted header row. */
  options: readonly SelectOption<V>[] | readonly SelectGroup<V>[];
  placeholder?: ReactNode;
  disabled?: boolean;
  /** Trigger height. `sm` (26px) for toolbars, `md` (32px, default) for forms. */
  size?: "sm" | "md";
  /** Shown before the value on the trigger. */
  icon?: ReactNode;
  /** Trigger width; defaults to filling its container. */
  width?: CSSProperties["width"];
  id?: string;
  name?: string;
  "aria-label"?: string;
  "data-testid"?: string;
  /** Popup min/max width; defaults to at least the trigger's width. */
  popupWidth?: CSSProperties["minWidth"];
  invalid?: boolean;
  /** Adds a filter field at the top of the popup. Absent = a plain select. */
  search?: SelectSearch;
}

function isGrouped<V extends string>(options: SelectProps<V>["options"]): options is readonly SelectGroup<V>[] {
  return options.length > 0 && "options" in options[0];
}

/** Lowercase words of `text`. Identifier separators count as spaces, so
 *  "new york" finds "America/New_York". */
function searchWords(text: string): string[] {
  return text.toLowerCase().replace(/[_/-]+/g, " ").split(/\s+/).filter(Boolean);
}

/** Every word typed must appear in `text`, in any order; typing nothing matches everything. */
export function matchesSearch(text: string, query: string): boolean {
  const wanted = searchWords(query);
  if (wanted.length === 0) return true;
  const haystack = searchWords(text).join(" ");
  return wanted.every((word) => haystack.includes(word));
}

// The look, shared by both paths below: one definition, so a restyle cannot
// reach the plain select and miss the searchable one.

function triggerStyle(selected: boolean, { size, width, invalid, disabled }: Pick<SelectProps<string>, "size" | "width" | "invalid" | "disabled">): CSSProperties {
  const small = size === "sm";
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    width: width ?? "100%",
    minWidth: 0,
    height: small ? 26 : 32,
    padding: small ? "0 6px 0 8px" : "0 8px 0 10px",
    fontSize: small ? 12 : 13,
    lineHeight: 1,
    textAlign: "left",
    color: selected ? "var(--text)" : "var(--text-dim)",
    background: "var(--bg-panel)",
    border: `1px solid ${invalid ? "var(--status-error)" : "var(--border)"}`,
    borderRadius: "var(--radius-control)",
    cursor: disabled ? "default" : "pointer",
    opacity: disabled ? 0.55 : 1,
  };
}

const popupBounds: CSSProperties = { maxWidth: "min(420px, calc(100vw - 16px))", maxHeight: "min(360px, var(--available-height))" };
const itemStyle: CSSProperties = { display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", borderRadius: "calc(var(--radius-control) - 2px)", fontSize: 12.5, outline: "none" };
const groupLabelStyle: CSSProperties = { padding: "6px 10px 3px", fontSize: 10.5, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-dim)" };
const itemTextStyle: CSSProperties = { display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const itemDescriptionStyle: CSSProperties = { display: "block", fontSize: 11, color: "var(--text-dim)", whiteSpace: "normal" };
const indicatorStyle: CSSProperties = { display: "inline-flex", flexShrink: 0, color: "var(--accent)" };

export function Select<V extends string = string>(props: SelectProps<V>) {
  return props.search ? <SearchableSelect {...props} search={props.search} /> : <PlainSelect {...props} />;
}

function PlainSelect<V extends string>({
  value, onChange, options, placeholder, disabled, size = "md", icon, width, id, name, invalid, popupWidth,
  "aria-label": ariaLabel, "data-testid": testId,
}: SelectProps<V>) {
  const groups: readonly SelectGroup<V>[] = isGrouped(options) ? options : [{ label: null, options }];
  const flat = groups.flatMap((group) => group.options);
  const selected = flat.find((option) => option.value === value) ?? null;

  return (
    <BaseSelect.Root<V>
      value={value}
      onValueChange={(next) => { if (next !== null && next !== value) onChange(next); }}
      disabled={disabled}
      name={name}
      items={flat.map((option) => ({ value: option.value, label: option.label }))}
    >
      <BaseSelect.Trigger
        id={id}
        aria-label={ariaLabel}
        aria-invalid={invalid || undefined}
        data-testid={testId}
        className="ui-focus-ring ui-select-trigger"
        style={triggerStyle(selected !== null, { size, width, invalid, disabled })}
      >
        {icon && <span style={{ display: "inline-flex", flexShrink: 0, color: "var(--text-muted)" }}>{icon}</span>}
        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          <BaseSelect.Value>{selected ? selected.label : placeholder ?? ""}</BaseSelect.Value>
        </span>
        <BaseSelect.Icon style={{ display: "inline-flex", flexShrink: 0, color: "var(--text-muted)" }}>
          <ChevronDown size={size === "sm" ? 12 : 14} />
        </BaseSelect.Icon>
      </BaseSelect.Trigger>
      <BaseSelect.Portal>
        <BaseSelect.Positioner sideOffset={4} alignItemWithTrigger={false} style={{ zIndex: 1200 }}>
          <BaseSelect.Popup
            className="dropdown-surface"
            style={{ minWidth: popupWidth ?? "var(--anchor-width)", ...popupBounds, overflowY: "auto", padding: 4 }}
          >
            <BaseSelect.List>
              {groups.map((group, groupIndex) => (
                <BaseSelect.Group key={groupIndex}>
                  {group.label !== null && group.label !== undefined && (
                    <BaseSelect.GroupLabel style={groupLabelStyle}>
                      {group.label}
                    </BaseSelect.GroupLabel>
                  )}
                  {group.options.map((option) => (
                    <BaseSelect.Item
                      key={option.value}
                      value={option.value}
                      disabled={option.disabled}
                      className="dropdown-item"
                      style={{ ...itemStyle, cursor: option.disabled ? "default" : "pointer", opacity: option.disabled ? 0.5 : 1 }}
                    >
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <BaseSelect.ItemText style={itemTextStyle}>{option.label}</BaseSelect.ItemText>
                        {option.description && <span style={itemDescriptionStyle}>{option.description}</span>}
                      </span>
                      <BaseSelect.ItemIndicator style={indicatorStyle}>
                        <Check size={13} />
                      </BaseSelect.ItemIndicator>
                    </BaseSelect.Item>
                  ))}
                </BaseSelect.Group>
              ))}
            </BaseSelect.List>
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  );
}

/** The same control with a filter field above the list. The field's text is
 *  base-ui's own input value, so it starts empty on every open and the list
 *  narrows as it is typed. */
function SearchableSelect<V extends string>({
  value, onChange, options, placeholder, disabled, size = "md", icon, width, id, name, invalid, popupWidth, search,
  "aria-label": ariaLabel, "data-testid": testId,
}: SelectProps<V> & { search: SelectSearch }) {
  const coarse = useIsCoarsePointer();
  const grouped = isGrouped(options);
  const flat: readonly SelectOption<V>[] = grouped ? options.flatMap((group) => group.options) : options;
  const selected = flat.find((option) => option.value === value) ?? null;
  // Combobox takes groups as `{ items }` records; a flat list is just the options.
  const items = grouped ? options.map((group) => ({ value: group.label, items: group.options })) : flat;

  const renderOption = (option: SelectOption<V>) => (
    <Combobox.Item
      key={option.value}
      value={option}
      disabled={option.disabled}
      className="dropdown-item"
      style={{ ...itemStyle, cursor: option.disabled ? "default" : "pointer", opacity: option.disabled ? 0.5 : 1 }}
    >
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={itemTextStyle}>{option.label}</span>
        {option.description && <span style={itemDescriptionStyle}>{option.description}</span>}
      </span>
      <Combobox.ItemIndicator style={indicatorStyle}>
        <Check size={13} />
      </Combobox.ItemIndicator>
    </Combobox.Item>
  );

  return (
    <Combobox.Root<SelectOption<V>>
      items={items}
      value={selected}
      onValueChange={(next) => { if (next !== null && next.value !== value) onChange(next.value); }}
      isItemEqualToValue={(a, b) => a.value === b.value}
      // The first match is highlighted as soon as something is typed, so
      // "type, Enter" picks it; opening on the chosen option is unaffected.
      autoHighlight
      // The one place that decides what text an option stands for: what the
      // typed filter is matched against, and what base-ui reads for typeahead.
      itemToStringLabel={(option) => (typeof option.label === "string" ? option.label : option.value)}
      itemToStringValue={(option) => option.value}
      filter={(option, query, itemToString) => matchesSearch(itemToString?.(option) ?? option.value, query)}
      disabled={disabled}
      name={name}
    >
      <Combobox.Trigger
        id={id}
        aria-label={ariaLabel}
        aria-invalid={invalid || undefined}
        data-testid={testId}
        className="ui-focus-ring ui-select-trigger"
        style={triggerStyle(selected !== null, { size, width, invalid, disabled })}
      >
        {icon && <span style={{ display: "inline-flex", flexShrink: 0, color: "var(--text-muted)" }}>{icon}</span>}
        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          <Combobox.Value>{selected ? selected.label : placeholder ?? ""}</Combobox.Value>
        </span>
        <Combobox.Icon style={{ display: "inline-flex", flexShrink: 0, color: "var(--text-muted)" }}>
          <ChevronDown size={size === "sm" ? 12 : 14} />
        </Combobox.Icon>
      </Combobox.Trigger>
      <Combobox.Portal>
        <Combobox.Positioner sideOffset={4} align="start" style={{ zIndex: 1200 }}>
          <Combobox.Popup
            className="dropdown-surface"
            aria-label={ariaLabel}
            style={{ minWidth: popupWidth ?? "var(--anchor-width)", ...popupBounds, display: "flex", flexDirection: "column" }}
          >
            <div style={{ position: "relative", flexShrink: 0, borderBottom: "1px solid var(--border)" }}>
              <Search size={13} aria-hidden="true" style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--text-muted)", pointerEvents: "none" }} />
              <Combobox.Input
                placeholder={search.placeholder}
                aria-label={search.placeholder}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                style={{ width: "100%", boxSizing: "border-box", height: 34, padding: "0 10px 0 30px", border: "none", background: "transparent", color: "var(--text)", fontSize: coarse ? 16 : 12.5, outline: "none" }}
              />
            </div>
            <Combobox.Empty>
              <div style={{ padding: "14px 10px", fontSize: 12, color: "var(--text-dim)", textAlign: "center" }}>{search.empty}</div>
            </Combobox.Empty>
            <Combobox.List style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto", padding: 4 }}>
              {grouped
                ? (group: { value: ReactNode; items: readonly SelectOption<V>[] }, groupIndex: number) => (
                  <Combobox.Group key={groupIndex} items={group.items}>
                    {group.value !== null && group.value !== undefined && (
                      <Combobox.GroupLabel style={groupLabelStyle}>{group.value}</Combobox.GroupLabel>
                    )}
                    <Combobox.Collection>{renderOption}</Combobox.Collection>
                  </Combobox.Group>
                )
                : renderOption}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}
