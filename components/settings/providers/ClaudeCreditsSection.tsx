"use client";

/**
 * Settings › Providers › Anthropic › "API credits (backup)": the Claude API
 * key Nitin saved for each signed-in Claude plan account. omp serves the same
 * models on those credits only when every plan has hit its limit (see
 * lib/claude-credits.ts), so the rows exist to say whose credits each key is —
 * not to bind a key to that account's plan.
 *
 * The key text lives in one draft string while it is typed (password input,
 * never rendered as text), is sent once, and is cleared the moment the save
 * succeeds. The server only ever answers with the last four characters.
 */
import { AlertCircle, AlertTriangle, Check, KeyRound, Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ConfirmDialog } from "@/components/ui/field";
import { toast } from "@/components/ui/toast";
import { useIsCoarsePointer } from "@/hooks/useIsCoarsePointer";
import { setSettingsRouteData, useSettingsRoute } from "@/hooks/useSettingsData";
import type { ClaudeCreditsAccount, ClaudeCreditsStatus } from "@/lib/claude-credits";
import type { ProviderLoginAccount } from "@/lib/harness/types";
import { useI18n } from "@/lib/i18n";
import { formatApiError } from "@/lib/i18n/api-error";
import { chipStyle, nativeInputStyle } from "../primitives";
import { buttonStyle, cardStyle, dangerButtonStyle, primaryButtonStyle, quietButtonStyle, sectionTitleStyle } from "./controls";
import { creditsCoverage, formatAddedDate, maskKey, planTitle } from "./claude-credits-view";

const ROUTE = "/api/claude-credits";
/** A finger gets taller buttons; with a mouse the panel's own 32px stands. */
const TAP = 38;

const mutedLine = { margin: 0, fontSize: 11, color: "var(--text-dim)", lineHeight: 1.45 } as const;

function ErrorLine({ children }: { children: ReactNode }) {
  return <div role="alert" style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12, color: "var(--status-error)" }}><AlertCircle size={13} aria-hidden="true" />{children}</div>;
}

type Target = { kind: "account"; id: string } | { kind: "stray"; id: string };

