"use client";

import { Check, Copy, KeyRound, Loader2, Plus, ShieldAlert, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { NativeSetting, nativeInputStyle } from "./primitives";
import { ApiError, ErrorNote, dangerButtonStyle, primaryButtonStyle, requestJson, smallButtonStyle } from "./account-controls";
import { ConfirmDialog } from "@/components/ui/field";
import { toast } from "@/components/ui/toast";
import { useCopyFeedback } from "@/hooks/useCopyFeedback";

/**
 * Personal access tokens for the signed-in account: the credential a native
 * client (the Cody Android app) carries instead of a password.
 *
 * Three facts from the server shape this UI, and none of them are footnotes:
 * the secret exists exactly once, in the mint response, so the reveal has to be
 * loud and dismissing it has to read as destructive; `lastUsedAt` is written at
 * five-minute resolution, so the labels are deliberately coarse ("about an hour
 * ago") and say so; and a bearer credential is refused when it tries to mint, so
 * that 403 is explained rather than reported.
 */

/** Mirrors `PublicAccessToken` in lib/auth/tokens — metadata only, never a secret. */
interface AccessToken {
  id: string;
  name: string;
  preview: string;
  createdAt: string;
  lastUsedAt: string | null;
}

/** Matches MAX_TOKEN_NAME_LENGTH, so the field stops before the route refuses. */
const MAX_TOKEN_NAME_LENGTH = 60;

/**
 * Deliberately vague, because the server is: use is recorded once per five
 * minutes, so a minute-accurate label would be a lie about a value that can be
 * five minutes stale. Everything above ten minutes is hedged with "about".
 */
function describeLastUsed(value: string | null, now: number): string {
  if (!value) return "Never used";
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "Last used at an unknown time";
  const minutes = Math.max(0, Math.round((now - timestamp) / 60_000));
  if (minutes < 10) return "Used in the last few minutes";
  if (minutes < 60) return "Used within the last hour";
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours <= 1 ? "Last used about an hour ago" : `Last used about ${hours} hours ago`;
  const days = Math.round(hours / 24);
  return days <= 1 ? "Last used about a day ago" : `Last used about ${days} days ago`;
}

function formatCreated(value: string): string {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "Created at an unknown time";
  return `Created ${new Date(timestamp).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}`;
}

/**
 * The one-time reveal. Rendered in the error tone rather than the success tone
 * on purpose: the moment carries an obligation, and a green tick would suggest
 * the token is safely stored somewhere it is not.
 */
function SecretReveal({ name, secret, onDismiss }: { name: string; secret: string; onDismiss: () => void }) {
  const { copied, copy } = useCopyFeedback();
  return (
    <div
      role="alert"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: 12,
        border: "1px solid color-mix(in srgb, var(--status-warning) 55%, transparent)",
        borderRadius: "var(--radius-card)",
        background: "color-mix(in srgb, var(--status-warning) 12%, var(--bg-panel))",
      }}
    >
      <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 650, color: "var(--text)" }}>
        <ShieldAlert size={14} aria-hidden style={{ color: "var(--status-warning)", flexShrink: 0 }} />
        Copy this token now — it is shown only once
      </span>
      <span style={{ fontSize: 11.5, lineHeight: 1.5, color: "var(--text-muted)" }}>
        Only a hash of “{name}” is stored, so Cody cannot show it again. If you close this without saving it, the token is
        lost for good and you will have to revoke it and create another.
      </span>
      <code
        style={{
          padding: "8px 10px",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-control)",
          background: "var(--bg)",
          color: "var(--text)",
          fontFamily: "var(--font-mono)",
          fontSize: 11.5,
          lineHeight: 1.5,
          wordBreak: "break-all",
          userSelect: "all",
        }}
      >
        {secret}
      </code>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <button type="button" onClick={() => copy(secret)} style={primaryButtonStyle}>
          {copied ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
          {copied ? "Copied" : "Copy token"}
        </button>
        <button type="button" onClick={onDismiss} style={smallButtonStyle}>
          I have saved it — hide the token
        </button>
      </div>
    </div>
  );
}

