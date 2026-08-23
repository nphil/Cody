"use client";

import { Check, Cpu, Download, Loader2, LogOut, ShieldCheck, Trash2, Upload, UserRoundPlus, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { chipStyle, nativeInputStyle, nativeOptionStyle, nativeSelectStyle, NativeSetting } from "./primitives";
import { dangerButtonStyle, ErrorNote, primaryButtonStyle, requestJson, smallButtonStyle, useAsyncAction } from "./account-controls";
import { AccessTokensSection } from "./AccessTokensSection";
import { ConfirmDialog } from "@/components/ui/field";
import { useEngineInstalls } from "@/hooks/useEngineInstalls";
import { useI18n } from "@/lib/i18n";
import type { EngineSummary, EnginesPayload } from "../EnginePicker";

/**
 * The User Accounts settings panel: the signed-in profile (name, picture,
 * password, sign out) plus, for administrators, the server's account roster
 * and self-service-signup status. Follows the settings-panel convention of
 * NativeSetting cards so search highlighting and theming come for free.
 */

interface PublicUser {
  id: string;
  username: string;
  fullName: string;
  role: "admin" | "member";
  envManaged: boolean;
  hasAvatar: boolean;
  avatarKey: string | null;
  createdAt: string;
}

interface AccountStateInfo {
  authRequired: boolean;
  firstRun: boolean;
  signupAllowed: boolean;
  user: PublicUser | null;
}

const AVATAR_TARGET_PX = 256;

function avatarUrl(user: PublicUser): string | null {
  return user.hasAvatar ? `/api/accounts/avatar/${user.id}?v=${user.avatarKey ?? ""}` : null;
}

function initials(user: PublicUser): string {
  const parts = user.fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return user.username.slice(0, 2).toUpperCase();
  return parts.slice(0, 2).map((part) => part[0]!.toUpperCase()).join("");
}

/** Center-crop to a square and downscale before upload, so the server stores
 * small images without needing an image library. */
async function downscaleImage(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  try {
    const side = Math.min(bitmap.width, bitmap.height);
    const target = Math.min(AVATAR_TARGET_PX, side);
    const canvas = document.createElement("canvas");
    canvas.width = target;
    canvas.height = target;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas unavailable");
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, target, target);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", 0.9));
    if (!blob) throw new Error("Could not encode image");
    return blob;
  } finally {
    bitmap.close();
  }
}

function Avatar({ user, size }: { user: PublicUser; size: number }) {
  const url = avatarUrl(user);
  const fontSize = Math.round(size * 0.36);
  return url ? (
    // eslint-disable-next-line @next/next/no-img-element -- same-origin API image; next/image adds nothing here
    <img src={url} alt="" width={size} height={size} style={{ width: size, height: size, borderRadius: "50%", objectFit: "cover", border: "1px solid var(--border)", flexShrink: 0 }} />
  ) : (
    <span aria-hidden style={{ width: size, height: size, borderRadius: "50%", background: "color-mix(in srgb, var(--accent) 18%, var(--bg))", color: "var(--accent)", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize, fontWeight: 650, letterSpacing: "0.02em", flexShrink: 0, userSelect: "none" }}>
      {initials(user)}
    </span>
  );
}

/**
 * Agent engine card: the same choice the onboarding picker offers, kept
 * reachable for the administrator afterwards. Admin-only (the roster route it
 * mirrors is). It installs missing engines and switches the active one;
 * update checks and update actions live in Settings › System & Updates.
 */
