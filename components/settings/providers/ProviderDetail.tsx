"use client";

/**
 * One provider, in a Drawer (a 420px side drawer on a desktop, a pushed
 * level on a phone): its methods in precedence order — the engine's own
 * sign-in(s), the API key variables Cody stores, a custom endpoint's
 * models.yml form — plus the catalog check, omp's "only these models"
 * curation, and the danger zone that removes what Cody itself holds.
 *
 * Everything here writes through the same channels the old panels used
 * (`/api/auth/*` sign-ins, `/api/provider-keys`, `/api/models-config`,
 * `/api/omp-settings` via the config writer) and ends with
 * `invalidateProviderReads()`, so the directory behind the drawer and the
 * composer's catalog both re-read.
 *
 * `KeyMethodCard` is exported for the setup wizard, which renders it in
 * its own card for the key providers the picker offers.
 */
import { AlertCircle, AlertTriangle, Check, ChevronDown, ChevronRight, KeyRound, Loader2, LogIn, LogOut, Plus, RefreshCw, Trash2, UserPlus } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ModelCatalogPicker } from "@/components/ModelCatalogPicker";
import { ModelEntryEditor, ProviderEntryEditor, type ModelEntry, type ModelsFileData, type ProviderEntry } from "@/components/ModelsConfig";
import { Select, type SelectOption } from "@/components/ui/Select";
import { ConfirmDialog } from "@/components/ui/field";
import { toast } from "@/components/ui/toast";
import { useNativeSettings } from "@/hooks/useConfigWriter";
import { useModelCatalog } from "@/hooks/useModelCatalog";
import { useSettingsRoute } from "@/hooks/useSettingsData";
import { useUsage } from "@/hooks/useUsage";
import type { ProviderLoginAccount } from "@/lib/harness/types";
import { useI18n } from "@/lib/i18n";
import { formatApiError } from "@/lib/i18n/api-error";
import { providerGlob } from "@/lib/model-allow-list";
import { omitUntouchedModelDrafts } from "@/lib/models-config-drafts";
import { firstKindApiMismatch } from "@/lib/model-kinds";
import { formatModelDisplayName } from "@/lib/model-display";
import { isSubscriptionLogin, type ProviderMethod, type ProviderMethodVariable, type ProviderRow, type ProvidersResponse } from "@/lib/provider-directory";
import { selectBindingWindow } from "@/lib/usage/select";
import type { UsageAccount } from "@/lib/usage/types";
import { clampQuotaPercent, QuotaBar, usageToneColor } from "@/components/QuotaBar";
import { DangerZone } from "../DangerZone";
import { Drawer } from "../Drawer";
import { ModelCurationDialog } from "../models/ModelCurationDialog";
import { chipStyle, nativeInputStyle, ToggleSwitch } from "../primitives";
import { activeChatNote, postLogout, ProviderLoginFlow, type ProviderLoginRow } from "../ProviderLoginFlow";
import { useSaveStatus } from "../SaveStatus";
import { useSettingsShell } from "../shell-context";
import { buttonStyle, cardStyle, dangerButtonStyle, describeModels, describeWinning, invalidateProviderReads, missingOptionalHint, pluralModels, primaryButtonStyle, ProviderTile, quietButtonStyle, sectionTitleStyle } from "./controls";
import { OpenRouterCreditsSection, OpenRouterKeyLimitsSection, OpenRouterRoutingSection } from "./OpenRouterSettings";
import { ClaudeCreditsSection } from "./ClaudeCreditsSection";

export const PROVIDERS_PANEL_ID = "providers";

/** Curation is worth a section once a provider is big or open-ended. */
const CURATION_THRESHOLD = 20;

function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section aria-label={title} style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <h4 style={sectionTitleStyle}>{title}</h4>
        {aside}
      </div>
      {children}
    </section>
  );
}

function StateChip({ ok, children }: { ok: boolean; children: ReactNode }) {
  return <span style={{ ...chipStyle, color: ok ? "var(--status-success)" : "var(--text-dim)", display: "inline-flex", alignItems: "center", gap: 4 }}>{ok && <Check size={10} aria-hidden="true" />}{children}</span>;
}

function ErrorLine({ children }: { children: ReactNode }) {
  return <div role="alert" style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12, color: "var(--status-error)" }}><AlertCircle size={13} aria-hidden="true" />{children}</div>;
}

/** The `ProviderLoginRow` shape ProviderLoginFlow drives, from a method. */
export function loginRowOf(row: ProviderRow, method: ProviderMethod): ProviderLoginRow {
  return {
    id: method.loginId ?? row.id,
    name: method.name ?? row.name,
    authenticated: method.state === "connected",
    kind: method.kind === "device" ? "device" : "oauth",
    canLogout: method.canLogout === true,
    ...(method.hint ? { hint: method.hint } : {}),
  };
}

// ── Sign-in ──────────────────────────────────────────────────────────────────

/** A limited account's local reset clock. This file carries no i18n (unlike
 * ChatInput's near-identical `formatResetTime`), so it stays a plain
 * browser-locale format. */
function formatLocalTime(iso: string | null): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? null : at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function AccountStateChip({ state, resetsAt }: { state: ProviderLoginAccount["state"]; resetsAt: string | null }) {
  if (state === "in_use") return <span style={{ ...chipStyle, color: "var(--accent)" }}>In use</span>;
  if (state === "standby") return <span style={{ ...chipStyle, color: "var(--text-dim)" }}>Standby</span>;
  if (state === "disabled") return <span style={{ ...chipStyle, color: "var(--status-error)" }}>Disabled</span>;
  const reset = formatLocalTime(resetsAt);
  return <span style={{ ...chipStyle, color: "var(--status-warning)" }}>{reset ? `Limited · resets ${reset}` : "Limited"}</span>;
}

/** The account's own most-binding usage window, as a compact bar — the same
 * shared primitive and colour rule the composer and the Providers directory's
 * Usage block both draw with. */
function AccountUsageBar({ account }: { account: UsageAccount }) {
  const binding = selectBindingWindow([account]);
  if (!binding) return null;
  const percent = clampQuotaPercent(binding.window.utilization);
  const color = usageToneColor(percent, binding.window.state);
  return (
    <span style={{ width: 48, flexShrink: 0 }} aria-label={`${Math.round(percent)}% of ${binding.window.label} used`}>
      <QuotaBar percent={percent} color={color} />
    </span>
  );
}

/** One account under a multi-account sign-in: identity, plan, the state omp
 * ranked it at, and — when it is not the credential's only remaining copy —
 * removal. */
