"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertCircle, ChevronDown, ChevronRight, LogIn, LogOut, RefreshCw } from "lucide-react";
import { formatApiError } from "@/lib/i18n/api-error";
import { chipStyle } from "@/components/settings/primitives";
import { ProviderLoginFlow, type ProviderLoginRow } from "@/components/settings/ProviderLoginFlow";

/**
 * Provider SIGN-IN for the active engine (Settings → API Keys & Providers,
 * above the key cards) — the engine's OWN login (a Claude Pro/Max or ChatGPT
 * subscription, a device code, omp's OAuth roster, …) instead of an API key
 * Cody stores itself. Every engine that declares `providerLogins`
 * (lib/harness/types.ts) is listed here through the one engine-neutral
 * route, `/api/auth/providers`; the actual sign-in flow for a row is the
 * SAME `ProviderLoginFlow` component OMP's own Models & Auth panel uses, so
 * there is exactly one implementation of the state machine.
 *
 * Self-contained like ProviderKeysPanel: fetches its own data and its own
 * admin check, and is meant to be mounted only behind
 * `capabilities.providerLogin` (SettingsConfig does that; this panel also
 * hides itself if the server ever answers `unsupported` anyway).
 */

interface ProvidersResponse {
  engine?: { id: string; shortName: string };
  providers?: ProviderLoginRow[];
  /** Why the list is empty — not installed, its login command failed — in
   * the engine's own words. */
  reason?: string;
}

function ProviderRow({ provider, canEdit, expanded, onToggle, onChanged }: {
  provider: ProviderLoginRow;
  canEdit: boolean;
  expanded: boolean;
  onToggle: () => void;
  onChanged: () => void;
}) {
  const toggleButtonStyle = {
    display: "inline-flex", alignItems: "center", gap: 6,
    padding: "5px 10px",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-control)",
    background: "none",
    cursor: "pointer",
    fontSize: 12,
    fontWeight: 600,
  } as const;

  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-panel)", overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", flexWrap: "wrap" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 2, flex: "1 1 160px", minWidth: 0 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{provider.name}</span>
          {provider.hint && <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{provider.hint}</span>}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
          <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: "50%", background: provider.authenticated ? "var(--status-success)" : "var(--border)", display: "inline-block" }} />
          <span style={{ fontSize: 11, color: provider.authenticated ? "var(--status-success)" : "var(--text-dim)" }}>
            {provider.authenticated ? "Signed in" : "Not signed in"}
          </span>
        </div>

        {canEdit && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0, flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={onToggle}
              aria-expanded={expanded}
              style={provider.authenticated ? { ...toggleButtonStyle, color: "var(--text-muted)" } : { ...toggleButtonStyle, background: "var(--accent)", borderColor: "var(--accent)", color: "var(--on-accent)" }}
            >
              {provider.authenticated ? <RefreshCw size={12} aria-hidden="true" /> : <LogIn size={12} aria-hidden="true" />}
              {provider.authenticated ? "Re-login" : "Sign in"}
            </button>
            {provider.authenticated && provider.canLogout && (
              <button
                type="button"
                onClick={onToggle}
                aria-expanded={expanded}
                style={{ ...toggleButtonStyle, color: "var(--status-error)", borderColor: "color-mix(in srgb, var(--status-error) 30%, transparent)" }}
              >
                <LogOut size={12} aria-hidden="true" />
                Sign out
              </button>
            )}
            <button
              type="button"
              onClick={onToggle}
              aria-label={expanded ? `Collapse ${provider.name}` : `Expand ${provider.name}`}
              aria-expanded={expanded}
              style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 24, height: 24, border: "none", background: "none", color: "var(--text-dim)", cursor: "pointer", flexShrink: 0 }}
            >
              {expanded ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
            </button>
          </div>
        )}
      </div>

      {canEdit && expanded && (
        <div style={{ borderTop: "1px solid var(--border)", padding: 12 }}>
          <ProviderLoginFlow provider={provider} onChanged={onChanged} />
        </div>
      )}
    </div>
  );
}

export function ProviderSignInPanel() {
  const [data, setData] = useState<ProvidersResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // The server also gates this route on capabilities.providerLogin; a 400
  // "unsupported" hides the section instead of showing an error box, in
  // case this ever renders for a moment during an engine switch.
  const [unsupported, setUnsupported] = useState(false);
  // Only an administrator may sign an engine in or out — the credential is
  // shared by every user's sessions, same reasoning as the key cards below.
  // Members still see whether a provider is connected.
  const [canEdit, setCanEdit] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

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
      const response = await fetch("/api/auth/providers", { cache: "no-store" });
      const body = await response.json().catch(() => null) as (ProvidersResponse & { error?: string; code?: string }) | null;
      if (!response.ok) {
        if (body?.code === "unsupported") { setUnsupported(true); setData(null); setLoadError(null); return; }
        throw new Error(formatApiError(body ?? null));
      }
      setUnsupported(false);
      setData(body);
      setLoadError(null);
    } catch (failure) {
      setLoadError(failure instanceof Error ? failure.message : String(failure));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const toggle = useCallback((id: string) => {
    setExpandedId((current) => (current === id ? null : id));
  }, []);

  const onRowChanged = useCallback(() => { void load(); }, [load]);

  if (unsupported) return null;

  const engineName = data?.engine?.shortName ?? "the active engine";
  const providers = data?.providers ?? [];

  return (
    <section aria-labelledby="provider-signin-heading" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div>
        <h3 id="provider-signin-heading" style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, fontWeight: 600, margin: 0 }}>
          <LogIn size={15} aria-hidden="true" />
          Sign in to {engineName}&apos;s providers
        </h3>
        <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--text-muted)", maxWidth: "62ch" }}>
          Use {engineName}&apos;s own sign-in — a browser subscription or a device code — to connect a provider without pasting an API key below.
          {!canEdit && " Only an administrator can sign in or out."}
        </p>
      </div>

      {loadError && (
        <div role="alert" style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12, color: "var(--status-error)" }}>
          <AlertCircle size={13} aria-hidden="true" />{loadError}
        </div>
      )}

      {data && providers.length === 0 && (
        <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>
          {data.reason ?? `${engineName} has no providers to sign in to yet.`}
        </p>
      )}

      {providers.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {providers.map((provider) => (
            <ProviderRow
              key={provider.id}
              provider={provider}
              canEdit={canEdit}
              expanded={expandedId === provider.id}
              onToggle={() => toggle(provider.id)}
              onChanged={onRowChanged}
            />
          ))}
          {providers.map((provider) => (
            <span key={`chip-${provider.id}`} style={{ display: "none" }}>{chipStyle && null}</span>
          ))}
        </div>
      )}
    </section>
  );
}
