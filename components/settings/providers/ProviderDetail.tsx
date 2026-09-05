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
import { AlertCircle, AlertTriangle, Check, ChevronDown, ChevronRight, KeyRound, Loader2, LogIn, LogOut, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ModelCatalogPicker } from "@/components/ModelCatalogPicker";
import { ModelEntryEditor, ProviderEntryEditor, type ModelEntry, type ModelsFileData, type ProviderEntry } from "@/components/ModelsConfig";
import { ConfirmDialog } from "@/components/ui/field";
import { toast } from "@/components/ui/toast";
import { useNativeSettings } from "@/hooks/useConfigWriter";
import { useModelCatalog } from "@/hooks/useModelCatalog";
import { useSettingsRoute } from "@/hooks/useSettingsData";
import { formatApiError } from "@/lib/i18n/api-error";
import { providerGlob } from "@/lib/model-allow-list";
import { omitUntouchedModelDrafts } from "@/lib/models-config-drafts";
import { isSubscriptionLogin, type ProviderMethod, type ProviderMethodVariable, type ProviderRow, type ProvidersResponse } from "@/lib/provider-directory";
import { DangerZone } from "../DangerZone";
import { Drawer } from "../Drawer";
import { ModelCurationDialog } from "../models/ModelCurationDialog";
import { chipStyle, nativeInputStyle, ToggleSwitch } from "../primitives";
import { ProviderLoginFlow, type ProviderLoginRow } from "../ProviderLoginFlow";
import { useSaveStatus } from "../SaveStatus";
import { useSettingsShell } from "../shell-context";
import { buttonStyle, cardStyle, dangerButtonStyle, describeModels, describeWinning, invalidateProviderReads, missingOptionalHint, pluralModels, primaryButtonStyle, ProviderTile, quietButtonStyle, sectionTitleStyle } from "./controls";

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

