"use client";

/**
 * "Add a local endpoint": the one flow that writes a NEW provider into
 * omp's models.yml from a base URL — llama-swap, Ollama, llama.cpp, LM
 * Studio, vLLM, or any OpenAI-compatible server. The endpoint's model list
 * is discovered server-side (`/api/models-config/discover`: no CORS, an
 * honest timeout) and seeded as the provider's models; an unreachable
 * endpoint still saves, and the models are added later in the provider's
 * Advanced form.
 *
 * Shared by the Providers hub (a Discovered row's Add, the picker's Custom
 * card) and the setup wizard, which is why the copy goes through
 * `setupWizard.local*` — tri-locale keys the wizard already owned.
 */
import { AlertCircle, Loader2, Plus } from "lucide-react";
import { useCallback, useState } from "react";
import { Field, TextInput } from "@/components/ui/field";
import { useI18n } from "@/lib/i18n";

const LOCAL_PRESETS = [
  { label: "llama-swap", baseUrl: "http://localhost:9292/v1" },
  { label: "Ollama", baseUrl: "http://localhost:11434/v1" },
  { label: "llama.cpp", baseUrl: "http://localhost:8080/v1" },
  { label: "LM Studio / vLLM", baseUrl: "http://localhost:1234/v1" },
] as const;

function slugName(label: string): string {
  return label.split(" ")[0].toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
}

export function LocalEndpointForm({ onSaved, initialName, initialBaseUrl }: {
  /** Called with the models.yml provider name once the file is written. */
  onSaved: (name: string) => void;
  initialName?: string;
  initialBaseUrl?: string;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(initialName ?? "local");
  const [baseUrl, setBaseUrl] = useState(initialBaseUrl ?? "");
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
      onSaved(key);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  }, [baseUrl, name, onSaved, t]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
      <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>{t("setupWizard.localIntro")}</p>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {LOCAL_PRESETS.map((preset) => (
          <button
            key={preset.label}
            type="button"
            className="ui-control ui-focus-ring"
            onClick={() => {
              setBaseUrl(preset.baseUrl);
              setName(slugName(preset.label));
            }}
            style={{ fontSize: 12 }}
          >
            {preset.label}
          </button>
        ))}
      </div>
      <Field label={t("setupWizard.localName")}>
        <TextInput value={name} onChange={setName} mono autoComplete="off" spellCheck={false} disabled={busy} />
      </Field>
      <Field label={t("setupWizard.localBaseUrl")}>
        <TextInput value={baseUrl} onChange={setBaseUrl} placeholder="http://192.168.1.10:9292/v1" mono autoComplete="off" spellCheck={false} disabled={busy} />
      </Field>
      {error && (
        <p role="alert" style={{ margin: 0, display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--status-error)" }}>
          <AlertCircle size={13} aria-hidden="true" /> {error}
        </p>
      )}
      {note && <p style={{ margin: 0, fontSize: 11, color: "var(--text-dim)", lineHeight: 1.5 }}>{note}</p>}
      <button
        type="button"
        onClick={() => void save()}
        disabled={busy}
        className="ui-focus-ring"
        style={{ alignSelf: "flex-start", display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 14px", border: "none", borderRadius: "var(--radius-control)", background: "var(--accent)", color: "var(--on-accent)", cursor: busy ? "wait" : "pointer", fontSize: 12, fontWeight: 600 }}
      >
        {busy ? <Loader2 size={14} aria-hidden="true" className="icon-spin" /> : <Plus size={14} aria-hidden="true" />}
        {t("setupWizard.localSave")}
      </button>
    </div>
  );
}