function AccountRow({ account, canEdit, busy, onRemove, usageAccount }: {
  account: ProviderLoginAccount;
  canEdit: boolean;
  busy: boolean;
  onRemove: () => void;
  /** The matching usage-snapshot account (by credential id), when the engine
   * reports one; absent renders no bar at all rather than an empty one. */
  usageAccount?: UsageAccount | null;
}) {
  const title = account.position === 0 ? "Primary" : account.position === 1 ? "Secondary" : `Account ${account.position + 1}`;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
      <span style={{ flex: "1 1 120px", minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
        <span style={{ fontSize: 12, fontWeight: 600 }}>{title}</span>
        <span style={{ fontSize: 11, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={account.label}>
          {account.label}
        </span>
      </span>
      {account.planType && <span style={{ fontSize: 11, color: "var(--text-muted)", whiteSpace: "nowrap" }}>{account.planType}</span>}
      {usageAccount && <AccountUsageBar account={usageAccount} />}
      <AccountStateChip state={account.state} resetsAt={account.resetsAt} />
      {account.canRemove && canEdit && (
        <button type="button" className="ui-focus-ring" onClick={onRemove} disabled={busy} aria-label={`Remove ${account.label}`} style={{ ...quietButtonStyle, padding: "6px 8px" }}>
          {busy ? <Loader2 size={12} aria-hidden="true" className="icon-spin" /> : <Trash2 size={12} aria-hidden="true" />}
        </button>
      )}
    </div>
  );
}

export function LoginMethodCard({ row, method, canEdit, shortName, autoStart, onChanged, usageAccounts }: {
  row: ProviderRow;
  method: ProviderMethod;
  canEdit: boolean;
  shortName: string;
  autoStart: boolean;
  onChanged: () => void;
  /** This provider's usage-snapshot accounts, matched to a credential row by
   * `ProviderLoginAccount.id` (omp's stringified credential row id) below.
   * Undefined (no usage read yet, or the engine reports none) renders every
   * account row exactly as it did before per-account usage existed. */
  usageAccounts?: readonly UsageAccount[];
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(autoStart);
  const [starting, setStarting] = useState(autoStart);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<ProviderLoginAccount | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const removingRef = useRef(false);
  const provider = loginRowOf(row, method);
  const connected = method.state === "connected";
  const accounts = method.accounts;
  const hasAccounts = (accounts?.length ?? 0) > 0;
  const showAddAccount = hasAccounts;

  const logout = async () => {
    setLogoutError(null);
    setLoggingOut(true);
    const answer = await postLogout(provider.id);
    setLoggingOut(false);
    if (!answer.ok && !answer.notFound) {
      setLogoutError(answer.message);
      toast.error(t("providerRemoval.signOutFailed", { name: provider.name }), answer.message);
      return;
    }
    if (!answer.ok) toast.info(t("providerRemoval.alreadyRemoved"), t("providerRemoval.alreadyGoneSignIn"));
    else if (answer.removed) toast.success(t("providerRemoval.signedOut", { name: provider.name }), activeChatNote(answer.active, t));
    else toast.info(t("providerRemoval.nothingToRemove"), t("providerRemoval.nothingSaved", { name: provider.name }));
    setExpanded(false);
    onChanged();
  };

  const removeAccount = async (account: ProviderLoginAccount) => {
    if (removingRef.current) return;
    removingRef.current = true;
    setRemovingId(account.id);
    setRemoveError(null);
    const answer = await postLogout(provider.id, account.id);
    removingRef.current = false;
    setRemovingId(null);
    if (!answer.ok && !answer.notFound) {
      setRemoveError(answer.message);
      toast.error(t("providerRemoval.removeFailed", { name: account.label }), answer.message);
      return;
    }
    if (!answer.ok) {
      // A stale list: the account is already gone. Refresh instead of alarming.
      toast.info(t("providerRemoval.alreadyRemoved"), t("providerRemoval.alreadyGoneAccount"));
    } else {
      const detail = [answer.providerRemoved ? t("providerRemoval.providerSignedOut", { name: row.name }) : null, activeChatNote(answer.active, t)].filter(Boolean).join(" ");
      toast.success(t("providerRemoval.removedTitle", { name: account.label }), detail || undefined);
    }
    setRemoveTarget(null);
    onChanged();
  };

  return (
    <div style={cardStyle}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ flex: "1 1 160px", minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ fontSize: 12.5, fontWeight: 600 }}>{provider.name}</span>
          {provider.hint && <span style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.4 }}>{provider.hint}</span>}
        </span>
        <StateChip ok={connected}>{connected ? (isSubscriptionLogin(method) ? "Signed in" : `Key stored in ${shortName}`) : "Not signed in"}</StateChip>
      </div>
      {canEdit && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <button type="button" className="ui-focus-ring" onClick={() => { setLogoutError(null); setRemoveError(null); setStarting(true); setExpanded(true); }} aria-expanded={expanded} style={connected ? buttonStyle : primaryButtonStyle}>
            {showAddAccount ? <UserPlus size={12} aria-hidden="true" /> : connected ? <RefreshCw size={12} aria-hidden="true" /> : <LogIn size={12} aria-hidden="true" />}
            {showAddAccount ? (accounts?.length === 1 ? "Add secondary account" : "Add account") : connected ? "Re-login" : "Sign in"}
          </button>
          {connected && method.canLogout && !hasAccounts && (
            <button type="button" className="ui-focus-ring" onClick={() => { void logout(); }} disabled={loggingOut} style={dangerButtonStyle}>
              {loggingOut ? <Loader2 size={12} aria-hidden="true" className="icon-spin" /> : <LogOut size={12} aria-hidden="true" />}
              Sign out
            </button>
          )}
          <button
            type="button"
            className="ui-focus-ring"
            onClick={() => { setStarting(false); setExpanded((current) => !current); }}
            aria-label={expanded ? `Collapse ${provider.name}` : `Expand ${provider.name}`}
            aria-expanded={expanded}
            style={{ ...quietButtonStyle, marginLeft: "auto", padding: "6px 8px" }}
          >
            {expanded ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
          </button>
        </div>
      )}
      {hasAccounts && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {accounts?.map((account) => (
            <AccountRow
              key={account.id}
              account={account}
              canEdit={canEdit}
              busy={removingId === account.id}
              onRemove={() => { setRemoveError(null); setRemoveTarget(account); }}
              usageAccount={usageAccounts?.find((entry) => String(entry.credentialId) === account.id) ?? null}
            />
          ))}
        </div>
      )}
      {accounts === undefined ? (
        connected && !method.canLogout && (
          <p style={{ margin: 0, fontSize: 11, color: "var(--text-dim)", lineHeight: 1.45 }}>
            Sign out from the {shortName} TUI (<code style={{ fontFamily: "var(--font-mono)" }}>/logout</code> in a Cody terminal); {shortName} keeps this credential in its own store.
          </p>
        )
      ) : hasAccounts && method.multiAccount ? (
        <p style={{ margin: 0, fontSize: 11, color: "var(--text-dim)", lineHeight: 1.45 }}>
          {shortName} rotates between these accounts automatically and skips a limited one until it resets.
        </p>
      ) : connected && accounts.length === 0 ? (
        <p style={{ margin: 0, fontSize: 11, color: "var(--text-dim)", lineHeight: 1.45 }}>
          {t("providerRemoval.notStoredNote", { shortName })}
        </p>
      ) : null}
      {logoutError && <ErrorLine>{logoutError}</ErrorLine>}
      {removeError && <ErrorLine>{removeError}</ErrorLine>}
      {canEdit && expanded && (
        <div style={{ borderTop: "1px solid var(--border)", paddingTop: 10 }}>
          <ProviderLoginFlow key={provider.id} provider={provider} onChanged={onChanged} autoStart={starting} compact />
        </div>
      )}
      {removeTarget && (
        <ConfirmDialog
          open
          onOpenChange={(open) => { if (!open) setRemoveTarget(null); }}
          title={`Remove ${removeTarget.label}?`}
          description={`Sessions stop using this ${removeTarget.label} account.${accounts?.length === 1 ? ` This is the last account, so ${row.name} is disconnected.` : ""}`}
          confirmLabel="Remove"
          danger
          busy={removingId === removeTarget.id}
          onConfirm={() => { void removeAccount(removeTarget); }}
        />
      )}
    </div>
  );
}

