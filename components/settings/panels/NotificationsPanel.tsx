"use client";

/**
 * Settings › Notifications: push to the owner's phone through their own ntfy
 * server when a chat needs them, finishes, or breaks (`lib/notifications`).
 *
 * Layout, top to bottom: one connection card (master switch, server, topic,
 * token, Cody address, test), "What to send" (the catalog's groups, one row
 * per event), and a small behaviour card. Every write is a minimal
 * `NotificationPrefsPatch` PUT through the corner's `track`, and the route
 * cache takes the server's answer, so the rail's status line follows.
 *
 * Text fields commit on blur or Enter (never per keystroke); toggles and
 * selects apply optimistically and snap back if the server refuses. The token
 * never comes back from the server: only `hasToken` does.
 *
 * `SEARCH_ENTRIES` is derived from the same catalog the rows render from.
 */
import { AlertCircle, CheckCircle2, Send } from "lucide-react";
import { useContext, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import {
  FINISHED_MIN_SECONDS_CHOICES,
  NOTIFICATION_EVENTS,
  NOTIFICATION_EVENT_IDS,
  NOTIFICATION_GROUPS,
  PRIORITY_LABELS,
  QUOTA_LOW_PERCENT_CHOICES,
  type NotificationEventSpec,
  type NotificationPrefsPatch,
  type NtfyPriority,
  type PublicNotificationPrefs,
} from "@/lib/notifications/catalog";
import { invalidateSettingsRoutes, readSettingsRoute, setSettingsRouteData, useSettingsRoute } from "@/hooks/useSettingsData";
import { TextInput, SecretInput } from "@/components/ui/field";
import { Select, type SelectOption } from "@/components/ui/Select";
import { dangerButtonStyle, smallButtonStyle } from "../account-controls";
import { NativeSetting, SettingsHighlightContext, ToggleSwitch, chipStyle, slugify } from "../primitives";
import { SaveStatusCorner, useSaveStatus } from "../SaveStatus";
import type { SearchEntry } from "../search-index";
import { useSettingsShell } from "../shell-context";

export const NOTIFICATIONS_PANEL_ID = "notifications";
const ROUTE = "/api/notifications";

interface NotificationsPayload {
  prefs: PublicNotificationPrefs;
  defaults: PublicNotificationPrefs;
}

type TextKey = "server" | "topic" | "codyUrl";
type FieldKey = TextKey | "token";

const MASTER_LABEL = "Send notifications";
const ANSWER_LABEL = "Answer from the notification";
const SKIP_LABEL = "Skip the chat I'm looking at";

const TRAIL: readonly string[] = ["Cody", "Notifications"];

const CONNECTION_ENTRIES: ReadonlyArray<{ label: string; description: string; keywords: readonly string[] }> = [
  { label: MASTER_LABEL, description: "Master switch for push notifications. Nothing is sent while it is off.", keywords: ["ntfy", "push", "phone", "alert", "enable", "on", "off"] },
  { label: "ntfy server", description: "The ntfy server that delivers the pushes to your phone.", keywords: ["url", "host", "ntfy.sh", "self-hosted"] },
  { label: "Topic", description: "The ntfy topic your phone subscribes to.", keywords: ["ntfy", "channel", "subscribe"] },
  { label: "Access token", description: "Only needed when the topic requires a login.", keywords: ["ntfy", "password", "bearer", "tk_", "auth", "secret"] },
  { label: "Cody address", description: "The address your phone opens from a notification, and where answer buttons reply.", keywords: ["url", "link", "tailscale", "lan", "reachable", "open in cody"] },
  { label: "Send test", description: "Send a test notification with your saved settings.", keywords: ["try", "check", "verify"] },
];

export const SEARCH_ENTRIES: readonly SearchEntry[] = [
  ...CONNECTION_ENTRIES.map((entry): SearchEntry => ({
    id: slugify(entry.label),
    tab: "notifications",
    label: entry.label,
    description: entry.description,
    keywords: entry.keywords,
    breadcrumb: [...TRAIL],
    scope: "Cody only",
    action: "jump",
  })),
  ...NOTIFICATION_EVENTS.map((event): SearchEntry => ({
    id: slugify(event.label),
    tab: "notifications",
    label: event.label,
    description: event.description,
    keywords: ["notify", "push", "ntfy", "priority", ...(event.id === "finished" ? ["duration", "long"] : []), ...(event.id === "quotaLow" ? ["usage", "limit", "percent", "threshold"] : [])],
    breadcrumb: [...TRAIL, NOTIFICATION_GROUPS.find((group) => group.id === event.group)?.label ?? "What to send"],
    scope: "Cody only",
    action: "jump",
  })),
  {
    id: slugify(ANSWER_LABEL),
    tab: "notifications",
    label: ANSWER_LABEL,
    description: "Approve or pick an answer straight from the notification, with buttons.",
    keywords: ["buttons", "approve", "allow", "deny", "reply", "ntfy", "action"],
    breadcrumb: [...TRAIL, "Behaviour"],
    scope: "Cody only",
    action: "jump",
  },
  {
    id: slugify(SKIP_LABEL),
    tab: "notifications",
    label: SKIP_LABEL,
    description: "Do not notify about the chat you have open and are looking at.",
    keywords: ["viewing", "presence", "suppress", "focus", "open chat"],
    breadcrumb: [...TRAIL, "Behaviour"],
    scope: "Cody only",
    action: "jump",
  },
];

/* ───────────────────────────── helpers ───────────────────────────── */

function applyPatch(prefs: PublicNotificationPrefs, patch: NotificationPrefsPatch): PublicNotificationPrefs {
  const { token, events, ...rest } = patch;
  const next: PublicNotificationPrefs = { ...prefs, ...rest };
  if (token !== undefined) next.hasToken = token !== null && token !== "";
  if (events) {
    next.events = { ...prefs.events };
    for (const id of NOTIFICATION_EVENT_IDS) {
      const change = events[id];
      if (change) next.events[id] = { ...prefs.events[id], ...change };
    }
  }
  return next;
}

function formatMinSeconds(seconds: number): string {
  if (seconds === 0) return "Any length";
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  return `${Math.round(seconds / 3600)} h`;
}

/** The catalog's choices, plus the saved value when the server holds one the
 * hub does not offer (it accepts any integer in bounds), so the Select never
 * shows a blank trigger. */
function numberOptions(choices: readonly number[], current: number, format: (value: number) => string): SelectOption[] {
  const values = choices.includes(current) ? [...choices] : [...choices, current].sort((a, b) => a - b);
  return values.map((value) => ({ value: String(value), label: format(value) }));
}

const PRIORITY_OPTIONS: SelectOption[] = (Object.keys(PRIORITY_LABELS) as unknown as NtfyPriority[]).map((priority) => ({
  value: String(priority),
  label: PRIORITY_LABELS[priority],
}));

/* ───────────────────────────── building blocks ───────────────────────────── */

const cardStyle: CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-card)",
  background: "var(--bg-panel)",
  minWidth: 0,
};

