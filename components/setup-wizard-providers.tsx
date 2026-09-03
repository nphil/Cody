"use client";

import { AlertCircle, ArrowLeft, Check, KeyRound, Loader2, Plus, Server } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { AddProviderPicker, ApiKeyDetail, type ApiKeyProvider } from "./ModelsConfig";
import { ProviderLoginFlow, type ProviderLoginRow } from "./settings/ProviderLoginFlow";

/**
 * The wizard's providers step: a deliberately empty-first surface. A fresh
 * instance shows "nothing connected yet" and one Add provider button; adding
 * walks the same flows omp itself uses — OAuth sign-in (with the
 * paste-the-redirect fallback), API keys, or a local OpenAI-compatible
 * endpoint (llama-swap, Ollama, llama.cpp, LM Studio) whose model list is
 * discovered from its /models endpoint. Each added provider then appears in
 * the list. The full editor (registry, roles, retry) stays where it belongs:
 * Settings → API Keys & Providers.
 */

interface CustomProviderRow {
  key: string;
  baseUrl: string;
  modelCount: number;
}

const LOCAL_PRESETS = [
  { label: "llama-swap", baseUrl: "http://localhost:9292/v1" },
  { label: "Ollama", baseUrl: "http://localhost:11434/v1" },
  { label: "llama.cpp", baseUrl: "http://localhost:8080/v1" },
  { label: "LM Studio / vLLM", baseUrl: "http://localhost:1234/v1" },
] as const;

type View =
  | { kind: "list" }
  | { kind: "picker" }
  | { kind: "oauth"; id: string }
  | { kind: "apiKey"; id: string }
  | { kind: "custom" };