function AgentEngineSection({ isMobile }: { isMobile: boolean }) {
  const { t } = useI18n();
  const [data, setData] = useState<EnginesPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selecting, setSelecting] = useState<string | null>(null);
  const [pendingUninstall, setPendingUninstall] = useState<EngineSummary | null>(null);
  const [uninstalling, setUninstalling] = useState<string | null>(null);
  /** Post-uninstall honesty line ("a system copy on PATH remains"). */
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch("/api/engines", { cache: "no-store", signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    setData((await response.json()) as EnginesPayload);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal).catch((failure: unknown) => {
      if (controller.signal.aborted) return;
      setError(failure instanceof Error ? failure.message : String(failure));
    });
    return () => controller.abort();
  }, [load]);

  const post = useCallback(async (path: string, id: string) => {
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    const body = (await response.json().catch(() => null)) as { error?: string; detail?: string } | null;
    if (!response.ok) {
      throw new Error([body?.error, body?.detail].filter(Boolean).join(" — ") || `HTTP ${response.status}`);
    }
  }, []);

  const onInstallSettled = useCallback((_id: string, ok: boolean) => {
    if (ok) void load().catch(() => {});
  }, [load]);
  const {
    installing: installingIds,
    progress: installProgress,
    errors: installErrors,
    start: startInstall,
    watch: watchInstall,
  } = useEngineInstalls(onInstallSettled);

  // Reattach to installs already running server-side (page reload, the
  // onboarding picker, another admin) so the row shows live progress.
  useEffect(() => {
    for (const engine of data?.engines ?? []) {
      if (engine.installing) watchInstall(engine.id);
    }
  }, [data, watchInstall]);

  const select = (engine: EngineSummary) => {
    setError(null);
    setSelecting(engine.id);
    void post("/api/engines/select", engine.id)
      // Everything the page loaded came from the old engine — capabilities,
      // model lists, live sessions. Reload rather than reconcile.
      //
      // assign("/") rather than reload(): a reload keeps the query string, and
      // `?session=<id>` names a session of the OLD engine. The sidebar's
      // restore then hunts for an id that is not in the new engine's list,
      // retrying for eight seconds behind a blank loading pane before giving
      // up — and because the id stays in the address bar, every later refresh
      // of that URL stalls the same way. A session id is engine-scoped state,
      // exactly like ENGINE_SCOPED_KEYS.
      .then(() => window.location.assign("/"))
      .catch((failure: unknown) => {
        setError(failure instanceof Error ? failure.message : String(failure));
        setSelecting(null);
      });
  };

  const uninstall = (engine: EngineSummary) => {
    setError(null);
    setNote(null);
    setUninstalling(engine.id);
    void (async () => {
      const response = await fetch("/api/engines/install", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: engine.id }),
      });
      const body = (await response.json().catch(() => null)) as { error?: string; detail?: string; remainingBinary?: string | null } | null;
      if (!response.ok) {
        throw new Error([body?.error, body?.detail].filter(Boolean).join(" — ") || `HTTP ${response.status}`);
      }
      return body;
    })()
      .then((body) => {
        setPendingUninstall(null);
        // Removal from Cody's prefix cannot touch a system install; say so
        // rather than letting the still-"Installed" row look like a failure.
        if (body?.remainingBinary) {
          setNote(`${engine.name} was removed from Cody's tools directory, but a system copy remains at ${body.remainingBinary}.`);
        }
        return load();
      })
      .catch((failure: unknown) => {
        setError(failure instanceof Error ? failure.message : String(failure));
      })
      .finally(() => setUninstalling(null));
  };

  if (!data && !error) {
    return (
      <section style={{ padding: 14, border: "1px solid var(--border)", borderRadius: "var(--radius-card)", background: "var(--bg-panel)", color: "var(--text-muted)", fontSize: 12 }}>
        <Loader2 size={13} aria-hidden style={{ animation: "spin 0.9s linear infinite", marginRight: 8, verticalAlign: "-2px" }} />
        Loading engines…
      </section>
    );
  }

  const engines = data?.engines ?? [];
  const active = engines.find((engine) => engine.id === data?.active) ?? null;
  // Only a selection blocks the card (it reloads the page). Installs are
  // per-engine so the other rows stay usable while npm runs.
  const busy = selecting !== null;

  return (
    <>
      <div style={{ marginTop: 4 }}>
        <h3 style={{ fontSize: 13, fontWeight: 600, margin: 0, display: "flex", alignItems: "center", gap: 6 }}>
          <Cpu size={14} aria-hidden style={{ color: "var(--accent)" }} /> Agent engine
        </h3>
        <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--text-muted)", lineHeight: 1.55 }}>
          The coding agent behind every session on this server.
          {active ? ` Currently ${active.name}${active.version ? ` (v${active.version})` : ""}.` : ""}
          {" "}Switching restarts running agent sessions and reloads this page. Experimental engines run with file
          edits auto-accepted inside your workspace.
        </p>
      </div>

      <ErrorNote message={error} />

      <section style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-card)", background: "var(--bg-panel)", overflow: "hidden" }}>
        {engines.map((engine, index) => {
          const isActive = engine.id === data?.active;
          const installBusy = installingIds.has(engine.id);
          const installError = installErrors[engine.id];
          return (
            <div
              key={engine.id}
              style={{
                display: "flex",
                alignItems: isMobile ? "stretch" : "flex-start",
                flexDirection: isMobile ? "column" : "row",
                gap: 10,
                padding: "12px 14px",
                borderTop: index === 0 ? "none" : "1px solid var(--border)",
                background: isActive ? "color-mix(in srgb, var(--accent) 6%, transparent)" : "transparent",
              }}
            >
              <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0, flex: 1 }}>
                <span style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)" }}>{engine.name}</span>
                  {isActive && <span style={{ ...chipStyle, color: "var(--accent)" }}>Active</span>}
                  {engine.experimental
                    ? <span style={{ ...chipStyle, color: "var(--status-warning)" }}>Experimental</span>
                    : <span style={chipStyle}>Recommended</span>}
                  <span style={{ ...chipStyle, fontFamily: "var(--font-mono)" }}>
                    {engine.installed ? (engine.version ? `v${engine.version}` : "Installed") : "Not installed"}
                  </span>
                </span>
                <span style={{ fontSize: 11.5, color: "var(--text-muted)", lineHeight: 1.5 }}>{engine.tagline}</span>
                {engine.authHint && (
                  <span style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.5 }}>{engine.authHint}</span>
                )}
                {!engine.installed && !engine.installable && (
                  <span style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.5 }}>
                    Install the {engine.binaryName} CLI on the host to use this engine.
                  </span>
                )}
                {installBusy && (
                  <span role="status" aria-live="polite" style={{ display: "flex", flexDirection: "column", gap: 5, marginTop: 2 }}>
                    <span aria-hidden style={{ display: "block", height: 3, borderRadius: 2, overflow: "hidden", background: "var(--bg-subtle)" }}>
                      <span style={{ display: "block", height: "100%", width: "40%", borderRadius: 2, background: "var(--accent)", animation: "engine-progress-slide 1.2s ease-in-out infinite" }} />
                    </span>
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--text-dim)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {installProgress[engine.id] || "Installing…"}
                    </span>
                  </span>
                )}
                {installError && <ErrorNote message={installError} />}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                {!engine.installed && engine.installable && (
                  <button type="button" onClick={() => startInstall(engine.id)} disabled={busy || installBusy} style={{ ...smallButtonStyle, opacity: busy || installBusy ? 0.6 : 1 }}>
                    {installBusy
                      ? <Loader2 size={13} aria-hidden style={{ animation: "spin 0.9s linear infinite" }} />
                      : <Download size={13} aria-hidden />}
                    {installBusy ? "Installing…" : "Install"}
                  </button>
                )}
                {engine.installed && !isActive && (
                  <button type="button" onClick={() => select(engine)} disabled={busy} style={{ ...primaryButtonStyle, opacity: busy ? 0.6 : 1 }}>
                    {selecting === engine.id && <Loader2 size={13} aria-hidden style={{ animation: "spin 0.9s linear infinite" }} />}
                    {selecting === engine.id ? "Switching…" : `Use ${engine.shortName}`}
                  </button>
                )}
                {engine.installed && engine.managed && !isActive && (
                  <button
                    type="button"
                    onClick={() => setPendingUninstall(engine)}
                    disabled={busy || installBusy || uninstalling !== null}
                    style={{ ...dangerButtonStyle, opacity: busy || installBusy || uninstalling !== null ? 0.6 : 1 }}
                  >
                    {uninstalling === engine.id
                      ? <Loader2 size={13} aria-hidden style={{ animation: "spin 0.9s linear infinite" }} />
                      : <Trash2 size={13} aria-hidden />}
                    {uninstalling === engine.id ? "Uninstalling…" : "Uninstall"}
                  </button>
                )}
                {isActive && (
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 5, color: "var(--accent)", fontSize: 11.5, fontWeight: 600 }}>
                    <Check size={13} aria-hidden /> In use
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </section>

      {note && (
        <p role="status" style={{ margin: 0, fontSize: 11.5, color: "var(--text-muted)", lineHeight: 1.5 }}>
          {note}
        </p>
      )}

      <p style={{ margin: 0, fontSize: 11, color: "var(--text-dim)", lineHeight: 1.5 }}>
        {t("updates.engines.settingsPointer")}
      </p>

      <ConfirmDialog
        open={pendingUninstall !== null}
        onOpenChange={(open) => { if (!open) setPendingUninstall(null); }}
        title={pendingUninstall ? `Uninstall ${pendingUninstall.name}?` : "Uninstall engine"}
        description="Removes the engine from Cody's tools directory. Sessions already recorded stay on disk and the engine can be reinstalled from this card at any time. Its own sign-in state and configuration are not touched."
        confirmLabel={uninstalling ? "Uninstalling…" : "Uninstall engine"}
        danger
        busy={uninstalling !== null}
        onConfirm={() => { if (pendingUninstall) uninstall(pendingUninstall); }}
      />
    </>
  );
}

