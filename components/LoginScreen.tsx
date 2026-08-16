"use client";

import { AlertCircle, Eye, EyeOff, Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n";

/**
 * The sign-in surface: full-screen, theme-native, wordmark up top. Three modes
 * share one card — sign in, self-service signup, and first-run setup (no
 * accounts exist yet, the account being created becomes the administrator).
 * The mode comes from /api/accounts/state, the only unauthenticated data
 * source in the app.
 */

interface AccountState {
  authRequired: boolean;
  firstRun: boolean;
  signupAllowed: boolean;
  user: { id: string; username: string } | null;
}

type Mode = "signin" | "signup" | "firstRun";

/** Only same-origin path targets — a `next` like `//evil.example` must not
 * become a post-login redirect. */
function safeNextTarget(raw: string | null): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  return raw;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="login-field">
      <span className="login-label">{label}</span>
      {children}
    </label>
  );
}

function PasswordInput({ id, value, onChange, placeholder, autoComplete, showLabel, hideLabel }: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  autoComplete: string;
  showLabel: string;
  hideLabel: string;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <span style={{ position: "relative", display: "block" }}>
      <input
        id={id}
        className="login-input"
        type={visible ? "text" : "password"}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
        required
        style={{ paddingRight: 40 }}
      />
      <button
        type="button"
        className="login-reveal"
        onClick={() => setVisible((current) => !current)}
        aria-label={visible ? hideLabel : showLabel}
        title={visible ? hideLabel : showLabel}
      >
        {visible ? <EyeOff size={15} aria-hidden /> : <Eye size={15} aria-hidden />}
      </button>
    </span>
  );
}

export function LoginScreen() {
  const { t } = useI18n();
  const [state, setState] = useState<AccountState | null>(null);
  const [mode, setMode] = useState<Mode>("signin");
  const [username, setUsername] = useState("");
  const [fullName, setFullName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const usernameRef = useRef<HTMLInputElement>(null);

  const next = useMemo(
    () => safeNextTarget(typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("next") : null),
    [],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/accounts/state", { cache: "no-store" });
        const data = (await response.json()) as AccountState;
        if (cancelled) return;
        if (data.user) {
          // Already signed in — nothing to do on this screen.
          window.location.replace(next);
          return;
        }
        setState(data);
        setMode(data.firstRun ? "firstRun" : "signin");
      } catch {
        if (!cancelled) setState({ authRequired: true, firstRun: false, signupAllowed: false, user: null });
      }
    })();
    return () => { cancelled = true; };
  }, [next]);

  // Refocus the identity field whenever the card switches shape.
  useEffect(() => {
    usernameRef.current?.focus();
  }, [mode, state]);

  const submit = useCallback(async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setError(null);
    const creating = mode !== "signin";
    if (creating && password !== confirm) {
      setError(t("login.passwordMismatch"));
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(creating ? "/api/accounts/signup" : "/api/accounts/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(creating ? { username, fullName, password } : { username, password }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string; code?: string } | null;
        setError(body?.code === "bad_credentials" ? t("login.badCredentials") : body?.error || t("login.genericError"));
        setBusy(false);
        return;
      }
      window.location.replace(next);
    } catch {
      setError(t("login.genericError"));
      setBusy(false);
    }
  }, [busy, mode, username, fullName, password, confirm, next, t]);

  const creating = mode !== "signin";
  const heading =
    mode === "firstRun" ? t("login.firstRunTitle")
    : mode === "signup" ? t("login.signupTitle")
    : t("login.signinTitle");
  const subheading =
    mode === "firstRun" ? t("login.firstRunSubtitle")
    : mode === "signup" ? t("login.signupSubtitle")
    : t("login.signinSubtitle");

  return (
    <div className="login-page">
      <div className="login-column">
        <div className="login-brand">
          <div className="login-wordmark" aria-label="Cody">
            <span style={{ color: "var(--accent)" }}>co</span>
            <span style={{ color: "var(--text)" }}>dy</span>
            <span className="login-caret" aria-hidden />
          </div>
        </div>

        <form className="login-card" onSubmit={submit} aria-busy={busy || state === null}>
          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            <span style={{ fontSize: 16, fontWeight: 650, color: "var(--text)", fontFamily: "var(--font-serif)" }}>{heading}</span>
            <span style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>{subheading}</span>
          </div>

          {error && (
            <div className="login-error" role="alert">
              <AlertCircle size={14} aria-hidden style={{ flexShrink: 0, marginTop: 1 }} />
              <span>{error}</span>
            </div>
          )}

          {creating && (
            <Field label={t("login.fullName")}>
              <input
                className="login-input"
                value={fullName}
                onChange={(event) => setFullName(event.target.value)}
                autoComplete="name"
                placeholder={t("login.fullNamePlaceholder")}
              />
            </Field>
          )}

          <Field label={t("login.username")}>
            <input
              ref={usernameRef}
              className="login-input"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              required
            />
          </Field>

          <Field label={t("login.password")}>
            <PasswordInput
              id="login-password"
              value={password}
              onChange={setPassword}
              autoComplete={creating ? "new-password" : "current-password"}
              showLabel={t("login.showPassword")}
              hideLabel={t("login.hidePassword")}
            />
          </Field>

          {creating && (
            <Field label={t("login.confirmPassword")}>
              <PasswordInput
                id="login-confirm"
                value={confirm}
                onChange={setConfirm}
                autoComplete="new-password"
                showLabel={t("login.showPassword")}
                hideLabel={t("login.hidePassword")}
              />
            </Field>
          )}

          <button type="submit" className="login-primary" disabled={busy || state === null}>
            {busy && <Loader2 size={15} aria-hidden style={{ animation: "spin 0.9s linear infinite" }} />}
            {creating ? t("login.createAccount") : t("login.signIn")}
          </button>

          {mode === "signin" && state?.signupAllowed && (
            <>
              <div className="login-divider">{t("login.or")}</div>
              <button type="button" className="login-ghost" onClick={() => { setError(null); setMode("signup"); }}>
                {t("login.createAccount")}
              </button>
            </>
          )}
          {mode === "signup" && (
            <button type="button" className="login-ghost" onClick={() => { setError(null); setMode("signin"); }}>
              {t("login.backToSignIn")}
            </button>
          )}
        </form>

        <div className="login-footer">Cody v{process.env.NEXT_PUBLIC_CODY_VERSION ?? "0.0.0"}</div>
      </div>
    </div>
  );
}
