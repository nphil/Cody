"use client";

/**
 * "+ Add provider": every provider the engine can reach that is not yet
 * connected, searchable, in the groups of provider-groups.ts — Subscriptions,
 * API key, Gateways & routers, Local & self-hosted (a discovered runtime
 * wears a Found chip), Search & tools, Custom endpoint (engines with a
 * models.yml), Other. Popular first inside a group; regional / plan variants
 * fold into one card with a select; a row that offers both a sign-in and a
 * key asks which.
 *
 * Content only: the Providers hub wraps it in a Drawer (a side drawer on a
 * desktop, a pushed level on a phone) and the setup wizard in its card,
 * which is why the labels go through the tri-locale `modelsConfig.*` keys.
 */
import { ChevronRight, Plus, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { useI18n } from "@/lib/i18n";
import type { LocalAiScanResult } from "@/hooks/useLocalAiScan";
import { pickerRowsForGroup, type ProviderRow } from "@/lib/provider-directory";
import { GROUP_ORDER, type ProviderGroup } from "./provider-groups";
import { ProviderTile, primaryButtonStyle } from "./controls";

export interface PickChoice {
  row: ProviderRow;
  /** The sign-in to start; absent means "the key method". */
  loginId?: string;
}

interface AddProviderPickerProps {
  rows: readonly ProviderRow[];
  discovered?: readonly LocalAiScanResult[];
  /** The engine keeps a models.yml: offer the custom-endpoint card. */
  canAddCustom: boolean;
  onPick: (choice: PickChoice) => void;
  onAddCustom: () => void;
}

interface Choice extends PickChoice {
  key: string;
  label: string;
}

/** Which discovered runtime a local roster id corresponds to. */
const LOCAL_RUNTIME_OF: Record<string, LocalAiScanResult["runtime"]> = {
  ollama: "ollama",
  "lm-studio": "lmstudio",
  "llama.cpp": "llamacpp",
};

function choicesOf(card: ProviderRow, variants: readonly ProviderRow[], keyLabel: string): Choice[] {
  const choices: Choice[] = [];
  for (const row of [card, ...variants]) {
    for (const method of row.methods) {
      if (method.loginId) choices.push({ key: `${row.id}:${method.loginId}`, label: method.name ?? row.name, row, loginId: method.loginId });
    }
    if (row.methods.some((method) => method.kind === "key" || method.kind === "env")) {
      choices.push({ key: `${row.id}:key`, label: variants.length > 0 || card.methods.some((method) => method.loginId) ? `${row.name} · ${keyLabel}` : keyLabel, row });
    }
  }
  if (choices.length === 0) choices.push({ key: `${card.id}:open`, label: card.name, row: card });
  return choices;
}

function matches(query: string, card: ProviderRow, variants: readonly ProviderRow[]): boolean {
  if (!query) return true;
  const haystack = [card, ...variants].flatMap((row) => [row.id, row.name, ...row.methods.map((method) => method.name ?? "")]).join(" ").toLowerCase();
  return haystack.includes(query);
}

const cardBase = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "10px 12px",
  minHeight: 52,
  background: "var(--bg-panel)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-card)",
  boxSizing: "border-box" as const,
  minWidth: 0,
  textAlign: "left" as const,
  width: "100%",
  color: "var(--text)",
} as const;

