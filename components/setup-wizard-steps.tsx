"use client";

import { AlertCircle, Check, Loader2, Search } from "lucide-react";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTheme } from "@/hooks/useTheme";
import { useI18n } from "@/lib/i18n";
import { THEMES } from "@/lib/theme-catalog";
import type { EngineSummary } from "./EnginePicker";

/**
 * The setup wizard's per-engine step framework, mirroring omp's own TUI
 * setup flow (src/modes/setup-wizard in oh-my-pi): providers → web search →
 * default model → theme. Steps are resolved per engine: capability-driven by
 * default (an engine with the models surface gets the full flow, a
 * CLI-authenticating engine gets sign-in guidance + theme), with an explicit
 * per-engine override map for future engines whose onboarding needs its own
 * shape. Every step writes through the same routes Settings uses, so manual
 * setup stays a first-class alternative to the wizard.
 */

export type WizardStepId = "providers" | "webSearch" | "model" | "signIn" | "theme";

/** Future engines: name an explicit step list here when the capability-driven
 * default doesn't fit (keyed by engine id). */
const ENGINE_STEP_OVERRIDES: Record<string, WizardStepId[]> = {};

export function getWizardSteps(engineId: string | null, hasModelsUi: boolean): WizardStepId[] {
  const override = engineId ? ENGINE_STEP_OVERRIDES[engineId] : undefined;
  if (override) return override;
  return hasModelsUi ? ["providers", "webSearch", "model", "theme"] : ["signIn", "theme"];
}

const WizardProvidersStep = dynamic(() => import("./setup-wizard-providers").then((module) => module.WizardProvidersStep), {
  loading: () => (
    <div role="status" style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "var(--text-dim)" }}>
      <Loader2 size={14} aria-hidden style={{ animation: "spin 0.9s linear infinite" }} />
    </div>
  ),
});

/** Empty-first provider list + Add flow (see setup-wizard-providers.tsx);
 * deliberately NOT the full Settings editor. */
export function ProvidersStep() {
  return <WizardProvidersStep />;
}

export function SignInStep({ engine }: { engine: EngineSummary | null }) {
  const { t } = useI18n();
  return (
    <div className="setup-wizard-card">
      <p>{engine?.authHint ?? t("setupWizard.authFallback")}</p>
      <p>{t("setupWizard.authTerminalHint")}</p>
    </div>
  );
}

/** omp's web/search/types.ts SEARCH_PROVIDER_OPTIONS, curated to the entries
 * a first run realistically picks; the rest stay reachable in engine
 * settings. Order arrays are written the way omp's own wizard writes them:
 * the choice first, then the remaining priority order. */
const WEB_SEARCH_CHOICES = [
  { value: "auto", label: "Auto" },
  { value: "perplexity", label: "Perplexity" },
  { value: "gemini", label: "Gemini" },
  { value: "anthropic", label: "Anthropic" },
  { value: "codex", label: "OpenAI" },
  { value: "xai", label: "xAI" },
  { value: "duckduckgo", label: "DuckDuckGo" },
] as const;

const WEB_SEARCH_FULL_ORDER = [
  "perplexity", "gemini", "anthropic", "codex", "xai", "zai", "exa", "tinyfish", "jina", "kagi",
  "tavily", "firecrawl", "brave", "kimi", "parallel", "synthetic", "searxng", "startpage",
  "duckduckgo", "ecosia", "google", "mojeek", "public",
];

export function WebSearchStep() {
  const { t } = useI18n();
  const [selection, setSelection] = useState<string>("auto");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/omp-settings", { cache: "no-store", signal: controller.signal })
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { settings?: { providers?: { webSearchOrder?: string[] } } } | null) => {
        if (controller.signal.aborted) return;
        setSelection(data?.settings?.providers?.webSearchOrder?.[0] ?? "auto");
      })
      .catch(() => {})
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);

  const choose = useCallback(async (value: string) => {
    setSelection(value);
    setSaving(true);
    setError(null);
    const order = value === "auto" ? [] : [value, ...WEB_SEARCH_FULL_ORDER.filter((id) => id !== value)];
    try {
      const response = await fetch("/api/omp-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: { providers: { webSearchOrder: order } } }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error || `HTTP ${response.status}`);
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setSaving(false);
    }
  }, []);

  if (loading) {
    return (
      <div className="setup-wizard-card" role="status">
        <Loader2 size={14} aria-hidden style={{ animation: "spin 0.9s linear infinite" }} />
      </div>
    );
  }
  return (
    <div className="setup-wizard-card" role="radiogroup" aria-label={t("setupWizard.webSearchTitle")}>
      {WEB_SEARCH_CHOICES.map((choice) => (
        <button
          key={choice.value}
          type="button"
          role="radio"
          aria-checked={selection === choice.value}
          className="setup-wizard-option"
          data-selected={selection === choice.value ? "true" : undefined}
          onClick={() => void choose(choice.value)}
          disabled={saving}
        >
          <span className="setup-wizard-option-check" aria-hidden>
            {selection === choice.value ? <Check size={13} /> : null}
          </span>
          <span className="setup-wizard-option-label">{choice.label}</span>
          <span className="setup-wizard-option-desc">{t(`setupWizard.webSearch.${choice.value}`)}</span>
        </button>
      ))}
      <p className="setup-wizard-note">{t("setupWizard.webSearchNote")}</p>
      {error && (
        <p className="setup-wizard-error" role="alert">
          <AlertCircle size={13} aria-hidden /> {error}
        </p>
      )}
    </div>
  );
}