function LoginMethodCard({ row, method, canEdit, shortName, autoStart, onChanged }: {
  row: ProviderRow;
  method: ProviderMethod;
  canEdit: boolean;
  shortName: string;
  autoStart: boolean;
  onChanged: () => void;
}) {
  const [expanded, setExpanded] = useState(autoStart);
  const [starting, setStarting] = useState(autoStart);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const provider = loginRowOf(row, method);
  const connected = method.state === "connected";

  const logout = async () => {
    setLogoutError(null);
    setLoggingOut(true);
    try {
      const response = await fetch(`/api/auth/logout/${encodeURIComponent(provider.id)}`, { method: "POST" });
      const body = await response.json().catch(() => null) as { error?: string; code?: string } | null;
      if (!response.ok) {
        setLogoutError(body?.error || body?.code ? formatApiError(body ?? {}) : `HTTP ${response.status}`);
        return;
      }
      setExpanded(false);
      onChanged();
    } catch (failure) {
      setLogoutError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setLoggingOut(false);
    }
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
          <button type="button" className="ui-focus-ring" onClick={() => { setLogoutError(null); setStarting(true); setExpanded(true); }} aria-expanded={expanded} style={connected ? buttonStyle : primaryButtonStyle}>
            {connected ? <RefreshCw size={12} aria-hidden="true" /> : <LogIn size={12} aria-hidden="true" />}
            {connected ? "Re-login" : "Sign in"}
          </button>
          {connected && method.canLogout && (
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
      {connected && !method.canLogout && (
        <p style={{ margin: 0, fontSize: 11, color: "var(--text-dim)", lineHeight: 1.45 }}>
          Sign out from the {shortName} TUI (<code style={{ fontFamily: "var(--font-mono)" }}>/logout</code> in a Cody terminal); {shortName} keeps this credential in its own store.
        </p>
      )}
      {logoutError && <ErrorLine>{logoutError}</ErrorLine>}
      {canEdit && expanded && (
        <div style={{ borderTop: "1px solid var(--border)", paddingTop: 10 }}>
          <ProviderLoginFlow key={provider.id} provider={provider} onChanged={onChanged} autoStart={starting} compact />
        </div>
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
  const inputId = `provider-key-${variable.name}`;

  const submit = async (value: string) => {
    setBusy(true);
    setError(null);
    try {
      await putProviderKey(variable.name, value);
      setDraft("");
      onWritten(value.trim().length > 0);
      setSavedTick(true);
      setTimeout(() => setSavedTick(false), 1800);
      onSaved();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  const status = stored ? "Saved in Cody" : variable.fromEnvironment ? "Set on the container" : "Not set";
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
                <code style={{ flex: 1, minWidth: 0, fontSize: 12, fontFamily: "var(--font-mono)", color: model.id ? "var(--text)" : "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{model.id || "new model"}</code>
                {model.reasoning && <span style={{ ...chipStyle, color: "var(--accent)" }}>thinking</span>}
                <ChevronRight size={14} aria-hidden="true" style={{ color: "var(--text-dim)" }} />
              </button>
            ))}
          </div>
        )}
      </div>
      {saveError && <ErrorLine>{saveError}</ErrorLine>}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <button type="button" className="ui-focus-ring" onClick={cancel} disabled={!dirty || saving} style={{ ...quietButtonStyle, opacity: dirty ? 1 : 0.6 }}>Cancel</button>
        <button type="button" className="ui-focus-ring" onClick={() => void save()} disabled={!dirty || saving} style={{ ...primaryButtonStyle, opacity: dirty ? 1 : 0.6 }}>
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
  const shortName = response.engine.shortName;
  const canEdit = response.canEdit;
  const readOnly = response.instanceSource === "readonly";
  const [advancedDirty, setAdvancedDirty] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const onDirtyChange = useCallback((dirty: boolean) => setAdvancedDirty(dirty), []);

  const loginMethods = row.methods.filter((method) => method.loginId);
  const keyMethod = row.methods.find((method) => method.kind === "key" || method.kind === "env");
  const custom = row.methods.some((method) => method.kind === "custom");
  const [selectedLogin, setSelectedLogin] = useState<string>(() => initialLoginId ?? loginMethods.find((method) => method.state === "connected")?.loginId ?? loginMethods[0]?.loginId ?? "");
  const currentLogin = loginMethods.find((method) => method.loginId === selectedLogin) ?? loginMethods[0];
  const status = describeWinning(row, shortName);
  const models = describeModels(row);
  const hint = missingOptionalHint(row);
  const storedVariables = (keyMethod?.variables ?? []).filter((variable) => variable.stored);
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
    } catch (failure) {
      setActionError(failure instanceof Error ? failure.message : String(failure));
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
    } catch (failure) {
      setActionError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setDisabling(false);
    }
  };

  const remove = async () => {
    setRemoving(true);
    setActionError(null);
    try {
      if (custom) {
        const current = await fetch("/api/models-config").then((r) => (r.ok ? r.json() : null)) as { providers?: Record<string, unknown> } | null;
        const providers = { ...(current?.providers ?? {}) };
        delete providers[row.id];
        const response = await fetch("/api/models-config", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ providers }) });
        const body = await response.json().catch(() => null) as { error?: string } | null;
        if (!response.ok || body?.error) throw new Error(body?.error || `HTTP ${response.status}`);
      }
      for (const variable of storedVariables) await putProviderKey(variable.name, "");
      setRemoveOpen(false);
      changed();
      toast.success(`${row.name} removed`);
      onClose();
    } catch (failure) {
      setActionError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setRemoving(false);
    }
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
    ...(canEdit && (custom || storedVariables.length > 0)
      ? [{
        title: custom ? `Remove ${row.name}` : `Clear the saved ${storedVariables.length === 1 ? "key" : "keys"}`,
        description: custom
          ? `Deletes ${row.name} and its ${pluralModels(row.modelCount ?? 0)} from models.yml.`
          : `Forgets ${storedVariables.map((variable) => variable.name).join(", ")} saved in Cody. A value set on the container stays.`,
        action: (
          <button type="button" className="ui-focus-ring" onClick={() => setRemoveOpen(true)} disabled={readOnly && custom} style={dangerButtonStyle}>
            <Trash2 size={13} aria-hidden="true" /> {custom ? "Remove" : "Clear"}
          </button>
        ),
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
            <select value={currentLogin?.loginId} onChange={(event) => setSelectedLogin(event.target.value)} aria-label="Sign-in variant" style={{ minHeight: 32, padding: "4px 8px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg)", color: "var(--text)", fontSize: 12, maxWidth: 220 }}>
              {loginMethods.map((method) => <option key={method.loginId} value={method.loginId}>{method.name ?? method.loginId}</option>)}
            </select>
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
            />
          )}
        </Section>
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
        title={custom ? `Remove ${row.name}?` : `Clear the saved key for ${row.name}?`}
        description={custom
          ? `${row.name} and its ${pluralModels(row.modelCount ?? 0)} are deleted from models.yml. Sessions using them lose the provider on their next start.`
          : `${storedVariables.map((variable) => variable.name).join(", ")} saved in Cody will be forgotten. Sessions started afterwards run without it${keyMethod?.variables?.some((variable) => variable.fromEnvironment) ? ", falling back to the container's value" : ""}.`}
        confirmLabel={custom ? "Remove" : "Clear"}
        danger
        busy={removing}
        onConfirm={() => void remove()}
      />
    </Drawer>
  );
}
