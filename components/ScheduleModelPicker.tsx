"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { Check, ChevronLeft, Search } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import {
  chooseScheduleModel,
  findScheduleModel,
  groupScheduleModels,
  scheduleModelKey,
  searchScheduleModels,
  type ScheduleModelCatalog,
  type ScheduleModelGroup,
  type ScheduleModelOption,
} from "@/lib/scheduled/model-ui";
import type { ScheduledModelChoice } from "@/lib/scheduled/types";
import { ModelIcon, ProviderIcon } from "./ProviderIcon";
import type { MenuPresentation } from "./ScheduleMenu";

/**
 * The Send menu's second view: the models a scheduled message may go out on.
 * It lists what the composer's own model picker lists (the pinned models, one
 * group per provider, with the same icons and names) and a search reaches the
 * rest of the catalog — the same models the chat can be switched to. "Same as
 * chat" comes first: the message goes out on whatever the chat is on when it
 * is sent, which is what a message with no model does.
 *
 * A model whose quota is spent stays choosable and says so: queueing onto it
 * is the point. Choosing a row returns to the menu's rows; it never sends or
 * schedules by itself.
 */

/** A search can match hundreds of models (a gateway's whole catalog): show the first ones and say so. */
const SEARCH_LIMIT = 60;

export interface ScheduleModelPickerProps {
  presentation: MenuPresentation;
  /** The menu's own row height, so these rows are the same size as the ones around them. */
  rowHeight: number;
  catalog: ScheduleModelCatalog;
  /** The model chosen for the message, or null: "Same as chat". */
  value: ScheduledModelChoice | null;
  /** The new choice; null is "Same as chat". Picking the model already chosen keeps its reasoning level. */
  onChoose: (choice: ScheduledModelChoice | null) => void;
  onBack: () => void;
}

function PickerRow({ checked, testId, model, icon, title, hint, rowHeight, sheet, onPick }: {
  checked: boolean;
  testId: string;
  model?: string;
  icon: ReactNode;
  title: string;
  hint: string | null;
  rowHeight: number;
  sheet: boolean;
  onPick: () => void;
}) {
  const style: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 8,
    width: "100%",
    minHeight: rowHeight,
    padding: sheet ? "6px 12px" : "4px 10px",
    background: "transparent",
    border: "none",
    borderRadius: "var(--radius-control)",
    color: checked ? "var(--text)" : "var(--text-muted)",
    fontWeight: checked ? 600 : 400,
    cursor: "pointer",
    fontSize: sheet ? 14 : 13,
    textAlign: "left",
  };
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      tabIndex={-1}
      onClick={onPick}
      data-testid={testId}
      data-model={model}
      data-selected={checked || undefined}
      className="dropdown-item"
      style={style}
    >
      <span aria-hidden="true" style={{ display: "inline-flex", width: 14, flexShrink: 0, color: "var(--accent)" }}>
        {checked && <Check size={14} strokeWidth={2.5} />}
      </span>
      <span aria-hidden="true" style={{ display: "inline-flex", width: 14, flexShrink: 0, color: checked ? "var(--accent)" : "var(--text-dim)" }}>{icon}</span>
      <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 1 }}>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</span>
        {hint && (
          <span style={{ fontSize: 11, fontWeight: 400, color: "var(--text-dim)", lineHeight: 1.35, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{hint}</span>
        )}
      </span>
    </button>
  );
}

