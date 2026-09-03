"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useI18n } from "@/lib/i18n";
import { isSafeExternalUrl } from "@/lib/safe-url";
import { formatApiError } from "@/lib/i18n/api-error";

/**
 * One provider's sign-in state machine: an SSE stream over
 * `/api/auth/login/<id>` drives the frames below, with a POST to the same
 * route feeding back whatever the user pastes or picks, and a POST to
 * `/api/auth/logout/<id>` for sign-out. Every engine that declares
 * `providerLogins` (lib/harness/types.ts — omp, pi, Claude Code, Codex,
 * Hermes, each running its OWN login and keeping the credential in its OWN
 * store) is driven through this exact wire shape, so this is the ONE sign-in
 * UI implementation in Cody: both the API Keys & Providers "Sign in" section
 * (ProviderSignInPanel) and OMP's own Models & Auth panel (ModelsConfig)
 * render it unchanged, just with a different `provider` row.
 *
 * Frames: `auth {url, instructions, token}` (browser sign-in; the paste box
 * shows immediately so a redirect URL pasted early is not lost),
 * `device_code {userCode, verificationUri, intervalSeconds, expiresInSeconds}`
 * (no paste box — the user types the code on the provider's site while the
 * engine polls), `prompt_request {message, placeholder, token}`,
 * `select_request {message, options, token}` (kept for an engine whose flow
 * needs a choice, even though none does today), `progress {message}`,
 * `success`, `error {message}`, `cancelled`.
 */

export interface ProviderLoginRow {
  /** The engine's own id for the provider ("anthropic", "openai-codex"). */
  id: string;
  name: string;
  /** Signed in right now, as far as the engine reports it. */
  authenticated: boolean;
  /**
   * "oauth": a browser sign-in whose fallback is pasting the code or the
   * final redirect URL back; "device": a short code typed on the provider's
   * site, nothing to paste.
   */
  kind: "oauth" | "device";
  /** Whether a Sign out control should render at all. */
  canLogout: boolean;
  /** One line of context for the row ("Claude Pro/Max subscription"). */
  hint?: string;
}

type LoginFlowState =
  | { phase: "idle" }
  | { phase: "connecting" }
  | { phase: "auth"; url: string; instructions: string | null; token: string }
  | { phase: "device_code"; userCode: string; verificationUri: string; intervalSeconds: number | null; expiresInSeconds: number | null }
  | { phase: "prompt"; message: string; placeholder: string | null; token: string }
  | { phase: "select"; message: string; options: { id: string; label: string }[]; token: string }
  | { phase: "progress"; message: string }
  | { phase: "success" }
  | { phase: "error"; message: string };

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 2 }}>{children}</div>;
}