// ── API key ──────────────────────────────────────────────────────────────────

async function putProviderKey(name: string, value: string): Promise<void> {
  const response = await fetch("/api/provider-keys", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, value }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(formatApiError(body));
}

function VariableRow({ variable, stored, canEdit, onWritten, onSaved }: {
  variable: ProviderMethodVariable;
  /** `variable.stored`, or the write this card just made (see KeyMethodCard). */
  stored: boolean;
  canEdit: boolean;
  onWritten: (stored: boolean) => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedTick, setSavedTick] = useState(false);
  const { t } = useI18n();
  const inputId = `provider-key-${variable.name}`;

  const submit = async (value: string) => {
    const clearing = value.trim().length === 0;
    setBusy(true);
    setError(null);
    try {
      await putProviderKey(variable.name, value);
      setDraft("");
      onWritten(!clearing);
      setSavedTick(true);
      setTimeout(() => setSavedTick(false), 1800);
      if (clearing) toast.success(t("providerRemoval.cleared", { name: variable.name }), variable.fromEnvironment ? t("providerRemoval.clearedUsesServer") : undefined);
      onSaved();
    } catch (failure) {
      // A 409 `set_in_environment` lands here too, with the server's words.
      const message = failure instanceof Error ? failure.message : String(failure);
      setError(message);
      toast.error(t(clearing ? "providerRemoval.clearFailed" : "providerRemoval.saveFailed", { name: variable.name }), message);
    } finally {
      setBusy(false);
    }
  };

  const status = stored ? "Saved in Cody" : variable.fromEnvironment ? t("providerRemoval.statusServer") : "Not set";
  const present = stored || variable.fromEnvironment;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <label htmlFor={inputId} style={{ fontSize: 12, fontWeight: 600 }}>{variable.label}</label>
        <code style={{ fontSize: 11, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>{variable.name}</code>
        <StateChip ok={present}>{status}</StateChip>
        {variable.optional && !present && <span style={{ fontSize: 11, color: "var(--text-dim)" }}>Optional</span>}
      </div>
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        <input
          id={inputId}
          type={variable.secret ? "password" : "text"}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter" && draft.trim()) void submit(draft); }}
          placeholder={stored ? "Replace the saved value" : variable.hint ?? (variable.secret ? "Paste a key" : "Value")}
          disabled={!canEdit || busy}
          autoComplete="off"
          spellCheck={false}
          style={{ ...nativeInputStyle, flex: "1 1 200px", minWidth: 0, fontFamily: variable.secret ? "var(--font-mono)" : undefined }}
        />
        <button type="button" className="ui-focus-ring" onClick={() => void submit(draft)} disabled={!canEdit || busy || !draft.trim()} style={{ ...buttonStyle, opacity: !canEdit || busy || !draft.trim() ? 0.6 : 1 }}>
          {busy ? <Loader2 size={13} className="icon-spin" aria-hidden="true" /> : savedTick ? <Check size={13} aria-hidden="true" /> : null}
          Save
        </button>
        {stored && (
          <button type="button" className="ui-focus-ring" onClick={() => void submit("")} disabled={!canEdit || busy} style={quietButtonStyle}>
            {variable.fromEnvironment ? "Use container value" : "Clear"}
          </button>
        )}
      </div>
      {stored && variable.fromEnvironment && (
        <span style={{ fontSize: 11, color: "var(--text-dim)" }}>Saved in Cody overrides the container value.</span>
      )}
      {!stored && variable.fromEnvironment && (
        <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("providerRemoval.removeItThere")}</span>
      )}
      {error && <ErrorLine>{error}</ErrorLine>}
    </div>
  );
}

/** The API-key method: one row per variable, with Save / Clear. */
export function KeyMethodCard({ method, canEdit, shortName, onSaved }: {
  method: ProviderMethod;
  canEdit: boolean;
  shortName: string;
  onSaved: () => void;
}) {
  const variables = method.variables ?? [];
  // The directory re-reads after a write, but that read spawns the engine
  // again and takes seconds; until it lands the card follows the writes it
  // just made, chip and rows alike.
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  useEffect(() => { setOverrides({}); }, [method]);
  const storedOf = (variable: ProviderMethodVariable) => overrides[variable.name] ?? variable.stored;
  const anyStored = variables.some(storedOf);
  const complete = variables.filter((variable) => !variable.optional).every((variable) => storedOf(variable) || variable.fromEnvironment);
  const chip = complete ? (anyStored ? "Key saved in Cody" : "Key from container") : "Not set";
  return (
    <div style={cardStyle}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <KeyRound size={13} aria-hidden="true" style={{ color: "var(--text-muted)" }} />
        <span style={{ fontSize: 12.5, fontWeight: 600, flex: 1 }}>API key</span>
        <StateChip ok={complete}>{chip}</StateChip>
      </div>
      <p style={{ margin: 0, fontSize: 11, color: "var(--text-muted)", lineHeight: 1.45 }}>
        A key saved here reaches {shortName} as an environment variable; sessions started after the save use it.{!canEdit && " Only an administrator can change it."}
      </p>
      {variables.map((variable) => (
        <VariableRow
          key={variable.name}
          variable={variable}
          stored={storedOf(variable)}
          canEdit={canEdit}
          onWritten={(stored) => setOverrides((current) => ({ ...current, [variable.name]: stored }))}
          onSaved={onSaved}
        />
      ))}
    </div>
  );
}

