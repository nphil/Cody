"use client";

import { AlertCircle, ArrowLeft, Check, KeyRound, Loader2, Plus, Server } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { loadEngineInfo } from "@/lib/engine-capabilities";
import { sortConnectedRows, type ProviderRow, type ProvidersResponse } from "@/lib/provider-directory";
import { AddProviderPicker } from "./settings/providers/AddProviderPicker";
import { LocalEndpointForm } from "./settings/providers/LocalEndpointForm";
import { KeyMethodCard, loginRowOf } from "./settings/providers/ProviderDetail";
import { ProviderLoginFlow } from "./settings/ProviderLoginFlow";

/**
 * The wizard's providers step: a deliberately empty-first surface. A fresh
 * instance shows "nothing connected yet" and one Add provider button; adding
 * walks the same flows the Providers hub uses — the engine's own sign-in
 * (with the paste-the-redirect fallback), an API key saved in Cody, or a
 * local OpenAI-compatible endpoint (llama-swap, Ollama, llama.cpp, LM
 * Studio) whose model list is discovered from its /models endpoint. Each
 * added provider then appears in the list. Everything reads from the one
 * `/api/providers` join the hub itself renders.
 */

type View =
  | { kind: "list" }
  | { kind: "picker" }
  | { kind: "login"; id: string; loginId: string }
  | { kind: "key"; id: string }
  | { kind: "custom" };

export function WizardProvidersStep() {
  const { t } = useI18n();
  const [view, setView] = useState<View>({ kind: "list" });
  const [directory, setDirectory] = useState<ProvidersResponse | null>(null);
  const [canAddCustom, setCanAddCustom] = useState(false);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(() => {
    void fetch("/api/providers", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((body: ProvidersResponse | null) => { if (body) setDirectory(body); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    reload();
    // Custom endpoints go into the engine's models.yml, which only an engine
    // with the management editor keeps.
    void loadEngineInfo().then((info) => setCanAddCustom(info.capabilities.models === true));
  }, [reload]);

  const rows = directory?.providers ?? [];
  const shortName = directory?.engine.shortName ?? "";
  const connected = sortConnectedRows(rows);
  const rowById = (id: string): ProviderRow | undefined => rows.find((row) => row.id === id);

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
        <BackRow label={t("setupWizard.providersBack")} onBack={() => setView({ kind: "list" })} />
        <AddProviderPicker
          rows={rows}
          canAddCustom={canAddCustom}
          onPick={(choice) => setView(choice.loginId ? { kind: "login", id: choice.row.id, loginId: choice.loginId } : { kind: "key", id: choice.row.id })}
          onAddCustom={() => setView({ kind: "custom" })}
        />
      </div>
    );
  }

  if (view.kind === "login") {
    const row = rowById(view.id);
    const method = row?.methods.find((entry) => entry.loginId === view.loginId);
    return (
      <div className="setup-wizard-card">
        <BackRow label={t("setupWizard.providersBack")} onBack={() => { setView({ kind: "list" }); reload(); }} />
        {row && method
          ? <ProviderLoginFlow provider={loginRowOf(row, method)} onChanged={reload} autoStart />
          : <p>{t("setupWizard.providersMissing")}</p>}
      </div>
    );
  }

  if (view.kind === "key") {
    const row = rowById(view.id);
    const method = row?.methods.find((entry) => entry.kind === "key" || entry.kind === "env");
    return (
      <div className="setup-wizard-card">
        <BackRow label={t("setupWizard.providersBack")} onBack={() => { setView({ kind: "list" }); reload(); }} />
        {row && method
          ? <KeyMethodCard method={method} canEdit={directory?.canEdit ?? true} shortName={shortName} onSaved={reload} />
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
      {connected.length === 0 && <p className="setup-wizard-empty">{t("setupWizard.providersEmpty")}</p>}
      {connected.map((row) => {
        const winner = row.methods.find((method) => method.winning);
        const kind = winner?.kind;
        const signedIn = kind === "oauth" || kind === "device";
        const custom = kind === "custom";
        return (
          <div key={row.id} className="setup-wizard-provider-row">
            {signedIn
              ? <Check size={14} aria-hidden style={{ color: "var(--status-success)" }} />
              : custom
                ? <Server size={14} aria-hidden style={{ color: "var(--accent)" }} />
                : <KeyRound size={14} aria-hidden style={{ color: "var(--accent)" }} />}
            <span className="setup-wizard-option-label">{row.name}</span>
            <span className="setup-wizard-option-desc">
              {signedIn
                ? t("setupWizard.providerSignedIn")
                : custom
                  ? `${row.endpoint?.baseUrl ?? ""}${row.modelCount ? ` · ${t("setupWizard.providerModels", { count: String(row.modelCount) })}` : ""}`
                  : t("setupWizard.providerApiKey")}
            </span>
          </div>
        );
      })}
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

/** Kept for the parse-error hint the wizard used to render inline. */
export function WizardInlineError({ children }: { children: React.ReactNode }) {
  return (
    <p className="setup-wizard-error" role="alert">
      <AlertCircle size={13} aria-hidden /> {children}
    </p>
  );
}