export function ProviderLoginFlow({ provider, onChanged }: { provider: ProviderLoginRow; onChanged: () => void }) {
  const { t, tn } = useI18n();
  const [loginState, setLoginState] = useState<LoginFlowState>({ phase: "idle" });
  const [inputValue, setInputValue] = useState("");
  const eventSourceRef = useRef<EventSource | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (loginState.phase === "auth" || loginState.phase === "prompt") {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [loginState.phase]);

  // Reset state when the provider changes.
  useEffect(() => {
    setLoginState({ phase: "idle" });
    setInputValue("");
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
  }, [provider.id]);

  useEffect(() => {
    return () => { eventSourceRef.current?.close(); };
  }, []);

  const handleLogin = useCallback(() => {
    eventSourceRef.current?.close();
    setLoginState({ phase: "connecting" });
    setInputValue("");

    const es = new EventSource(`/api/auth/login/${encodeURIComponent(provider.id)}`);
    eventSourceRef.current = es;

    es.onmessage = (e) => {
      let data: {
        type: string; url?: string; instructions?: string | null;
        token?: string; message?: string; placeholder?: string | null;
        userCode?: string; verificationUri?: string; intervalSeconds?: number | null; expiresInSeconds?: number | null;
        options?: { id: string; label: string }[];
      };
      try {
        data = JSON.parse(e.data) as typeof data;
      } catch {
        // Malformed frame: ignore rather than killing the handler.
        return;
      }
      if (data.type === "auth") {
        setLoginState({ phase: "auth", url: data.url!, instructions: data.instructions ?? null, token: data.token! });
        if (isSafeExternalUrl(data.url)) window.open(data.url, "_blank", "noopener,noreferrer");
      } else if (data.type === "device_code") {
        setLoginState({
          phase: "device_code",
          userCode: data.userCode!,
          verificationUri: data.verificationUri!,
          intervalSeconds: data.intervalSeconds ?? null,
          expiresInSeconds: data.expiresInSeconds ?? null,
        });
        if (isSafeExternalUrl(data.verificationUri)) window.open(data.verificationUri, "_blank", "noopener,noreferrer");
      } else if (data.type === "prompt_request") {
        setLoginState({ phase: "prompt", message: data.message!, placeholder: data.placeholder ?? null, token: data.token! });
      } else if (data.type === "select_request") {
        setLoginState({ phase: "select", message: data.message!, options: data.options ?? [], token: data.token! });
      } else if (data.type === "progress") {
        setLoginState({ phase: "progress", message: data.message! });
      } else if (data.type === "success") {
        es.close();
        setLoginState({ phase: "success" });
        onChanged();
      } else if (data.type === "error") {
        es.close();
        setLoginState({ phase: "error", message: data.message! });
      } else if (data.type === "cancelled") {
        es.close();
        setLoginState({ phase: "idle" });
      }
    };
    es.onerror = () => {
      es.close();
      setLoginState((prev) => prev.phase === "success" ? prev : { phase: "error", message: t("modelsConfig.connectionLost") });
    };
  }, [provider.id, onChanged, t]);

  const handleLogout = useCallback(async () => {
    try {
      const res = await fetch(`/api/auth/logout/${encodeURIComponent(provider.id)}`, { method: "POST" });
      const d = await res.json().catch(() => ({})) as { error?: string; code?: string };
      if (!res.ok || d.error) {
        // An engine with no non-interactive logout answers 400 `unsupported`
        // with its own words; show those rather than a generic failure.
        setLoginState({ phase: "error", message: d.error || d.code ? formatApiError(d) : `HTTP ${res.status}` });
        return;
      }
      setLoginState({ phase: "idle" });
      onChanged();
    } catch (e) {
      setLoginState({ phase: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }, [provider.id, onChanged]);

  // `allowEmpty`: a prompt can be optional (pi's GitHub Copilot flow asks
  // for an enterprise domain, blank meaning github.com), so an empty answer
  // to a prompt is sent as-is; the paste box under a sign-in URL still
  // needs a value.
  const submitCode = useCallback(async (token: string, code: string, allowEmpty = false) => {
    if (!code.trim() && !allowEmpty) return;
    setLoginState({ phase: "progress", message: t("modelsConfig.verifying") });
    try {
      const res = await fetch(`/api/auth/login/${encodeURIComponent(provider.id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, code: code.trim() }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({})) as { error?: string; code?: string };
        setLoginState({ phase: "error", message: d.error || d.code ? formatApiError(d) : t("modelsConfig.serverError", { status: res.status }) });
        return;
      }
      setInputValue("");
      // Success path: the SSE stream will emit "success" and update state.
    } catch (e) {
      setLoginState({ phase: "error", message: e instanceof Error ? e.message : t("modelsConfig.networkError") });
    }
  }, [provider.id, t]);

  const submitSelection = useCallback(async (token: string, value: string) => {
    setLoginState({ phase: "progress", message: t("modelsConfig.continuing") });
    try {
      const res = await fetch(`/api/auth/login/${encodeURIComponent(provider.id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, code: value }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({})) as { error?: string; code?: string };
        setLoginState({ phase: "error", message: d.error || d.code ? formatApiError(d) : t("modelsConfig.serverError", { status: res.status }) });
      }
    } catch (e) {
      setLoginState({ phase: "error", message: e instanceof Error ? e.message : t("modelsConfig.networkError") });
    }
  }, [provider.id, t]);

  const isWorking = loginState.phase === "connecting" || loginState.phase === "progress" ||
    loginState.phase === "auth" || loginState.phase === "device_code" ||
    loginState.phase === "prompt" || loginState.phase === "select";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <SectionTitle>{t("modelsConfig.subscription")}</SectionTitle>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: provider.authenticated ? "var(--status-success)" : "var(--border)", display: "inline-block" }} />
          <span style={{ fontSize: 11, color: provider.authenticated ? "var(--status-success)" : "var(--text-dim)" }}>
            {provider.authenticated ? t("modelsConfig.connected") : t("modelsConfig.notConnected")}
          </span>
        </div>
      </div>

      {/* Status */}
      <div style={{ minHeight: 48 }}>
        {loginState.phase === "idle" && (
          <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
            {provider.authenticated ? t("modelsConfig.alreadyConnected") : t("modelsConfig.connectAccount", { name: provider.name })}
          </p>
        )}
        {loginState.phase === "connecting" && (
          <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>{t("modelsConfig.openingBrowser")}</p>
        )}
        {loginState.phase === "select" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
              {loginState.message}
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {loginState.options.map((option) => (
                <button
                  key={option.id}
                  onClick={() => submitSelection(loginState.token, option.id)}
                  style={{ padding: "6px 9px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 5, color: "var(--text)", cursor: "pointer", fontSize: 12, textAlign: "left" }}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        )}
        {(loginState.phase === "auth" || loginState.phase === "prompt") && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
              {loginState.phase === "auth"
                ? t("modelsConfig.completeSignIn")
                : loginState.message}
            </p>
            {loginState.phase === "auth" && loginState.instructions && (
              <p style={{ margin: 0, fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5 }}>{loginState.instructions}</p>
            )}
            {loginState.phase === "auth" && (
              <p style={{ margin: 0, fontSize: 11, color: "var(--text-dim)", lineHeight: 1.5 }}>
                <a href={loginState.url} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)", wordBreak: "break-all" }}>
                  {t("modelsConfig.browserNotOpened")}
                </a>
              </p>
            )}
            <div style={{ display: "flex", gap: 6 }}>
              <input
                ref={inputRef}
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") submitCode(loginState.token, inputValue, loginState.phase === "prompt"); }}
                placeholder={loginState.phase === "auth" ? t("modelsConfig.pasteCodeOrUrl") : (loginState.placeholder ?? t("modelsConfig.enterValue"))}
                style={{ flex: 1, padding: "6px 9px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 5, color: "var(--text)", fontSize: 12, outline: "none", fontFamily: "var(--font-mono)", boxSizing: "border-box" }}
              />
              <button
                onClick={() => submitCode(loginState.token, inputValue, loginState.phase === "prompt")}
                disabled={!inputValue.trim() && loginState.phase !== "prompt"}
                style={{ padding: "6px 12px", background: inputValue.trim() || loginState.phase === "prompt" ? "var(--accent)" : "var(--bg-panel)", border: "none", borderRadius: 5, color: inputValue.trim() || loginState.phase === "prompt" ? "var(--on-accent)" : "var(--text-dim)", cursor: inputValue.trim() || loginState.phase === "prompt" ? "pointer" : "not-allowed", fontSize: 12, fontWeight: 600, flexShrink: 0 }}
              >
                {t("modelsConfig.submit")}
              </button>
            </div>
          </div>
        )}
        {loginState.phase === "device_code" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
              {t("modelsConfig.deviceCodeInstructions")}
            </p>
            <div style={{ padding: "8px 10px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 5, color: "var(--text)", fontSize: 16, fontWeight: 700, fontFamily: "var(--font-mono)", letterSpacing: 0, wordBreak: "break-all" }}>
              {loginState.userCode}
            </div>
            <p style={{ margin: 0, fontSize: 11, color: "var(--text-dim)", lineHeight: 1.5 }}>
              <a href={loginState.verificationUri} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)", wordBreak: "break-all" }}>
                {loginState.verificationUri}
              </a>
              {loginState.expiresInSeconds ? " " + tn("modelsConfig.expiresInMinutes", Math.ceil(loginState.expiresInSeconds / 60)) : ""}
            </p>
          </div>
        )}
        {loginState.phase === "progress" && (
          <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>{loginState.message}</p>
        )}
        {loginState.phase === "success" && (
          <p style={{ margin: 0, fontSize: 12, color: "var(--status-success)" }}>{t("modelsConfig.connectedSuccessfully")}</p>
        )}
        {loginState.phase === "error" && (
          <p style={{ margin: 0, fontSize: 12, color: "var(--status-error)" }}>{loginState.message}</p>
        )}
      </div>

      {/* Actions */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {isWorking ? (
          <button
            onClick={() => { eventSourceRef.current?.close(); setLoginState({ phase: "idle" }); }}
            style={{ padding: "5px 12px", background: "none", border: "1px solid var(--border)", borderRadius: 5, color: "var(--text-muted)", cursor: "pointer", fontSize: 12 }}
          >
            {t("modelsConfig.cancel")}
          </button>
        ) : (
          <>
            <button
              onClick={handleLogin}
              style={{ padding: "5px 14px", background: "var(--accent)", border: "none", borderRadius: 5, color: "var(--on-accent)", cursor: "pointer", fontSize: 12, fontWeight: 600 }}
            >
              {provider.authenticated ? t("modelsConfig.relogin") : t("modelsConfig.login")}
            </button>
            {provider.authenticated && provider.canLogout && (
              <button
                onClick={handleLogout}
                style={{ padding: "5px 12px", background: "none", border: "1px solid color-mix(in srgb, var(--status-error) 30%, transparent)", borderRadius: 5, color: "var(--status-error)", cursor: "pointer", fontSize: 12 }}
              >
                {t("modelsConfig.disconnect")}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