// ── Check models / Verify key ───────────────────────────────────────────────

interface VerifyOutcome {
  ok: boolean;
  modelCount: number;
  error?: string;
  checkedAt: string;
}

function VerifyControl({ row, custom }: { row: ProviderRow; custom: boolean }) {
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<VerifyOutcome | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setFailure(null);
    try {
      const response = await fetch("/api/providers/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerId: row.id }),
      });
      const body = await response.json().catch(() => null) as (VerifyOutcome & { error?: string; code?: string }) | null;
      if (!response.ok) {
        setFailure(body?.error || body?.code ? formatApiError(body ?? {}) : `HTTP ${response.status}`);
        return;
      }
      if (body) setOutcome(body);
      invalidateProviderReads();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <button type="button" className="ui-focus-ring" onClick={() => void run()} disabled={busy} style={buttonStyle}>
          {busy ? <Loader2 size={13} className="icon-spin" aria-hidden="true" /> : <RefreshCw size={13} aria-hidden="true" />}
          {custom ? "Verify key" : "Check models"}
        </button>
        {outcome && (
          <span role="status" style={{ fontSize: 12, color: outcome.ok ? "var(--status-success)" : "var(--status-warning)", display: "inline-flex", alignItems: "center", gap: 6 }}>
            {outcome.ok ? <Check size={13} aria-hidden="true" /> : <AlertTriangle size={13} aria-hidden="true" />}
            {outcome.ok ? `Connected · ${pluralModels(outcome.modelCount)} · checked just now` : `Rejected: ${outcome.error ?? "no models"}${custom ? " — key kept" : ""}`}
          </span>
        )}
      </div>
      {!custom && <span style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.45 }}>Re-reads the catalog with the current keys. A registry read cannot reject a wrong key; a model count is the evidence.</span>}
      {failure && <ErrorLine>{failure}</ErrorLine>}
    </div>
  );
}

// ── Only these models (omp) ─────────────────────────────────────────────────

/**
 * omp's per-provider curation, read and written through the Models hub's
 * own data hook so the two hubs never disagree: the summary strip, the
 * "include future models" switch (a whole-provider glob versus an exact
 * list) and Choose…, which opens the same ModelCurationDialog the catalog
 * uses.
 */
function OnlyTheseModels({ row, readOnly, canEdit }: { row: ProviderRow; readOnly: boolean; canEdit: boolean }) {
  const catalog = useModelCatalog();
  const { track } = useSaveStatus(PROVIDERS_PANEL_ID);
  const [curating, setCurating] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const closeCuration = useCallback(() => setCurating(null), []);

  // Only the catalog ids this row actually serves models under; a login id
  // omp files nothing under (anthropic-console) has nothing to curate.
  const present = row.catalogIds.filter((id) => catalog.rows.some((entry) => entry.provider === id && entry.source !== "placeholder"));
  const ids = present.length > 0 ? present : row.catalogIds.slice(0, 1);
  const summaryOf = (id: string) => catalog.curation.find((entry) => entry.provider === id) ?? { provider: id, total: 0, enabled: 0, mode: "unrestricted" as const };
  const keysFor = (id: string) => catalog.rows.filter((entry) => entry.provider === id && entry.source !== "placeholder").map((entry) => entry.key);
  const enabledKeysFor = (id: string) => catalog.rows.filter((entry) => entry.provider === id && entry.source !== "placeholder" && entry.state !== "instanceHidden" && entry.state !== "needsKey").map((entry) => entry.key);
  const summaries = ids.map(summaryOf);
  const includeFuture = summaries.every((entry) => entry.mode === "all" || entry.mode === "unrestricted");
  const disabled = readOnly || catalog.readOnly || !canEdit || catalog.loading;
  const entries = catalog.enabledModels.filter((entry) => ids.some((id) => entry === providerGlob(id) || entry.startsWith(`${id}/`)));

  const setIncludeFuture = (on: boolean) => {
    void track(async () => {
      for (const entry of summaries) {
        const all = keysFor(entry.provider);
        const current = enabledKeysFor(entry.provider);
        await catalog.writeProviderCuration(entry.provider, on || current.length === 0 ? all : current, { includeFuture: on });
      }
    });
  };

  const summary = summaries.map((entry) => {
    const total = catalog.loading && entry.total === 0 ? "…" : String(entry.total);
    if (entry.mode === "all" || entry.mode === "unrestricted") return `${entry.provider}: all current & future (${total})`;
    if (entry.mode === "none") return `${entry.provider}: none of ${total}`;
    return `${entry.provider}: ${entry.enabled} of ${total} · exact list`;
  });

  return (
    <div style={cardStyle}>
      <label style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, cursor: disabled ? "default" : "pointer" }}>
        <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ fontSize: 12.5, fontWeight: 600 }}>Include future {row.name} models</span>
          <span style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.45 }}>{includeFuture ? "New models this provider adds are offered as they appear." : "Pinned to an exact list — models added later stay hidden until re-curated."}</span>
        </span>
        <ToggleSwitch checked={includeFuture} onChange={setIncludeFuture} disabled={disabled} />
      </label>
      <div style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5 }}>{summary.join(" · ")}</div>
      {entries.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
          {entries.slice(0, 12).map((entry) => <code key={entry} style={{ ...chipStyle, fontFamily: "var(--font-mono)" }}>{entry}</code>)}
          {entries.length > 12 && <span style={{ ...chipStyle }}>+{entries.length - 12} more</span>}
        </div>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        {ids.map((id) => (
          <button key={id} type="button" className="ui-focus-ring" onClick={() => setCurating(id)} disabled={disabled || keysFor(id).length === 0} style={{ ...buttonStyle, opacity: disabled || keysFor(id).length === 0 ? 0.6 : 1 }}>
            {ids.length > 1 ? `Choose ${id}…` : "Choose…"}
          </button>
        ))}
        {(readOnly || catalog.readOnly) && <span style={{ ...chipStyle, color: "var(--status-warning)" }}>Read-only</span>}
        {catalog.error && <ErrorLine>{catalog.error}</ErrorLine>}
      </div>
      {curating && (
        <ModelCurationDialog
          open
          provider={curating}
          catalog={catalog.rows.filter((entry) => entry.provider === curating && entry.source !== "placeholder").map((entry) => ({ id: entry.id, name: entry.name, provider: entry.provider }))}
          enabled={new Set(enabledKeysFor(curating))}
          saving={saving}
          onCancel={closeCuration}
          onConfirm={(selected, options) => {
            setSaving(true);
            void track(async () => {
              await catalog.writeProviderCuration(curating, [...selected], { includeFuture: options.includeFuture });
              // Curation hides only what a human has looked at: record the
              // keys the dialog listed, never the whole catalog.
              await catalog.markSeen([...new Set([...options.displayed, ...catalog.catalogKeys.filter((key) => !key.startsWith(`${curating}/`))])]).catch(() => undefined);
            }).then((ok) => {
              setSaving(false);
              if (ok) setCurating(null);
            });
          }}
        />
      )}
    </div>
  );
}