export function AccessTokensSection() {
  const [tokens, setTokens] = useState<AccessToken[] | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [loadError, setLoadError] = useState<string | null>(null);

  const [newName, setNewName] = useState("");
  const [minting, setMinting] = useState(false);
  /** Set once a mint is refused with 403 bearer_forbidden: the panel is being
   *  viewed through a token, which may list and revoke but never mint. */
  const [bearerBlocked, setBearerBlocked] = useState(false);
  const [issued, setIssued] = useState<{ name: string; secret: string } | null>(null);

  const [pendingRevoke, setPendingRevoke] = useState<AccessToken | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const reload = useCallback(() => {
    requestJson<{ tokens: AccessToken[] }>("/api/accounts/me/tokens")
      .then((data) => {
        setTokens(data.tokens);
        setNow(Date.now());
        setLoadError(null);
      })
      .catch((error: unknown) => setLoadError(error instanceof Error ? error.message : String(error)));
  }, []);

  useEffect(reload, [reload]);

  const mint = () => {
    const name = newName.trim();
    if (!name || minting) return;
    setMinting(true);
    requestJson<{ token: AccessToken; secret: string }>("/api/accounts/me/tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    })
      .then((data) => {
        setIssued({ name: data.token.name, secret: data.secret });
        setNewName("");
        setBearerBlocked(false);
        reload();
      })
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.code === "bearer_forbidden") {
          setBearerBlocked(true);
          return;
        }
        toast.error("Could not create the token", error instanceof Error ? error.message : String(error));
      })
      .finally(() => setMinting(false));
  };

  const revoke = (token: AccessToken) => {
    setRevokingId(token.id);
    requestJson<{ success: boolean }>(`/api/accounts/me/tokens/${token.id}`, { method: "DELETE" })
      .then(() => {
        setPendingRevoke(null);
        toast.success(`Revoked “${token.name}”`, "Any app using that token is signed out.");
        reload();
      })
      .catch((error: unknown) => {
        setPendingRevoke(null);
        toast.error("Could not revoke the token", error instanceof Error ? error.message : String(error));
        // The server is the authority on which tokens exist, and the most likely
        // failure is a 404 for a token something else already revoked. Leaving
        // the row on screen would offer a button that can only fail again.
        reload();
      })
      .finally(() => setRevokingId(null));
  };

  return (
    <>
      <NativeSetting
        label="Access tokens"
        description="A token signs a native client in without your password — paste one into the Cody Android app's onboarding screen. Each token carries this account's full access, is shown only once when you create it, and changing your password revokes all of them."
        scope="Cody only"
        control={
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {issued && <SecretReveal name={issued.name} secret={issued.secret} onDismiss={() => setIssued(null)} />}

            {bearerBlocked ? (
              <div role="alert" style={{ display: "flex", gap: 6, fontSize: 12, lineHeight: 1.5, color: "var(--status-warning)" }}>
                <ShieldAlert size={13} aria-hidden style={{ flexShrink: 0, marginTop: 2 }} />
                You are signed in with an access token, and a token cannot create another one. Sign in with your password to
                create a token. You can still see and revoke the tokens below.
              </div>
            ) : (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <input
                  value={newName}
                  onChange={(event) => setNewName(event.target.value)}
                  onKeyDown={(event) => { if (event.key === "Enter") mint(); }}
                  placeholder="Name this device — for example, Pixel tablet"
                  aria-label="New token name"
                  maxLength={MAX_TOKEN_NAME_LENGTH}
                  spellCheck={false}
                  style={{ ...nativeInputStyle, flex: 1, minWidth: 180 }}
                />
                <button
                  type="button"
                  onClick={mint}
                  disabled={minting || newName.trim() === ""}
                  style={{ ...primaryButtonStyle, opacity: minting || newName.trim() === "" ? 0.6 : 1 }}
                >
                  {minting ? <Loader2 size={13} aria-hidden style={{ animation: "spin 0.9s linear infinite" }} /> : <Plus size={13} aria-hidden />}
                  Create token
                </button>
              </div>
            )}

            <ErrorNote message={loadError} />

            {tokens !== null && tokens.length === 0 && !loadError && (
              <span style={{ fontSize: 11.5, lineHeight: 1.5, color: "var(--text-muted)" }}>
                No tokens yet. Create one to sign in a native client — such as the Cody Android app — without giving it your
                password.
              </span>
            )}

            {tokens !== null && tokens.length > 0 && (
              <>
                <div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-card)", background: "var(--bg)", overflow: "hidden" }}>
                  {tokens.map((token, index) => (
                    <div
                      key={token.id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        padding: "8px 12px",
                        borderTop: index === 0 ? "none" : "1px solid var(--border)",
                        flexWrap: "wrap",
                      }}
                    >
                      <KeyRound size={14} aria-hidden style={{ color: "var(--text-dim)", flexShrink: 0 }} />
                      <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0, flex: 1 }}>
                        <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {token.name}
                        </span>
                        <span style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
                          cody_pat_{token.preview}…
                        </span>
                        <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
                          {formatCreated(token.createdAt)} · {describeLastUsed(token.lastUsedAt, now)}
                        </span>
                      </div>
                      {revokingId === token.id && <Loader2 size={13} aria-hidden style={{ animation: "spin 0.9s linear infinite", color: "var(--text-dim)" }} />}
                      <button
                        type="button"
                        onClick={() => setPendingRevoke(token)}
                        disabled={revokingId === token.id}
                        aria-label={`Revoke ${token.name}`}
                        style={{ ...dangerButtonStyle, minHeight: 28, fontSize: 11.5 }}
                      >
                        <Trash2 size={12} aria-hidden /> Revoke
                      </button>
                    </div>
                  ))}
                </div>
                <span style={{ fontSize: 11, lineHeight: 1.5, color: "var(--text-dim)" }}>
                  Use is recorded about every five minutes, so “last used” is approximate. Only successful use counts, so a
                  token that a password change already revoked keeps the time it last worked — a device still trying with it
                  will not move that time.
                </span>
              </>
            )}

            {tokens === null && !loadError && (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "var(--text-muted)" }}>
                <Loader2 size={13} aria-hidden style={{ animation: "spin 0.9s linear infinite" }} /> Loading tokens…
              </span>
            )}
          </div>
        }
      />

      <ConfirmDialog
        open={pendingRevoke !== null}
        onOpenChange={(open) => { if (!open) setPendingRevoke(null); }}
        title={pendingRevoke ? `Revoke “${pendingRevoke.name}”?` : "Revoke token"}
        description="Any app signed in with this token stops working immediately — its next request fails and it will ask to be set up again. This cannot be undone; create a new token to sign that app back in."
        confirmLabel={revokingId ? "Revoking…" : "Revoke token"}
        danger
        busy={revokingId !== null}
        onConfirm={() => { if (pendingRevoke) revoke(pendingRevoke); }}
      />
    </>
  );
}