const sectionHeadingStyle: CSSProperties = {
  margin: 0,
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "var(--text-muted)",
};

const mutedTextStyle: CSSProperties = { color: "var(--text-muted)", fontSize: 11, lineHeight: 1.45 };

/** A search jump target: scrolls into view and outlines when search lands on it. */
function Anchor({ id, children, style }: { id: string; children: ReactNode; style?: CSSProperties }) {
  const highlightId = useContext(SettingsHighlightContext);
  const ref = useRef<HTMLDivElement | null>(null);
  const highlighted = highlightId !== null && highlightId === id;
  useEffect(() => {
    if (highlighted) ref.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [highlighted]);
  return (
    <div
      ref={ref}
      data-search-id={id}
      style={{
        borderRadius: "var(--radius-control)",
        transition: "box-shadow var(--dur-fast)",
        ...(highlighted ? { boxShadow: "0 0 0 2px var(--accent)" } : {}),
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/** Label + control + hint or error. The error replaces the hint, in the
 * alert colour, so a refused value reads right where it was typed. */
function FieldRow({ id, label, hint, error, children }: { id: string; label: string; hint?: ReactNode; error?: string | null; children: ReactNode }) {
  return (
    <Anchor id={slugify(label)} style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0, padding: 2 }}>
      <label htmlFor={id} style={{ fontSize: 11.5, fontWeight: 600, color: "var(--text)" }}>{label}</label>
      {children}
      {error ? (
        <span role="alert" style={{ display: "flex", gap: 5, alignItems: "flex-start", color: "var(--status-error)", fontSize: 11, lineHeight: 1.45 }}>
          <AlertCircle size={12} aria-hidden style={{ flexShrink: 0, marginTop: 2 }} />
          {error}
        </span>
      ) : hint ? (
        <span style={mutedTextStyle}>{hint}</span>
      ) : null}
    </Anchor>
  );
}

/** Pressing Enter in a field commits it the same way leaving it does: by
 * blurring, so blur is the one commit path and a save never fires twice. */
function blurOnEnter(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== "Enter") return;
  const target = event.target;
  if (target instanceof HTMLInputElement) target.blur();
}

function EventRow({
  spec,
  prefs,
  first,
  isMobile,
  onChange,
}: {
  spec: NotificationEventSpec;
  prefs: PublicNotificationPrefs;
  first: boolean;
  isMobile: boolean;
  onChange: (patch: NotificationPrefsPatch) => void;
}) {
  const event = prefs.events[spec.id];
  const setEvent = (change: Partial<{ enabled: boolean; priority: NtfyPriority }>) => onChange({ events: { [spec.id]: change } as NotificationPrefsPatch["events"] });
  const extras = spec.id === "finished"
    ? (
      <ControlLabel label="Only if it took at least">
        <Select
          size="md"
          width={isMobile ? "100%" : 140}
          aria-label="Only notify if the reply took at least"
          value={String(prefs.finishedMinSeconds)}
          options={numberOptions(FINISHED_MIN_SECONDS_CHOICES, prefs.finishedMinSeconds, formatMinSeconds)}
          onChange={(value) => onChange({ finishedMinSeconds: Number(value) })}
        />
      </ControlLabel>
    )
    : spec.id === "quotaLow"
      ? (
        <ControlLabel label="When usage reaches">
          <Select
            size="md"
            width={isMobile ? "100%" : 100}
            aria-label="Warn when usage reaches"
            value={String(prefs.quotaLowPercent)}
            options={numberOptions(QUOTA_LOW_PERCENT_CHOICES, prefs.quotaLowPercent, (value) => `${value}%`)}
            onChange={(value) => onChange({ quotaLowPercent: Number(value) })}
          />
        </ControlLabel>
      )
      : null;

  return (
    <Anchor id={slugify(spec.label)} style={{ borderTop: first ? undefined : "1px solid var(--border)", borderRadius: 0 }}>
      <div style={{ padding: "4px 14px 10px", display: "flex", flexDirection: "column", gap: 8 }}>
        <label style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, minHeight: 44, paddingTop: 6, cursor: "pointer" }}>
          <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
            <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)" }}>{spec.label}</span>
            <span style={mutedTextStyle}>{spec.description}</span>
          </span>
          <ToggleSwitch checked={event.enabled} onChange={(enabled) => setEvent({ enabled })} />
        </label>
        {event.enabled && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end" }}>
            <ControlLabel label="Priority">
              <Select
                size="md"
                width={isMobile ? "100%" : 110}
                aria-label={`${spec.label} priority`}
                value={String(event.priority)}
                options={PRIORITY_OPTIONS}
                onChange={(value) => setEvent({ priority: Number(value) as NtfyPriority })}
              />
            </ControlLabel>
            {extras}
          </div>
        )}
      </div>
    </Anchor>
  );
}