// ── Advanced: the models.yml form ───────────────────────────────────────────

type ModelsConfigBody = ModelsFileData & { parseError?: string; path?: string };

function AdvancedForm({ row, onDirtyChange, onSaved }: {
  row: ProviderRow;
  onDirtyChange: (dirty: boolean) => void;
  onSaved: (name: string) => void;
}) {
  const { callbacks } = useSettingsShell();
  const config = useSettingsRoute<ModelsConfigBody>("/api/models-config");
  const [name, setName] = useState(row.id);
  const [draft, setDraft] = useState<ProviderEntry | null>(null);
  const [baseline, setBaseline] = useState<ProviderEntry | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Stable closers for the nested drawers (see ProviderDirectory).
  const closeEditor = useCallback(() => setEditing(null), []);
  const closeCatalog = useCallback(() => setCatalogOpen(false), []);

  // The file is the baseline; a re-read only replaces an unedited draft.
  useEffect(() => {
    const entry = config.data?.providers?.[row.id];
    if (!entry) return;
    setBaseline(entry);
    setDraft((current) => (current === null || current === baseline ? entry : current));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.data, row.id]);

  const dirty = draft !== null && (draft !== baseline || name !== row.id);
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);

  const cancel = () => {
    setDraft(baseline);
    setName(row.id);
    setSaveError(null);
  };

  const save = async () => {
    if (!draft || config.data?.parseError) return;
    const key = name.trim();
    if (!key) {
      setSaveError("A provider name is required.");
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const providers: Record<string, ProviderEntry> = { ...(config.data?.providers ?? {}) };
      if (key !== row.id) delete providers[row.id];
      providers[key] = draft;
      const response = await fetch("/api/models-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(omitUntouchedModelDrafts({ providers })),
      });
      const body = await response.json().catch(() => null) as { error?: string; code?: string } | null;
      if (!response.ok || body?.error) throw new Error(body?.error || body?.code ? formatApiError(body ?? {}) : `HTTP ${response.status}`);
      setBaseline(draft);
      invalidateProviderReads();
      callbacks.onModelsSaved();
      toast.success("models.yml saved");
      onSaved(key);
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : String(failure);
      setSaveError(message);
      toast.error("Could not save models.yml", message);
    } finally {
      setSaving(false);
    }
  };

  if (config.data?.parseError) {
    return (
      <div style={cardStyle}>
        <ErrorLine>models.yml could not be parsed, so this provider cannot be edited here. Fix it in a text editor{config.data.path ? ` (${config.data.path})` : ""}.</ErrorLine>
        <pre style={{ margin: 0, fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{config.data.parseError}</pre>
      </div>
    );
  }
  if (!draft) {
    return <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{config.error ?? "Reading models.yml…"}</div>;
  }

  const models = draft.models ?? [];
  const kindError = firstKindApiMismatch(name, draft);
  const updateModel = (index: number, model: ModelEntry) => setDraft({ ...draft, models: models.map((entry, i) => (i === index ? model : entry)) });
  const removeModel = (index: number) => {
    const next = models.filter((_, i) => i !== index);
    setDraft({ ...draft, models: next.length ? next : undefined });
    setEditing(null);
  };
  const addModel = () => {
    setDraft({ ...draft, models: [...models, { id: "" }] });
    setEditing(models.length);
  };
  const editingModel = editing !== null ? models[editing] : undefined;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
      <ProviderEntryEditor name={name} provider={draft} onChange={setDraft} onRename={setName} />
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: 12.5, fontWeight: 600 }}>Models ({models.length})</span>
          <span style={{ display: "inline-flex", gap: 6 }}>
            <button type="button" className="ui-focus-ring" onClick={addModel} style={quietButtonStyle}><Plus size={12} aria-hidden="true" /> Model</button>
            <button type="button" className="ui-focus-ring" onClick={() => setCatalogOpen(true)} style={quietButtonStyle}>From catalog</button>
          </span>
        </div>
        {models.length === 0 ? (
          <div style={{ fontSize: 12, color: "var(--text-dim)", padding: "10px 12px", border: "1px dashed var(--border)", borderRadius: "var(--radius-card)" }}>No models yet. Add one by id, or pick from the catalog.</div>
        ) : (
          <div role="list" style={{ display: "flex", flexDirection: "column", border: "1px solid var(--border)", borderRadius: "var(--radius-card)", overflow: "hidden" }}>
            {models.map((model, index) => (
              <button
                key={index}
                type="button"
                role="listitem"
                className="settings-directory-row ui-focus-ring"
                onClick={() => setEditing(index)}
                style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 44, padding: "8px 12px", border: "none", borderTop: index > 0 ? "1px solid var(--border)" : "none", background: "var(--bg-panel)", color: "var(--text)", cursor: "pointer", textAlign: "left", width: "100%" }}
              >
                <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                  <span style={{ fontSize: 12, color: model.id ? "var(--text)" : "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{model.id ? formatModelDisplayName(model.id, model.name) : "new model"}</span>
                  {model.id && <code style={{ fontSize: 10.5, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{model.id}</code>}
                </span>
                {model.reasoning && <span style={{ ...chipStyle, color: "var(--accent)" }}>thinking</span>}
                <ChevronRight size={14} aria-hidden="true" style={{ color: "var(--text-dim)" }} />
              </button>
            ))}
          </div>
        )}
      </div>
      {saveError && <ErrorLine>{saveError}</ErrorLine>}
      {kindError && <ErrorLine>{kindError}</ErrorLine>}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <button type="button" className="ui-focus-ring" onClick={cancel} disabled={!dirty || saving} style={{ ...quietButtonStyle, opacity: dirty ? 1 : 0.6 }}>Cancel</button>
        <button type="button" className="ui-focus-ring" onClick={() => void save()} disabled={!dirty || saving || kindError !== null} style={{ ...primaryButtonStyle, opacity: dirty && kindError === null ? 1 : 0.6 }}>
          {saving ? <Loader2 size={13} className="icon-spin" aria-hidden="true" /> : null}
          {saving ? "Saving…" : "Save"}
        </button>
      </div>

      <Drawer open={editingModel !== undefined} title={editingModel?.id || "New model"} presentation="push" onClose={closeEditor} width={480}>
        {editingModel !== undefined && editing !== null && (
          <ModelEntryEditor
            key={editing}
            providerName={name}
            provider={draft}
            model={editingModel}
            onChange={(model) => updateModel(editing, model)}
            onDelete={() => removeModel(editing)}
          />
        )}
      </Drawer>
      {catalogOpen && (
        <ModelCatalogPicker
          open
          providerName={name}
          providerBaseUrl={draft.baseUrl ?? ""}
          existingIds={new Set(models.map((model) => model.id))}
          onAdd={(model, baseUrl) => {
            const next: ProviderEntry = { ...draft, models: [...models, model] };
            if (baseUrl && !draft.baseUrl) next.baseUrl = baseUrl;
            setDraft(next);
            setCatalogOpen(false);
          }}
          onClose={closeCatalog}
        />
      )}
    </div>
  );
}