export function AccountSettings({ isMobile }: { isMobile: boolean }) {
  const [me, setMe] = useState<PublicUser | null>(null);
  const [stateInfo, setStateInfo] = useState<AccountStateInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [fullName, setFullName] = useState("");
  const [nameSaved, setNameSaved] = useState(false);
  const [nameBusy, nameError, runName] = useAsyncAction();

  const [avatarBusy, avatarError, runAvatar] = useAsyncAction();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordDone, setPasswordDone] = useState(false);
  const [passwordBusy, passwordError, runPassword, setPasswordError] = useAsyncAction();

  const [users, setUsers] = useState<PublicUser[] | null>(null);
  const [rosterError, setRosterError] = useState<string | null>(null);
  const [rosterBusy, setRosterBusy] = useState<string | null>(null);

  const [showAddForm, setShowAddForm] = useState(false);
  const [addUsername, setAddUsername] = useState("");
  const [addFullName, setAddFullName] = useState("");
  const [addPassword, setAddPassword] = useState("");
  const [addRole, setAddRole] = useState<"member" | "admin">("member");
  const [addBusy, addError, runAdd, setAddError] = useAsyncAction();

  const isAdmin = me?.role === "admin";

  const reloadRoster = useCallback(() => {
    requestJson<{ users: PublicUser[] }>("/api/accounts/users")
      .then((data) => { setUsers(data.users); setRosterError(null); })
      .catch((error: unknown) => setRosterError(error instanceof Error ? error.message : String(error)));
  }, []);

  useEffect(() => {
    let cancelled = false;
    requestJson<AccountStateInfo>("/api/accounts/state")
      .then((data) => {
        if (cancelled) return;
        setStateInfo(data);
        setMe(data.user);
        if (data.user) setFullName(data.user.fullName);
      })
      .catch((error: unknown) => { if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error)); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (isAdmin) reloadRoster();
  }, [isAdmin, reloadRoster]);

  const saveName = () => runName(async () => {
    const data = await requestJson<{ user: PublicUser }>("/api/accounts/me", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fullName }),
    });
    setMe(data.user);
    setFullName(data.user.fullName);
    setNameSaved(true);
    setTimeout(() => setNameSaved(false), 1800);
  });

  const uploadAvatar = (file: File) => runAvatar(async () => {
    const blob = await downscaleImage(file);
    const form = new FormData();
    form.append("avatar", blob, "avatar.webp");
    const data = await requestJson<{ user: PublicUser }>("/api/accounts/me/avatar", { method: "POST", body: form });
    setMe(data.user);
    if (isAdmin) reloadRoster();
  });

  const removeAvatar = () => runAvatar(async () => {
    const data = await requestJson<{ user: PublicUser }>("/api/accounts/me/avatar", { method: "DELETE" });
    setMe(data.user);
    if (isAdmin) reloadRoster();
  });

  const changePassword = () => {
    if (newPassword !== confirmPassword) {
      setPasswordError("New passwords do not match");
      return;
    }
    runPassword(async () => {
      await requestJson<{ success: boolean }>("/api/accounts/me/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setPasswordDone(true);
      setTimeout(() => setPasswordDone(false), 2500);
    });
  };

  const signOut = () => {
    void fetch("/api/accounts/logout", { method: "POST" }).finally(() => window.location.replace("/login"));
  };

  const changeRole = (target: PublicUser, role: "admin" | "member") => {
    setRosterBusy(target.id);
    requestJson<{ user: PublicUser }>(`/api/accounts/users/${target.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role }),
    })
      .then(() => { setRosterError(null); reloadRoster(); })
      .catch((error: unknown) => setRosterError(error instanceof Error ? error.message : String(error)))
      .finally(() => setRosterBusy(null));
  };

  const resetPassword = (target: PublicUser) => {
    const next = window.prompt(`New password for @${target.username} (at least 8 characters):`);
    if (next === null) return;
    setRosterBusy(target.id);
    requestJson<{ user: PublicUser }>(`/api/accounts/users/${target.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: next }),
    })
      .then(() => setRosterError(null))
      .catch((error: unknown) => setRosterError(error instanceof Error ? error.message : String(error)))
      .finally(() => setRosterBusy(null));
  };

  const removeUser = (target: PublicUser) => {
    if (!window.confirm(`Delete the account @${target.username}? Their sessions remain on disk but lose their owner.`)) return;
    setRosterBusy(target.id);
    requestJson<{ success: boolean }>(`/api/accounts/users/${target.id}`, { method: "DELETE" })
      .then(() => { setRosterError(null); reloadRoster(); })
      .catch((error: unknown) => setRosterError(error instanceof Error ? error.message : String(error)))
      .finally(() => setRosterBusy(null));
  };

  const addUser = () => runAdd(async () => {
    await requestJson<{ user: PublicUser }>("/api/accounts/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: addUsername, fullName: addFullName, password: addPassword, role: addRole }),
    });
    setAddUsername("");
    setAddFullName("");
    setAddPassword("");
    setAddRole("member");
    setShowAddForm(false);
    reloadRoster();
  });

  if (loadError) {
    return (
      <div role="tabpanel" id="settings-panel-accounts" aria-labelledby="settings-tab-accounts" style={{ padding: 20 }}>
        <ErrorNote message={loadError} />
      </div>
    );
  }

  // An open instance (no accounts, no password): explain and point at the
  // first-run flow instead of rendering an empty profile.
  if (stateInfo && !me) {
    return (
      <div role="tabpanel" id="settings-panel-accounts" aria-labelledby="settings-tab-accounts" style={{ padding: 20, display: "flex", flexDirection: "column", gap: 16 }}>
        <div>
          <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>User Accounts</h3>
          <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--text-muted)" }}>No accounts exist on this server yet, and it is running without authentication.</p>
        </div>
        <section style={{ padding: 16, border: "1px solid var(--border)", borderRadius: "var(--radius-card)", background: "var(--bg-panel)", display: "flex", flexDirection: "column", gap: 10, alignItems: "flex-start" }}>
          <span style={{ fontSize: 12.5, color: "var(--text)", lineHeight: 1.5 }}>
            Create the first account to turn sign-in on. The first account becomes the administrator, and every visitor after that will need to sign in.
          </span>
          <a href="/login" style={{ ...primaryButtonStyle, textDecoration: "none" }}>
            <UserRoundPlus size={14} aria-hidden /> Create the first account
          </a>
        </section>
      </div>
    );
  }

  if (!me) {
    return (
      <div role="status" style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 12, padding: 40 }}>
        <Loader2 size={14} aria-hidden style={{ animation: "spin 0.9s linear infinite", marginRight: 8 }} /> Loading account…
      </div>
    );
  }

  return (
    <div role="tabpanel" id="settings-panel-accounts" aria-labelledby="settings-tab-accounts" style={{ padding: 20, display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>User Accounts</h3>
        <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--text-muted)" }}>Your profile and sign-in security{isAdmin ? ", plus the accounts that can use this server" : ""}.</p>
      </div>

      {/* Identity header */}
      <section style={{ padding: 16, border: "1px solid var(--border)", borderRadius: "var(--radius-card)", background: "var(--bg-panel)", display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
        <Avatar user={me} size={56} />
        <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0, flex: 1 }}>
          <span style={{ fontSize: 14.5, fontWeight: 650, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{me.fullName}</span>
          <span style={{ fontSize: 12, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>@{me.username}</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {me.role === "admin" && <span style={{ ...chipStyle, display: "inline-flex", alignItems: "center", gap: 4 }}><ShieldCheck size={11} aria-hidden /> Admin</span>}
          {me.envManaged && <span style={chipStyle}>Managed by Docker</span>}
        </div>
        <button type="button" onClick={signOut} style={smallButtonStyle}>
          <LogOut size={13} aria-hidden /> Sign out
        </button>
      </section>

      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "repeat(2, minmax(0, 1fr))", gap: 10 }}>
        <NativeSetting
          label="Full name"
          description="Shown on your profile and, for administrators, in the account roster."
          scope="Cody only"
          control={
            <div style={{ display: "flex", gap: 8 }}>
              <input
                value={fullName}
                onChange={(event) => setFullName(event.target.value)}
                maxLength={80}
                style={{ ...nativeInputStyle, flex: 1, minWidth: 0 }}
              />
              <button type="button" onClick={saveName} disabled={nameBusy || fullName.trim() === "" || fullName === me.fullName} style={{ ...primaryButtonStyle, opacity: nameBusy || fullName.trim() === "" || fullName === me.fullName ? 0.6 : 1 }}>
                {nameBusy ? <Loader2 size={13} aria-hidden style={{ animation: "spin 0.9s linear infinite" }} /> : nameSaved ? <Check size={13} aria-hidden /> : null}
                Save
              </button>
            </div>
          }
        >
          {nameError ? <ErrorNote message={nameError} /> : undefined}
        </NativeSetting>

        <NativeSetting
          label="Profile picture"
          description="PNG, JPEG or WebP. Cropped square and downscaled in your browser before upload."
          scope="Cody only"
          control={
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <Avatar user={me} size={40} />
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                style={{ display: "none" }}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file) uploadAvatar(file);
                }}
              />
              <button type="button" onClick={() => fileInputRef.current?.click()} disabled={avatarBusy} style={smallButtonStyle}>
                {avatarBusy ? <Loader2 size={13} aria-hidden style={{ animation: "spin 0.9s linear infinite" }} /> : <Upload size={13} aria-hidden />} Upload
              </button>
              {me.hasAvatar && (
                <button type="button" onClick={removeAvatar} disabled={avatarBusy} style={smallButtonStyle}>
                  <X size={13} aria-hidden /> Remove
                </button>
              )}
              <ErrorNote message={avatarError} />
            </div>
          }
        />
      </div>

      <NativeSetting
        label="Change password"
        description={me.envManaged
          ? "This account signs in with the CODY_PASSWORD environment variable. Change it in your container settings — for example the Unraid template — and restart."
          : "Changing your password signs out your other devices and revokes this account's access tokens — apps signed in with a token will need a new one."}
        control={me.envManaged ? undefined : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 420 }}>
            <input type="password" placeholder="Current password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} style={nativeInputStyle} />
            <input type="password" placeholder="New password (at least 8 characters)" autoComplete="new-password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} style={nativeInputStyle} />
            <input type="password" placeholder="Repeat new password" autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} style={nativeInputStyle} />
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <button
                type="button"
                onClick={changePassword}
                disabled={passwordBusy || !currentPassword || !newPassword || !confirmPassword}
                style={{ ...primaryButtonStyle, opacity: passwordBusy || !currentPassword || !newPassword || !confirmPassword ? 0.6 : 1 }}
              >
                {passwordBusy && <Loader2 size={13} aria-hidden style={{ animation: "spin 0.9s linear infinite" }} />}
                Update password
              </button>
              {passwordDone && <span style={{ display: "inline-flex", alignItems: "center", gap: 5, color: "var(--status-success)", fontSize: 12 }}><Check size={13} aria-hidden /> Password updated</span>}
            </div>
            <ErrorNote message={passwordError} />
          </div>
        )}
      />

      <AccessTokensSection />

      {isAdmin && (
        <>
          <div style={{ marginTop: 4 }}>
            <h3 style={{ fontSize: 13, fontWeight: 600, margin: 0 }}>Accounts on this server</h3>
            <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--text-muted)" }}>
              {stateInfo?.signupAllowed
                ? "Anyone who can reach the login screen may create an account. Set CODY_ALLOW_SIGNUP=0 to restrict account creation to administrators."
                : "Self-service signup is disabled (CODY_ALLOW_SIGNUP=0); only administrators can create accounts here."}
            </p>
          </div>

          <section style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-card)", background: "var(--bg-panel)", overflow: "hidden" }}>
            {(users ?? []).map((user, index) => (
              <div key={user.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", borderTop: index === 0 ? "none" : "1px solid var(--border)", flexWrap: "wrap" }}>
                <Avatar user={user} size={32} />
                <div style={{ display: "flex", flexDirection: "column", minWidth: 0, flex: 1 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {user.fullName}
                    {user.id === me.id && <span style={{ color: "var(--text-dim)", fontWeight: 400 }}> (you)</span>}
                  </span>
                  <span style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>@{user.username}</span>
                </div>
                {user.envManaged && <span style={chipStyle}>Managed by Docker</span>}
                {rosterBusy === user.id && <Loader2 size={13} aria-hidden style={{ animation: "spin 0.9s linear infinite", color: "var(--text-dim)" }} />}
                <select
                  value={user.role}
                  onChange={(event) => changeRole(user, event.target.value as "admin" | "member")}
                  disabled={user.envManaged || rosterBusy === user.id}
                  aria-label={`Role for ${user.username}`}
                  style={{ ...nativeSelectStyle, minHeight: 28, fontSize: 11.5, opacity: user.envManaged ? 0.6 : 1 }}
                >
                  <option value="admin" style={nativeOptionStyle}>Admin</option>
                  <option value="member" style={nativeOptionStyle}>Member</option>
                </select>
                {!user.envManaged && (
                  <button type="button" onClick={() => resetPassword(user)} disabled={rosterBusy === user.id} style={{ ...smallButtonStyle, minHeight: 28, fontSize: 11.5 }}>
                    Reset password
                  </button>
                )}
                {user.id !== me.id && (
                  <button type="button" onClick={() => removeUser(user)} disabled={rosterBusy === user.id || user.envManaged} aria-label={`Delete ${user.username}`} style={{ ...dangerButtonStyle, minHeight: 28, fontSize: 11.5, opacity: user.envManaged ? 0.5 : 1 }}>
                    <Trash2 size={12} aria-hidden />
                  </button>
                )}
              </div>
            ))}
            {users === null && !rosterError && (
              <div style={{ padding: "14px", color: "var(--text-muted)", fontSize: 12 }}>Loading accounts…</div>
            )}
            {rosterError && <div style={{ padding: "10px 14px" }}><ErrorNote message={rosterError} /></div>}

            <div style={{ borderTop: users && users.length > 0 ? "1px solid var(--border)" : "none", padding: "10px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
              {!showAddForm ? (
                <button type="button" onClick={() => setShowAddForm(true)} style={{ ...smallButtonStyle, alignSelf: "flex-start" }}>
                  <UserRoundPlus size={13} aria-hidden /> Add account
                </button>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "repeat(2, minmax(0, 1fr))", gap: 8 }}>
                    <input placeholder="Username" autoCapitalize="none" spellCheck={false} value={addUsername} onChange={(event) => setAddUsername(event.target.value)} style={nativeInputStyle} />
                    <input placeholder="Full name" value={addFullName} onChange={(event) => setAddFullName(event.target.value)} style={nativeInputStyle} />
                    <input type="password" placeholder="Password (at least 8 characters)" autoComplete="new-password" value={addPassword} onChange={(event) => setAddPassword(event.target.value)} style={nativeInputStyle} />
                    <select value={addRole} onChange={(event) => setAddRole(event.target.value as "member" | "admin")} aria-label="Role for the new account" style={nativeSelectStyle}>
                      <option value="member" style={nativeOptionStyle}>Member</option>
                      <option value="admin" style={nativeOptionStyle}>Admin</option>
                    </select>
                  </div>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <button type="button" onClick={addUser} disabled={addBusy || !addUsername || !addPassword} style={{ ...primaryButtonStyle, opacity: addBusy || !addUsername || !addPassword ? 0.6 : 1 }}>
                      {addBusy && <Loader2 size={13} aria-hidden style={{ animation: "spin 0.9s linear infinite" }} />}
                      Create account
                    </button>
                    <button type="button" onClick={() => { setShowAddForm(false); setAddError(null); }} style={smallButtonStyle}>Cancel</button>
                  </div>
                  <ErrorNote message={addError} />
                </div>
              )}
            </div>
          </section>

          <AgentEngineSection isMobile={isMobile} />
        </>
      )}
    </div>
  );
}