function PickerCard({ card, variants, found, keyLabel, variantLabel, methodLabel, foundChip, addLabel, onPick }: {
  card: ProviderRow;
  variants: readonly ProviderRow[];
  found: boolean;
  keyLabel: string;
  /** The select's label when the choices are regions / plans of one product. */
  variantLabel: string;
  /** The select's label when the choices are a sign-in versus a key. */
  methodLabel: string;
  foundChip: string;
  addLabel: string;
  onPick: (choice: PickChoice) => void;
}) {
  const choices = useMemo(() => choicesOf(card, variants, keyLabel), [card, variants, keyLabel]);
  const [selected, setSelected] = useState(choices[0]?.key ?? "");
  const current = choices.find((choice) => choice.key === selected) ?? choices[0];
  const selectLabel = variants.length > 0 || choices.filter((choice) => choice.loginId).length > 1 ? variantLabel : methodLabel;
  const subtitle = card.modelCount !== null && card.modelCount > 0 ? `${card.modelCount} models` : card.methods.find((method) => method.loginId)?.hint ?? null;
  const chip = found ? <span style={{ fontSize: 10, padding: "1px 6px", borderRadius: 4, background: "color-mix(in srgb, var(--status-success) 14%, transparent)", color: "var(--status-success)", fontWeight: 600 }}>{foundChip}</span> : null;

  if (choices.length <= 1) {
    return (
      <button type="button" data-provider-card={card.id} className="settings-directory-row ui-focus-ring" onClick={() => onPick(current)} style={{ ...cardBase, cursor: "pointer" }}>
        <ProviderTile brand={card.brand} />
        <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ fontSize: 12.5, fontWeight: 600, display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{card.name}</span>
            {chip}
          </span>
          {subtitle && <span style={{ fontSize: 11, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{subtitle}</span>}
        </span>
        <ChevronRight size={14} aria-hidden="true" style={{ color: "var(--text-dim)", flexShrink: 0 }} />
      </button>
    );
  }

  return (
    <div data-provider-card={card.id} style={{ ...cardBase, flexWrap: "wrap" }}>
      <ProviderTile brand={card.brand} />
      <span style={{ flex: "1 1 140px", minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
        <span style={{ fontSize: 12.5, fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{card.name}</span>
          {chip}
        </span>
        {subtitle && <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{subtitle}</span>}
      </span>
      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--text-muted)", flex: "1 1 200px", minWidth: 0 }}>
        <span style={{ whiteSpace: "nowrap" }}>{selectLabel}</span>
        <select
          value={current?.key}
          onChange={(event) => setSelected(event.target.value)}
          aria-label={`${card.name}: ${selectLabel}`}
          style={{ flex: 1, minWidth: 0, minHeight: 32, padding: "4px 8px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg)", color: "var(--text)", fontSize: 12 }}
        >
          {choices.map((choice) => <option key={choice.key} value={choice.key}>{choice.label}</option>)}
        </select>
      </label>
      <button type="button" className="ui-focus-ring" onClick={() => { if (current) onPick(current); }} style={primaryButtonStyle}>
        <Plus size={13} aria-hidden="true" /> {addLabel}
      </button>
    </div>
  );
}

export function AddProviderPicker({ rows, discovered = [], canAddCustom, onPick, onAddCustom }: AddProviderPickerProps) {
  const { t } = useI18n();
  const [search, setSearch] = useState("");
  const query = search.trim().toLowerCase();

  const labels: Record<ProviderGroup, string> = {
    subscription: t("modelsConfig.subscriptions"),
    key: t("modelsConfig.apiKey"),
    gateway: t("modelsConfig.groupGateways"),
    local: t("modelsConfig.groupLocal"),
    search: t("modelsConfig.groupSearchTools"),
    custom: t("modelsConfig.customSection"),
    other: t("modelsConfig.groupOther"),
  };
  const foundRuntimes = new Set(discovered.map((result) => result.runtime));
  const showCustom = canAddCustom && (!query || "custom".includes(query) || "openai-compatible".includes(query) || "anthropic-compatible".includes(query) || t("modelsConfig.openaiAnthropicCompatible").toLowerCase().includes(query));

  const groups = GROUP_ORDER.map((group) => ({
    group,
    cards: pickerRowsForGroup(rows, group).filter((card) => matches(query, card.row, card.variants)),
  })).filter((entry) => entry.cards.length > 0 || (entry.group === "custom" && showCustom));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
      <div style={{ position: "relative" }}>
        <Search size={13} aria-hidden="true" style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--text-muted)", pointerEvents: "none" }} />
        <input
          type="search"
          data-drawer-autofocus
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t("modelsConfig.searchProviders")}
          aria-label={t("modelsConfig.searchProviders")}
          style={{ width: "100%", boxSizing: "border-box", minHeight: 36, padding: "6px 10px 6px 30px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg)", color: "var(--text)", fontSize: 13, outline: "none" }}
        />
      </div>
      {groups.length === 0 && (
        <div style={{ padding: "20px 0", fontSize: 12, color: "var(--text-dim)", textAlign: "center" }}>{t("modelsConfig.noProvidersMatch")}</div>
      )}
      {groups.map(({ group, cards }) => (
        <section key={group} aria-label={labels[group]} style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
          <h4 style={{ margin: 0, fontSize: 11, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-muted)" }}>{labels[group]}</h4>
          {group === "custom" && showCustom && (
            <button type="button" className="settings-directory-row ui-focus-ring" onClick={onAddCustom} style={{ ...cardBase, cursor: "pointer" }}>
              <span aria-hidden="true" style={{ width: 28, height: 28, borderRadius: 6, border: "1px dashed var(--border)", display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0, color: "var(--text-muted)" }}><Plus size={14} /></span>
              <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                <span style={{ fontSize: 12.5, fontWeight: 600 }}>{t("modelsConfig.openaiAnthropicCompatible")}</span>
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{t("modelsConfig.customEndpointFormat")}</span>
              </span>
              <ChevronRight size={14} aria-hidden="true" style={{ color: "var(--text-dim)", flexShrink: 0 }} />
            </button>
          )}
          {cards.map((card) => (
            <PickerCard
              key={card.row.id}
              card={card.row}
              variants={card.variants}
              found={group === "local" && foundRuntimes.has(LOCAL_RUNTIME_OF[card.row.id])}
              keyLabel={t("modelsConfig.apiKey")}
              variantLabel={t("modelsConfig.variantLabel")}
              methodLabel={t("modelsConfig.connectVia")}
              foundChip={t("modelsConfig.foundChip")}
              addLabel={t("modelsConfig.catalogAdd")}
              onPick={onPick}
            />
          ))}
        </section>
      ))}
    </div>
  );
}