// ── Removing a whole provider ───────────────────────────────────────────────

/** Everything "Remove" would take off one provider row, worked out from the
 * row alone so the button, its confirmation and the toasts all say the same. */
export interface RemovalPlan {
  name: string;
  modelCount: number;
  /** Sign-ins to sign out of: holding stored accounts, or connected with a
   * sign-out Cody can drive. */
  logins: { loginId: string; name: string; accounts: number }[];
  accountCount: number;
  /** Key variables saved in Cody. */
  storedNames: string[];
  /** A custom endpoint declared in models.yml. */
  custom: boolean;
  /** Variables the server's own environment sets: Cody cannot clear these. */
  environmentNames: string[];
  /** There is something Cody can remove. */
  removable: boolean;
}

export function planRemoval(row: ProviderRow): RemovalPlan {
  const logins = row.methods.flatMap((method) => {
    if (!method.loginId) return [];
    const accounts = method.accounts?.length ?? 0;
    if (accounts === 0 && !(method.state === "connected" && method.canLogout)) return [];
    return [{ loginId: method.loginId, name: method.name ?? method.loginId, accounts }];
  });
  const variables = row.methods.flatMap((method) => method.variables ?? []);
  const storedNames = [...new Set(variables.filter((variable) => variable.stored).map((variable) => variable.name))];
  const environmentNames = [...new Set(variables.filter((variable) => variable.fromEnvironment).map((variable) => variable.name))];
  const custom = row.methods.some((method) => method.kind === "custom");
  return {
    name: row.name,
    modelCount: row.modelCount ?? 0,
    logins,
    accountCount: logins.reduce((sum, login) => sum + login.accounts, 0),
    storedNames,
    custom,
    environmentNames,
    removable: logins.length > 0 || storedNames.length > 0 || custom,
  };
}

/** `useI18n()`'s translators, as the pure helpers below take them so they
 * run without React. */
export type Translate = (key: string, vars?: Record<string, string | number>) => string;
export type TranslatePlural = (key: string, count: number, vars?: Record<string, string | number>) => string;

/** The consequence of Remove in short plain sentences, e.g. "This signs you
 * out of 2 Claude accounts. This forgets the key Cody saved: OPENROUTER_API_KEY.
 * Something set on the server itself stays. Remove it there." Empty when
 * nothing is removable. */
export function describeRemoval(plan: RemovalPlan, t: Translate, tn: TranslatePlural): string {
  const sentences = [
    ...plan.logins.map((login) => (login.accounts > 0
      ? tn("providerRemoval.signOutAccounts", login.accounts, { name: login.name })
      : t("providerRemoval.signOutLogin", { name: login.name }))),
    ...(plan.storedNames.length > 0
      ? [tn("providerRemoval.forgetKeys", plan.storedNames.length, { names: plan.storedNames.join(t("providerRemoval.listJoin")) })]
      : []),
    ...(plan.custom ? [tn("providerRemoval.removeEndpoint", plan.modelCount, { name: plan.name })] : []),
  ];
  if (sentences.length === 0) return "";
  if (plan.environmentNames.length > 0) sentences.push(t("providerRemoval.serverLeftover"));
  return sentences.join(" ");
}

/** The server's environment is the only thing left to remove: Cody can only
 * offer Disable. */
export function isEnvironmentOnly(plan: RemovalPlan): boolean {
  return !plan.removable && plan.environmentNames.length > 0;
}

/** The network calls Remove makes, injected so the order and the stop-at-
 * the-first-failure rule can be tested without a server. */
export interface RemovalSteps {
  signOut: (loginId: string) => Promise<{ removed: boolean; active: number }>;
  clearKey: (name: string) => Promise<void>;
  deleteEndpoint: () => Promise<void>;
}

export interface RemovalOutcome {
  /** What was actually taken off, in plain words, in the order it happened. */
  done: string[];
  /** The first step that failed, in plain words; the rest were not tried. */
  failure: string | null;
  /** Chats mid-reply that keep the old state until that reply ends. */
  active: number;
  /** Variables still set in the server's environment. */
  leftover: string[];
}

const reasonOf = (failure: unknown) => (failure instanceof Error ? failure.message : String(failure));

/** Sign-ins first, then saved keys, then the custom endpoint; stops at the
 * first failure so the report says exactly what was and was not removed. */
export async function runRemoval(plan: RemovalPlan, steps: RemovalSteps, t: Translate): Promise<RemovalOutcome> {
  const done: string[] = [];
  let active = 0;
  const outcome = (failure: string | null): RemovalOutcome => ({ done, failure, active, leftover: plan.environmentNames });
  for (const login of plan.logins) {
    try {
      const answer = await steps.signOut(login.loginId);
      active = Math.max(active, answer.active);
      if (answer.removed) done.push(t("providerRemoval.doneSignedOut", { name: login.name }));
    } catch (failure) {
      return outcome(t("providerRemoval.failSignOut", { name: login.name, reason: reasonOf(failure) }));
    }
  }
  for (const name of plan.storedNames) {
    try {
      await steps.clearKey(name);
      done.push(t("providerRemoval.doneForgot", { name }));
    } catch (failure) {
      return outcome(t("providerRemoval.failForget", { name, reason: reasonOf(failure) }));
    }
  }
  if (plan.custom) {
    try {
      await steps.deleteEndpoint();
      done.push(t("providerRemoval.doneRemoved", { name: plan.name }));
    } catch (failure) {
      return outcome(t("providerRemoval.failRemove", { name: plan.name, reason: reasonOf(failure) }));
    }
  }
  return outcome(null);
}