interface RuntimeModelEntry {
  id: string;
  name: string;
  provider: string;
}

export function DefaultModelStep() {
  const { t } = useI18n();
  const [models, setModels] = useState<RuntimeModelEntry[]>([]);
  const [roles, setRoles] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      fetch("/api/models", { cache: "no-store", signal: controller.signal })
        .then((response) => (response.ok ? response.json() : null)),
      fetch("/api/model-roles", { cache: "no-store", signal: controller.signal })
        .then((response) => (response.ok ? response.json() : null)),
    ])
      .then(([modelsData, rolesData]: [{ modelList?: RuntimeModelEntry[] } | null, { roles?: Record<string, string> } | null]) => {
        if (controller.signal.aborted) return;
        setModels(modelsData?.modelList ?? []);
        setRoles(rolesData?.roles ?? {});
      })
      .catch(() => {})
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);

  const current = roles.default ?? null;
  const visible = useMemo(() => {
    const query = filter.trim().toLowerCase();
    const list = query
      ? models.filter((model) => `${model.provider}/${model.id} ${model.name}`.toLowerCase().includes(query))
      : models;
    return list.slice(0, 40);
  }, [filter, models]);

  const choose = useCallback(async (selector: string) => {
    setSaving(true);
    setError(null);
    const next = { ...roles, default: selector };
    try {
      const response = await fetch("/api/model-roles", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roles: next }),
      });
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok || body?.error) throw new Error(body?.error || `HTTP ${response.status}`);
      setRoles(next);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setSaving(false);
    }
  }, [roles]);

  if (loading) {
    return (
      <div className="setup-wizard-card" role="status">
        <Loader2 size={14} aria-hidden style={{ animation: "spin 0.9s linear infinite" }} />
        <span>{t("setupWizard.modelDiscovering")}</span>
      </div>
    );
  }
  if (models.length === 0) {
    return (
      <div className="setup-wizard-card">
        <p>{t("setupWizard.modelNone")}</p>
      </div>
    );
  }
  return (
    <div className="setup-wizard-card">
      <label className="setup-wizard-search">
        <Search size={13} aria-hidden />
        <input
          type="search"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder={t("setupWizard.modelSearch")}
          aria-label={t("setupWizard.modelSearch")}
        />
      </label>
      <div className="setup-wizard-options" role="radiogroup" aria-label={t("setupWizard.modelTitle")}>
        {visible.map((model) => {
          const selector = `${model.provider}/${model.id}`;
          const selected = current === selector;
          return (
            <button
              key={selector}
              type="button"
              role="radio"
              aria-checked={selected}
              className="setup-wizard-option"
              data-selected={selected ? "true" : undefined}
              onClick={() => void choose(selector)}
              disabled={saving}
            >
              <span className="setup-wizard-option-check" aria-hidden>{selected ? <Check size={13} /> : null}</span>
              <span className="setup-wizard-option-label">{model.name || model.id}</span>
              <span className="setup-wizard-option-desc">{selector}</span>
            </button>
          );
        })}
      </div>
      <p className="setup-wizard-note">{t("setupWizard.modelNote")}</p>
      {error && (
        <p className="setup-wizard-error" role="alert">
          <AlertCircle size={13} aria-hidden /> {error}
        </p>
      )}
    </div>
  );
}

export function ThemeStep() {
  const { t } = useI18n();
  const { themeId, setTheme } = useTheme();
  return (
    <div className="setup-wizard-card">
      <div className="setup-wizard-options" role="radiogroup" aria-label={t("setupWizard.themeTitle")}>
        {THEMES.map((theme) => (
          <button
            key={theme.id}
            type="button"
            role="radio"
            aria-checked={themeId === theme.id}
            className="setup-wizard-option"
            data-selected={themeId === theme.id ? "true" : undefined}
            onClick={() => setTheme(theme.id)}
          >
            <span className="setup-wizard-swatch" aria-hidden style={{ background: theme.preview.background, borderColor: theme.preview.accent }}>
              <span style={{ background: theme.preview.accent }} />
            </span>
            <span className="setup-wizard-option-label">{theme.name}</span>
            <span className="setup-wizard-option-desc">{theme.mode === "dark" ? t("setupWizard.themeDark") : t("setupWizard.themeLight")}</span>
          </button>
        ))}
      </div>
      <p className="setup-wizard-note">{t("setupWizard.themeNote")}</p>
    </div>
  );
}