function ControlLabel({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0, flex: "0 1 auto" }}>
      <span style={{ fontSize: 10.5, color: "var(--text-muted)" }}>{label}</span>
      {children}
    </div>
  );
}

type TestResult = { ok: true } | { ok: false; message: string };

/* ───────────────────────────── the panel ───────────────────────────── */

export function NotificationsPanel() {
  const { isMobile } = useSettingsShell();
  const route = useSettingsRoute<NotificationsPayload>(ROUTE);
  const { track } = useSaveStatus(NOTIFICATIONS_PANEL_ID);
  const prefs = route.data?.prefs ?? null;

  const [drafts, setDrafts] = useState<Partial<Record<TextKey, string>>>({});
  const [tokenDraft, setTokenDraft] = useState("");
  const [errors, setErrors] = useState<Partial<Record<FieldKey, string>>>({});
  const [pending, setPending] = useState(0);
  const inflight = useRef(0);
  const skippedResponse = useRef(false);
  const [origin, setOrigin] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  const setFieldError = (field: FieldKey, message: string | null) => {
    setErrors((current) => {
      if (message === null) {
        if (!(field in current)) return current;
        const next = { ...current };
        delete next[field];
        return next;
      }
      return { ...current, [field]: message };
    });
  };

  /** One PUT with a minimal patch. `optimistic` shows the new value before the
   * server answers (toggles and selects); a refusal re-reads the server's
   * truth. Resolves to whether the save landed. */
  const write = (patch: NotificationPrefsPatch, opts?: { field?: FieldKey; optimistic?: boolean }): Promise<boolean> => {
    const before = readSettingsRoute<NotificationsPayload>(ROUTE);
    if (opts?.optimistic && before) setSettingsRouteData<NotificationsPayload>(ROUTE, { ...before, prefs: applyPatch(before.prefs, patch) });
    return track(async () => {
      inflight.current += 1;
      setPending((count) => count + 1);
      try {
        const response = await fetch(ROUTE, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
        const body = await response.json().catch(() => ({})) as { prefs?: PublicNotificationPrefs; error?: string };
        if (!response.ok || body.error || !body.prefs) throw new Error(body.error || `HTTP ${response.status}`);
        // With another write still on the wire its answer is the newer one,
        // so only the last response to land updates the cache.
        const latest = readSettingsRoute<NotificationsPayload>(ROUTE);
        if (inflight.current === 1 && latest) setSettingsRouteData<NotificationsPayload>(ROUTE, { ...latest, prefs: body.prefs });
        else skippedResponse.current = true;
        if (opts?.field) setFieldError(opts.field, null);
      } catch (failure) {
        if (opts?.field) setFieldError(opts.field, failure instanceof Error ? failure.message : String(failure));
        throw failure;
      } finally {
        inflight.current -= 1;
        setPending((count) => count - 1);
        // The write whose answer we skipped may itself have failed: once the
        // line is quiet, re-read the server's truth.
        if (inflight.current === 0 && skippedResponse.current) {
          skippedResponse.current = false;
          invalidateSettingsRoutes(ROUTE, { exact: true });
        }
      }
    }).then((ok) => {
      if (!ok && opts?.optimistic) invalidateSettingsRoutes(ROUTE, { exact: true });
      return ok;
    });
  };

  const commitText = (key: TextKey) => {
    const draft = drafts[key];
    if (draft === undefined || !prefs) return;
    const next = draft.trim();
    const clear = () => setDrafts((current) => {
      if (current[key] !== draft) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
    if (next === prefs[key]) {
      clear();
      setFieldError(key, null);
      return;
    }
    setTestResult(null);
    void write({ [key]: next }, { field: key }).then((ok) => { if (ok) clear(); });
  };

  const commitToken = () => {
    const next = tokenDraft.trim();
    if (!next) {
      setTokenDraft("");
      return;
    }
    const sent = tokenDraft;
    setTestResult(null);
    void write({ token: next }, { field: "token" }).then((ok) => { if (ok) setTokenDraft((current) => (current === sent ? "" : current)); });
  };

  const clearToken = () => {
    setTokenDraft("");
    setTestResult(null);
    void write({ token: null }, { field: "token", optimistic: true });
  };

  const sendTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const response = await fetch(`${ROUTE}/test`, { method: "POST" });
      const body = await response.json().catch(() => null) as { ok?: boolean; error?: string; status?: number } | null;
      if (body?.ok === true) {
        setTestResult({ ok: true });
      } else {
        const reason = body?.error || `HTTP ${response.status}`;
        const status = typeof body?.status === "number" && !reason.includes(String(body.status)) ? ` (HTTP ${body.status})` : "";
        setTestResult({ ok: false, message: `${reason}${status}` });
      }
    } catch {
      setTestResult({ ok: false, message: "Could not reach Cody." });
    } finally {
      setTesting(false);
    }
  };

  const touch = isMobile ? { minHeight: 44 } : {};

  if (!prefs) {
    return (
      <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 12 }}>
        <PanelHeader />
        {route.error ? (
          <div role="alert" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", color: "var(--status-error)", fontSize: 12 }}>
            <AlertCircle size={13} aria-hidden /> Could not load notification settings: {route.error}
            <button type="button" className="ui-focus-ring" style={{ ...smallButtonStyle, ...touch }} onClick={() => { void route.reload(); }}>Retry</button>
          </div>
        ) : (
          <div role="status" style={{ ...mutedTextStyle, fontSize: 12 }}>Loading…</div>
        )}
      </div>
    );
  }

  const configured = prefs.server !== "" && prefs.topic !== "";
  const masterHint = !configured
    ? "Add a server and topic below, then switch this on."
    : prefs.enabled
      ? `Sending to ${prefs.server.replace(/^https?:\/\//, "")}/${prefs.topic}.`
      : "Off. Nothing is sent until you switch this on.";
  const serverValue = drafts.server ?? prefs.server;
  const topicValue = drafts.topic ?? prefs.topic;
  const codyUrlValue = drafts.codyUrl ?? prefs.codyUrl;
  const canTest = configured && pending === 0 && !testing;
  const columns = isMobile ? "1fr" : "repeat(2, minmax(0, 1fr))";

  return (
    <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 18, maxWidth: 760, boxSizing: "border-box", minWidth: 0 }}>
      <SaveStatusCorner panelId={NOTIFICATIONS_PANEL_ID} />
      <PanelHeader />

      {/* 1 · Connection */}
      <section aria-label="Connection" style={{ ...cardStyle, overflow: "hidden" }}>
        <Anchor id={slugify(MASTER_LABEL)} style={{ borderRadius: 0 }}>
          <label style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "10px 14px", minHeight: 52, cursor: "pointer" }}>
            <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
              <span style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)" }}>{MASTER_LABEL}</span>
                <span style={chipStyle}>Cody only</span>
              </span>
              <span style={mutedTextStyle}>{masterHint}</span>
            </span>
            <ToggleSwitch checked={prefs.enabled} onChange={(enabled) => { void write({ enabled }, { optimistic: true }); }} />
          </label>
        </Anchor>

        <div style={{ borderTop: "1px solid var(--border)", padding: 12, display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "grid", gridTemplateColumns: columns, gap: 12 }}>
            <FieldRow id="ntfy-server" label="ntfy server" error={errors.server} hint="Your ntfy server's address, e.g. https://ntfy.example.net.">
              <TextInput
                id="ntfy-server"
                value={serverValue}
                placeholder="https://ntfy.example.net"
                mono
                invalid={Boolean(errors.server)}
                autoComplete="off"
                spellCheck={false}
                onChange={(value) => { setDrafts((current) => ({ ...current, server: value })); setFieldError("server", null); }}
                onBlurValidate={() => commitText("server")}
                onKeyDown={blurOnEnter}
              />
            </FieldRow>
            <FieldRow id="ntfy-topic" label="Topic" error={errors.topic} hint="Subscribe to this topic in the ntfy app. Pick a hard-to-guess name: on a public server anyone who knows it can read it.">
              <TextInput
                id="ntfy-topic"
                value={topicValue}
                placeholder="cody-alerts"
                mono
                invalid={Boolean(errors.topic)}
                autoComplete="off"
                spellCheck={false}
                onChange={(value) => { setDrafts((current) => ({ ...current, topic: value })); setFieldError("topic", null); }}
                onBlurValidate={() => commitText("topic")}
                onKeyDown={blurOnEnter}
              />
            </FieldRow>
          </div>

          <FieldRow
            id="ntfy-token"
            label="Access token"
            error={errors.token}
            hint={prefs.hasToken ? "Type a new token to replace the saved one." : "Only needed when the topic requires a login. Sent as a Bearer token."}
          >
            <div onKeyDown={blurOnEnter}>
              <SecretInput
                id="ntfy-token"
                value={tokenDraft}
                placeholder={prefs.hasToken ? "A token is saved" : "tk_… (optional)"}
                invalid={Boolean(errors.token)}
                showLabel="Show token"
                hideLabel="Hide token"
                onChange={(value) => { setTokenDraft(value); setFieldError("token", null); }}
                onBlurValidate={commitToken}
              />
            </div>
            {prefs.hasToken && tokenDraft === "" && (
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span style={{ ...chipStyle, color: "var(--status-success, var(--text-muted))" }}>Token saved</span>
                <span style={mutedTextStyle}>It stays on the server and is never shown again.</span>
                <button type="button" className="ui-focus-ring" style={{ ...dangerButtonStyle, ...touch }} onClick={clearToken}>Clear token</button>
              </div>
            )}
          </FieldRow>

          <FieldRow
            id="ntfy-cody-address"
            label="Cody address"
            error={errors.codyUrl}
            hint="The address your phone opens when you tap a notification. Links and buttons only work where your phone can reach it, e.g. your home network or Tailscale."
          >
            <TextInput
              id="ntfy-cody-address"
              value={codyUrlValue}
              placeholder="https://cody.example.net"
              mono
              invalid={Boolean(errors.codyUrl)}
              autoComplete="off"
              spellCheck={false}
              onChange={(value) => { setDrafts((current) => ({ ...current, codyUrl: value })); setFieldError("codyUrl", null); }}
              onBlurValidate={() => commitText("codyUrl")}
              onKeyDown={blurOnEnter}
            />
            {prefs.codyUrl === "" && drafts.codyUrl === undefined && origin !== "" && (
              <div>
                <button
                  type="button"
                  className="ui-focus-ring"
                  style={{ ...smallButtonStyle, ...touch, maxWidth: "100%" }}
                  onClick={() => { setTestResult(null); void write({ codyUrl: origin }, { field: "codyUrl" }); }}
                >
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>Use {origin}</span>
                </button>
              </div>
            )}
          </FieldRow>

          <Anchor id={slugify("Send test")} style={{ display: "flex", flexDirection: "column", gap: 6, padding: 2 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <button
                type="button"
                className="ui-focus-ring"
                disabled={!canTest}
                aria-busy={testing || undefined}
                style={{ ...smallButtonStyle, ...touch, opacity: canTest ? 1 : 0.55, cursor: canTest ? "pointer" : "not-allowed" }}
                onClick={() => { void sendTest(); }}
              >
                <Send size={13} aria-hidden />
                {testing ? "Sending…" : "Send test"}
              </button>
              <span style={mutedTextStyle}>
                {configured ? "Uses the saved settings above; works even while notifications are off." : "Save a server and topic first."}
              </span>
            </div>
            {testResult?.ok === true && (
              <div role="status" style={{ display: "flex", gap: 6, alignItems: "center", color: "var(--status-success, var(--text))", fontSize: 12 }}>
                <CheckCircle2 size={13} aria-hidden style={{ flexShrink: 0 }} /> Sent. It should arrive on your phone in a moment.
              </div>
            )}
            {testResult?.ok === false && (
              <div role="alert" style={{ display: "flex", gap: 6, alignItems: "flex-start", color: "var(--status-error)", fontSize: 12, lineHeight: 1.45, overflowWrap: "anywhere" }}>
                <AlertCircle size={13} aria-hidden style={{ flexShrink: 0, marginTop: 2 }} /> {testResult.message}
              </div>
            )}
          </Anchor>
        </div>
      </section>

      {/* 2 + 3 · Choices stay editable while the master switch is off, just quieter. */}
      <div style={{ display: "flex", flexDirection: "column", gap: 18, opacity: prefs.enabled ? 1 : 0.65, transition: "opacity var(--dur-fast)" }}>
        {!prefs.enabled && (
          <div role="note" style={{ ...mutedTextStyle, fontSize: 12 }}>
            Notifications are off. Your choices below are saved and apply once you switch them on.
          </div>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <h4 style={{ ...sectionHeadingStyle, color: "var(--text)", fontSize: 12.5, letterSpacing: 0, textTransform: "none", fontWeight: 600 }}>What to send</h4>
          {NOTIFICATION_GROUPS.map((entry) => (
            <section key={entry.id} aria-label={entry.label} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                <h5 style={sectionHeadingStyle}>{entry.label}</h5>
                <span style={mutedTextStyle}>{entry.description}</span>
              </div>
              <div style={{ ...cardStyle, overflow: "hidden" }}>
                {NOTIFICATION_EVENTS.filter((event) => event.group === entry.id).map((spec, index) => (
                  <EventRow key={spec.id} spec={spec} prefs={prefs} first={index === 0} isMobile={isMobile} onChange={(patch) => { void write(patch, { optimistic: true }); }} />
                ))}
              </div>
            </section>
          ))}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <h4 style={{ ...sectionHeadingStyle, color: "var(--text)", fontSize: 12.5, letterSpacing: 0, textTransform: "none", fontWeight: 600 }}>Behaviour</h4>
          <NativeSetting
            label={ANSWER_LABEL}
            description="Approve or pick an answer straight from the notification. “Always allow” options are never offered as buttons. Needs the Cody address above."
            scope="Cody only"
            control={prefs.answerButtons && prefs.codyUrl === "" ? (
              <span style={{ ...mutedTextStyle, color: "var(--status-warning)" }}>No buttons will appear until a Cody address is set.</span>
            ) : undefined}
          >
            <ToggleSwitch checked={prefs.answerButtons} onChange={(answerButtons) => { void write({ answerButtons }, { optimistic: true }); }} />
          </NativeSetting>
          <NativeSetting
            label={SKIP_LABEL}
            description="Stay quiet about the chat you have open and are looking at, in any browser tab. Other chats still notify."
            scope="Cody only"
          >
            <ToggleSwitch checked={prefs.skipWhenViewing} onChange={(skipWhenViewing) => { void write({ skipWhenViewing }, { optimistic: true }); }} />
          </NativeSetting>
        </div>
      </div>
    </div>
  );
}

function PanelHeader() {
  return (
    <div>
      <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>Notifications</h3>
      <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--text-muted)" }}>Get a push on your phone through your own ntfy server when Cody needs you.</p>
    </div>
  );
}