export interface RemovalReport {
  kind: "removed" | "nothing" | "failed";
  title: string;
  description?: string;
  /** Close the drawer: everything is gone and nothing lingers. */
  close: boolean;
}

/** The toast for a finished `runRemoval`. */
export function reportRemoval(outcome: RemovalOutcome, name: string, t: Translate, tn: TranslatePlural): RemovalReport {
  if (outcome.failure) {
    const partial = outcome.done.length > 0;
    return {
      kind: "failed",
      title: t(partial ? "providerRemoval.partlyRemoved" : "providerRemoval.removeFailed", { name }),
      description: [
        outcome.failure,
        partial ? t("providerRemoval.doneSoFar", { list: outcome.done.join(t("providerRemoval.listJoin")) }) : t("providerRemoval.nothingRemoved"),
        t("providerRemoval.restUntouched"),
      ].join(" "),
      close: false,
    };
  }
  const leftover = outcome.leftover.length > 0
    ? tn("providerRemoval.stillOnServer", outcome.leftover.length, { names: outcome.leftover.join(t("providerRemoval.listJoin")) })
    : null;
  const description = [leftover, activeChatNote(outcome.active, t)].filter(Boolean).join(" ");
  if (outcome.done.length === 0) {
    return {
      kind: "nothing",
      title: t("providerRemoval.nothingToRemove"),
      description: [t("providerRemoval.nothingSaved", { name }), description].filter(Boolean).join(" "),
      close: false,
    };
  }
  return { kind: "removed", title: t("providerRemoval.removedTitle", { name }), ...(description ? { description } : {}), close: leftover === null };
}

/** Deletes one custom endpoint from the saved list; refuses to write if the
 * list could not be read, so a failed read can never wipe the other endpoints. */
async function deleteCustomEndpoint(id: string, t: Translate): Promise<void> {
  const read = await fetch("/api/models-config");
  if (!read.ok) throw new Error(t("providerRemoval.readFailed", { status: read.status }));
  const current = await read.json().catch(() => null) as { providers?: Record<string, unknown> } | null;
  const providers = { ...(current?.providers ?? {}) };
  delete providers[id];
  const response = await fetch("/api/models-config", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ providers }) });
  const body = await response.json().catch(() => null) as { error?: string } | null;
  if (!response.ok || body?.error) throw new Error(body?.error || `HTTP ${response.status}`);
}

// ── The drawer ──────────────────────────────────────────────────────────────

export interface ProviderDetailProps {
  row: ProviderRow;
  response: ProvidersResponse;
  open: boolean;
  onClose: () => void;
  /** The sign-in the picker chose; expanded and started on open. */
  initialLoginId?: string | null;
  autoStart?: boolean;
  onChanged: () => void;
}