export function WizardProvidersStep() {
  const { t } = useI18n();
  const [view, setView] = useState<View>({ kind: "list" });
  const [oauthProviders, setOauthProviders] = useState<ProviderLoginRow[]>([]);
  const [apiKeyProviders, setApiKeyProviders] = useState<ApiKeyProvider[]>([]);
  const [customProviders, setCustomProviders] = useState<CustomProviderRow[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(() => {
    void Promise.all([
      fetch("/api/auth/providers").then((r) => (r.ok ? r.json() : null)),
      fetch("/api/auth/all-providers").then((r) => (r.ok ? r.json() : null)),
      fetch("/api/models-config").then((r) => (r.ok ? r.json() : null)),
    ])
      .then(([oauth, keys, config]: [
        { providers?: ProviderLoginRow[] } | null,
        { providers?: ApiKeyProvider[] } | null,
        { providers?: Record<string, { baseUrl?: string; models?: unknown[] }> } | null,
      ]) => {
        setOauthProviders(oauth?.providers ?? []);
        setApiKeyProviders(keys?.providers ?? []);
        setCustomProviders(Object.entries(config?.providers ?? {}).map(([key, value]) => ({
          key,
          baseUrl: value?.baseUrl ?? "",
          modelCount: Array.isArray(value?.models) ? value.models.length : 0,
        })));
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const connectedOAuth = oauthProviders.filter((provider) => provider.authenticated);
  const configuredKeys = apiKeyProviders.filter((provider) => provider.configured);
  const hasAny = connectedOAuth.length > 0 || configuredKeys.length > 0 || customProviders.length > 0;

  if (loading) {
    return (
      <div className="setup-wizard-card" role="status">
        <Loader2 size={14} aria-hidden style={{ animation: "spin 0.9s linear infinite" }} />
      </div>
    );
  }

  if (view.kind === "picker") {
    return (
      <div className="setup-wizard-card setup-wizard-picker">
        <AddProviderPicker
          oauthProviders={oauthProviders}
          apiKeyProviders={apiKeyProviders}
          onSelectOAuth={(id) => setView({ kind: "oauth", id })}
          onSelectApiKey={(id) => setView({ kind: "apiKey", id })}
          onAddCustom={() => setView({ kind: "custom" })}
          // The picker fires onSelect* and then onClose; a plain reset here
          // would clobber the just-chosen detail view and bounce back to the
          // list, so only the still-on-picker case closes.
          onClose={() => setView((current) => (current.kind === "picker" ? { kind: "list" } : current))}
        />
      </div>
    );
  }

  if (view.kind === "oauth") {
    const provider = oauthProviders.find((item) => item.id === view.id);
    return (
      <div className="setup-wizard-card">
        <BackRow label={t("setupWizard.providersBack")} onBack={() => { setView({ kind: "list" }); reload(); }} />
        {provider
          ? <ProviderLoginFlow provider={provider} onChanged={reload} />
          : <p>{t("setupWizard.providersMissing")}</p>}
      </div>
    );
  }

  if (view.kind === "apiKey") {
    const provider = apiKeyProviders.find((item) => item.id === view.id);
    return (
      <div className="setup-wizard-card">
        <BackRow label={t("setupWizard.providersBack")} onBack={() => { setView({ kind: "list" }); reload(); }} />
        {provider
          ? <ApiKeyDetail provider={provider} />
          : <p>{t("setupWizard.providersMissing")}</p>}
      </div>
    );
  }

  if (view.kind === "custom") {
    return (
      <div className="setup-wizard-card">
        <BackRow label={t("setupWizard.providersBack")} onBack={() => { setView({ kind: "list" }); reload(); }} />
        <LocalEndpointForm onSaved={() => { setView({ kind: "list" }); reload(); }} />
      </div>
    );
  }

  return (
    <div className="setup-wizard-card">
      {!hasAny && <p className="setup-wizard-empty">{t("setupWizard.providersEmpty")}</p>}
      {connectedOAuth.map((provider) => (
        <div key={`oauth-${provider.id}`} className="setup-wizard-provider-row">
          <Check size={14} aria-hidden style={{ color: "var(--status-success)" }} />
          <span className="setup-wizard-option-label">{provider.name}</span>
          <span className="setup-wizard-option-desc">{t("setupWizard.providerSignedIn")}</span>
        </div>
      ))}
      {configuredKeys.map((provider) => (
        <div key={`key-${provider.id}`} className="setup-wizard-provider-row">
          <KeyRound size={14} aria-hidden style={{ color: "var(--accent)" }} />
          <span className="setup-wizard-option-label">{provider.displayName}</span>
          <span className="setup-wizard-option-desc">{t("setupWizard.providerApiKey")}</span>
        </div>
      ))}
      {customProviders.map((provider) => (
        <div key={`custom-${provider.key}`} className="setup-wizard-provider-row">
          <Server size={14} aria-hidden style={{ color: "var(--accent)" }} />
          <span className="setup-wizard-option-label">{provider.key}</span>
          <span className="setup-wizard-option-desc">
            {provider.baseUrl}{provider.modelCount > 0 ? ` · ${t("setupWizard.providerModels", { count: String(provider.modelCount) })}` : ""}
          </span>
        </div>
      ))}
      <button type="button" className="login-ghost engine-button setup-wizard-add" onClick={() => setView({ kind: "picker" })}>
        <Plus size={14} aria-hidden /> {t("setupWizard.providersAdd")}
      </button>
    </div>
  );
}

function BackRow({ label, onBack }: { label: string; onBack: () => void }) {
  return (
    <button type="button" className="engine-link setup-wizard-back" onClick={onBack}>
      <ArrowLeft size={13} aria-hidden /> {label}
    </button>
  );
}

function LocalEndpointForm({ onSaved }: { onSaved: () => void }) {
  const { t } = useI18n();
  const [name, setName] = useState("local");
  const [baseUrl, setBaseUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const save = useCallback(async () => {
    const key = name.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
    const url = baseUrl.trim().replace(/\/+$/, "");
    if (!key || !url) {
      setError(t("setupWizard.localMissingFields"));
      return;
    }
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      // Discover the endpoint's models server-side (no CORS, honest timeout);
      // an unreachable endpoint still saves, models can be added later.
      const discovered = await fetch("/api/models-config/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseUrl: url }),
      })
        .then((response) => (response.ok ? response.json() : null))
        .then((data: { models?: string[] } | null) => data?.models ?? [])
        .catch(() => [] as string[]);

      const current = await fetch("/api/models-config").then((response) => (response.ok ? response.json() : null)) as
        | { providers?: Record<string, unknown> }
        | null;
      const providers = { ...(current?.providers ?? {}) };
      providers[key] = {
        baseUrl: url,
        api: "openai-completions",
        auth: "none",
        models: discovered.map((id) => ({ id })),
      };
      const response = await fetch("/api/models-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providers }),
      });
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`);
      if (discovered.length === 0) setNote(t("setupWizard.localNoModels"));
      onSaved();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  }, [baseUrl, name, onSaved, t]);

  return (
    <>
      <p>{t("setupWizard.localIntro")}</p>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {LOCAL_PRESETS.map((preset) => (
          <button
            key={preset.label}
            type="button"
            className="login-ghost engine-button setup-wizard-chip"
            onClick={() => {
              setBaseUrl(preset.baseUrl);
              setName(preset.label.split(" ")[0].toLowerCase().replace(/[^a-z0-9-]+/g, "-"));
            }}
          >
            {preset.label}
          </button>
        ))}
      </div>
      <label className="setup-wizard-field">
        <span>{t("setupWizard.localName")}</span>
        <input type="text" value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      <label className="setup-wizard-field">
        <span>{t("setupWizard.localBaseUrl")}</span>
        <input type="text" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="http://192.168.1.10:9292/v1" />
      </label>
      {error && (
        <p className="setup-wizard-error" role="alert">
          <AlertCircle size={13} aria-hidden /> {error}
        </p>
      )}
      {note && <p className="setup-wizard-note">{note}</p>}
      <button type="button" className="login-primary engine-button setup-wizard-btn" onClick={() => void save()} disabled={busy} style={{ alignSelf: "flex-start" }}>
        {busy ? <Loader2 size={14} aria-hidden style={{ animation: "spin 0.9s linear infinite" }} /> : <Plus size={14} aria-hidden />}
        {t("setupWizard.localSave")}
      </button>
    </>
  );
}
