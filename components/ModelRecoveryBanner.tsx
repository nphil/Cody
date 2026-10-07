"use client";

import { useEffect, useMemo, useState } from "react";
import { TriangleAlert } from "lucide-react";
import type { ModelRecovery } from "@/hooks/useAgentSession";
import { fetchSettingsRoute } from "@/hooks/useSettingsData";
import { readComposerVisibility, modelVisibilityKey } from "@/lib/composer-model-visibility";
import { useI18n } from "@/lib/i18n";
import { formatModelDisplayName } from "@/lib/model-display";
import type { SessionPresetResponse } from "@/lib/model-presets/types";
import { Select } from "@/components/ui/Select";

interface CatalogModel {
  id: string;
  name: string;
  provider: string;
}

interface Props {
  recovery: ModelRecovery;
  /** The current catalog (the same list the composer's picker uses). */
  modelList: readonly CatalogModel[];
  /** A message the person sent is waiting on this choice. */
  hasHeldMessage: boolean;
  onRecover: (provider: string, modelId: string) => void;
}

const keyOf = (provider: string, modelId: string) => `${provider}/${modelId}`;

/**
 * Shown when omp (18.6.3+) refuses to reopen a chat because the model it saved
 * no longer exists or has no credentials. Says so in plain words and lets the
 * person continue the chat on any model from today's catalog; whatever they had
 * just sent is held, and goes out on the pick. The chat's own preset default is
 * pre-selected when it is in the catalog, like the composer's Smart choice.
 */
export function ModelRecoveryBanner({ recovery, modelList, hasHeldMessage, onRecover }: Props) {
  const { t } = useI18n();
  const [picked, setPicked] = useState("");
  const [smartKey, setSmartKey] = useState<string | null>(null);

  const options = useMemo(() => {
    const visibility = readComposerVisibility("omp");
    return modelList
      .filter((model) => {
        const key = modelVisibilityKey(model);
        return !visibility.hidden.has(key) && !visibility.instanceHidden.has(key);
      })
      .map((model) => ({ key: keyOf(model.provider, model.id), provider: model.provider, modelId: model.id, label: `${formatModelDisplayName(model.id, model.name)} · ${model.provider}` }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [modelList]);

  useEffect(() => {
    let cancelled = false;
    void fetchSettingsRoute<SessionPresetResponse>(`/api/sessions/${encodeURIComponent(recovery.sessionId)}/preset`)
      .then((entry) => {
        const smart = entry.data?.smartDefault;
        if (!cancelled && smart) setSmartKey(keyOf(smart.provider, smart.modelId));
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [recovery.sessionId]);

  const selected = options.some((option) => option.key === picked)
    ? picked
    : smartKey && options.some((option) => option.key === smartKey) ? smartKey : "";
  const choice = options.find((option) => option.key === selected);
  const gone = modelList.find((model) => model.provider === recovery.provider && model.id === recovery.modelId);
  const goneName = gone ? formatModelDisplayName(gone.id, gone.name) : keyOf(recovery.provider, recovery.modelId);
  const color = "var(--status-warning)";

  return (
    <div
      role="alert"
      data-testid="model-recovery-banner"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        margin: "8px 0",
        padding: "8px 10px",
        borderRadius: "var(--radius-control)",
        border: `1px solid color-mix(in srgb, ${color} 35%, transparent)`,
        background: `color-mix(in srgb, ${color} 6%, transparent)`,
        color: "var(--text)",
        fontSize: 12,
        lineHeight: 1.4,
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10, minWidth: 0 }}>
        <span aria-hidden style={{ color, flexShrink: 0, marginTop: 1 }}><TriangleAlert size={14} /></span>
        <div style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>
          <div>{t("engineRecovery.notice", { model: goneName })}</div>
          {hasHeldMessage && <div style={{ color: "var(--text-muted)", marginTop: 2 }}>{t("engineRecovery.heldNote")}</div>}
          {recovery.error && <div style={{ color: "var(--status-error)", marginTop: 2 }}>{t("engineRecovery.failed", { detail: recovery.error })}</div>}
          {options.length === 0 && <div style={{ color: "var(--text-muted)", marginTop: 2 }}>{t("engineRecovery.noModels")}</div>}
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        <Select<string>
          aria-label={t("engineRecovery.pickLabel")}
          data-testid="model-recovery-select"
          value={selected || null}
          disabled={recovery.busy || options.length === 0}
          onChange={setPicked}
          size="sm"
          placeholder={t("engineRecovery.pickPlaceholder")}
          options={options.map((option) => ({ value: option.key, label: option.label }))}
          search={{ placeholder: t("engineRecovery.searchPlaceholder"), empty: t("engineRecovery.noMatch") }}
        />
        <button
          type="button"
          disabled={!choice || recovery.busy}
          onClick={() => { if (choice) onRecover(choice.provider, choice.modelId); }}
          className="ui-smooth ui-focus-ring"
          style={{
            flexShrink: 0,
            cursor: !choice || recovery.busy ? "default" : "pointer",
            opacity: !choice || recovery.busy ? 0.55 : 1,
            padding: "4px 10px",
            borderRadius: "var(--radius-control)",
            border: "1px solid var(--border)",
            background: "var(--bg-panel)",
            color: "var(--text)",
            fontSize: 11,
            fontWeight: 600,
          }}
        >
          {recovery.busy ? t("engineRecovery.continuing") : t("engineRecovery.continue")}
        </button>
      </div>
    </div>
  );
}