export function ProviderDetail({ row, response, open, onClose, initialLoginId = null, autoStart = false, onChanged }: ProviderDetailProps) {
  const { capabilities, engine } = useSettingsShell();
  const { t, tn } = useI18n();
  const shortName = response.engine.shortName;
  const canEdit = response.canEdit;
  const readOnly = response.instanceSource === "readonly";
  const [advancedDirty, setAdvancedDirty] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const onDirtyChange = useCallback((dirty: boolean) => setAdvancedDirty(dirty), []);
  // Only polls while this drawer is actually open; the directory behind it
  // already has its own usage read for the Usage summary block.
  const usage = useUsage(open);
  const usageAccounts = usage.snapshot?.accounts.filter((entry) => row.catalogIds.includes(entry.provider));

  const loginMethods = row.methods.filter((method) => method.loginId);
  const keyMethod = row.methods.find((method) => method.kind === "key" || method.kind === "env");
  const custom = row.methods.some((method) => method.kind === "custom");
  // OpenRouter's extra surface keys off the row id, which is the key-catalogue
  // id for a joined row — never the brand, which a custom endpoint pointed at
  // OpenRouter could also wear without being the account this reads.
  const isOpenRouter = row.id === "openrouter" && !custom;
  const [selectedLogin, setSelectedLogin] = useState<string>(() => initialLoginId ?? loginMethods.find((method) => method.state === "connected")?.loginId ?? loginMethods[0]?.loginId ?? "");
  const currentLogin = loginMethods.find((method) => method.loginId === selectedLogin) ?? loginMethods[0];
  const loginOptions: SelectOption<string>[] = loginMethods.map((method) => ({
    value: method.loginId as string,
    label: method.name ?? (method.loginId as string),
  }));
  const status = describeWinning(row, shortName);
  const models = describeModels(row);
  const hint = missingOptionalHint(row);
  const showCuration = engine?.id === "omp" && capabilities.models && capabilities.configEditor && row.connected && !custom
    && ((row.modelCount ?? 0) > CURATION_THRESHOLD || row.group === "gateway" || row.group === "local");
  // Disabling writes omp's own `disabledProviders`, the counterpart of the
  // Enable action below — reachable only where that write makes sense: omp,
  // an admin, a writable registry, a row not already disabled, and one with
  // a real provider id to disable (never a login id — see `orderIds`).
  const canDisable = engine?.id === "omp" && capabilities.configEditor && canEdit && !readOnly;
  const nativeSettings = useNativeSettings(canDisable);
  const showDisable = canDisable && !row.disabled && row.connected && row.orderIds.length > 0;
  const [disabling, setDisabling] = useState(false);

  const changed = () => {
    invalidateProviderReads();
    onChanged();
  };

  const enable = async () => {
    setActionError(null);
    try {
      for (const id of row.catalogIds) {
        const response = await fetch("/api/providers/enable", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: id }) });
        const body = await response.json().catch(() => null) as { error?: string } | null;
        if (!response.ok || body?.error) throw new Error(body?.error || `HTTP ${response.status}`);
      }
      changed();
      toast.success(t("providerRemoval.enabled", { name: row.name }));
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : String(failure);
      setActionError(message);
      toast.error(t("providerRemoval.enableFailed", { name: row.name }), message);
    }
  };

  const disable = async () => {
    setActionError(null);
    setDisabling(true);
    try {
      const current = nativeSettings.settings?.disabledProviders ?? [];
      const next = [...new Set([...current, ...row.orderIds])];
      await nativeSettings.patchTop({ disabledProviders: next });
      changed();
      toast.success(t("providerRemoval.disabled", { name: row.name }), t("providerRemoval.disabledNote"), { action: { label: t("providerRemoval.undo"), onClick: () => { void enable(); } } });
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : String(failure);
      setActionError(message);
      toast.error(t("providerRemoval.disableFailed", { name: row.name }), message);
    } finally {
      setDisabling(false);
    }
  };

  const plan = planRemoval(row);

  const remove = async () => {
    setRemoving(true);
    setActionError(null);
    const outcome = await runRemoval(plan, {
      signOut: async (loginId) => {
        const answer = await postLogout(loginId);
        // Not found: that sign-in is already gone, so there is nothing to undo.
        if (!answer.ok && answer.notFound) return { removed: false, active: 0 };
        if (!answer.ok) throw new Error(answer.message);
        return { removed: answer.removed, active: answer.active };
      },
      clearKey: (name) => putProviderKey(name, ""),
      deleteEndpoint: () => deleteCustomEndpoint(row.id, t),
    }, t);
    const report = reportRemoval(outcome, row.name, t, tn);
    setRemoving(false);
    setRemoveOpen(false);
    // Even a half-finished removal changed something: re-read either way.
    if (outcome.done.length > 0 || !outcome.failure) changed();
    if (report.kind === "failed") {
      setActionError(`${report.title}. ${report.description ?? ""}`.trim());
      toast.error(report.title, report.description);
    } else if (report.kind === "nothing") {
      toast.info(report.title, report.description);
    } else {
      toast.success(report.title, report.description);
    }
    if (report.close) onClose();
  };

  const dangerRows = [
    ...(showDisable
      ? [{
        title: `Disable in ${shortName}`,
        description: `Switches ${row.name} off in ${shortName}'s own config: none of its models are offered until it is enabled again.`,
        action: (
          <button type="button" className="ui-focus-ring" onClick={() => void disable()} disabled={disabling || !nativeSettings.settings} style={dangerButtonStyle}>
            {disabling ? <Loader2 size={13} aria-hidden="true" className="icon-spin" /> : null}
            Disable
          </button>
        ),
      }]
      : []),
    ...(canEdit && plan.removable
      ? [{
        title: t("providerRemoval.removeTitle", { name: row.name }),
        description: describeRemoval(plan, t, tn),
        action: (
          <button type="button" className="ui-focus-ring" onClick={() => setRemoveOpen(true)} disabled={readOnly && plan.custom} style={dangerButtonStyle}>
            <Trash2 size={13} aria-hidden="true" /> {t("providerRemoval.removeButton")}
          </button>
        ),
      }]
      : []),
    ...(canEdit && isEnvironmentOnly(plan)
      ? [{
        title: t("providerRemoval.statusServer"),
        description: t("providerRemoval.serverOnlyBody"),
        action: <span style={{ ...chipStyle, color: "var(--text-dim)" }}>{t("providerRemoval.serverOnlyChip")}</span>,
      }]
      : []),
  ];

  return (
    <Drawer open={open} title={row.name} presentation="side" onClose={onClose} dirty={advancedDirty} ariaLabel={`${row.name} provider`}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
        <ProviderTile brand={row.brand} size={36} />
        <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: status.tone === "ok" ? "var(--status-success)" : status.tone === "warn" ? "var(--status-warning)" : "var(--text-dim)" }}>{status.text}</span>
          <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{[models, hint].filter(Boolean).join(" · ") || (row.reason ?? "")}</span>
        </div>
      </div>
      {row.disabled && canEdit && (
        <div style={{ ...cardStyle, flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span style={{ flex: "1 1 160px", fontSize: 12, color: "var(--text-muted)" }}>Disabled in {shortName}: none of its models are offered.</span>
          <button type="button" className="ui-focus-ring" onClick={() => void enable()} disabled={readOnly} style={buttonStyle}>Enable</button>
        </div>
      )}
      {readOnly && (
        <div role="status" style={{ ...cardStyle, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.45 }}>
          <span><span style={{ ...chipStyle, color: "var(--status-warning)", marginRight: 6 }}>Read-only</span>{response.readonlyReason}</span>
        </div>
      )}
      {actionError && <ErrorLine>{actionError}</ErrorLine>}

      {loginMethods.length > 0 && capabilities.providerLogin && (
        <Section
          title="Subscription"
          aside={loginMethods.length > 1 && (
            <Select
              value={currentLogin?.loginId ?? null}
              onChange={setSelectedLogin}
              options={loginOptions}
              aria-label="Sign-in variant"
              width="220px"
            />
          )}
        >
          {currentLogin && (
            <LoginMethodCard
              key={currentLogin.loginId}
              row={row}
              method={currentLogin}
              canEdit={canEdit}
              shortName={shortName}
              autoStart={autoStart && currentLogin.loginId === initialLoginId}
              onChanged={changed}
              usageAccounts={usageAccounts}
            />
          )}
        </Section>
      )}

      {row.id === "anthropic" && engine?.id === "omp" && capabilities.providerLogin && currentLogin && (
        <ClaudeCreditsSection canEdit={canEdit} onChanged={changed} planAccounts={currentLogin.accounts} />
      )}

      {keyMethod && (
        <Section title="API key">
          <KeyMethodCard method={keyMethod} canEdit={canEdit} shortName={shortName} onSaved={changed} />
        </Section>
      )}

      {response.canVerify && canEdit && (row.connected || custom) && (
        <Section title={custom ? "Verify" : "Check"}>
          <VerifyControl row={row} custom={custom} />
        </Section>
      )}

      {/* OpenRouter's own surface. Placed after the key (the balance is
          meaningless without one) and before curation, because "how much is
          left" and "where does this route" are what people open this drawer
          for once the key is saved. */}
      {isOpenRouter && (
        <>
          <Section title="Credits">
            <OpenRouterCreditsSection canEdit={canEdit} />
          </Section>
          {canEdit && (
            <Section title="Key limits">
              <OpenRouterKeyLimitsSection />
            </Section>
          )}
          {capabilities.models && capabilities.configEditor && canEdit && (
            <Section title="Routing">
              <OpenRouterRoutingSection readOnly={readOnly} />
            </Section>
          )}
        </>
      )}

      {showCuration && (
        <Section title="Only these models">
          <OnlyTheseModels row={row} readOnly={readOnly} canEdit={canEdit} />
        </Section>
      )}

      {custom && capabilities.models && (
        <Section title="Advanced">
          {canEdit
            ? <AdvancedForm row={row} onDirtyChange={onDirtyChange} onSaved={() => { changed(); }} />
            : <div style={{ fontSize: 12, color: "var(--text-muted)" }}>Only an administrator can edit models.yml.</div>}
        </Section>
      )}

      <DangerZone rows={dangerRows} />
      <ConfirmDialog
        open={removeOpen}
        onOpenChange={setRemoveOpen}
        title={t("providerRemoval.removeConfirmTitle", { name: row.name })}
        description={describeRemoval(plan, t, tn)}
        confirmLabel={t("providerRemoval.removeButton")}
        danger
        busy={removing}
        onConfirm={() => void remove()}
      />
    </Drawer>
  );
}