export function ClaudeCreditsSection({ canEdit, onChanged, planAccounts }: {
  /** The signed-in user may change settings at all (the server still checks). */
  canEdit: boolean;
  /** Called after a key was saved or removed, so the directory re-reads. */
  onChanged: () => void;
  /** The Claude plan accounts as the sign-in card shows them, with their live state. */
  planAccounts: readonly ProviderLoginAccount[] | undefined;
}) {
  const { t } = useI18n();
  const tap = useIsCoarsePointer() ? { minHeight: TAP } : null;
  const hasPlan = (planAccounts?.length ?? 0) > 0;
  const route = useSettingsRoute<ClaudeCreditsStatus>(ROUTE, { enabled: hasPlan });
  const status = route.data;

  // Signing a plan account in or out changes this list on the server too.
  const planIds = (planAccounts ?? []).map((account) => account.id).join(",");
  const lastPlanIds = useRef(planIds);
  const { reload } = route;
  useEffect(() => {
    if (lastPlanIds.current === planIds) return;
    lastPlanIds.current = planIds;
    if (hasPlan) void reload();
  }, [planIds, hasPlan, reload]);

  // At most one key is being typed at a time.
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<Target | null>(null);
  const [error, setError] = useState<{ scope: string; message: string } | null>(null);
  const [removeTarget, setRemoveTarget] = useState<{ target: Target; keyId: string; name: string } | null>(null);
  const busyRef = useRef(false);

  if (!hasPlan) return null;

  const mutate = async (scope: string, target: Target, init: RequestInit, onDone: () => void) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(target);
    setError(null);
    try {
      const response = await fetch(ROUTE, { ...init, headers: { "Content-Type": "application/json" } });
      const body = await response.json().catch(() => null) as (ClaudeCreditsStatus & { error?: string; code?: string }) | null;
      if (!response.ok || !body || body.error) {
        setError({ scope, message: formatApiError(body) });
        return;
      }
      setSettingsRouteData<ClaudeCreditsStatus>(ROUTE, body);
      onDone();
      onChanged();
    } catch {
      setError({ scope, message: formatApiError(null) });
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  };

  const save = (account: ClaudeCreditsAccount) => {
    const key = draft.trim();
    if (!key) return;
    void mutate(account.accountId, { kind: "account", id: account.accountId }, { method: "PUT", body: JSON.stringify({ accountId: account.accountId, key }) }, () => {
      setDraft("");
      setEditing(null);
      toast.success(t("claudeCredits.saved"));
    });
  };

  const remove = () => {
    if (!removeTarget) return;
    const { target, keyId } = removeTarget;
    // Closed on failure too: the reason shows under the row, not behind the dialog.
    void mutate(target.id, target, { method: "DELETE", body: JSON.stringify({ keyId }) }, () => toast.success(t("claudeCredits.removed"))).then(() => setRemoveTarget(null));
  };

  const startEditing = (id: string) => {
    setDraft("");
    setError(null);
    setEditing(id);
  };
  const stopEditing = () => {
    setDraft("");
    setError(null);
    setEditing(null);
  };

  const title = t("claudeCredits.title");
  const titleOf = (position: number) => {
    const plan = planTitle(position);
    return plan.kind === "primary" ? t("claudeCredits.primary") : plan.kind === "secondary" ? t("claudeCredits.secondary") : t("claudeCredits.account", { n: plan.n });
  };

  if (!status) {
    if (!route.error) return null;
    return (
      <section aria-label={title} style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
        <h4 style={sectionTitleStyle}>{title}</h4>
        <ErrorLine>{t("claudeCredits.loadFailed")}</ErrorLine>
      </section>
    );
  }
  if (status.accounts.length === 0 && status.strayKeys.length === 0) return null;

  const editable = canEdit && status.canEdit && status.available;
  const keyCount = status.accounts.filter((account) => account.key).length + status.strayKeys.length;
  const coverage = creditsCoverage((planAccounts ?? []).map((account) => account.state), keyCount);
  const removing = busy !== null && removeTarget !== null && busy.id === removeTarget.target.id;

  return (
    <section aria-label={title} style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <h4 style={sectionTitleStyle}>{title}</h4>
        {coverage && (
          <span style={{ ...chipStyle, color: coverage === "covering" ? "var(--accent)" : "var(--text-dim)", display: "inline-flex", alignItems: "center", gap: 4 }}>
            {coverage === "covering" && <Check size={10} aria-hidden="true" />}
            {t(coverage === "covering" ? "claudeCredits.covering" : "claudeCredits.standby")}
          </span>
        )}
      </div>
      <div style={cardStyle}>
        {!status.available ? (
          <p style={mutedLine}>{status.reason ?? t("errors.claude_credits_unavailable")}</p>
        ) : (
          <>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {status.accounts.map((account) => {
                const isEditing = editing === account.accountId;
                const rowBusy = busy?.kind === "account" && busy.id === account.accountId;
                const added = account.key?.addedAt ? formatAddedDate(account.key.addedAt) : null;
                const name = titleOf(account.position);
                return (
                  <div key={account.accountId} style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", minWidth: 0 }}>
                      <span style={{ flex: "1 1 140px", minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                        <span style={{ fontSize: 12, fontWeight: 600 }}>{name}</span>
                        <span style={{ fontSize: 11, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={account.label}>{account.label}</span>
                      </span>
                      {account.key ? (
                        <span style={{ display: "inline-flex", flexDirection: "column", gap: 2, alignItems: "flex-start", minWidth: 0 }}>
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, fontFamily: "var(--font-mono)", color: "var(--text)" }}>
                            <KeyRound size={12} aria-hidden="true" style={{ color: "var(--text-muted)" }} />
                            {maskKey(account.key.last4)}
                          </span>
                          {added && <span style={{ fontSize: 10.5, color: "var(--text-dim)" }}>{t("claudeCredits.added", { date: added })}</span>}
                        </span>
                      ) : (
                        <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("claudeCredits.noKey")}</span>
                      )}
                      {editable && !isEditing && (
                        <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}>
                          <button type="button" className="ui-focus-ring" onClick={() => startEditing(account.accountId)} disabled={busy !== null} aria-label={account.key ? t("claudeCredits.replaceFor", { account: name }) : t("claudeCredits.addFor", { account: name })} style={{ ...(account.key ? buttonStyle : primaryButtonStyle), ...tap, opacity: busy !== null ? 0.6 : 1 }}>
                            {account.key ? <Pencil size={12} aria-hidden="true" /> : <Plus size={12} aria-hidden="true" />}
                            {account.key ? t("claudeCredits.replace") : t("claudeCredits.add")}
                          </button>
                          {account.key && (
                            <button type="button" className="ui-focus-ring" onClick={() => { setError(null); setRemoveTarget({ target: { kind: "account", id: account.accountId }, keyId: account.key!.keyId, name }); }} disabled={busy !== null} aria-label={t("claudeCredits.removeFor", { account: name })} style={{ ...dangerButtonStyle, ...tap, opacity: busy !== null ? 0.6 : 1 }}>
                              <Trash2 size={12} aria-hidden="true" />
                              {t("claudeCredits.remove")}
                            </button>
                          )}
                        </span>
                      )}
                    </div>
                    {editable && isEditing && (
                      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                        <input
                          type="password"
                          value={draft}
                          autoFocus
                          onChange={(event) => setDraft(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" && draft.trim() && busy === null) save(account);
                            if (event.key === "Escape") stopEditing();
                          }}
                          placeholder={t("claudeCredits.placeholder")}
                          aria-label={t("claudeCredits.keyFor", { account: name })}
                          disabled={rowBusy}
                          autoComplete="off"
                          spellCheck={false}
                          style={{ ...nativeInputStyle, flex: "1 1 200px", minWidth: 0, ...tap, fontFamily: "var(--font-mono)" }}
                        />
                        <button type="button" className="ui-focus-ring" onClick={() => save(account)} disabled={rowBusy || !draft.trim()} style={{ ...primaryButtonStyle, ...tap, opacity: rowBusy || !draft.trim() ? 0.6 : 1 }}>
                          {rowBusy && <Loader2 size={12} className="icon-spin" aria-hidden="true" />}
                          {t("claudeCredits.save")}
                        </button>
                        <button type="button" className="ui-focus-ring" onClick={stopEditing} disabled={rowBusy} style={{ ...quietButtonStyle, ...tap }}>
                          {t("claudeCredits.cancel")}
                        </button>
                      </div>
                    )}
                    {error?.scope === account.accountId && <ErrorLine>{error.message}</ErrorLine>}
                  </div>
                );
              })}
            </div>
            {status.strayKeys.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8, borderTop: "1px solid var(--border)", paddingTop: 10 }}>
                <span style={{ fontSize: 12, fontWeight: 600 }}>{t("claudeCredits.strayTitle")}</span>
                <p style={mutedLine}>{t("claudeCredits.strayHint")}</p>
                {status.strayKeys.map((stray) => {
                  const name = stray.label ?? t("claudeCredits.strayUnknown");
                  return (
                    <div key={stray.keyId} style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", minWidth: 0 }}>
                        <span style={{ flex: "1 1 140px", minWidth: 0, fontSize: 11, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={name}>{name}</span>
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, fontFamily: "var(--font-mono)" }}>
                          <KeyRound size={12} aria-hidden="true" style={{ color: "var(--text-muted)" }} />
                          {maskKey(stray.last4)}
                        </span>
                        {editable && (
                          <button type="button" className="ui-focus-ring" onClick={() => { setError(null); setRemoveTarget({ target: { kind: "stray", id: stray.keyId }, keyId: stray.keyId, name }); }} disabled={busy !== null} aria-label={t("claudeCredits.removeFor", { account: name })} style={{ ...dangerButtonStyle, ...tap, opacity: busy !== null ? 0.6 : 1 }}>
                            <Trash2 size={12} aria-hidden="true" />
                            {t("claudeCredits.remove")}
                          </button>
                        )}
                      </div>
                      {error?.scope === stray.keyId && <ErrorLine>{error.message}</ErrorLine>}
                    </div>
                  );
                })}
              </div>
            )}
            <p style={mutedLine}>{t("claudeCredits.note")}</p>
            <p style={mutedLine}>{t("claudeCredits.genericKeyNote")}</p>
            {!status.fallbackEnabled && (
              <div role="status" style={{ display: "flex", gap: 6, alignItems: "flex-start", fontSize: 12, color: "var(--status-warning)", lineHeight: 1.45 }}>
                <AlertTriangle size={13} aria-hidden="true" style={{ marginTop: 2, flexShrink: 0 }} />
                {t("claudeCredits.fallbackOff")}
              </div>
            )}
            {status.returnsToPlan === false && keyCount > 0 && (
              <div role="status" style={{ display: "flex", gap: 6, alignItems: "flex-start", fontSize: 12, color: "var(--status-warning)", lineHeight: 1.45 }}>
                <AlertTriangle size={13} aria-hidden="true" style={{ marginTop: 2, flexShrink: 0 }} />
                {t("claudeCredits.noReturn")}
              </div>
            )}
            {!editable && <p style={mutedLine}>{t("claudeCredits.readOnly")}</p>}
          </>
        )}
      </div>
      {removeTarget && (
        <ConfirmDialog
          open
          onOpenChange={(open) => { if (!open && !removing) setRemoveTarget(null); }}
          title={t("claudeCredits.removeTitle")}
          description={t("claudeCredits.removeBody", { account: removeTarget.name })}
          confirmLabel={t("claudeCredits.remove")}
          cancelLabel={t("claudeCredits.cancel")}
          danger
          busy={removing}
          onConfirm={remove}
        />
      )}
    </section>
  );
}
