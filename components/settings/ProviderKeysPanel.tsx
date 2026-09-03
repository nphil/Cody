"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertCircle, Check, KeyRound, Loader2 } from "lucide-react";
import { formatApiError } from "@/lib/i18n/api-error";
import { chipStyle, nativeInputStyle } from "@/components/settings/primitives";

/**
 * Provider keys for the active engine (Settings → API Keys & Providers).
 *
 * This is the in-app answer to the failure every engine but omp used to fail
 * with silently: no credentials. Keys are saved on the server and handed to
 * every engine child as environment variables — the one credential path
 * omp, pi, Hermes, Claude Code and Codex all share — so the same panel serves
 * all five, filtered to the providers the active engine actually reads.
 *
 * Values never come back from the server. The panel knows only whether a
 * variable is set, and by which route: saved here, or set on the container
 * (in which case saving here overrides it, and the chip says so).
 */

interface VariableStatus {
  name: string;
  label: string;
  secret: boolean;
  hint?: string;
  stored: boolean;
  fromEnvironment: boolean;
}

interface ProviderStatus {
  id: string;
  name: string;
  variables: VariableStatus[];
  configured: boolean;
}

interface KeysResponse {
  engine?: { id: string; shortName: string };
  providers?: ProviderStatus[];
}

function VariableRow({ variable, canEdit, onSave }: {
  variable: VariableStatus;
  canEdit: boolean;
  onSave: (name: string, value: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedTick, setSavedTick] = useState(false);

  const submit = async (value: string) => {
    setBusy(true);
    setError(null);
    try {
      await onSave(variable.name, value);
      setDraft("");
      setSavedTick(true);
      setTimeout(() => setSavedTick(false), 1800);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  const status = variable.stored
    ? "Saved in Cody"
    : variable.fromEnvironment
      ? "Set on the container"
      : "Not set";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 12, fontWeight: 600 }}>{variable.label}</span>
        <code style={{ fontSize: 11, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>{variable.name}</code>
        <span style={{ ...chipStyle, color: variable.stored || variable.fromEnvironment ? "var(--status-success)" : "var(--text-dim)" }}>{status}</span>
        {variable.stored && variable.fromEnvironment && (
          <span style={{ fontSize: 11, color: "var(--text-dim)" }}>The saved value overrides the container&apos;s.</span>
        )}
      </div>
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        <input
          type={variable.secret ? "password" : "text"}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter" && draft.trim()) void submit(draft); }}
          placeholder={variable.stored ? "Replace the saved value" : variable.hint ?? (variable.secret ? "Paste a key" : "Value")}
          disabled={!canEdit || busy}
          autoComplete="off"
          spellCheck={false}
          aria-label={`${variable.label} (${variable.name})`}
          style={{ ...nativeInputStyle, flex: "1 1 220px", minWidth: 0, fontFamily: variable.secret ? "var(--font-mono)" : undefined }}
        />
        <button
          type="button"
          className="ui-control ui-focus-ring"
          onClick={() => void submit(draft)}
          disabled={!canEdit || busy || !draft.trim()}
          style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
        >
          {busy ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : savedTick ? <Check size={13} aria-hidden="true" /> : null}
          Save
        </button>
        {variable.stored && (
          <button type="button" className="ui-control ui-focus-ring" onClick={() => void submit("")} disabled={!canEdit || busy} style={{ color: "var(--text-muted)" }}>
            Clear
          </button>
        )}
      </div>
      {error && (
        <div role="alert" style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12, color: "var(--status-error)" }}>
          <AlertCircle size={13} aria-hidden="true" />{error}
        </div>
      )}
    </div>
  );
}

export function ProviderKeysPanel() {
  const [data, setData] = useState<KeysResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Only an administrator may change a key that every user's sessions will
  // spend; members still see what is configured, which is the answer to
  // "why does the engine not reply".
  const [canEdit, setCanEdit] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/accounts/me", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { user?: { role?: string } } | null) => { if (!cancelled) setCanEdit(body?.user?.role === "admin"); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/provider-keys", { cache: "no-store" });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        // Before the first account exists there is no one to gate a key on;
        // that is the first-run state, not a failure of this panel.
        const code = body && typeof body === "object" && typeof (body as { code?: unknown }).code === "string" ? (body as { code: string }).code : null;
        if (code === "no_accounts") { setData(null); setLoadError("Create the first account (the first-run setup) to manage provider keys."); return; }
        throw new Error(formatApiError(body));
      }
      setData(body as KeysResponse);
      setLoadError(null);
    } catch (failure) {
      setLoadError(failure instanceof Error ? failure.message : String(failure));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const save = useCallback(async (name: string, value: string) => {
    const response = await fetch("/api/provider-keys", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, value }),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(formatApiError(body));
    setData(body as KeysResponse);
  }, []);

  const engineName = data?.engine?.shortName ?? "the active engine";
  const providers = data?.providers ?? [];
  const configured = providers.filter((provider) => provider.configured);

  return (
    <section aria-labelledby="provider-keys-heading" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div>
        <h3 id="provider-keys-heading" style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, fontWeight: 600, margin: 0 }}>
          <KeyRound size={15} aria-hidden="true" />
          Provider keys for {engineName}
        </h3>
        <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--text-muted)", maxWidth: "62ch" }}>
          Keys saved here reach {engineName} as environment variables, the same way a key set on the container would.
          A saved key applies to sessions started after it is saved; the engine&apos;s own sign-in (OAuth, a login command
          in a Cody terminal) keeps working alongside it.
          {!canEdit && " Only an administrator can change them."}
        </p>
      </div>

      {loadError && (
        <div role="alert" style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12, color: "var(--status-error)" }}>
          <AlertCircle size={13} aria-hidden="true" />{loadError}
        </div>
      )}

      {data && providers.length === 0 && (
        <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>{engineName} does not read provider keys from its environment.</p>
      )}

      {data && providers.length > 0 && (
        <p style={{ margin: 0, fontSize: 12, color: configured.length > 0 ? "var(--text-muted)" : "var(--status-warning)" }}>
          {configured.length > 0
            ? `Configured: ${configured.map((provider) => provider.name).join(", ")}.`
            : `No provider has a key yet, so ${engineName} cannot answer a prompt until one is added.`}
        </p>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {providers.map((provider) => (
          <div
            key={provider.id}
            style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-control)", padding: "10px 12px", background: "var(--bg-panel)", display: "flex", flexDirection: "column", gap: 10 }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{provider.name}</span>
              {provider.configured && <span style={{ ...chipStyle, color: "var(--status-success)" }}>Configured</span>}
            </div>
            {provider.variables.map((variable) => (
              <VariableRow key={variable.name} variable={variable} canEdit={canEdit} onSave={save} />
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}
