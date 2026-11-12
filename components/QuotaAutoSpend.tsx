"use client";

/**
 * The "spend saved resets automatically" switches in the quota popover's Saved
 * resets area. A saved reset can clear a rate limit the moment it is hit, and
 * the owner decides whether omp may spend one without asking: Ask (nothing is
 * spent until they say so), Spend, or Never.
 *
 * Which switches exist is the RUNNING engine's call. omp 18.18.7 split the
 * single `<group>.autoRedeem` setting into one per limit (5-hour, weekly, and
 * Claude's separate Fable consent); older engines have only the single one.
 * `buildAutoRedeemGroups` reads the engine's own settings schema and offers
 * exactly the keys it has, with the value omp acts on (the schema reader
 * already folds an old single key into the per-limit ones), and a switch is
 * written through the same schema writer the Settings panel uses, so the
 * two can never disagree.
 *
 * Split in two: `AutoSpendControls` is pure props -> markup (testable without
 * a browser), `AutoSpendSection` binds it to the schema hook.
 */
import React, { useRef } from "react";
import { Info } from "lucide-react";
import { toast } from "@/components/ui/toast";
import { useSchemaIndex } from "@/hooks/useSchemaIndex";
import { credentialProviderName } from "@/hooks/credential-notices";
import { buildAutoRedeemGroups, type AutoRedeemChoice, type AutoRedeemGroup, type AutoRedeemWindow } from "@/hooks/auto-redeem-controls";
import { Tooltip } from "./ui/primitives";

type Translate = (key: string, vars?: Record<string, string | number>) => string;

/** In the order shown. `unset` is "Ask": omp keeps asking before it spends one. */
const CHOICES: ReadonlyArray<{ value: AutoRedeemChoice; labelKey: string }> = [
  { value: "unset", labelKey: "usage.autoSpendAsk" },
  { value: "yes", labelKey: "usage.autoSpendYes" },
  { value: "no", labelKey: "usage.autoSpendNo" },
];

const WINDOW_LABEL_KEYS: Record<AutoRedeemWindow, string> = {
  "5h": "usage.autoSpend5h",
  weekly: "usage.autoSpendWeekly",
  fable: "usage.autoSpendFable",
  all: "usage.autoSpendAll",
};

/** One three-way choice, behaving as a radio group: a single tab stop, arrow
 *  keys move and pick, as the segmented controls elsewhere in Cody do. */
function ChoiceSwitch({
  label,
  value,
  testId,
  t,
  onChange,
}: {
  label: string;
  value: AutoRedeemChoice;
  testId: string;
  t: Translate;
  onChange: (choice: AutoRedeemChoice) => void;
}) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const current = CHOICES.findIndex((choice) => choice.value === value);
    let next: number;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (current + 1) % CHOICES.length;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (current - 1 + CHOICES.length) % CHOICES.length;
    else return;
    event.preventDefault();
    onChange(CHOICES[next]!.value);
    buttons.current[next]?.focus();
  };
  return (
    <div
      role="radiogroup"
      aria-label={label}
      data-testid={`auto-spend-${testId}`}
      onKeyDown={onKeyDown}
      style={{ flexShrink: 0, display: "inline-flex", gap: 2, padding: 2, borderRadius: 7, background: "var(--bg-subtle)" }}
    >
      {CHOICES.map((choice, index) => {
        const selected = choice.value === value;
        return (
          <button
            key={choice.value}
            ref={(element) => { buttons.current[index] = element; }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            data-choice={choice.value}
            data-selected={selected ? "true" : undefined}
            onClick={() => { if (!selected) onChange(choice.value); }}
            className="ui-focus-ring"
            style={{
              padding: "1px 8px", border: "none", borderRadius: 5, cursor: "pointer", fontSize: 11,
              fontWeight: selected ? 600 : 500,
              background: selected ? "var(--bg-panel)" : "transparent",
              color: selected ? "var(--text)" : "var(--text-muted)",
              boxShadow: selected ? "var(--shadow-card)" : "none",
              whiteSpace: "nowrap",
            }}
          >
            {t(choice.labelKey)}
          </button>
        );
      })}
    </div>
  );
}

/** The switches for the given groups. Renders nothing when there are none. */
export function AutoSpendControls({
  groups,
  t,
  onChange,
}: {
  groups: readonly AutoRedeemGroup[];
  t: Translate;
  onChange: (key: string, choice: AutoRedeemChoice) => void;
}) {
  if (groups.length === 0) return null;
  return (
    <div data-testid="auto-spend" style={{ marginTop: 10, paddingTop: 8, borderTop: "1px solid var(--border)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)" }}>{t("usage.autoSpendHeading")}</span>
        <Tooltip content={t("usage.autoSpendHelp")}>
          <button
            type="button"
            aria-label={t("usage.autoSpendHelp")}
            style={{ display: "inline-flex", alignItems: "center", background: "none", border: "none", padding: 0, cursor: "pointer", color: "var(--text-dim)" }}
          >
            <Info size={11} strokeWidth={1.8} aria-hidden="true" />
          </button>
        </Tooltip>
      </div>
      <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 8 }}>
        {groups.map((group) => {
          const name = credentialProviderName(group.provider);
          return (
            <div key={group.provider} data-testid={`auto-spend-${group.provider}`} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{name}</div>
              {group.controls.map((control) => {
                const windowLabel = t(WINDOW_LABEL_KEYS[control.window]);
                return (
                  <div key={control.key} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                    <span style={{ minWidth: 0, fontSize: 11, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {windowLabel}
                    </span>
                    <ChoiceSwitch
                      label={`${name} · ${windowLabel}`}
                      value={control.value}
                      testId={control.key}
                      t={t}
                      onChange={(choice) => onChange(control.key, choice)}
                    />
                  </div>
                );
              })}
              {group.hasFable && (
                <div data-testid="auto-spend-fable-note" style={{ fontSize: 11, lineHeight: 1.4, color: "var(--text-dim)" }}>
                  {t("usage.autoSpendFableNote")}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The switches bound to the running engine's settings. `providers` are the
 * engine provider ids that have saved resets in play; the schema decides which
 * switches each one gets. Nothing renders until the schema has loaded and has
 * at least one such key, so an engine without the setting shows no control.
 */
export function AutoSpendSection({ providers, t }: { providers: readonly string[]; t: Translate }) {
  const schema = useSchemaIndex();
  const groups = buildAutoRedeemGroups((key) => {
    const row = schema.byKey.get(key);
    return row && row.visible !== false ? { value: row.value } : undefined;
  }, providers);
  return (
    <AutoSpendControls
      groups={groups}
      t={t}
      onChange={(key, choice) => {
        // "Ask" is written out as `unset` rather than by clearing the key: on
        // an engine that still has the old single key, clearing would let it
        // flow back in and the choice would snap back to what it was.
        schema.setValue(key, choice).catch(() => toast.error(t("usage.autoSpendSaveFailed")));
      }}
    />
  );
}