export function ScheduleModelPicker({ presentation, rowHeight, catalog, value, onChoose, onBack }: ScheduleModelPickerProps) {
  const { t } = useI18n();
  const sheet = presentation === "sheet";
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searching = query.trim() !== "";

  // A mouse lands in the search field, ready to type. A finger lands on Back instead: the on-screen keyboard stays down until the field is tapped, so the list is not covered.
  useEffect(() => {
    (sheet ? backRef : inputRef).current?.focus({ preventScroll: true });
  }, [sheet]);

  const pinned = useMemo(() => new Set(catalog.groups.flatMap((group) => group.options.map(scheduleModelKey))), [catalog.groups]);
  const found = useMemo(() => {
    if (!searching) return null;
    const matches = searchScheduleModels(catalog.all, query);
    return { total: matches.length, first: matches[0] ?? null, groups: groupScheduleModels(matches.slice(0, SEARCH_LIMIT)) };
  }, [catalog.all, query, searching]);

  // A choice the list would not otherwise show (made through a search, or an edited message whose model is no longer pinned) is listed first, so the list always shows what is chosen.
  const chosen: ScheduleModelOption | null = value ? findScheduleModel(catalog, value) ?? { provider: value.provider, modelId: value.modelId, name: value.modelId } : null;
  const chosenKey = chosen ? scheduleModelKey(chosen) : null;
  const chosenOutside = !searching && chosen !== null && !pinned.has(scheduleModelKey(chosen));

  const pick = (option: ScheduleModelOption) => onChoose(chooseScheduleModel(catalog, value, option));

  const optionRow = (option: ScheduleModelOption, hint: string | null) => {
    const key = scheduleModelKey(option);
    return (
      <PickerRow
        key={key}
        checked={key === chosenKey}
        testId="schedule-model-option"
        model={key}
        icon={<ModelIcon provider={option.provider} modelId={option.modelId} size={13} />}
        title={option.name}
        hint={hint}
        rowHeight={rowHeight}
        sheet={sheet}
        onPick={() => pick(option)}
      />
    );
  };

  /** The provider (when the name alone would not tell two rows apart) and the spent-quota note. */
  const hintFor = (option: ScheduleModelOption, showProvider: boolean) =>
    [showProvider ? option.provider : null, catalog.limitText?.(option) ?? null].filter(Boolean).join(" · ") || null;

  // As in the composer's picker: two providers serving one display name are told apart by the provider, unless the group headers already do.
  const groupsView = (groups: readonly ScheduleModelGroup[]) => groups.map((group, index) => (
    <div key={group.id} role="group" aria-label={group.provider}>
      {groups.length > 1 && (
        <div
          aria-hidden="true"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "6px 12px 4px",
            fontSize: 10,
            fontWeight: 600,
            color: "var(--text-dim)",
            textTransform: "uppercase",
            letterSpacing: "0.07em",
            borderTop: index > 0 ? "1px solid var(--border)" : "none",
          }}
        >
          <ProviderIcon provider={group.provider} size={10} style={{ flexShrink: 0, color: "var(--text-dim)" }} />
          {group.provider}
        </div>
      )}
      {group.options.map((option) => optionRow(option, hintFor(option, groups.length === 1 && catalog.duplicateNames.has(option.name))))}
    </div>
  ));

  const onSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      event.stopPropagation();
      listRef.current?.querySelector<HTMLElement>('[role="menuitemradio"]')?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      backRef.current?.focus();
    } else if (event.key === "Enter") {
      // Typing a name and pressing Enter takes the first match; with nothing typed Enter steps into the list.
      event.preventDefault();
      event.stopPropagation();
      if (found?.first) pick(found.first);
      else if (!searching) listRef.current?.querySelector<HTMLElement>('[role="menuitemradio"]')?.focus();
    }
  };

  return (
    <div data-testid="schedule-model-picker">
      <div style={{ display: "flex", alignItems: "center", gap: 6, minHeight: rowHeight }}>
        <button
          ref={backRef}
          type="button"
          role="menuitem"
          tabIndex={-1}
          onClick={onBack}
          data-testid="schedule-model-back"
          className="dropdown-item"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 2,
            alignSelf: "stretch",
            minWidth: sheet ? 48 : 40,
            padding: sheet ? "0 12px 0 6px" : "0 10px 0 4px",
            background: "transparent",
            border: "none",
            borderRadius: "var(--radius-control)",
            color: "var(--text-muted)",
            cursor: "pointer",
            fontSize: sheet ? 14 : 13,
          }}
        >
          <ChevronLeft size={sheet ? 18 : 16} strokeWidth={2} aria-hidden="true" />
          {t("schedule.modelBack")}
        </button>
        <span style={{ fontSize: sheet ? 14 : 13, fontWeight: 600, color: "var(--text)" }}>{t("schedule.modelPickerTitle")}</span>
      </div>
      <div style={{ position: "relative", margin: sheet ? "2px 4px 6px" : "2px 2px 6px" }}>
        <Search size={14} aria-hidden="true" style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--text-muted)", pointerEvents: "none" }} />
        <input
          ref={inputRef}
          type="search"
          data-testid="schedule-model-search"
          data-menu-nav=""
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onSearchKeyDown}
          placeholder={t("schedule.modelSearch")}
          aria-label={t("schedule.modelSearch")}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          style={{
            width: "100%",
            boxSizing: "border-box",
            height: sheet ? 44 : 32,
            padding: "0 10px 0 30px",
            background: "var(--bg)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-control)",
            color: "var(--text)",
            // 16px keeps iOS from zooming the page when the field is focused.
            fontSize: sheet ? 16 : 13,
          }}
        />
      </div>
      <div
        ref={listRef}
        data-testid="schedule-model-list"
        style={{ maxHeight: sheet ? "min(52dvh, 420px)" : "min(280px, 40vh)", overflowY: "auto", overscrollBehavior: "contain" }}
      >
        {!searching && (
          <PickerRow
            checked={value === null}
            testId="schedule-model-same"
            icon={null}
            title={t("schedule.modelSame")}
            hint={catalog.current ? t("schedule.modelSameNow", { name: catalog.current.name }) : null}
            rowHeight={rowHeight}
            sheet={sheet}
            onPick={() => onChoose(null)}
          />
        )}
        {chosenOutside && chosen && optionRow(chosen, hintFor(chosen, true))}
        {searching
          ? found && found.total > 0
            ? groupsView(found.groups)
            : <div role="status" data-testid="schedule-model-empty" style={{ padding: "12px", fontSize: 12, color: "var(--text-dim)" }}>{t("schedule.modelNoMatch", { query: query.trim() })}</div>
          : catalog.groups.length > 0
            ? groupsView(catalog.groups)
            : <div role="status" data-testid="schedule-model-empty" style={{ padding: "8px 12px", fontSize: 12, color: "var(--text-dim)" }}>{t("schedule.modelNone")}</div>}
        {found && found.total > SEARCH_LIMIT && (
          <div role="status" data-testid="schedule-model-more" style={{ padding: "8px 12px", fontSize: 11, color: "var(--text-dim)" }}>{t("schedule.modelMore", { count: SEARCH_LIMIT })}</div>
        )}
      </div>
    </div>
  );
}
