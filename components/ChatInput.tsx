"use client";

import React, { useRef, useState, useCallback, useEffect, useImperativeHandle, forwardRef, memo, KeyboardEvent } from "react";
import { ChevronDown, ListChecks, Loader2, Paperclip, ShieldCheck, Sparkles, Target, TriangleAlert, Wrench } from "lucide-react";
import { getSubmitDuringRunBehavior } from "@/lib/composer-prefs";
import type { ToolPreset } from "@/lib/tool-presets";
import type { BuiltinSlashCommandResult, CompactResultInfo, QueuedMessages, SlashCommandInfo } from "@/hooks/useAgentSession";
import type { ActiveGoal, ActivePlan } from "@/lib/web-mode-state";
import { formatGoalElapsed } from "@/lib/web-mode-state";
import { toast } from "@/components/ui/toast";
import { formatCompactNumber, formatRelativeTime, usageToneColor } from "@/lib/format";
import { clearDraft, getDraft, setDraft, type ChatDraftFile, type ChatDraftImage } from "@/lib/draft-store";
import { WEB_SLASH_COMMANDS, expandWebSlashCommand } from "@/lib/web-slash-commands";
import { CHAT_COLUMN_MAX_WIDTH } from "@/lib/chat-layout";
import {
  composeMessageWithTextAttachments,
  MAX_ATTACHED_TEXT_BYTES,
  MAX_ATTACHED_TEXT_FILES,
  type AttachedTextFileData,
} from "@/lib/chat-attachments";
import {
  MAX_ATTACHED_IMAGE_BYTES,
  MAX_ATTACHED_IMAGES,
  isBase64ImageWithinLimits,
} from "@/lib/image-attachments";
import {
  checkPromptFrameBudget,
  formatAttachmentSize,
  prepareImageForAttachment,
  SUPPORTED_IMAGE_FORMAT_LABEL,
  UnsupportedImageError,
} from "@/lib/image-compress";
import {
  buildEntriesFromFiles, buildAtInsertText, extractAtQuery, filterFileEntries,
  type AtQueryMatch, type FileIndexEntry,
} from "@/lib/file-fuzzy";
import { FolderIcon, getFileIcon } from "./FileIcons";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useUsage } from "@/hooks/useUsage";
import { selectBindingWindow, selectWindowsForModel, type ModelRef } from "@/lib/usage/select";
import type { UsageAccount, UsageSnapshot, UsageWindow, UsageWindowState } from "@/lib/usage/types";
import { brandAccountLabel } from "@/lib/provider-brand";
import { ModelIcon, ProviderIcon } from "./ProviderIcon";
import { useI18n } from "@/lib/i18n";
import { selectableThinkingLevels } from "@/lib/thinking-levels";
import { STORAGE_EVENTS, STORAGE_KEYS } from "@/lib/storage-keys";

export interface AttachedImage {
  data: string;   // base64, no prefix (already compressed if it needed to be)
  mimeType: string;
  previewUrl: string; // object URL for display
  /** Original file name, when there was one — named in over-budget errors. */
  name?: string;
}

export type AttachedTextFile = AttachedTextFileData;

interface ModelOption {
  provider: string;
  modelId: string;
  name: string;
}

interface Props {
  onSend: (message: string, images?: AttachedImage[]) => void;
  onAbort: () => void;
  onSteer?: (message: string, images?: AttachedImage[]) => void;
  onFollowUp?: (message: string, images?: AttachedImage[]) => void;
  onPromptWithStreamingBehavior?: (message: string, behavior: "steer" | "followUp", images?: AttachedImage[]) => void;
  isStreaming: boolean;
  /** Active engine serves omp's advanced chat affordances. False means no
   * steering and no follow-up queue: nothing can be submitted mid-turn. */
  chatExtras?: boolean;
  model?: { provider: string; modelId: string } | null;
  isAutoModelSelection?: boolean;
  modelNames?: Record<string, string>;
  modelList?: { id: string; name: string; provider: string; supportsFastMode?: boolean }[];
  modelError?: string | null;
  modelsLoading?: boolean;
  onModelChange?: (provider: string, modelId: string) => void;
  /** Return a NEW session to auto ("Smart") model resolution. Present only
   * for a new, not-yet-spawned session — on a live session the Smart row
   * resolves the OMP roles default itself and calls onModelChange instead. */
  onSelectSmartModel?: () => void;
  /** Reports a live-session Smart pick after it resolved and pinned, so the
   * session state remembers the pin was Smart's answer (keeps the label on
   * "Smart · <model>" instead of reading like a manual pick). */
  onSmartModelPinned?: (provider: string, modelId: string) => void;
  /** The engine's last unprompted model switch for this session (retry
   * fallback, usage-aware routing). Renders a persistent marker beside the
   * model control naming what moved and why — the switch outlives its toast. */
  autoModelSwitch?: { from: string; to: string; role?: string; reason?: string } | null;
  fastModeEnabled?: boolean;
  fastModeActive?: boolean;
  fastModeSupported?: boolean;
  onFastModeChange?: (enabled: boolean) => void;
  /** Applied at spawn time only (--tools/--no-tools flags) — omp's RPC
   * protocol cannot change an already-running session's toolset. */
  toolPreset?: ToolPreset;
  onToolPresetChange?: (preset: ToolPreset) => void;
  onAbortCompaction?: () => void;
  isCompacting?: boolean;
  compactResult?: CompactResultInfo | null;
  thinkingLevel?: string;
  onThinkingLevelChange?: (level: string) => void;
  availableThinkingLevels?: string[] | null;
  thinkingLevelMap?: Record<string, string | null> | null;
  /** Display name for the current model when the catalog does not know it. */
  modelNameOverride?: string | null;
  retryInfo?: { attempt: number; maxAttempts: number; errorMessage?: string } | null;
  onAbortRetry?: () => void;
  queuedMessages?: QueuedMessages | null;
  inputHistory?: string[];
  /** Remove one queued message from the queue panel (Edit/Delete/Steer). */
  onRemoveQueuedMessage?: (text: string) => void;
  /** Relabel the first queued follow-up as a steering message. */
  onPromoteQueuedToSteer?: (text: string) => void;
  slashCommands?: SlashCommandInfo[];
  slashCommandsLoading?: boolean;
  onLoadSlashCommands?: () => Promise<SlashCommandInfo[]> | SlashCommandInfo[];
  onBuiltinCommand?: (message: string) => Promise<BuiltinSlashCommandResult>;
  onAudioUnlock?: () => void;
  draftKey?: string;
  /** Session working directory — enables the @ file autocomplete menu */
  cwd?: string | null;
  activeGoal?: ActiveGoal | null;
  activePlan?: ActivePlan | null;
  advisorEnabled?: boolean;
}

export interface ChatInputHandle {
  insertText: (text: string) => void;
  insertIfEmpty: (text: string) => void;
  prependText: (text: string) => void;
  addFiles: (files: File[]) => void;
}

// Most-to-least permissive, matching how a user thinks about "what am I
// giving up": Full keeps omp's whole builtin toolset (subagents, task lists,
// GitHub, web search, …); Core restricts to read/bash/edit/write only;
// None disables tools entirely.
const TOOL_PRESET_ORDER: ToolPreset[] = ["full", "default", "none"];
const TOOL_PRESET_LABEL_KEY: Record<ToolPreset, string> = {
  full: "chatInput.toolsFull",
  default: "chatInput.toolsDefault",
  none: "chatInput.toolsOff",
};
// Only the restrictive presets warn — Full loses nothing, so it gets no line.
const TOOL_PRESET_WARNING_KEY: Partial<Record<ToolPreset, string>> = {
  default: "chatInput.toolPresetCoreWarning",
  none: "chatInput.toolPresetNoneWarning",
};

const COMPOSITION_END_ENTER_GRACE_MS = 100;
/** Circumference of the composer ring (r = 9.5). */
const RING_CIRCUMFERENCE = 2 * Math.PI * 9.5;
/** Dashed track drawn when there is no quota to fill the ring with. */
const RING_ABSENT_DASH = "2.5 3.5";
/** How often the popover re-renders so "updated 2 min ago" stays true. */
const USAGE_FRESHNESS_TICK_MS = 30_000;
const COMPOSER_MODELS_STORAGE_KEY = STORAGE_KEYS.composerModels;

function readVisibleModelKeys(): Set<string> | null {
  try {
    const value = JSON.parse(localStorage.getItem(COMPOSER_MODELS_STORAGE_KEY) ?? "null");
    return Array.isArray(value) ? new Set(value.filter((item): item is string => typeof item === "string")) : null;
  } catch {
    return null;
  }
}

function compareModelOptions(collator: Intl.Collator, a: ModelOption, b: ModelOption): number {
  return collator.compare(a.name || a.modelId, b.name || b.modelId)
    || collator.compare(a.provider, b.provider)
    || collator.compare(a.modelId, b.modelId);
}

export interface QuotaWindowView {
  key: string;
  label: string;
  percent: number;
  color: string;
  state: UsageWindowState;
  exhausted: boolean;
  resetsAt: string | null;
}

/** One quota window the ring is deliberately NOT gauging — another provider's
 *  subscription, or another model tier on this one. Reported so a spent window
 *  is never a surprise, but kept out of everything that colours the ring. */
export interface QuotaOtherWindowView {
  key: string;
  /** Engine provider id, so the row can draw its brand mark. */
  provider: string;
  /** Account label, already branded ("Codex", never "Openai Codex"). */
  account: string;
  /** That account's binding window among the ones not shown above. */
  label: string;
  percent: number;
  state: UsageWindowState;
  exhausted: boolean;
  resetsAt: string | null;
}

export interface QuotaKnownView {
  known: true;
  /** Engine provider id of the binding account, for the header's brand mark. */
  provider: string;
  percent: number;
  color: string;
  state: UsageWindowState;
  label: string;
  resetsAt: string | null;
  windows: QuotaWindowView[];
  /** Everything the section above does not cover, de-emphasised. */
  others: QuotaOtherWindowView[];
  fetchedAt: string | null;
  stale: boolean;
}

export interface QuotaAbsentView {
  known: false;
  color: string;
  /** i18n key standing in for the headline percentage's meaning. */
  titleKey: string;
  /** i18n key for the explanation under the divider, if any. */
  noteKey: string | null;
  /** i18n key for the footer's scope line. */
  scopeKey: string;
  /** Engine-supplied prose explaining the gap, when it gave one. */
  reason: string | null;
  others: QuotaOtherWindowView[];
}

/** What the ring and the popover's quota half should say. A missing signal is
 *  a distinct shape — never a zero-percent reading — so nothing downstream can
 *  accidentally paint "0%" over an engine that simply does not report limits. */
export type QuotaView = QuotaKnownView | QuotaAbsentView;

/** The engine answered and reported no plan limits at all. Only reachable from
 *  an actual response — nothing else may claim this about an engine. */
const QUOTA_UNREPORTED: QuotaAbsentView = {
  known: false,
  color: "var(--text-muted)",
  titleKey: "usage.notReported",
  noteKey: "usage.notReportedNote",
  scopeKey: "usage.noQuotaSignal",
  reason: null,
  others: [],
};

/** No quota-reporting account serves the selected model's provider at all — a
 *  local runtime, say. Nothing this model spends is metered anywhere. */
const QUOTA_MODEL_UNMETERED: QuotaAbsentView = {
  known: false,
  color: "var(--text-muted)",
  titleKey: "usage.modelUnmetered",
  noteKey: "usage.modelUnmeteredNote",
  scopeKey: "usage.modelUnmeteredScope",
  reason: null,
  others: [],
};

/** The provider DOES report quota and none of it constrains this model (every
 *  window it reports is scoped to another model tier). Emphatically not the
 *  same as "no limits reported": the quota exists, it just cannot stop this
 *  model, and saying the former would hide a real limit the next model hits. */
const QUOTA_MODEL_UNCONSTRAINED: QuotaAbsentView = {
  known: false,
  color: "var(--text-muted)",
  titleKey: "usage.modelUnconstrained",
  noteKey: "usage.modelUnconstrainedNote",
  scopeKey: "usage.modelUnconstrainedScope",
  reason: null,
  others: [],
};

/** Cody never got an answer: the first read has not landed, or the last one
 *  failed (server restarting, proxy error page). Says nothing about the
 *  engine's limits, because nothing has established anything about them. */
const QUOTA_UNAVAILABLE: QuotaAbsentView = {
  known: false,
  color: "var(--text-muted)",
  titleKey: "usage.unavailableTitle",
  noteKey: "usage.unavailableNote",
  scopeKey: "usage.unavailableScope",
  reason: null,
  others: [],
};

/** A read is out and nothing has come back yet. */
const QUOTA_CHECKING: QuotaAbsentView = {
  known: false,
  color: "var(--text-muted)",
  titleKey: "usage.checking",
  noteKey: null,
  scopeKey: "usage.checkingScope",
  reason: null,
  others: [],
};

/** Machine reason codes ("engine_unsupported") must not reach the popover;
 *  only a sentence the server actually wrote for a human does. */
function readableReason(reason: string | null | undefined): string | null {
  if (typeof reason !== "string") return null;
  const trimmed = reason.trim();
  return trimmed.includes(" ") && trimmed.length <= 200 ? trimmed : null;
}

function clampQuotaPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

/** Severity ranking for the de-emphasised list: a refused window outranks a
 *  merely-full one, exactly as lib/usage/select ranks the binding one. */
const OTHER_STATE_RANK: Record<UsageWindowState, number> = { exhausted: 2, warning: 1, ok: 0 };

/**
 * Everything the primary section does not cover, one row per account.
 *
 * Scoping the ring to one model drops two things out of view: the other
 * providers' subscriptions, and this provider's windows that belong to another
 * model tier. Neither may colour the ring — they cannot stop this turn — but
 * neither may vanish either: discovering a spent week by running into it is
 * exactly the failure this whole change is fixing. So each account reports its
 * own binding window among whatever is left over.
 */
function buildOtherWindows(
  accounts: UsageAccount[],
  primary: { account: UsageAccount; windows: UsageWindow[] } | null,
): QuotaOtherWindowView[] {
  const shown = new Set((primary?.windows ?? []).map((window) => window.id));
  const rows: QuotaOtherWindowView[] = [];
  accounts.forEach((account, index) => {
    if (!account) return;
    const leftover = (account.windows ?? []).filter((window) => (
      Boolean(window) && !(account === primary?.account && shown.has(window.id))
    ));
    // Same comparator as the ring's own pick, so the row a user reads first is
    // the one that would stop them first on that account.
    const binding = selectBindingWindow([{ ...account, windows: leftover }]);
    if (!binding) return;
    rows.push({
      key: `${index}:${account.provider}:${binding.window.id}`,
      provider: account.provider,
      account: brandAccountLabel(account.provider, account.label || account.provider),
      label: binding.window.label,
      percent: clampQuotaPercent(binding.window.utilization),
      state: binding.window.state,
      exhausted: binding.window.state === "exhausted",
      resetsAt: binding.window.resetsAt,
    });
  });
  return rows.sort((a, b) => (
    (OTHER_STATE_RANK[b.state] ?? 0) - (OTHER_STATE_RANK[a.state] ?? 0) || b.percent - a.percent
  ));
}

/** Turns the usage snapshot into the ring's states. Pure, so the thresholds and
 *  the absence cases are testable without a DOM.
 *
 *  Quota is per provider, so the ring answers for the SELECTED model: an
 *  exhausted week on another provider says nothing about whether this model can
 *  run, and letting it drive the ring makes the gauge scream about a resource
 *  the conversation does not spend. With no model selected there is nothing to
 *  scope to, and the account-wide reading stands.
 *
 *  Absence comes in five flavours and they must not be conflated: still
 *  checking, could-not-read (never loaded, or the last read failed), the engine
 *  having genuinely answered "no limits here", this model's provider reporting
 *  no limits, and this model's provider reporting limits none of which apply to
 *  it. Only an actual answer is entitled to say anything about the engine. */
export function buildQuotaView(
  snapshot: UsageSnapshot | null,
  loading: boolean,
  failed = false,
  model?: ModelRef | null,
): QuotaView {
  if (!snapshot) {
    // A first read still in flight says "checking"; once one has failed, the
    // retries keep saying "could not read" rather than flipping back to
    // "checking" every poll. Neither one may speak for the engine.
    if (loading && !failed) return QUOTA_CHECKING;
    return QUOTA_UNAVAILABLE;
  }
  const accounts = snapshot.accounts ?? [];
  if (!snapshot.available || accounts.length === 0) {
    return { ...QUOTA_UNREPORTED, reason: readableReason(snapshot.reason) };
  }
  // Every account the engine reports is unlimited (a local runtime, say):
  // there is no quota to gauge, which is different from having no signal.
  if (accounts.every((account) => account.unlimited)) {
    return {
      known: false,
      color: "var(--text-muted)",
      titleKey: "usage.unlimitedTitle",
      noteKey: "usage.unlimitedNote",
      scopeKey: "usage.unlimited",
      reason: readableReason(snapshot.reason),
      others: [],
    };
  }

  // One account needs no disambiguation; several do, so each window carries
  // the account it belongs to — under its brand name, which is how the owner
  // knows the subscription ("Claude", not "Anthropic").
  const multipleAccounts = accounts.length > 1;
  const nameWindow = (account: UsageAccount, windowLabel: string) => {
    if (!multipleAccounts) return windowLabel;
    const accountLabel = brandAccountLabel(account.provider, account.label || account.provider);
    return accountLabel ? `${accountLabel} · ${windowLabel}` : windowLabel;
  };

  if (model) {
    const match = selectWindowsForModel(accounts, model);
    // windows[0] is the pick selectBindingWindowForModel makes — taking it here
    // selects once over the snapshot instead of twice, and guarantees the ring
    // and the list below it name the same window.
    const modelBinding = match?.windows[0] ?? null;
    const others = buildOtherWindows(accounts, modelBinding ? match : null);
    const reason = readableReason(snapshot.reason);

    if (!match || !modelBinding) {
      // Three different silences, and the copy has to tell them apart: no
      // account serves this provider / the account is unmetered / the account
      // reports quota that all belongs to other models.
      const providerReportsQuota = match !== null
        && match.account.unlimited !== true
        && (match.account.windows ?? []).some(Boolean);
      return providerReportsQuota
        ? { ...QUOTA_MODEL_UNCONSTRAINED, reason, others }
        : { ...QUOTA_MODEL_UNMETERED, reason, others };
    }

    const accountIndex = accounts.indexOf(match.account);
    const modelPercent = clampQuotaPercent(modelBinding.utilization);
    return {
      known: true,
      provider: match.account.provider,
      percent: modelPercent,
      color: usageToneColor(modelPercent, modelBinding.state),
      state: modelBinding.state,
      label: nameWindow(match.account, modelBinding.label),
      resetsAt: modelBinding.resetsAt,
      // Already most-binding-first from the selector, and left in that order:
      // the row a user reads first is the one that stops them first.
      windows: match.windows.map((quotaWindow) => {
        const percent = clampQuotaPercent(quotaWindow.utilization);
        return {
          key: `${accountIndex}:${match.account.provider}:${quotaWindow.id}`,
          label: nameWindow(match.account, quotaWindow.label),
          percent,
          color: usageToneColor(percent, quotaWindow.state),
          state: quotaWindow.state,
          exhausted: quotaWindow.state === "exhausted",
          resetsAt: quotaWindow.resetsAt,
        };
      }),
      others,
      fetchedAt: snapshot.fetchedAt ?? null,
      stale: snapshot.stale === true,
    };
  }

  const binding = selectBindingWindow(accounts);
  if (!binding) return { ...QUOTA_UNREPORTED, reason: readableReason(snapshot.reason) };

  const windows: QuotaWindowView[] = accounts
    // Window ids are unique only WITHIN an account, so two subscriptions on
    // one provider can report the same id. The row key carries the account's
    // position too — the list is re-sorted on every refresh, and duplicate
    // keys freeze the second account's row on stale numbers.
    .flatMap((account, accountIndex) => (account.windows ?? []).map((quotaWindow) => {
      const percent = clampQuotaPercent(quotaWindow.utilization);
      return {
        key: `${accountIndex}:${account.provider}:${quotaWindow.id}`,
        label: nameWindow(account, quotaWindow.label),
        percent,
        color: usageToneColor(percent, quotaWindow.state),
        state: quotaWindow.state,
        exhausted: quotaWindow.state === "exhausted",
        resetsAt: quotaWindow.resetsAt,
      };
    }))
    .sort((a, b) => b.percent - a.percent);

  const percent = clampQuotaPercent(binding.window.utilization);
  return {
    known: true,
    provider: binding.account.provider,
    percent,
    color: usageToneColor(percent, binding.window.state),
    state: binding.window.state,
    label: nameWindow(binding.account, binding.window.label),
    resetsAt: binding.window.resetsAt,
    windows,
    // The account-wide list above already shows every window there is.
    others: [],
    fetchedAt: snapshot.fetchedAt ?? null,
    stale: snapshot.stale === true,
  };
}

/** "18:20" for a reset later today, "Sun 09:00" once it crosses a day —
 *  matching how MessageView renders wall-clock times. */
function formatResetTime(iso: string | null, locale: string, now: number): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  const ts = at.getTime();
  if (!Number.isFinite(ts)) return null;
  const sameDay = at.toDateString() === new Date(now).toDateString();
  return sameDay
    ? at.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })
    : at.toLocaleString(locale, { weekday: "short", hour: "2-digit", minute: "2-digit" });
}

/** The one bar geometry every quota row shares: 4px track, pill radius. The
 *  de-emphasised rows dim the fill rather than changing shape, so the whole
 *  popover reads as one system. */
function QuotaBar({ percent, color, dimmed = false }: { percent: number; color: string; dimmed?: boolean }) {
  return (
    <div style={{ height: 4, overflow: "hidden", borderRadius: 999, background: "var(--border)" }}>
      <div style={{
        width: `${percent}%`,
        height: "100%",
        borderRadius: 999,
        background: color,
        opacity: dimmed ? 0.55 : 1,
        transition: "width var(--dur-med) var(--ease-out-warm), background var(--dur-fast) var(--ease-out-warm)",
      }} />
    </div>
  );
}

/** One window row: label / % / bar / reset. The primary list and the "not
 *  counted" list share this exact layout — the de-emphasised rows are the same
 *  design at a quieter volume, never a bar-less footnote. */
function QuotaWindowRow({
  icon,
  label,
  percent,
  color,
  exhausted,
  resetsAt,
  now,
  muted = false,
}: {
  icon?: React.ReactNode;
  label: string;
  percent: number;
  /** Bar fill; muted rows pass their quieter tone here, exhausted ones red. */
  color: string;
  exhausted: boolean;
  resetsAt: string | null;
  now: number;
  muted?: boolean;
}) {
  const { t, locale } = useI18n();
  const reset = formatResetTime(resetsAt, locale, now);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
          {icon}
          <div style={{
            fontSize: muted ? 11 : 12,
            fontWeight: 600,
            color: muted ? "var(--text-muted)" : "var(--text)",
            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
          }}>
            {label}
          </div>
          {exhausted && (
            <div style={{
              flexShrink: 0,
              fontSize: 9, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase",
              color: "var(--status-error)",
              border: "1px solid var(--status-error)",
              borderRadius: 999,
              padding: "1px 5px",
              whiteSpace: "nowrap",
            }}>
              {t("usage.exhausted")}
            </div>
          )}
        </div>
        <div style={{
          flexShrink: 0,
          fontSize: muted ? 11 : 12,
          fontWeight: 700,
          // A muted row's number stays quiet too — unless it is exhausted,
          // which keeps the error tone at full volume in both places.
          color: muted && !exhausted ? "var(--text-muted)" : color,
          fontVariantNumeric: "tabular-nums",
        }}>
          {`${Math.round(percent)}%`}
        </div>
      </div>
      <QuotaBar percent={percent} color={color} dimmed={muted && !exhausted} />
      {reset && (
        <div style={{ fontSize: 10, color: "var(--text-muted)", fontVariantNumeric: "tabular-nums" }}>
          {t("usage.resetsAt", { time: reset })}
        </div>
      )}
    </div>
  );
}

/** The quota ring's popover: plan quota for the selected model and nothing
 *  else — context usage and token traffic live in the top bar. Exported so the
 *  SSR tests can render it open, which the composer's own state never is. */
export function QuotaPopover({
  quota,
  provider,
  modelName,
  now,
}: {
  quota: QuotaView;
  /** Selected model's provider, naming the header before anything binds. */
  provider: string | null;
  modelName: string | null;
  now: number;
}) {
  const { t, locale } = useI18n();
  const percentText = quota.known ? `${Math.round(quota.percent)}%` : "—";
  const headlineReset = quota.known ? formatResetTime(quota.resetsAt, locale, now) : null;
  const age = quota.known && quota.fetchedAt ? formatRelativeTime(quota.fetchedAt, locale, now) : null;
  // Age is only claimed when the snapshot carries a usable timestamp, and a
  // snapshot the server flagged stale says so rather than passing for fresh.
  const freshness = age
    ? [t("usage.updatedAgo", { ago: age }), quota.known && quota.stale ? t("usage.stale") : null]
      .filter(Boolean).join(" · ")
    : null;

  return (
    <div
      role="dialog"
      aria-label={t("usage.title")}
      className="dropdown-surface"
      style={{
        position: "absolute",
        right: 0,
        bottom: "calc(100% + 8px)",
        zIndex: 120,
        width: 320,
        maxWidth: "calc(100vw - 32px)",
      }}
    >
      <div style={{ maxHeight: "min(400px, calc(100vh - 120px))", overflowY: "auto", padding: 16 }}>
        {/* Header — whose quota (brand mark + model) and the binding number. */}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <ProviderIcon
            provider={quota.known ? quota.provider : provider}
            size={14}
            style={{ flexShrink: 0, color: "var(--text-muted)" }}
          />
          <div style={{ flex: 1, minWidth: 0, fontSize: 12, fontWeight: 700, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {modelName ? t("usage.titleForModel", { model: modelName }) : t("usage.title")}
          </div>
          <div style={{ flexShrink: 0, fontSize: 16, fontWeight: 700, color: quota.color, fontVariantNumeric: "tabular-nums" }}>
            {percentText}
          </div>
        </div>
        {/* The headline always names the window it is quoting — a bare
            percentage would not say what ran out. */}
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8, marginTop: 4 }}>
          <div style={{ minWidth: 0, fontSize: 11, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {quota.known ? quota.label : t(quota.titleKey)}
          </div>
          {headlineReset && (
            <div style={{ flexShrink: 0, fontSize: 11, color: "var(--text-muted)", fontVariantNumeric: "tabular-nums" }}>
              {t("usage.resetsAt", { time: headlineReset })}
            </div>
          )}
        </div>
        {/* No bar without a reading: an empty track reads as 0%. */}
        {quota.known && (
          <div style={{ marginTop: 8 }}>
            <QuotaBar percent={quota.percent} color={quota.color} />
          </div>
        )}

        {/* Every OTHER window that constrains this model, most binding first —
            the binding one is already the headline above, and repeating it as
            the first row read as clutter (owner pass, 2026-08). Matched by
            label+reset rather than position: the account-wide view sorts its
            list by fullness, so the headline is not always windows[0]. */}
        {quota.known && quota.windows.some((entry) => entry.label !== quota.label || entry.resetsAt !== quota.resetsAt) && (
          <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--border)", display: "flex", flexDirection: "column", gap: 12 }}>
            {quota.windows.filter((entry) => entry.label !== quota.label || entry.resetsAt !== quota.resetsAt).map((entry) => (
              <QuotaWindowRow
                key={entry.key}
                label={entry.label}
                percent={entry.percent}
                color={entry.color}
                exhausted={entry.exhausted}
                resetsAt={entry.resetsAt}
                now={now}
              />
            ))}
          </div>
        )}

        {!quota.known && (quota.noteKey || quota.reason) && (
          <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--border)", fontSize: 11, lineHeight: 1.5, color: "var(--text-muted)" }}>
            {quota.noteKey ? t(quota.noteKey) : quota.reason}
            {quota.noteKey && quota.reason && (
              <div style={{ marginTop: 4, color: "var(--text-dim)" }}>{quota.reason}</div>
            )}
          </div>
        )}

        {/* Everything the model above is NOT charged against — other
            providers' subscriptions and this one's other tiers. Same row
            design as the list above, dimmed: a spent window here must stay
            visible, and must never colour the ring. */}
        {quota.others.length > 0 && (
          <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--border)" }}>
            <div style={{ marginBottom: 8, fontSize: 10, fontWeight: 700, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.045em" }}>
              {t("usage.notForThisModel")}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {quota.others.map((entry) => (
                <QuotaWindowRow
                  key={entry.key}
                  icon={<ProviderIcon provider={entry.provider} size={11} style={{ flexShrink: 0, color: "var(--text-dim)" }} />}
                  label={t("usage.notForThisModelRow", { account: entry.account, window: entry.label })}
                  percent={entry.percent}
                  color={entry.exhausted ? "var(--status-error)" : "var(--text-dim)"}
                  exhausted={entry.exhausted}
                  resetsAt={entry.resetsAt}
                  now={now}
                  muted
                />
              ))}
            </div>
            <div style={{ marginTop: 8, fontSize: 10, lineHeight: 1.45, color: "var(--text-dim)" }}>
              {t("usage.notForThisModelNote")}
            </div>
          </div>
        )}

        {/* Footer — whose limits these are, and how fresh the reading is. */}
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--border)", display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
          <div style={{ fontSize: 10, color: "var(--text-muted)" }}>
            {!quota.known
              ? t(quota.scopeKey)
              : modelName ? t("usage.modelScope") : t("usage.accountWide")}
          </div>
          {freshness && (
            <div style={{ flexShrink: 0, fontSize: 10, color: "var(--text-muted)", fontVariantNumeric: "tabular-nums" }}>
              {freshness}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const THINKING_LEVEL_DESC_KEYS: Record<string, string> = {
  auto: "chatInput.thinkingAuto",
  off: "chatInput.thinkingOff",
  minimal: "chatInput.thinkingMinimal",
  low: "chatInput.thinkingLow",
  medium: "chatInput.thinkingMedium",
  high: "chatInput.thinkingHigh",
  xhigh: "chatInput.thinkingXhigh",
  max: "chatInput.thinkingMax",
};

function formatTokenCount(tokens: number, locale: string): string {
  return formatCompactNumber(tokens, locale);
}

type SlashCommandSource = "builtin" | "extension" | "prompt" | "skill" | "ompBuiltin";

type SlashCommandPaletteItem = {
  name: string;
  description?: string;
  /** Bracketed argument hint rendered after the command name, e.g. "[goal]". */
  argumentHint?: string;
  source: SlashCommandSource;
};

function isDormantSkillCommand(command: SlashCommandPaletteItem, dormantNames: Set<string>): boolean {
  return command.source === "skill" && dormantNames.has(command.name);
}

const BUILTIN_SLASH_COMMAND_DEFS: { name: string; descriptionKey: string; argumentHintKey?: string }[] = [
  // Web-native prompt-composing commands (goal/plan/... are TUI-only in omp and
  // never execute over the RPC prompt path — see lib/web-slash-commands.ts).
  ...WEB_SLASH_COMMANDS.map((command) => ({
    name: command.name,
    descriptionKey: command.descriptionKey,
    argumentHintKey: command.argumentHintKey,
  })),
  { name: "compact", descriptionKey: "chatInput.cmdCompact" },
  { name: "reload", descriptionKey: "chatInput.cmdReload" },
  { name: "name", descriptionKey: "chatInput.cmdName" },
  { name: "session", descriptionKey: "chatInput.cmdSession" },
  { name: "copy", descriptionKey: "chatInput.cmdCopy" },
];

const CLIENT_BUILTIN_COMMAND_NAMES = new Set(BUILTIN_SLASH_COMMAND_DEFS.map((def) => def.name));

const SLASH_SOURCES: SlashCommandSource[] = ["builtin", "extension", "prompt", "skill", "ompBuiltin"];

const SLASH_SOURCE_GROUP_LABEL_KEYS: Record<SlashCommandSource, string> = {
  builtin: "chatInput.groupBuiltin",
  extension: "chatInput.groupExtensions",
  prompt: "chatInput.groupPrompts",
  skill: "chatInput.groupSkills",
  ompBuiltin: "chatInput.groupOmpBuiltin",
};

const SLASH_SOURCE_ORDER: Record<SlashCommandSource, number> = {
  builtin: 0,
  extension: 1,
  prompt: 2,
  skill: 3,
  ompBuiltin: 4,
};

function slashMatchRank(command: SlashCommandPaletteItem, query: string): number {
  const name = command.name.toLowerCase();
  const description = command.description?.toLowerCase() ?? "";
  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  if (name.includes(query)) return 2;
  if (description.includes(query)) return 3;
  return 4;
}

function imageToDraftImage(image: AttachedImage): ChatDraftImage {
  return { data: image.data, mimeType: image.mimeType, ...(image.name ? { name: image.name } : {}) };
}

function draftImageToAttachedImage(image: ChatDraftImage): AttachedImage {
  return {
    ...image,
    previewUrl: `data:${image.mimeType};base64,${image.data}`,
  };
}

function draftImagesToAttachedImages(images: ChatDraftImage[] | undefined): AttachedImage[] {
  return (images ?? [])
    .filter(isBase64ImageWithinLimits)
    .slice(0, MAX_ATTACHED_IMAGES)
    .map(draftImageToAttachedImage);
}
function textFileToDraftFile(file: AttachedTextFile): ChatDraftFile {
  return { name: file.name, mimeType: file.mimeType, content: file.content, size: file.size };
}

function draftFilesToAttachedFiles(files: ChatDraftFile[] | undefined): AttachedTextFile[] {
  return (files ?? [])
    .filter((file) => typeof file.name === "string"
      && typeof file.mimeType === "string"
      && typeof file.content === "string"
      && Number.isFinite(file.size)
      && file.size <= MAX_ATTACHED_TEXT_BYTES)
    .slice(0, MAX_ATTACHED_TEXT_FILES);
}

function revokeImagePreview(image: AttachedImage): void {
  if (image.previewUrl.startsWith("blob:")) {
    URL.revokeObjectURL(image.previewUrl);
  }
}

/** Compact action button for the queued follow-up bar. */
function QueuedActionButton({
  onClick,
  title,
  accent = false,
  children,
}: {
  onClick: () => void;
  title: string;
  accent?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      style={{
        flexShrink: 0,
        padding: "3px 7px",
        border: "none",
        borderRadius: 6,
        background: "transparent",
        color: accent ? "var(--accent)" : "var(--text-dim)",
        cursor: "pointer",
        fontSize: 11,
        fontWeight: accent ? 600 : 400,
        transition: "background var(--dur-fast) var(--ease-out-warm), color var(--dur-fast) var(--ease-out-warm)",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "var(--bg-hover)";
        if (!accent) e.currentTarget.style.color = "var(--text-muted)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
        if (!accent) e.currentTarget.style.color = "var(--text-dim)";
      }}
    >
      {children}
    </button>
  );
}

export function ModelErrorBanner({ error }: { error?: string | null }) {
  const { t } = useI18n();
  if (!error) return null;
  return (
    <div
      role="alert"
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 8,
        maxHeight: 120,
        marginBottom: 8,
        padding: "7px 10px",
        overflowY: "auto",
        border: "1px solid color-mix(in srgb, var(--status-error) 35%, transparent)",
        borderRadius: "var(--radius-control)",
        background: "color-mix(in srgb, var(--status-error) 8%, transparent)",
        color: "var(--status-error)",
        fontSize: 11,
        lineHeight: 1.45,
      }}
    >
      <svg
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ flexShrink: 0, marginTop: 1 }}
        aria-hidden="true"
      >
        <path d="M10.3 2.9 1.8 17a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 2.9a2 2 0 0 0-3.4 0Z" />
        <line x1="12" y1="9" x2="12" y2="13" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 600 }}>{t("chatInput.modelError")}</div>
        <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{error}</div>
      </div>
    </div>
  );
}

function ComposerModeStatus({ goal, plan }: { goal?: ActiveGoal | null; plan?: ActivePlan | null }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!goal) return;
    setExpanded(false);
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [goal]);

  if (!goal && !plan) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 8 }}>
      {goal && (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          title={expanded ? t("chatInput.collapseGoal") : t("chatInput.expandGoal")}
          style={{
            display: "flex", alignItems: expanded ? "flex-start" : "center", gap: 8,
            width: "100%", padding: "6px 9px",
            border: "1px solid color-mix(in srgb, var(--accent) 32%, var(--border))",
            borderRadius: "var(--radius-control)",
            background: "color-mix(in srgb, var(--accent) 7%, var(--bg-panel))",
            color: "var(--text)", cursor: "pointer", textAlign: "left",
            transition: "background var(--dur-fast) var(--ease-out-warm), border-color var(--dur-fast) var(--ease-out-warm)",
          }}
        >
          <Target size={14} strokeWidth={2} style={{ flexShrink: 0, marginTop: expanded ? 1 : 0, color: "var(--accent)" }} aria-hidden="true" />
          <span style={{ flexShrink: 0, color: "var(--text-dim)", fontSize: 10, fontFamily: "var(--font-mono)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
            {t("chatInput.goalActive")} · {formatGoalElapsed(now - goal.startedAt)}
          </span>
          <span style={{ minWidth: 0, flex: 1, overflow: expanded ? "visible" : "hidden", textOverflow: expanded ? undefined : "ellipsis", whiteSpace: expanded ? "pre-wrap" : "nowrap", fontSize: 12, lineHeight: 1.4 }}>
            {goal.objective}
          </span>
        </button>
      )}
      {plan && (
        <div role="status" aria-live="polite" style={{ display: "flex", alignItems: "center", gap: 7, padding: "5px 9px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-panel)", color: "var(--text-muted)", fontSize: 12 }}>
          <ListChecks size={14} strokeWidth={2} style={{ flexShrink: 0, color: "var(--accent)" }} aria-hidden="true" />
          <span style={{ fontWeight: 600 }}>{t("chatInput.planningInProgress")}</span>
          <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-dim)" }}>{plan.objective}</span>
        </div>
      )}
    </div>
  );
}

export const ChatInput = memo(forwardRef<ChatInputHandle, Props>(function ChatInput({
  onSend, onAbort, onSteer, onFollowUp, isStreaming, chatExtras = true, model, isAutoModelSelection, modelNames, modelList, modelError, modelsLoading, onModelChange, onSelectSmartModel, onSmartModelPinned, autoModelSwitch, fastModeEnabled, fastModeActive, fastModeSupported, onFastModeChange, toolPreset, onToolPresetChange,
  onAbortCompaction, isCompacting, compactResult,
  thinkingLevel, onThinkingLevelChange, availableThinkingLevels, thinkingLevelMap, modelNameOverride,
  retryInfo, queuedMessages, inputHistory = [], onAbortRetry,
  slashCommands, slashCommandsLoading, onLoadSlashCommands,
  onBuiltinCommand,
  onAudioUnlock,
  onPromptWithStreamingBehavior,
  onRemoveQueuedMessage,
  onPromoteQueuedToSteer,
  draftKey,
  cwd,
  activeGoal,
  activePlan,
  advisorEnabled,
}: Props, ref) {
  const isMobile = useIsMobile();
  const { t, tn, locale } = useI18n();
  const {
    snapshot: usageSnapshot,
    loading: usageLoading,
    failed: usageFailed,
    refresh: refreshUsage,
  } = useUsage();
  const modelCollator = React.useMemo(
    () => new Intl.Collator(locale, { numeric: true, sensitivity: "base" }),
    [locale],
  );
  const [value, setValue] = useState(() => (draftKey ? getDraft(draftKey)?.value ?? "" : ""));
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const [modelDropdownRect, setModelDropdownRect] = useState<{ top: number; left: number; width: number } | null>(null);
  const [thinkingDropdownOpen, setThinkingDropdownOpen] = useState(false);
  const [toolsDropdownOpen, setToolsDropdownOpen] = useState(false);
  const [contextPopoverOpen, setContextPopoverOpen] = useState(false);
  const [attachedImages, setAttachedImages] = useState<AttachedImage[]>(() => (
    draftKey ? draftImagesToAttachedImages(getDraft(draftKey)?.images) : []
  ));
  const [attachedTextFiles, setAttachedTextFiles] = useState<AttachedTextFile[]>(() => (
    draftKey ? draftFilesToAttachedFiles(getDraft(draftKey)?.files) : []
  ));
  const [attachError, setAttachError] = useState<string | null>(null);
  /** Images being decoded/compressed right now — the attach button spins and
   *  the composer will not send until they have landed. */
  const [preparingImageCount, setPreparingImageCount] = useState(0);
  const trimmedValue = value.trimStart();
  const bashMode = attachedImages.length === 0 && attachedTextFiles.length === 0 && trimmedValue.startsWith("!");
  const bashExcluded = bashMode && trimmedValue.startsWith("!!");
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [slashActiveIndex, setSlashActiveIndex] = useState(0);
  const [atQuery, setAtQuery] = useState<AtQueryMatch | null>(null);
  const [atMenuOpen, setAtMenuOpen] = useState(false);
  const [atActiveIndex, setAtActiveIndex] = useState(0);
  const [historyMenuOpen, setHistoryMenuOpen] = useState(false);
  const [historyActiveIndex, setHistoryActiveIndex] = useState(0);
  const [fileIndex, setFileIndex] = useState<{ cwd: string; entries: FileIndexEntry[]; truncated: boolean } | null>(null);
  const [fileIndexLoading, setFileIndexLoading] = useState(false);
  const [atServerResult, setAtServerResult] = useState<{ cwd: string; query: string; matches: FileIndexEntry[] } | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const modelDropdownPanelRef = useRef<HTMLDivElement>(null);
  const thinkingDropdownRef = useRef<HTMLDivElement>(null);
  const toolsDropdownRef = useRef<HTMLDivElement>(null);
  const historyMenuRef = useRef<HTMLDivElement>(null);
  const contextPopoverRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isComposingRef = useRef(false);
  const lastCompositionEndAtRef = useRef(0);
  const slashCommandsRequestedRef = useRef(false);
  const slashItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const atItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const historyItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const fileIndexMetaRef = useRef<{ cwd: string; fetchedAt: number } | null>(null);
  const fileIndexFetchingRef = useRef<string | null>(null);
  const draftKeyRef = useRef(draftKey);
  const valueRef = useRef(value);
  const attachedImagesRef = useRef(attachedImages);
  const attachedTextFilesRef = useRef(attachedTextFiles);
  // Textarea autosize is a write→read→write on `height`, which forces a
  // synchronous layout of the whole document — and the document includes the
  // entire mounted transcript, so typing stutters in a long session. The input
  // handler and the value effect both fire per keystroke; coalesce them into
  // one rAF so the measure happens once, in the frame's own layout phase.
  const autosizeFrameRef = useRef<number | null>(null);
  const scheduleAutosize = useCallback(() => {
    if (autosizeFrameRef.current !== null) return;
    autosizeFrameRef.current = requestAnimationFrame(() => {
      autosizeFrameRef.current = null;
      const ta = textareaRef.current;
      if (!ta) return;
      ta.style.height = "auto";
      if (ta.value) ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
    });
  }, []);
  useEffect(() => () => {
    if (autosizeFrameRef.current !== null) cancelAnimationFrame(autosizeFrameRef.current);
  }, []);
  // Bumped whenever the user clears/sends the composer: in-flight FileReader
  // and file.text() reads must not re-append their results afterwards.
  const attachmentRevisionRef = useRef(0);
  const pendingImageCountRef = useRef(0);
  const pendingTextFileCountRef = useRef(0);
  valueRef.current = value;
  attachedImagesRef.current = attachedImages;
  attachedTextFilesRef.current = attachedTextFiles;

  useImperativeHandle(ref, () => ({
    insertIfEmpty(text: string) {
      const ta = textareaRef.current;
      const current = ta ? ta.value : value;
      if (current.trim()) return;
      setValue(text);
      setAtQuery(null);
      requestAnimationFrame(() => {
        if (!ta) return;
        ta.focus();
        ta.style.height = "auto";
        ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
      });
    },
    prependText(text: string) {
      if (!text.trim()) return;
      const ta = textareaRef.current;
      const current = ta ? ta.value : value;
      // Mirrors the TUI's queue restore: queued text first, then whatever
      // the user already typed, separated by a blank line.
      const combined = [text, current].filter((t) => t.trim()).join("\n\n");
      setValue(combined);
      setAtQuery(null);
      requestAnimationFrame(() => {
        if (!ta) return;
        ta.focus();
        ta.setSelectionRange(combined.length, combined.length);
        ta.style.height = "auto";
        ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
      });
    },
    insertText(text: string) {
      const ta = textareaRef.current;
      if (!ta) {
        setValue((v) => v + (v ? " " : "") + text);
        return;
      }
      const start = ta.selectionStart ?? ta.value.length;
      const end = ta.selectionEnd ?? ta.value.length;
      const before = ta.value.slice(0, start);
      const after = ta.value.slice(end);
      const sep = before.length > 0 && !before.endsWith(" ") ? " " : "";
      const newVal = before + sep + text + after;
      setValue(newVal);
      setAtQuery(null);
      requestAnimationFrame(() => {
        if (!ta) return;
        const pos = start + sep.length + text.length;
        ta.setSelectionRange(pos, pos);
        ta.focus();
        ta.style.height = "auto";
        ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
      });
    },
    addFiles(files: File[]) {
      processFiles(files);
    },
  }));

  const processImageFiles = useCallback(async (files: File[]) => {
    const remaining = Math.max(
      0,
      MAX_ATTACHED_IMAGES - attachedImagesRef.current.length - pendingImageCountRef.current,
    );
    const imageFiles = files
      .filter((file) => file.type.startsWith("image/") && file.size <= MAX_ATTACHED_IMAGE_BYTES)
      .slice(0, remaining);
    if (!imageFiles.length) {
      if (files.length > 0) {
        setAttachError(
          remaining === 0
            ? `Maximum of ${MAX_ATTACHED_IMAGES} attached images reached.`
            : `${files.length} image(s) skipped: images up to ${Math.round(MAX_ATTACHED_IMAGE_BYTES / 1024 / 1024)} MB are supported.`,
        );
      }
      return;
    }
    const revision = attachmentRevisionRef.current;
    pendingImageCountRef.current += imageFiles.length;
    setPreparingImageCount((count) => count + imageFiles.length);
    const newImages: AttachedImage[] = [];
    const failures: string[] = [];
    try {
      // Sequential on purpose: a batch of phone photos decoded in parallel is
      // several hundred MB of bitmaps on a tablet. The composer shows the
      // attach spinner for the whole batch either way.
      for (const file of imageFiles) {
        // Cleared or sent mid-batch: stop burning CPU on attachments that are
        // already stale (the ones prepared so far are revoked below).
        if (attachmentRevisionRef.current !== revision) break;
        try {
          // Anything over the pass-through budget is downscaled and re-encoded
          // here, in the browser: the whole prompt must fit in one RPC frame
          // (see lib/image-compress.ts), and a raw photo never would.
          const prepared = await prepareImageForAttachment(file, (fileName) => t("chatInput.imageUndecodable", {
            name: fileName,
            formats: SUPPORTED_IMAGE_FORMAT_LABEL,
          }));
          newImages.push({
            data: prepared.data,
            mimeType: prepared.mimeType,
            previewUrl: URL.createObjectURL(file),
            name: file.name,
          });
        } catch (error) {
          // Per file, and never silent: the user must know which one dropped out.
          failures.push(error instanceof UnsupportedImageError
            ? error.message
            : t("chatInput.imageReadFailed", { name: file.name }));
        }
      }
      // The composer was cleared/sent while the reads were in flight —
      // drop the batch instead of re-appending stale attachments.
      if (attachmentRevisionRef.current !== revision) {
        newImages.forEach(revokeImagePreview);
        return;
      }
      setAttachedImages((prev) => {
        const accepted = newImages.slice(0, Math.max(0, MAX_ATTACHED_IMAGES - prev.length));
        newImages.slice(accepted.length).forEach(revokeImagePreview);
        return [...prev, ...accepted];
      });
      setAttachError(failures.length ? failures.join("\n") : null);
    } finally {
      pendingImageCountRef.current -= imageFiles.length;
      setPreparingImageCount((count) => Math.max(0, count - imageFiles.length));
    }
  }, [t]);

  const processTextFiles = useCallback(async (files: File[]) => {
    const remaining = Math.max(
      0,
      MAX_ATTACHED_TEXT_FILES - attachedTextFilesRef.current.length - pendingTextFileCountRef.current,
    );
    const textFiles = files
      .filter((file) => file.size <= MAX_ATTACHED_TEXT_BYTES)
      .slice(0, remaining);
    if (!textFiles.length) {
      if (files.length > 0) {
        setAttachError(
          remaining === 0
            ? `Maximum of ${MAX_ATTACHED_TEXT_FILES} text files reached.`
            : `${files.length} file(s) skipped: files up to ${Math.round(MAX_ATTACHED_TEXT_BYTES / 1024)} KB are supported.`,
        );
      }
      return;
    }
    const revision = attachmentRevisionRef.current;
    pendingTextFileCountRef.current += textFiles.length;
    try {
      const readFiles = await Promise.all(
        textFiles.map(async (file): Promise<AttachedTextFile> => ({
          name: file.name,
          mimeType: file.type,
          content: await file.text(),
          size: file.size,
        })),
      );
      // The composer was cleared/sent while the reads were in flight —
      // drop the batch instead of re-appending stale attachments.
      if (attachmentRevisionRef.current !== revision) return;
      // Binary content cannot be inlined into the prompt: NUL bytes, or
      // U+FFFD replacement characters left by mis-decoded binary (e.g.
      // UTF-16 text read as UTF-8).
      const newFiles = readFiles.filter(
        (file) => !file.content.includes("\u0000") && !file.content.includes("\uFFFD"),
      );
      const skipped = textFiles.length - newFiles.length;
      setAttachedTextFiles((prev) => [
        ...prev,
        ...newFiles.slice(0, Math.max(0, MAX_ATTACHED_TEXT_FILES - prev.length)),
      ]);
      if (skipped > 0) {
        setAttachError(`${skipped} file(s) skipped: binary or non-text files cannot be attached.`);
      } else {
        setAttachError(null);
      }
    } catch {
      setAttachError("One or more files could not be read. Try a different file.");
    } finally {
      pendingTextFileCountRef.current -= textFiles.length;
    }
  }, []);

  const processFiles = useCallback((files: File[]) => {
    if (isStreaming) {
      setAttachError("Attachments are disabled while the agent is running.");
      return;
    }
    const imageFiles = files.filter((file) => file.type.startsWith("image/"));
    const otherFiles = files.filter((file) => !file.type.startsWith("image/"));
    void processImageFiles(imageFiles);
    void processTextFiles(otherFiles);
  }, [isStreaming, processImageFiles, processTextFiles]);

  const removeImage = useCallback((index: number) => {
    setAttachedImages((prev) => {
      const next = [...prev];
      const [removed] = next.splice(index, 1);
      if (removed) revokeImagePreview(removed);
      return next;
    });
    setAttachError(null);
  }, []);

  const removeTextFile = useCallback((index: number) => {
    setAttachedTextFiles((prev) => prev.filter((_, fileIndex) => fileIndex !== index));
    setAttachError(null);
  }, []);

  const clearImages = useCallback(() => {
    setAttachedImages((prev) => {
      prev.forEach(revokeImagePreview);
      return [];
    });
  }, []);

  const clearTextFiles = useCallback(() => {
    setAttachedTextFiles([]);
  }, []);

  const clearInput = useCallback(() => {
    setValue("");
    setAtQuery(null);
    setHistoryMenuOpen(false);
    if (draftKey) clearDraft(draftKey);
    if (draftKeyRef.current && draftKeyRef.current !== draftKey) clearDraft(draftKeyRef.current);
    clearImages();
    clearTextFiles();
    // Invalidate any attachment reads still in flight.
    attachmentRevisionRef.current += 1;
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [clearImages, clearTextFiles, draftKey]);

  useEffect(() => {
    if (!draftKey || draftKeyRef.current !== draftKey) return;
    setDraft(draftKey, {
      value,
      images: attachedImages.map(imageToDraftImage),
      files: attachedTextFiles.map(textFileToDraftFile),
    });
  }, [attachedImages, attachedTextFiles, draftKey, value]);

  useEffect(() => {
    const previousDraftKey = draftKeyRef.current;
    if (previousDraftKey === draftKey) return;

    if (previousDraftKey) {
      setDraft(previousDraftKey, {
        value: valueRef.current,
        images: attachedImagesRef.current.map(imageToDraftImage),
        files: attachedTextFilesRef.current.map(textFileToDraftFile),
      });
    }

    const draft = draftKey ? getDraft(draftKey) : null;
    draftKeyRef.current = draftKey;
    setValue(draft?.value ?? "");
    setAtQuery(null);
    setHistoryMenuOpen(false);
    setAttachedImages((prev) => {
      prev.forEach(revokeImagePreview);
      return draftImagesToAttachedImages(draft?.images);
    });
    setAttachedTextFiles(draftFilesToAttachedFiles(draft?.files));
  }, [draftKey]);

  useEffect(() => {
    scheduleAutosize();
  }, [value, scheduleAutosize]);

  useEffect(() => {
    return () => {
      attachedImagesRef.current.forEach(revokeImagePreview);
    };
  }, []);

  /**
   * Last stop before a message leaves the composer: everything here has to fit
   * in ONE RPC frame, so a prompt that would overflow is refused where the user
   * can still remove something — never handed to the transport to bounce.
   */
  const budgetError = useCallback((composedMessage: string, images: AttachedImage[]): string | null => {
    const verdict = checkPromptFrameBudget({ message: composedMessage, images });
    if (verdict.ok) return null;
    const size = formatAttachmentSize(verdict.totalBytes);
    const limit = formatAttachmentSize(verdict.limit);
    const name = verdict.largest?.name;
    if (!verdict.largest) return t("chatInput.messageTooLarge", { size, limit });
    return name
      ? t("chatInput.attachmentsTooLargeNamed", { size, limit, name })
      : t("chatInput.attachmentsTooLarge", { size, limit });
  }, [t]);

  const handleSend = useCallback(async () => {
    const msg = value.trim();
    if (!msg && !attachedImages.length && !attachedTextFiles.length) return;
    if (isStreaming) return;
    // An image still being compressed is not in attachedImages yet; sending now
    // would quietly drop it.
    if (preparingImageCount > 0) return;
    onAudioUnlock?.();
    const composedMessage = composeMessageWithTextAttachments(msg, attachedTextFiles);
    const tooLarge = budgetError(composedMessage, attachedImages);
    if (tooLarge) {
      setAttachError(tooLarge);
      return;
    }
    if (!attachedImages.length && !attachedTextFiles.length && msg.startsWith("/") && onBuiltinCommand) {
      const result = await onBuiltinCommand(msg);
      if (result.handled) {
        if (!result.error && !result.retainInput) clearInput();
        return;
      }
    }
    onSend(composedMessage, attachedImages.length ? attachedImages : undefined);
    clearInput();
  }, [value, attachedImages, attachedTextFiles, isStreaming, preparingImageCount, budgetError, onBuiltinCommand, onSend, clearInput, onAudioUnlock]);

  const slashQuery = value.startsWith("/") && !/\s/.test(value.slice(1))
    ? value.slice(1).toLowerCase()
    : null;
  const [dormantSkillNames, setDormantSkillNames] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    if (slashQuery === null || !cwd) return;
    const controller = new AbortController();
    void fetch(`/api/skills?cwd=${encodeURIComponent(cwd)}`, { signal: controller.signal })
      .then((response) => response.ok ? response.json() as Promise<{ skills?: Array<{ name?: string; disableModelInvocation?: boolean }> }> : null)
      .then((data) => {
        if (!data) return;
        setDormantSkillNames(new Set((data.skills ?? []).flatMap((skill) => skill.disableModelInvocation && skill.name ? [skill.name] : [])));
      })
      .catch(() => {});
    return () => controller.abort();
  }, [cwd, slashQuery]);

  const builtinSlashCommands: SlashCommandPaletteItem[] = React.useMemo(
    () => BUILTIN_SLASH_COMMAND_DEFS.map((def) => ({
      name: def.name,
      description: t(def.descriptionKey),
      ...(def.argumentHintKey ? { argumentHint: t(def.argumentHintKey) } : {}),
      source: "builtin" as const,
    })),
    [t],
  );

  // Externally reported commands (extension/prompt/skill/ompBuiltin) group
  // below the client built-ins; any name the web UI intercepts itself —
  // whether an omp builtin or a user extension — is dropped so each command
  // appears exactly once and the client interception behavior is unchanged.
  const externalSlashCommands: SlashCommandPaletteItem[] = React.useMemo(
    () => (slashCommands ?? []).flatMap((command): SlashCommandPaletteItem[] => {
      const source = command.source as string;
      if (CLIENT_BUILTIN_COMMAND_NAMES.has(command.name)) return [];
      if (source === "builtin" || source === "ompBuiltin") {
        return [{ name: command.name, description: command.description, source: "ompBuiltin" }];
      }
      return [command];
    }),
    [slashCommands],
  );

  const filteredSlashCommands = (() => {
    if (slashQuery === null) return [];
    const commands = [...(isStreaming ? [] : builtinSlashCommands), ...externalSlashCommands];
    return [...commands]
      .filter((command) => {
        const name = command.name.toLowerCase();
        const description = command.description?.toLowerCase() ?? "";
        return name.includes(slashQuery) || description.includes(slashQuery);
      })
      .sort((a, b) => {
        const rankDelta = slashMatchRank(a, slashQuery) - slashMatchRank(b, slashQuery);
        if (rankDelta !== 0) return rankDelta;
        const dormancyDelta = Number(isDormantSkillCommand(a, dormantSkillNames)) - Number(isDormantSkillCommand(b, dormantSkillNames));
        if (dormancyDelta !== 0) return dormancyDelta;
        return SLASH_SOURCE_ORDER[a.source] - SLASH_SOURCE_ORDER[b.source]
          || modelCollator.compare(a.name, b.name);
      });
  })();

  const groupedSlashCommands = (() => {
    const groups = new Map<SlashCommandSource, { source: SlashCommandSource; items: { command: SlashCommandPaletteItem; index: number }[] }>();
    for (const source of SLASH_SOURCES) {
      groups.set(source, { source, items: [] });
    }
    filteredSlashCommands.forEach((command, index) => {
      groups.get(command.source)?.items.push({ command, index });
    });
    return SLASH_SOURCES
      .map((source) => groups.get(source)!)
      .filter((group) => group.items.length > 0);
  })();

  const slashCommandCountLabel = slashQuery
    ? tn("chatInput.matchCount", filteredSlashCommands.length)
    : tn("chatInput.commandCount", filteredSlashCommands.length);

  // ── @ file autocomplete ──────────────────────────────────────────────────
  // Recomputed from the text before the caret on every change/caret move.
  // Disabled entirely when there is no cwd (new session without a directory).
  const updateAtQuery = useCallback((text: string, cursor: number | null) => {
    if (!cwd) {
      setAtQuery(null);
      return;
    }
    const pos = cursor ?? text.length;
    setAtQuery(extractAtQuery(text.slice(0, pos)));
  }, [cwd]);

  const atQueryText = atQuery?.query ?? null;
  const atLocalMatches: FileIndexEntry[] = React.useMemo(() => (
    atQueryText !== null && fileIndex && fileIndex.cwd === cwd
      ? filterFileEntries(fileIndex.entries, atQueryText)
      : []
  ), [atQueryText, fileIndex, cwd]);

  // When the client index is truncated (repo larger than the index cap),
  // local filtering cannot see deep files, so queries are also ranked
  // server-side against the full listing. Local matches render immediately
  // and are replaced when the (debounced) server result for the current
  // query arrives; stale responses are ignored via the query/cwd tag.
  const needsServerSearch = Boolean(atQueryText && fileIndex?.truncated && fileIndex.cwd === cwd);
  useEffect(() => {
    if (!needsServerSearch || !cwd || !atQueryText) return;
    const fetchCwd = cwd;
    const query = atQueryText;
    const timer = setTimeout(() => {
      fetch(`/api/file-index?cwd=${encodeURIComponent(fetchCwd)}&q=${encodeURIComponent(query)}`)
        .then((res) => {
          if (!res.ok) throw new Error(`file search failed: ${res.status}`);
          return res.json() as Promise<{ matches?: FileIndexEntry[] }>;
        })
        .then((data) => setAtServerResult({ cwd: fetchCwd, query, matches: data.matches ?? [] }))
        .catch(() => {
          // Keep showing local matches; the next keystroke retries.
        });
    }, 150);
    return () => clearTimeout(timer);
  }, [needsServerSearch, atQueryText, cwd]);

  const serverResultInUse = needsServerSearch
    && atServerResult !== null
    && atServerResult.cwd === cwd
    && atServerResult.query === atQueryText;
  const atMatches: FileIndexEntry[] = serverResultInUse ? atServerResult.matches : atLocalMatches;

  // Open/reset the menu whenever the @token appears or changes (mirrors the
  // slash menu: Escape closes it, the next keystroke re-opens it).
  const atTokenKey = atQuery === null ? null : `${atQuery.start}:${atQuery.quoted ? 1 : 0}:${atQuery.query}`;
  useEffect(() => {
    if (atTokenKey === null) {
      setAtMenuOpen(false);
      setAtActiveIndex(0);
      return;
    }
    setAtMenuOpen(true);
    setAtActiveIndex(0);
  }, [atTokenKey]);

  // Fetch the file index when the menu opens. The server caches per cwd for
  // ~10s, so re-opening refreshes cheaply; while typing nothing refetches.
  const atTokenActive = atQuery !== null;
  useEffect(() => {
    if (!atTokenActive || !cwd) return;
    const meta = fileIndexMetaRef.current;
    if (meta && meta.cwd === cwd && Date.now() - meta.fetchedAt < 10_000) return;
    if (fileIndexFetchingRef.current === cwd) return;
    fileIndexFetchingRef.current = cwd;
    const fetchCwd = cwd;
    setFileIndexLoading(true);
    fetch(`/api/file-index?cwd=${encodeURIComponent(fetchCwd)}`)
      .then((res) => {
        if (!res.ok) throw new Error(`file index failed: ${res.status}`);
        return res.json() as Promise<{ files?: string[]; truncated?: boolean }>;
      })
      .then((data) => {
        setFileIndex({ cwd: fetchCwd, entries: buildEntriesFromFiles(data.files ?? []), truncated: !!data.truncated });
        fileIndexMetaRef.current = { cwd: fetchCwd, fetchedAt: Date.now() };
      })
      .catch(() => {
        // Leave any previous index in place; next open retries.
        fileIndexMetaRef.current = null;
      })
      .finally(() => {
        fileIndexFetchingRef.current = null;
        setFileIndexLoading(false);
      });
  }, [atTokenActive, cwd]);

  const applyAtCompletion = useCallback((entry: FileIndexEntry) => {
    if (!atQuery) return;
    const ta = textareaRef.current;
    const cursor = ta?.selectionStart ?? value.length;
    const before = value.slice(0, atQuery.start);
    let after = value.slice(cursor);
    // Completing inside a quoted token (@"my dir/… with the caret before the
    // closing quote): the replacement carries its own closing quote, so drop
    // the old one right after the caret (mirrors the TUI's applyCompletion).
    if (atQuery.quoted && after.startsWith('"')) {
      after = after.slice(1);
    }
    const insert = buildAtInsertText(entry.path, entry.isDir, atQuery.quoted);
    const newValue = before + insert.text + after;
    const newPos = before.length + insert.cursorOffset;
    setValue(newValue);
    // setValue alone does not fire onChange — re-derive the token here. Files
    // end with a space (token closes, menu hides); directories end with "/"
    // before the caret (token stays open for drill-down into the directory).
    setAtQuery(extractAtQuery(newValue.slice(0, newPos)));
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(newPos, newPos);
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
    });
  }, [atQuery, value]);

  useEffect(() => {
    if (atActiveIndex >= atMatches.length) {
      setAtActiveIndex(Math.max(0, atMatches.length - 1));
    }
  }, [atMatches.length, atActiveIndex]);

  useEffect(() => {
    atItemRefs.current.length = atMatches.length;
  }, [atMatches.length]);

  useEffect(() => {
    if (!atMenuOpen) return;
    atItemRefs.current[atActiveIndex]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [atActiveIndex, atMenuOpen]);

  useEffect(() => {
    if (historyActiveIndex >= inputHistory.length) {
      setHistoryActiveIndex(Math.max(0, inputHistory.length - 1));
    }
  }, [inputHistory.length, historyActiveIndex]);

  useEffect(() => {
    historyItemRefs.current.length = inputHistory.length;
  }, [inputHistory.length]);

  useEffect(() => {
    if (!historyMenuOpen) return;
    historyItemRefs.current[historyActiveIndex]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [historyActiveIndex, historyMenuOpen]);

  const applyHistoryInput = useCallback((text: string) => {
    setValue(text);
    setHistoryMenuOpen(false);
    setHistoryActiveIndex(0);
    setAtQuery(null);
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(text.length, text.length);
      ta.style.height = "auto";
      ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
    });
  }, []);

  const applySlashCommand = useCallback((command: SlashCommandPaletteItem) => {
    const nextValue = `/${command.name} `;
    setValue(nextValue);
    setSlashMenuOpen(false);
    setSlashActiveIndex(0);
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(nextValue.length, nextValue.length);
      ta.style.height = "auto";
      ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
    });
  }, []);

  const sendQueued = useCallback((mode: "steer" | "followup") => {
    const msg = value.trim();
    if (!msg && !attachedImages.length && !attachedTextFiles.length) return;
    if (attachedImages.length || attachedTextFiles.length) return;
    onAudioUnlock?.();
    const streamingBehavior = mode === "steer" ? "steer" : "followUp";
    if (msg.startsWith("/") && onPromptWithStreamingBehavior) {
      // Web commands must be expanded even when queued: the raw slash text
      // would otherwise reach omp as a literal message (its /goal //plan are
      // TUI-only). Action commands (compact/...) keep the raw text so omp's
      // own ACP handlers can run them.
      const expansion = expandWebSlashCommand(msg);
      if (expansion.kind === "expand") {
        onPromptWithStreamingBehavior(expansion.prompt, streamingBehavior, attachedImages.length ? attachedImages : undefined);
        clearInput();
        return;
      }
      if (expansion.kind === "usage-error") {
        toast.error(t("chatInput.commandUsageTitle"), t("agentSession.commandRequiresArgs", {
          command: expansion.command,
          usage: t(expansion.argumentHintKey),
        }));
        return;
      }
      onPromptWithStreamingBehavior(msg, streamingBehavior, attachedImages.length ? attachedImages : undefined);
      clearInput();
      return;
    }
    if (mode === "steer" && onSteer) {
      onSteer(msg, attachedImages.length ? attachedImages : undefined);
    } else if (mode === "followup" && onFollowUp) {
      onFollowUp(msg, attachedImages.length ? attachedImages : undefined);
    }
    clearInput();
  }, [value, attachedImages, attachedTextFiles, onPromptWithStreamingBehavior, onSteer, onFollowUp, clearInput, onAudioUnlock, t]);

  // ── Queued follow-up bar ────────────────────────────────────────────────
  // omp reports only a queued count over RPC; the texts are tracked in a
  // client-side mirror, so Edit/Delete/Steer act on that mirror through the
  // session hook's helpers.
  const queuedEntries = [
    ...(queuedMessages?.followUp ?? []).map((text) => ({ kind: "follow-up" as const, text })),
    ...(queuedMessages?.steering ?? []).map((text) => ({ kind: "steer" as const, text })),
  ];
  const firstQueued = queuedEntries[0] ?? null;
  const queuedCount = queuedEntries.length;

  const handleQueuedEdit = useCallback(() => {
    if (!firstQueued) return;
    onRemoveQueuedMessage?.(firstQueued.text);
    setValue(firstQueued.text);
    setAtQuery(null);
    setHistoryMenuOpen(false);
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(firstQueued.text.length, firstQueued.text.length);
      ta.style.height = "auto";
      ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
    });
  }, [firstQueued, onRemoveQueuedMessage]);

  const handleQueuedDelete = useCallback(() => {
    if (!firstQueued) return;
    onRemoveQueuedMessage?.(firstQueued.text);
  }, [firstQueued, onRemoveQueuedMessage]);

  const handleQueuedSteer = useCallback(() => {
    if (!firstQueued) return;
    if (firstQueued.kind === "follow-up") {
      onPromoteQueuedToSteer?.(firstQueued.text);
    }
    // Already a steering message: nothing to promote.
  }, [firstQueued, onPromoteQueuedToSteer]);

  const getNextSlashIndex = useCallback((direction: "up" | "down" | "left" | "right") => {
    const lastIndex = filteredSlashCommands.length - 1;
    if (lastIndex < 0) return 0;

    if (direction === "left") return Math.max(0, slashActiveIndex - 1);
    if (direction === "right") return Math.min(lastIndex, slashActiveIndex + 1);

    const currentNode = slashItemRefs.current[slashActiveIndex];
    if (!currentNode) {
      return direction === "down"
        ? Math.min(lastIndex, slashActiveIndex + 1)
        : Math.max(0, slashActiveIndex - 1);
    }

    const currentRect = currentNode.getBoundingClientRect();
    const currentX = currentRect.left + currentRect.width / 2;
    const currentY = currentRect.top + currentRect.height / 2;
    let bestIndex = -1;
    let bestScore = Number.POSITIVE_INFINITY;

    for (let index = 0; index <= lastIndex; index += 1) {
      if (index === slashActiveIndex) continue;
      const node = slashItemRefs.current[index];
      if (!node) continue;
      const rect = node.getBoundingClientRect();
      const candidateY = rect.top + rect.height / 2;
      const verticalDelta = candidateY - currentY;
      if (direction === "down" ? verticalDelta <= 4 : verticalDelta >= -4) continue;

      const candidateX = rect.left + rect.width / 2;
      const score = Math.abs(verticalDelta) * 1000 + Math.abs(candidateX - currentX);
      if (score < bestScore) {
        bestIndex = index;
        bestScore = score;
      }
    }

    if (bestIndex >= 0) return bestIndex;
    return direction === "down"
      ? Math.min(lastIndex, slashActiveIndex + 1)
      : Math.max(0, slashActiveIndex - 1);
  }, [filteredSlashCommands.length, slashActiveIndex]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      const nativeEvent = e.nativeEvent;
      const recentlyComposed = Date.now() - lastCompositionEndAtRef.current < COMPOSITION_END_ENTER_GRACE_MS;
      const isComposing =
        isComposingRef.current ||
        nativeEvent.isComposing ||
        nativeEvent.keyCode === 229;

      if (e.key === "Enter" && !e.shiftKey && (isComposing || recentlyComposed)) {
        if (recentlyComposed) e.preventDefault();
        return;
      }

      if (historyMenuOpen && !isComposing) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setHistoryActiveIndex((i) => Math.min(Math.max(0, inputHistory.length - 1), i + 1));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setHistoryActiveIndex((i) => Math.max(0, i - 1));
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setHistoryMenuOpen(false);
          return;
        }
        if ((e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) && inputHistory[historyActiveIndex]) {
          e.preventDefault();
          applyHistoryInput(inputHistory[historyActiveIndex]);
          return;
        }
      }

      if (slashMenuOpen && slashQuery !== null) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSlashActiveIndex(getNextSlashIndex("down"));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSlashActiveIndex(getNextSlashIndex("up"));
          return;
        }
        if (e.key === "ArrowRight") {
          e.preventDefault();
          setSlashActiveIndex(getNextSlashIndex("right"));
          return;
        }
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          setSlashActiveIndex(getNextSlashIndex("left"));
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setSlashMenuOpen(false);
          return;
        }
        if ((e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) && filteredSlashCommands[slashActiveIndex]) {
          e.preventDefault();
          applySlashCommand(filteredSlashCommands[slashActiveIndex]);
          return;
        }
      }

      // @ file menu — skip while composing so IME candidate navigation
      // (arrows/Enter/Tab) is never intercepted.
      if (atMenuOpen && atQuery !== null && !isComposing) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setAtActiveIndex((i) => Math.min(Math.max(0, atMatches.length - 1), i + 1));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setAtActiveIndex((i) => Math.max(0, i - 1));
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setAtMenuOpen(false);
          return;
        }
        if ((e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) && atMatches[atActiveIndex]) {
          e.preventDefault();
          applyAtCompletion(atMatches[atActiveIndex]);
          return;
        }
      }

      if (e.key === "ArrowUp" && !isComposing && !isStreaming && inputHistory.length > 0 && value.trim().length === 0) {
        e.preventDefault();
        setSlashMenuOpen(false);
        setAtMenuOpen(false);
        setHistoryActiveIndex(inputHistory.length - 1);
        setHistoryMenuOpen(true);
        return;
      }

      // Esc stops the agent when no slash/@/history menu or IME composition is active.
      if (e.key === "Escape" && !isComposing && isStreaming && onAbort) {
        e.preventDefault();
        onAbort();
        return;
      }

      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (isStreaming && (onSteer || onFollowUp)) {
          // Submit-during-run behavior comes from Settings (Steer current run
          // by default, or Queue follow-up); no in-composer selector.
          const behavior = getSubmitDuringRunBehavior();
          if (behavior === "steer" && onSteer) sendQueued("steer");
          else sendQueued("followup");
        } else {
          handleSend();
        }
      }
    },
    [isStreaming, onSteer, onFollowUp, onAbort, slashMenuOpen, slashQuery, filteredSlashCommands, slashActiveIndex, applySlashCommand, sendQueued, handleSend, getNextSlashIndex, atMenuOpen, atQuery, atMatches, atActiveIndex, applyAtCompletion, historyMenuOpen, inputHistory, historyActiveIndex, applyHistoryInput, value]
  );

  const handleInput = useCallback(() => {
    scheduleAutosize();
  }, [scheduleAutosize]);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = Array.from(e.clipboardData?.items ?? []);
    const imageItems = items.filter((item) => item.type.startsWith("image/"));
    if (!imageItems.length) return;
    e.preventDefault();
    const files = imageItems.map((item) => item.getAsFile()).filter((f): f is File => f !== null);
    processFiles(files);
  }, [processFiles]);

  useEffect(() => {
    if (slashQuery === null) {
      setSlashMenuOpen(false);
      setSlashActiveIndex(0);
      slashCommandsRequestedRef.current = false;
      return;
    }
    setSlashMenuOpen(true);
    setSlashActiveIndex(0);
    if (!slashCommandsRequestedRef.current && onLoadSlashCommands) {
      slashCommandsRequestedRef.current = true;
      Promise.resolve(onLoadSlashCommands()).catch(() => {
        slashCommandsRequestedRef.current = false;
      });
    }
  }, [slashQuery, onLoadSlashCommands]);

  useEffect(() => {
    if (slashActiveIndex >= filteredSlashCommands.length) {
      setSlashActiveIndex(Math.max(0, filteredSlashCommands.length - 1));
    }
  }, [filteredSlashCommands.length, slashActiveIndex]);

  useEffect(() => {
    slashItemRefs.current.length = filteredSlashCommands.length;
  }, [filteredSlashCommands.length]);

  useEffect(() => {
    if (!slashMenuOpen) return;
    slashItemRefs.current[slashActiveIndex]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [slashActiveIndex, slashMenuOpen]);

  // Build model options: prefer modelList (has provider info), fallback to modelNames
  const [visibleModelKeys, setVisibleModelKeys] = useState<Set<string> | null>(null);
  useEffect(() => {
    const refresh = () => setVisibleModelKeys(readVisibleModelKeys());
    refresh();
    window.addEventListener(STORAGE_EVENTS.composerModelsChange, refresh);
    return () => window.removeEventListener(STORAGE_EVENTS.composerModelsChange, refresh);
  }, []);

  const modelOptions: ModelOption[] = React.useMemo(() => {
    if (modelList && modelList.length > 0) {
      return modelList.map((m) => ({ provider: m.provider, modelId: m.id, name: m.name }))
        .filter((m) => visibleModelKeys === null || visibleModelKeys.has(`${m.provider}:${m.modelId}`))
        .sort((a, b) => compareModelOptions(modelCollator, a, b));
    }
    return Object.entries(modelNames ?? {}).map(([modelId, name]) => ({
      provider: model?.provider ?? "unknown",
      modelId,
      name,
    })).sort((a, b) => compareModelOptions(modelCollator, a, b));
  }, [modelList, modelNames, model?.provider, visibleModelKeys, modelCollator]);

  // Group options by provider, preserving insertion order
  const modelsByProvider: { provider: string; options: ModelOption[] }[] = React.useMemo(() => {
    const groups: { provider: string; options: ModelOption[] }[] = [];
    for (const opt of modelOptions) {
      const group = groups.find((g) => g.provider === opt.provider);
      if (group) group.options.push(opt);
      else groups.push({ provider: opt.provider, options: [opt] });
    }
    return groups;
  }, [modelOptions]);

  const displayModelName = model
    ? (modelOptions.find((o) => o.modelId === model.modelId && o.provider === model.provider)?.name
        ?? modelNameOverride
        ?? modelNames?.[`${model.provider}:${model.modelId}`]
        ?? model.modelId)
    : null;
  const currentName = displayModelName;
  // A failed load surfaces modelError; only an in-flight load shows the
  // loading chip, so "no models" can only appear after the fetch settled.
  const showModelsLoading = Boolean(modelsLoading) && !modelError;
  const modelSelectorDisabled = isStreaming || (showModelsLoading && modelOptions.length === 0);

  // Smart row on a LIVE session: there is no "auto" runtime state to fall
  // back into (the session already has a resolved model), so this reaches
  // for the same answer omp would give a brand-new session — the configured
  // OMP roles' `default` — and pins the picker to it. Unset or unmatched
  // roles surface a toast rather than silently doing nothing.
  const handleSmartModelForLiveSession = useCallback(async () => {
    if (!onModelChange) return;
    try {
      const res = await fetch("/api/model-roles");
      if (!res.ok) throw new Error(`model-roles fetch failed: ${res.status}`);
      const data = await res.json() as { roles?: Record<string, string> };
      const defaultRole = data.roles?.default;
      const slash = defaultRole ? defaultRole.indexOf("/") : -1;
      if (!defaultRole || slash === -1) {
        toast.info(t("chatInput.smartModelUnavailable"));
        return;
      }
      const provider = defaultRole.slice(0, slash);
      const rest = defaultRole.slice(slash + 1);
      // Exact match first — a model id can itself contain a colon (self-hosted
      // tags such as `qwen3:8b`) — before stripping an optional :thinking suffix.
      const match = modelList?.find((m) => m.provider === provider && m.id === rest)
        ?? (() => {
          const colon = rest.lastIndexOf(":");
          if (colon === -1) return undefined;
          const base = rest.slice(0, colon);
          return modelList?.find((m) => m.provider === provider && m.id === base);
        })();
      if (!match) {
        toast.info(t("chatInput.smartModelUnavailable"));
        return;
      }
      onModelChange(match.provider, match.id);
      onSmartModelPinned?.(match.provider, match.id);
    } catch (e) {
      console.error("Failed to resolve smart model:", e);
      toast.info(t("chatInput.smartModelUnavailable"));
    }
  }, [modelList, onModelChange, onSmartModelPinned, t]);

  // Turn-based engines take one prompt at a time: no steering, no follow-up
  // queue. Rather than leave Enter silently inert, the composer says it is
  // waiting. Typing stays allowed so the next message can be drafted.
  const turnWaiting = !chatExtras && isStreaming;

  const compactSavedTokens = compactResult
    ? Math.max(0, compactResult.tokensBefore - compactResult.estimatedTokensAfter)
    : 0;
  const compactVerb = compactResult?.reason && compactResult.reason !== "manual"
    ? t("chatInput.compactedWithReason", {
        reason: `${compactResult.reason[0].toUpperCase()}${compactResult.reason.slice(1)}`,
      })
    : t("chatInput.compacted");
  const compactResultText = compactResult
    ? t("chatInput.compactResult", {
        verb: compactVerb,
        before: formatTokenCount(compactResult.tokensBefore, locale),
        after: formatTokenCount(compactResult.estimatedTokensAfter, locale),
        saved: formatTokenCount(compactSavedTokens, locale),
      })
    : null;
  const thinkingDisplayLabel = (() => {
    const lvl = thinkingLevel ?? "auto";
    if (lvl === "auto" || !thinkingLevelMap) return lvl;
    return thinkingLevelMap[lvl] ?? lvl;
  })();
  // The ring gauges the binding PLAN QUOTA window OF THE SELECTED MODEL; the
  // context window has its own readout in the top bar.
  //
  // A model switch is pure re-filtering: one `omp usage --json` read already
  // carries every provider and every tier, so the cached snapshot already
  // answers for whichever model is now selected. Switching must NOT fetch.
  const quotaProvider = model?.provider;
  const quotaModelId = model?.modelId;
  const quota = React.useMemo(
    () => buildQuotaView(
      usageSnapshot,
      usageLoading,
      usageFailed,
      quotaProvider && quotaModelId ? { provider: quotaProvider, modelId: quotaModelId } : null,
    ),
    [usageSnapshot, usageLoading, usageFailed, quotaProvider, quotaModelId],
  );
  const quotaPercentText = quota.known ? `${Math.round(quota.percent)}%` : "—";
  // The tooltip names the window AND the model it is about, so a ring read at a
  // glance can never be attributed to the wrong conversation.
  const quotaRingTitle = quota.known
    ? (displayModelName
        ? t("usage.ringModel", { model: displayModelName, label: quota.label, percent: Math.round(quota.percent) })
        : `${quota.label} ${quotaPercentText}`)
    : (displayModelName
        ? t("usage.ringModelUnknown", { model: displayModelName, reason: t(quota.titleKey) })
        : t("usage.ringUnknown", { reason: t(quota.titleKey) }));
  const quotaRingLabel = quota.known
    ? (displayModelName
        ? t("usage.ringDetailsModel", { model: displayModelName, label: quota.label, percent: Math.round(quota.percent) })
        : t("usage.ringDetails", { label: quota.label, percent: Math.round(quota.percent) }))
    : quotaRingTitle;
  // Only ticks while the popover is open — "updated 2 min ago" has to stay
  // true while someone reads it, but nothing else in the composer cares.
  const [usageNow, setUsageNow] = useState(() => Date.now());
  useEffect(() => {
    if (!contextPopoverOpen) return;
    setUsageNow(Date.now());
    const timer = setInterval(() => setUsageNow(Date.now()), USAGE_FRESHNESS_TICK_MS);
    return () => clearInterval(timer);
  }, [contextPopoverOpen]);
  // Opening the popover is the one moment the number is being read closely.
  useEffect(() => {
    if (contextPopoverOpen) refreshUsage();
  }, [contextPopoverOpen, refreshUsage]);
  // A brand-new conversation must open with an honest ring, and the composer
  // may have been idle for a whole background poll before it. Keyed on the
  // session (draftKey), never on the model: switching models re-filters the
  // snapshot that is already in hand. The read hits omp's own 5-minute cache
  // through the server's — no model call, no tokens, and never a forced
  // upstream refresh — and the hook keeps its own 90s/5min cadence, so this
  // adds no polling loop.
  useEffect(() => {
    refreshUsage();
  }, [draftKey, refreshUsage]);

  const thinkingLevelOptions = React.useMemo(
    () => selectableThinkingLevels(availableThinkingLevels),
    [availableThinkingLevels],
  );
  // A run starting mid-interaction must not leave the reasoning menu
  // open: the level only applies to the next prompt, and the trigger is
  // disabled while streaming.
  useEffect(() => {
    if (isStreaming) setThinkingDropdownOpen(false);
  }, [isStreaming]);
  useEffect(() => {
    if (isStreaming) setToolsDropdownOpen(false);
  }, [isStreaming]);

  // Close dropdowns on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (
        dropdownRef.current && !dropdownRef.current.contains(e.target as Node) &&
        modelDropdownPanelRef.current && !modelDropdownPanelRef.current.contains(e.target as Node)
      ) {
        setModelDropdownOpen(false);
      }
      if (thinkingDropdownRef.current && !thinkingDropdownRef.current.contains(e.target as Node)) {
        setThinkingDropdownOpen(false);
      }
      if (toolsDropdownRef.current && !toolsDropdownRef.current.contains(e.target as Node)) {
        setToolsDropdownOpen(false);
      }
      if (historyMenuRef.current && !historyMenuRef.current.contains(e.target as Node) && !textareaRef.current?.contains(e.target as Node)) {
        setHistoryMenuOpen(false);
      }
      if (contextPopoverRef.current && !contextPopoverRef.current.contains(e.target as Node)) {
        setContextPopoverOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  useEffect(() => {
    if (!contextPopoverOpen) return;
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setContextPopoverOpen(false);
    };
    document.addEventListener("keydown", closeOnEscape, true);
    return () => document.removeEventListener("keydown", closeOnEscape, true);
  }, [contextPopoverOpen]);

  useEffect(() => {
    setContextPopoverOpen(false);
  }, [draftKey]);

  return (
    <div
      style={{
        flexShrink: 0,
        background: "transparent",
         padding: "0 16px calc(8px + env(safe-area-inset-bottom))",
        paddingRight: isMobile ? 16 : 52, // desktop: 16px base + 36px for ChatMinimap alignment
      }}
    >
      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        // Accept every file type: the handler below reads any non-image file
        // as text (rejecting binary content), so restricting the picker would
        // only hide files the app can attach (code, config, logs, ...).
        accept="*/*"
        multiple
        disabled={isStreaming}
        style={{ display: "none" }}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          processFiles(files);
          e.target.value = "";
        }}
      />
      <div style={{ maxWidth: CHAT_COLUMN_MAX_WIDTH, margin: "0 auto" }}>
        {/* The model registry is omp's; on an engine without chatExtras the
            selector is hidden, so its load errors must not surface either. */}
        <ModelErrorBanner error={chatExtras ? modelError : null} />
        <ComposerModeStatus goal={activeGoal} plan={activePlan} />
        {/* Retry banner */}
        {retryInfo && (
          <div style={{
            marginBottom: 8, padding: "5px 10px",
            background: "color-mix(in srgb, var(--status-warning) 8%, transparent)", border: "1px solid color-mix(in srgb, var(--status-warning) 25%, transparent)",
            borderRadius: 6, fontSize: 12, color: "var(--status-warning)",
            display: "flex", alignItems: "center", gap: 6,
          }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
              <path d="M3 3v5h5" />
            </svg>
            {t("chatInput.retrying", { attempt: retryInfo.attempt, maxAttempts: retryInfo.maxAttempts })}{retryInfo.errorMessage && <span style={{ opacity: 0.7, marginLeft: 4 }}>— {retryInfo.errorMessage}</span>}
            {onAbortRetry && (
              <button
                type="button"
                onClick={onAbortRetry}
                title="Stop the automatic retry and leave the failed turn as-is"
                style={{
                  marginLeft: "auto",
                  padding: "3px 9px",
                  fontSize: 11,
                  color: "var(--status-warning)",
                  background: "transparent",
                  border: "1px solid color-mix(in srgb, var(--status-warning) 45%, transparent)",
                  borderRadius: 6,
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                  transition: "background var(--dur-fast) var(--ease-out-warm)",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "color-mix(in srgb, var(--status-warning) 12%, transparent)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
              >
                Abort retry
              </button>
            )}
          </div>
        )}
        {compactResultText && (
          <div style={{
            marginBottom: 8, padding: "5px 10px",
            background: "color-mix(in srgb, var(--status-success) 8%, transparent)", border: "1px solid color-mix(in srgb, var(--status-success) 24%, transparent)",
            borderRadius: 6, fontSize: 12, color: "var(--status-success)",
            display: "flex", alignItems: "center", gap: 6,
          }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <polyline points="20 6 9 17 4 12" />
            </svg>
            {compactResultText}
          </div>
        )}
        {/* Image previews */}
        {attachError && (
          <div role="alert" style={{
            marginBottom: 8, padding: "5px 10px",
            background: "color-mix(in srgb, var(--status-error) 7%, transparent)", border: "1px solid color-mix(in srgb, var(--status-error) 30%, transparent)",
            borderRadius: 6, fontSize: 12, color: "var(--status-error)",
            // One line per rejected file when a batch fails for several reasons.
            whiteSpace: "pre-wrap",
          }}>
            {attachError}
          </div>
        )}
        {attachedImages.length > 0 && (
          <div style={{ display: "flex", gap: 6, marginBottom: 6, flexWrap: "wrap" }}>
            {attachedImages.map((img, i) => (
              <div key={i} style={{ position: "relative", flexShrink: 0 }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={img.previewUrl}
                  alt=""
                  style={{ width: 56, height: 56, objectFit: "cover", borderRadius: 6, border: "1px solid var(--border)", display: "block" }}
                />
                <button
                  onClick={() => removeImage(i)}
                  title="Remove image"
                  aria-label="Remove image"
                  style={{
                    position: "absolute", top: -5, right: -5,
                    width: 20, height: 20, borderRadius: "50%",
                    background: "var(--bg-panel)", border: "1px solid var(--border)",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    cursor: "pointer", padding: 0, color: "var(--text-muted)",
                    transition: "color var(--dur-fast) var(--ease-out-warm), background var(--dur-fast) var(--ease-out-warm)",
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; e.currentTarget.style.background = "var(--bg-panel)"; }}
                >
                  <svg width="9" height="9" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                    <line x1="1" y1="1" x2="7" y2="7" /><line x1="7" y1="1" x2="1" y2="7" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}
        {attachedTextFiles.length > 0 && (
          <div style={{ display: "flex", gap: 6, marginBottom: 6, flexWrap: "wrap" }}>
            {attachedTextFiles.map((file, i) => (
              <div
                key={i}
                style={{
                  display: "flex", alignItems: "center", gap: 7,
                  maxWidth: 260, height: 30,
                  padding: "0 6px 0 9px",
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  background: "var(--bg-panel)",
                  fontSize: 12,
                  color: "var(--text)",
                }}
              >
                <span style={{ flexShrink: 0, display: "flex", color: "var(--text-muted)" }}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
                    <polyline points="14 2 14 8 20 8" />
                  </svg>
                </span>
                <span
                  title={file.name}
                  style={{
                    minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                    fontFamily: "var(--font-mono)", fontSize: 11.5,
                  }}
                >
                  {file.name}
                </span>
                <span style={{ flexShrink: 0, fontSize: 10, color: "var(--text-dim)" }}>
                  {file.size < 1024 ? `${file.size} B` : `${Math.round(file.size / 1024)} KB`}
                </span>
                <button
                  onClick={() => removeTextFile(i)}
                  title="Remove file"
                  aria-label="Remove file"
                  style={{
                    flexShrink: 0, width: 18, height: 18,
                    borderRadius: "50%",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    background: "transparent", border: "none",
                    cursor: "pointer", padding: 0, color: "var(--text-muted)",
                    transition: "color var(--dur-fast) var(--ease-out-warm), background var(--dur-fast) var(--ease-out-warm)",
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; e.currentTarget.style.background = "transparent"; }}
                >
                  <svg width="9" height="9" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                    <line x1="1" y1="1" x2="7" y2="7" /><line x1="7" y1="1" x2="1" y2="7" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Main input */}
        <div style={{ position: "relative" }}>
          {historyMenuOpen && inputHistory.length > 0 && (
            <div
              ref={historyMenuRef}
              className="dropdown-surface"
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                bottom: "calc(100% + 8px)",
                zIndex: 120,
                maxHeight: "min(44vh, 360px)",
              }}
            >
              <div
                title={t("chatInput.inputHistory")}
                style={{
                  height: 30,
                  padding: "0 10px",
                  borderBottom: "1px solid var(--border)",
                  display: "flex",
                  alignItems: "center",
                  color: "var(--text-dim)",
                }}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M3 12a9 9 0 1 0 3-6.7" />
                  <path d="M3 4v5h5" />
                  <path d="M12 7v5l3 2" />
                </svg>
              </div>
              <div style={{ maxHeight: "calc(min(44vh, 360px) - 31px)", overflowY: "auto", padding: 4 }}>
                {inputHistory.map((item, index) => {
                  const active = index === historyActiveIndex;
                  return (
                    <button
                      key={`${index}:${item}`}
                      ref={(node) => {
                        historyItemRefs.current[index] = node;
                      }}
                      type="button"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        applyHistoryInput(item);
                      }}
                      onMouseEnter={() => setHistoryActiveIndex(index)}
                      style={{
                        width: "100%",
                        display: "flex",
                        alignItems: "flex-start",
                        gap: 8,
                        padding: "7px 8px",
                        border: "none",
                        borderRadius: 6,
                        background: active ? "var(--bg-selected)" : "none",
                        color: "var(--text)",
                        cursor: "pointer",
                        textAlign: "left",
                        fontSize: 12.5,
                        lineHeight: 1.45,
                      }}
                    >
                      <span style={{ flexShrink: 0, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-dim)", paddingTop: 1 }}>
                        {index + 1}
                      </span>
                      <span style={{ minWidth: 0, display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: 2, overflow: "hidden", overflowWrap: "anywhere" }}>
                        {item}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {slashMenuOpen && slashQuery !== null && (
            <div
              className="dropdown-surface"
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                bottom: "calc(100% + 8px)",
                zIndex: 120,
                maxHeight: "min(56vh, 460px)",
              }}
            >
              <div
                style={{
                  padding: "8px 10px",
                  borderBottom: "1px solid var(--border)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                  fontSize: 11,
                  color: "var(--text-dim)",
                }}
              >
                <span>{slashCommandsLoading ? t("chatInput.loadingCommands") : t("chatInput.slashCommandsHeader", { countLabel: slashCommandCountLabel })}</span>
                <span style={{ fontFamily: "var(--font-mono)" }}>{t("chatInput.tabEnterHint")}</span>
              </div>
              <div style={{ maxHeight: "calc(min(56vh, 460px) - 34px)", overflowY: "auto", padding: 10 }}>
                {!slashCommandsLoading && filteredSlashCommands.length === 0 ? (
                  <div style={{ padding: "2px 2px 4px", fontSize: 12, color: "var(--text-dim)" }}>
                    {t("chatInput.noCommandsFound")}
                  </div>
                ) : (
                  groupedSlashCommands.map((group) => (
                    <section key={group.source} style={{ marginBottom: 12 }}>
                      <div
                        style={{
                          position: "sticky",
                          top: -10,
                          zIndex: 1,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: 8,
                          padding: "4px 0 6px",
                          background: "var(--bg)",
                          color: "var(--text-dim)",
                          fontSize: 10,
                          fontWeight: 600,
                          textTransform: "uppercase",
                        }}
                      >
                        <span>{t(SLASH_SOURCE_GROUP_LABEL_KEYS[group.source])}</span>
                        <span style={{ fontFamily: "var(--font-mono)", fontWeight: 500 }}>{group.items.length}</span>
                      </div>
                      <div
                        style={{
                          display: "grid",
                          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                          gap: 8,
                        }}
                      >
                        {group.items.map(({ command, index }) => {
                          const active = index === slashActiveIndex;
                          const dormant = isDormantSkillCommand(command, dormantSkillNames);
                          return (
                            <button
                              key={`${command.source}:${command.name}`}
                              ref={(node) => {
                                slashItemRefs.current[index] = node;
                              }}
                              type="button"
                              onMouseDown={(e) => {
                                e.preventDefault();
                                applySlashCommand(command);
                              }}
                              onMouseEnter={() => setSlashActiveIndex(index)}
                              style={{
                                width: "100%",
                                minWidth: 0,
                                minHeight: 58,
                                display: "flex",
                                flexDirection: "column",
                                gap: 4,
                                justifyContent: "center",
                                padding: "9px 10px",
                                border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
                                borderRadius: 7,
                                background: active ? "var(--bg-selected)" : "var(--bg-panel)",
                                color: dormant ? "var(--text-dim)" : "var(--text)",
                                cursor: "pointer",
                                textAlign: "left",
                                boxShadow: active ? "0 0 0 1px color-mix(in srgb, var(--accent) 28%, transparent)" : "none",
                              }}
                            >
                              <span style={{
                                fontSize: 13,
                                fontFamily: "var(--font-mono)",
                                overflowWrap: "anywhere",
                                wordBreak: "break-word",
                              }}>
                                /{command.name}
                                {command.argumentHint && (
                                  <span style={{ marginLeft: 6, fontSize: 10, color: "var(--text-dim)" }}>{command.argumentHint}</span>
                                )}
                                {dormant && <span style={{ marginLeft: 6, fontSize: 10, color: "var(--text-dim)" }}>{t("chatInput.dormant")}</span>}
                              </span>
                              {command.description && (
                                <span style={{
                                  display: "-webkit-box",
                                  WebkitBoxOrient: "vertical",
                                  WebkitLineClamp: 2,
                                  overflow: "hidden",
                                  fontSize: 11,
                                  lineHeight: 1.35,
                                  color: "var(--text-dim)",
                                }}>
                                  {command.description}
                                </span>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </section>
                  ))
                )}
              </div>
            </div>
          )}
          {atMenuOpen && atQuery !== null && (() => {
            const indexLoading = fileIndexLoading && (!fileIndex || fileIndex.cwd !== cwd);
            const matchCountLabel = tn("chatInput.matchCount", atMatches.length);
            // With a truncated index, local results are provisional — the
            // debounced server search over the full listing replaces them.
            const truncatedHint = fileIndex?.truncated && !serverResultInUse
              ? ` · ${atQuery.query ? t("chatInput.searchingAllFiles") : t("chatInput.indexTruncated")}`
              : "";
            return (
              <div
                className="dropdown-surface"
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  bottom: "calc(100% + 8px)",
                  zIndex: 120,
                  maxHeight: "min(48vh, 400px)",
                }}
              >
                <div
                  style={{
                    padding: "8px 10px",
                    borderBottom: "1px solid var(--border)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 8,
                    fontSize: 11,
                    color: "var(--text-dim)",
                  }}
                >
                  <span>
                    {indexLoading
                      ? t("chatInput.loadingFiles")
                      : `${t("chatInput.filesHeader", { countLabel: matchCountLabel })}${truncatedHint}`}
                  </span>
                  <span style={{ fontFamily: "var(--font-mono)" }}>{t("chatInput.tabEnterHint")}</span>
                </div>
                <div style={{ maxHeight: "calc(min(48vh, 400px) - 34px)", overflowY: "auto", padding: 4 }}>
                  {!indexLoading && atMatches.length === 0 ? (
                    <div style={{ padding: "6px 8px", fontSize: 12, color: "var(--text-dim)" }}>
                      {needsServerSearch && !serverResultInUse ? t("chatInput.searching") : t("chatInput.noMatchingFiles")}
                    </div>
                  ) : (
                    atMatches.map((entry, index) => {
                      const active = index === atActiveIndex;
                      const name = entry.path.split("/").pop() ?? entry.path;
                      const dirPrefix = entry.path.slice(0, entry.path.length - name.length);
                      return (
                        <button
                          key={`${entry.isDir ? "d" : "f"}:${entry.path}`}
                          ref={(node) => {
                            atItemRefs.current[index] = node;
                          }}
                          type="button"
                          onMouseDown={(e) => {
                            e.preventDefault();
                            applyAtCompletion(entry);
                          }}
                          onMouseEnter={() => setAtActiveIndex(index)}
                          style={{
                            width: "100%",
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                            padding: "6px 8px",
                            border: "none",
                            borderRadius: 6,
                            background: active ? "var(--bg-selected)" : "none",
                            color: "var(--text)",
                            cursor: "pointer",
                            textAlign: "left",
                            fontSize: 12.5,
                            fontFamily: "var(--font-mono)",
                          }}
                        >
                          <span style={{ flexShrink: 0, display: "flex", alignItems: "center" }}>
                            {entry.isDir ? <FolderIcon size={14} /> : getFileIcon(name, 14)}
                          </span>
                          <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {dirPrefix && <span style={{ color: "var(--text-dim)" }}>{dirPrefix}</span>}
                            {name}
                            {entry.isDir && <span style={{ color: "var(--text-dim)" }}>/</span>}
                          </span>
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
            );
          })()}
        {/* Waiting strip — same slot as the queued bar, shown when the engine
            cannot take anything until the current turn ends. Visible even once
            the user has typed, which the placeholder alone would not be. */}
        {turnWaiting && !firstQueued && (
          <div
            role="status"
            style={{
              border: "1px solid var(--border)",
              borderBottom: "none",
              borderRadius: "var(--radius-card) var(--radius-card) 0 0",
              background: "var(--bg-panel)",
              padding: "5px 12px",
              display: "flex",
              alignItems: "center",
              gap: 6,
              minWidth: 0,
              fontSize: 11,
              color: "var(--text-muted)",
            }}
          >
            <Loader2 size={11} strokeWidth={2.2} style={{ flexShrink: 0, animation: "spin 0.8s linear infinite" }} aria-hidden="true" />
            <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {t("chatInput.waitingForTurn")}
            </span>
          </div>
        )}
        {/* Queued follow-up bar — thin strip attached to the composer's top
            edge. Hidden entirely when nothing is queued. */}
        {firstQueued && (
          <div style={{
            border: "1px solid var(--border)",
            borderBottom: "none",
            borderRadius: "var(--radius-card) var(--radius-card) 0 0",
            background: "var(--bg-panel)",
            padding: "5px 8px 5px 12px",
            display: "flex",
            alignItems: "center",
            gap: 8,
            minWidth: 0,
          }}>
            <span style={{
              flexShrink: 0,
              fontSize: 10,
              fontWeight: 600,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              color: "var(--text-muted)",
            }}>
              {firstQueued.kind === "steer" ? t("chatInput.queuedSteer") : t("chatInput.queuedFollowUp")}
              {queuedCount > 1 && <span style={{ color: "var(--text-dim)" }}>{" · " + queuedCount}</span>}
            </span>
            <span
              title={firstQueued.text}
              style={{
                flex: 1,
                minWidth: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                fontSize: 12,
                color: "var(--text-muted)",
              }}
            >
              {firstQueued.text}
            </span>
            <QueuedActionButton onClick={handleQueuedEdit} title={t("chatInput.queuedEditTitle")}>
              {t("chatInput.queuedEdit")}
            </QueuedActionButton>
            <QueuedActionButton onClick={handleQueuedDelete} title={t("chatInput.queuedDeleteTitle")}>
              {t("chatInput.queuedDelete")}
            </QueuedActionButton>
            <QueuedActionButton onClick={handleQueuedSteer} title={t("chatInput.queuedSteerTitle")} accent>
              {t("chatInput.queuedSteerAction")}
            </QueuedActionButton>
          </div>
        )}
          <div
            className="chat-input-shell"
            style={{
              display: "flex",
              flexDirection: "column",
              background: "var(--bg)",
              border: `1px solid ${bashMode ? "var(--tool-bg)" : "color-mix(in srgb, var(--border) 70%, transparent)"}`,
              borderRadius: "var(--radius-card)",
              padding: "12px 12px 10px 14px",
              boxShadow: "var(--shadow-card)",
              transition: "border-color var(--dur-fast) var(--ease-out-warm), background var(--dur-fast) var(--ease-out-warm), box-shadow var(--dur-fast) var(--ease-out-warm)",
            } as React.CSSProperties}
          >
          <textarea
            ref={textareaRef}
            className="composer-textarea"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setHistoryMenuOpen(false);
              updateAtQuery(e.target.value, e.target.selectionStart);
            }}
            onSelect={(e) => {
              const el = e.currentTarget;
              updateAtQuery(el.value, el.selectionStart);
            }}
            onKeyDown={handleKeyDown}
            onCompositionStart={() => {
              isComposingRef.current = true;
            }}
            onCompositionEnd={(e) => {
              isComposingRef.current = false;
              lastCompositionEndAtRef.current = Date.now();
              const el = e.currentTarget;
              updateAtQuery(el.value, el.selectionStart);
            }}
            onInput={handleInput}
            onPaste={handlePaste}
            placeholder={turnWaiting ? t("chatInput.waitingForTurn") : t("chatInput.placeholder")}
            rows={1}
            style={{
              width: "100%",
              background: "none",
              border: "none",
              outline: "none",
              resize: "none",
              color: "var(--text)",
              fontSize: 14,
              lineHeight: 1.6,
              fontFamily: "inherit",
              minHeight: 24,
              maxHeight: 200,
              overflow: "auto",
            }}
          />

          {/* Toolbar: attachment · model · settings · reasoning · fast · context ring · send/stop */}
          <div style={{
            display: "flex",
            alignItems: "center",
            gap: 2,
            marginTop: 8,
            paddingTop: 8,
            borderTop: "1px solid color-mix(in srgb, var(--border) 62%, transparent)",
            flexWrap: isMobile ? "wrap" : "nowrap",
          }}>
            {/* Attachment */}
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={isStreaming || preparingImageCount > 0}
              title={preparingImageCount > 0 ? t("chatInput.imagePreparing") : t("chatInput.attachFile")}
              aria-label={preparingImageCount > 0 ? t("chatInput.imagePreparing") : t("chatInput.attachFile")}
              style={{
                flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center",
                width: 28, height: 28, padding: 0,
                background: "none", border: "none",
                borderRadius: 7,
                color: (attachedImages.length || attachedTextFiles.length) ? "var(--accent)" : "var(--text-muted)",
                cursor: isStreaming || preparingImageCount > 0 ? "not-allowed" : "pointer",
                opacity: isStreaming ? 0.5 : 1,
                transition: "background var(--dur-fast) var(--ease-out-warm), color var(--dur-fast) var(--ease-out-warm)",
              }}
              onMouseEnter={(e) => {
                if (isStreaming || preparingImageCount > 0) return;
                e.currentTarget.style.background = "var(--bg-hover)";
                e.currentTarget.style.color = (attachedImages.length || attachedTextFiles.length) ? "var(--accent)" : "var(--text)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "none";
                e.currentTarget.style.color = (attachedImages.length || attachedTextFiles.length) ? "var(--accent)" : "var(--text-muted)";
              }}
            >
              {preparingImageCount > 0 ? (
                <Loader2 size={14} strokeWidth={2} style={{ animation: "spin 0.8s linear infinite" }} aria-hidden="true" />
              ) : (
                <Paperclip size={14} strokeWidth={1.8} />
              )}
            </button>

            {/* Model selector — compact text button with dropdown */}
            {(modelOptions.length > 0 || currentName || modelError || showModelsLoading) && onModelChange && (
              <div ref={dropdownRef} style={{ position: "relative", minWidth: 0 }}>
                <button
                  onClick={(e) => {
                    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    setModelDropdownRect({ top: rect.top, left: rect.left, width: rect.width });
                    setModelDropdownOpen((v) => !v);
                  }}
                  disabled={modelSelectorDisabled}
                  style={{
                    display: "flex", alignItems: "center", gap: 5,
                    height: 28,
                    maxWidth: 190,
                    padding: "0 8px",
                    overflow: "hidden",
                    background: modelDropdownOpen ? "var(--bg-hover)" : "none",
                    border: "none",
                    borderRadius: 7,
                    color: "var(--text-muted)",
                    cursor: modelSelectorDisabled ? "not-allowed" : "pointer",
                    fontSize: 12,
                    opacity: modelSelectorDisabled ? 0.5 : 1,
                    transition: "background var(--dur-fast) var(--ease-out-warm), color var(--dur-fast) var(--ease-out-warm)",
                  }}
                  onMouseEnter={(e) => {
                    if (isStreaming) return;
                    e.currentTarget.style.background = "var(--bg-hover)";
                    e.currentTarget.style.color = "var(--text)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = modelDropdownOpen ? "var(--bg-hover)" : "none";
                    e.currentTarget.style.color = "var(--text-muted)";
                  }}
                  title={modelOptions.length > 0
                    ? t("chatInput.changeModel")
                    : showModelsLoading ? t("chatInput.loadingModels") : t("chatInput.noAvailableModels")}
                >
                  {model ? (
                    <ModelIcon provider={model.provider} modelId={model.modelId} size={13} style={{ flexShrink: 0 }} />
                  ) : (
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                      <rect x="4" y="4" width="16" height="16" rx="2" />
                      <rect x="9" y="9" width="6" height="6" />
                      <line x1="9" y1="1" x2="9" y2="4" /><line x1="15" y1="1" x2="15" y2="4" />
                      <line x1="9" y1="20" x2="9" y2="23" /><line x1="15" y1="20" x2="15" y2="23" />
                      <line x1="20" y1="9" x2="23" y2="9" /><line x1="20" y1="14" x2="23" y2="14" />
                      <line x1="1" y1="9" x2="4" y2="9" /><line x1="1" y1="14" x2="4" y2="14" />
                    </svg>
                  )}
                  {advisorEnabled && (
                    // ShieldCheck, deliberately NOT Sparkles: Sparkles is the
                    // Smart-model glyph in the dropdown one click away, and an
                    // accent sparkle beside the model name read as "this model
                    // was auto-picked" — a meaning it never had.
                    <span title={t("chatInput.advisorEnabled")} aria-label={t("chatInput.advisorEnabled")} style={{ display: "flex", flexShrink: 0, color: "var(--accent)" }}>
                      <ShieldCheck size={13} strokeWidth={2} aria-hidden="true" />
                    </span>
                  )}
                  {isAutoModelSelection && currentName && (
                    // The same glyph as the dropdown's Smart row, so "Smart"
                    // in the label and the row read as one feature.
                    <span style={{ display: "flex", flexShrink: 0, color: "var(--accent)" }} aria-hidden="true">
                      <Sparkles size={12} strokeWidth={2} />
                    </span>
                  )}
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
                    {isAutoModelSelection && currentName
                      ? `${t("chatInput.smartModel")} · ${currentName}`
                      : currentName ?? (modelOptions.length > 0
                        ? t("chatInput.selectModel")
                        : showModelsLoading ? t("chatInput.loadingModels") : t("chatInput.noModels"))}
                  </span>
                  <ChevronDown size={12} strokeWidth={1.8} style={{ flexShrink: 0, opacity: 0.7 }} aria-hidden="true" />
                </button>
                {modelDropdownOpen && modelDropdownRect && (() => {
                  const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
                  const bottom = viewportHeight - modelDropdownRect.top + 6;
                  const maxH = Math.max(120, Math.min(modelDropdownRect.top - 8, viewportHeight * 0.6));
                  const panelPos: React.CSSProperties = isMobile
                    ? { left: 8, right: 8, maxWidth: "calc(100vw - 16px)" }
                    : { left: modelDropdownRect.left, width: "max-content", minWidth: modelDropdownRect.width, maxWidth: "calc(100vw - 16px)" };
                  return (
                    <div ref={modelDropdownPanelRef} className="dropdown-surface" style={{
                    position: "fixed",
                    bottom,
                    ...panelPos,
                    zIndex: 500,
                    overflow: "hidden", maxHeight: maxH, overflowY: "auto",
                    }}>
                    <button
                      className="dropdown-item"
                      key="smart-model-role"
                      onClick={() => {
                        setModelDropdownOpen(false);
                        if (onSelectSmartModel) onSelectSmartModel();
                        else void handleSmartModelForLiveSession();
                      }}
                      style={{
                        display: "flex", alignItems: "flex-start", gap: 8,
                        width: "100%", padding: "7px 12px",
                        background: isAutoModelSelection ? "var(--bg-selected)" : "transparent",
                        border: "none",
                        borderBottom: "1px solid var(--border)",
                        color: isAutoModelSelection ? "var(--text)" : "var(--text-muted)",
                        cursor: "pointer", fontSize: 12, textAlign: "left",
                        fontWeight: isAutoModelSelection ? 600 : 400,
                      }}
                      onMouseEnter={(e) => { if (!isAutoModelSelection) e.currentTarget.style.background = "var(--bg-hover)"; }}
                      onMouseLeave={(e) => { if (!isAutoModelSelection) e.currentTarget.style.background = "transparent"; }}
                    >
                      {isAutoModelSelection
                        ? <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 3 }}><polyline points="1.5 5 4 7.5 8.5 2.5" /></svg>
                        : <span style={{ width: 10, flexShrink: 0 }} />}
                      <Sparkles size={13} strokeWidth={1.8} style={{ flexShrink: 0, marginTop: 2, color: isAutoModelSelection ? "var(--accent)" : "var(--text-dim)" }} />
                      <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                        <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t("chatInput.smartModel")}</span>
                        <span style={{ fontSize: 11, color: "var(--text-dim)", fontWeight: 400, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t("chatInput.smartModelHint")}</span>
                      </span>
                    </button>
                    {modelsByProvider.length === 0 ? (
                      <div style={{ padding: "8px 12px", color: "var(--text-dim)", fontSize: 12, whiteSpace: "nowrap" }}>
                        {showModelsLoading ? t("chatInput.loadingModels") : t("chatInput.noAvailableModels")}
                      </div>
                    ) : modelsByProvider.map((group, gi) => (
                      <div key={group.provider}>
                        {(modelsByProvider.length > 1) && (
                          <div style={{
                            display: "flex", alignItems: "center", gap: 6,
                            padding: "6px 12px 4px",
                            fontSize: 10, fontWeight: 600, color: "var(--text-dim)",
                            textTransform: "uppercase", letterSpacing: "0.07em",
                            borderTop: gi > 0 ? "1px solid var(--border)" : "none",
                          }}>
                            <ProviderIcon provider={group.provider} size={10} style={{ flexShrink: 0, color: "var(--text-dim)" }} />
                            {group.provider}
                          </div>
                        )}
                        {group.options.map((opt) => {
                          const isActive = opt.modelId === model?.modelId && opt.provider === model?.provider;
                          return (
                            <button
                              className="dropdown-item"
                              key={`${opt.provider}:${opt.modelId}`}
                              onClick={() => { setModelDropdownOpen(false); if (!isActive || isAutoModelSelection) onModelChange(opt.provider, opt.modelId); }}
                              style={{
                                display: "flex", alignItems: "center", gap: 8,
                                width: "100%", padding: "7px 12px",
                                background: isActive ? "var(--bg-selected)" : "transparent",
                                border: "none",
                                color: isActive ? "var(--text)" : "var(--text-muted)",
                                cursor: "pointer", fontSize: 12, textAlign: "left",
                                fontWeight: isActive ? 600 : 400,
                                whiteSpace: "nowrap",
                              }}
                              onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = "var(--bg-hover)"; }}
                              onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = "none"; }}
                            >
                              {isActive
                                ? <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><polyline points="1.5 5 4 7.5 8.5 2.5" /></svg>
                                : <span style={{ width: 10, flexShrink: 0 }} />}
                              <ModelIcon provider={opt.provider} modelId={opt.modelId} size={13} style={{ flexShrink: 0, color: isActive ? "var(--accent)" : "var(--text-dim)" }} />
                              {opt.name}
                            </button>
                          );
                        })}
                      </div>
                    ))}
                    {/* Fast mode lives with the model it belongs to: the
                        footer only appears when the active model supports it. */}
                    {fastModeSupported && onFastModeChange && (
                      <label
                        style={{
                          position: "sticky", bottom: 0,
                          display: "flex", alignItems: "flex-start", gap: 8,
                          padding: "8px 12px",
                          borderTop: "1px solid var(--border)",
                          background: "var(--bg-panel)",
                          cursor: "pointer",
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={Boolean(fastModeEnabled)}
                          onChange={() => onFastModeChange(!fastModeEnabled)}
                          style={{ margin: "2px 0 0", accentColor: "var(--accent)", cursor: "pointer", flexShrink: 0 }}
                        />
                        <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                          <span style={{ fontSize: 12, fontWeight: 600, color: fastModeActive ? "var(--accent)" : "var(--text)" }}>
                            {t("chatInput.fastLabel")}
                          </span>
                          <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                            {t("chatInput.fastModeHint")}
                          </span>
                        </span>
                      </label>
                    )}
                  </div>
                  );
                })()}
              </div>
            )}

            {/* The engine moved this session onto a different model by itself
                (retry fallback / usage-aware routing). The 10s toast is easy
                to miss and the switched model outlives it, so the marker
                stays until the model moves again — click re-shows the full
                from → to and reason. */}
            {autoModelSwitch && (
              <button
                type="button"
                onClick={() => {
                  const detail = [
                    t("chatInput.autoSwitchDetail", { from: autoModelSwitch.from, to: autoModelSwitch.to }),
                    autoModelSwitch.role ? t("agentSession.fallbackAppliedDetail", { role: autoModelSwitch.role }) : null,
                    autoModelSwitch.reason ? t("agentSession.fallbackReason", { reason: autoModelSwitch.reason }) : null,
                  ].filter(Boolean).join("\n");
                  toast.info(t("chatInput.autoSwitchChip"), detail, { durationMs: 12_000, clamp: true });
                }}
                title={t("chatInput.autoSwitchTitle")}
                aria-label={t("chatInput.autoSwitchTitle")}
                style={{
                  display: "inline-flex", alignItems: "center", gap: 4,
                  height: 28, padding: "0 7px",
                  background: "none", border: "none", borderRadius: 7,
                  color: "var(--status-warning)", cursor: "pointer",
                  fontSize: 11, flexShrink: 0, whiteSpace: "nowrap",
                }}
              >
                <TriangleAlert size={12} aria-hidden="true" style={{ flexShrink: 0 }} />
                {t("chatInput.autoSwitchChip")}
              </button>
            )}

            {/* Tool preset selector — applies at spawn time only, so it stays
                available even mid-run (the picked preset takes effect on the
                next new session, not the live one). */}
            {onToolPresetChange && (
              <div ref={toolsDropdownRef} style={{ position: "relative" }}>
                <button
                  onClick={() => setToolsDropdownOpen((v) => !v)}
                  title={t("chatInput.changeToolPresetTitle", { preset: t(TOOL_PRESET_LABEL_KEY[toolPreset ?? "full"]) })}
                  aria-label={t("chatInput.changeToolPreset")}
                  style={{
                    display: "flex", alignItems: "center", gap: 5,
                    height: 28,
                    padding: "0 8px",
                    background: toolsDropdownOpen ? "var(--bg-hover)" : "none",
                    border: "none",
                    borderRadius: 7,
                    color: toolPreset && toolPreset !== "full" ? "var(--status-warning)" : "var(--text-muted)",
                    cursor: "pointer",
                    fontSize: 12,
                    transition: "background var(--dur-fast) var(--ease-out-warm), color var(--dur-fast) var(--ease-out-warm)",
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = toolsDropdownOpen ? "var(--bg-hover)" : "none"; }}
                >
                  <Wrench size={12} strokeWidth={1.8} style={{ flexShrink: 0 }} aria-hidden="true" />
                  <span style={{ whiteSpace: "nowrap" }}>{t(TOOL_PRESET_LABEL_KEY[toolPreset ?? "full"])}</span>
                  <ChevronDown size={12} strokeWidth={1.8} style={{ flexShrink: 0, opacity: 0.7 }} aria-hidden="true" />
                </button>
                {toolsDropdownOpen && (
                  <div className="dropdown-surface" style={{
                    position: "absolute", bottom: "calc(100% + 6px)", left: 0,
                    zIndex: 100, minWidth: 260, maxWidth: "calc(100vw - 32px)",
                  }}>
                    {TOOL_PRESET_ORDER.map((preset) => {
                      const isActive = (toolPreset ?? "full") === preset;
                      const warningKey = TOOL_PRESET_WARNING_KEY[preset];
                      return (
                        <button
                          className="dropdown-item"
                          key={preset}
                          onClick={() => { setToolsDropdownOpen(false); if (!isActive) onToolPresetChange(preset); }}
                          style={{
                            display: "flex", alignItems: "flex-start", gap: 8,
                            width: "100%", padding: "7px 12px",
                            background: isActive ? "var(--bg-selected)" : "transparent",
                            border: "none",
                            color: isActive ? "var(--text)" : "var(--text-muted)",
                            cursor: "pointer", fontSize: 12, textAlign: "left",
                            fontWeight: isActive ? 600 : 400,
                          }}
                          onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = "var(--bg-hover)"; }}
                          onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = "transparent"; }}
                        >
                          {isActive
                            ? <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 3 }}><polyline points="1.5 5 4 7.5 8.5 2.5" /></svg>
                            : <span style={{ width: 10, flexShrink: 0 }} />}
                          <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                            <span style={{ whiteSpace: "nowrap" }}>{t(TOOL_PRESET_LABEL_KEY[preset])}</span>
                            {warningKey && (
                              <span style={{ fontSize: 11, fontWeight: 400, color: "var(--status-warning)", whiteSpace: "normal" }}>
                                {t(warningKey)}
                              </span>
                            )}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* Reasoning level selector — stays visible while the agent
                runs (disabled) so the level never looks like it reset. */}
            {onThinkingLevelChange && (
              <div ref={thinkingDropdownRef} style={{ position: "relative" }}>
                <button
                  onClick={() => setThinkingDropdownOpen((v) => !v)}
                  disabled={isStreaming}
                  title={t("chatInput.changeReasoningTitle", { level: thinkingDisplayLabel })}
                  aria-label={`${t("chatInput.changeReasoning")}: ${thinkingDisplayLabel}`}
                  style={{
                    display: "flex", alignItems: "center", gap: 5,
                    height: 28,
                    padding: "0 8px",
                    background: thinkingDropdownOpen ? "var(--bg-hover)" : "none",
                    border: "none",
                    borderRadius: 7,
                    color: "var(--text-muted)",
                    cursor: isStreaming ? "not-allowed" : "pointer",
                    opacity: isStreaming ? 0.5 : 1,
                    fontSize: 12,
                    transition: "background var(--dur-fast) var(--ease-out-warm), color var(--dur-fast) var(--ease-out-warm)",
                  }}
                  onMouseEnter={(e) => {
                    if (isStreaming) return;
                    e.currentTarget.style.background = "var(--bg-hover)";
                    e.currentTarget.style.color = "var(--text)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = thinkingDropdownOpen ? "var(--bg-hover)" : "none";
                    e.currentTarget.style.color = "var(--text-muted)";
                  }}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                    <path d="M9.5 2A5.5 5.5 0 0 0 4 7.5c0 1.7.78 3.21 2 4.21V14a1 1 0 0 0 1 1h5a1 1 0 0 0 1-1v-2.29c1.22-1 2-2.51 2-4.21A5.5 5.5 0 0 0 9.5 2z" />
                    <line x1="7" y1="18" x2="12" y2="18" />
                    <line x1="8" y1="21" x2="11" y2="21" />
                  </svg>
                  <span style={{ whiteSpace: "nowrap" }}>{thinkingDisplayLabel}</span>
                  <ChevronDown size={12} strokeWidth={1.8} style={{ flexShrink: 0, opacity: 0.7 }} aria-hidden="true" />
                </button>
                {thinkingDropdownOpen && (
                  <div className="dropdown-surface" style={{
                    position: "absolute", bottom: "calc(100% + 6px)", left: 0,
                    zIndex: 100, minWidth: 250, maxWidth: "calc(100vw - 32px)",
                  }}>
                    {thinkingLevelOptions.map((lvl) => {
                      const isActive = (thinkingLevel ?? "auto") === lvl;
                      const descKey = THINKING_LEVEL_DESC_KEYS[lvl];
                      const desc = descKey ? t(descKey) : "";
                      const mappedVal = (lvl !== "auto" && thinkingLevelMap) ? thinkingLevelMap[lvl] : undefined;
                      const displayLabel = (mappedVal != null && mappedVal !== lvl) ? mappedVal : lvl;
                      const showOriginal = mappedVal != null && mappedVal !== lvl;
                      return (
                        <button
                          className="dropdown-item"
                          key={lvl}
                          onClick={() => { setThinkingDropdownOpen(false); if (!isActive && !isStreaming) onThinkingLevelChange(lvl); }}
                          style={{
                            display: "flex", alignItems: "center", gap: 8,
                            width: "100%", padding: "7px 12px",
                            background: isActive ? "var(--bg-selected)" : "transparent",
                            border: "none",
                            color: isActive ? "var(--text)" : "var(--text-muted)",
                            cursor: "pointer", fontSize: 12, textAlign: "left",
                            fontWeight: isActive ? 600 : 400,
                            whiteSpace: "nowrap",
                          }}
                          onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = "var(--bg-hover)"; }}
                          onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = "transparent"; }}
                        >
                          {isActive
                            ? <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><polyline points="1.5 5 4 7.5 8.5 2.5" /></svg>
                            : <span style={{ width: 10, flexShrink: 0 }} />}
                          <span style={{ flexShrink: 0, whiteSpace: "nowrap" }}>{displayLabel}{showOriginal && <span style={{ color: "var(--text-dim)", fontWeight: 400 }}> ({lvl})</span>}</span>
                          {desc && (
                            <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 11, color: "var(--text-dim)", marginLeft: 8 }}>
                              {desc}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            <div style={{ flex: 1 }} />

            {/* Icon-only plan-quota gauge. The arc tracks the binding quota
                window; context usage lives in the top bar and, in detail,
                below the divider inside this popover. */}
              <div
                ref={contextPopoverRef}
                // marginRight doubles the visual space between the gauge and
                // the Send/Stop button (owner request); the toolbar's own gap
                // supplies the other half.
                style={{ position: "relative", width: 28, height: 28, flexShrink: 0, marginRight: 4 }}
              >
                <button
                  type="button"
                  title={quotaRingTitle}
                  aria-label={quotaRingLabel}
                  aria-expanded={contextPopoverOpen}
                  aria-haspopup="dialog"
                  onClick={() => setContextPopoverOpen((open) => !open)}
                  style={{
                    position: "relative",
                    width: 28,
                    height: 28,
                    padding: 0,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: quota.color,
                    background: contextPopoverOpen ? "var(--bg-hover)" : "none",
                    border: "none",
                    borderRadius: 7,
                    cursor: "pointer",
                    transition: "background var(--dur-fast) var(--ease-out-warm), color var(--dur-fast) var(--ease-out-warm)",
                  }}
                >
                  <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true">
                    <circle
                      cx="13" cy="13" r="9.5" fill="none" stroke="var(--border)" strokeWidth="2.5"
                      strokeDasharray={quota.known ? undefined : RING_ABSENT_DASH}
                    />
                    {/* No arc at all when there is nothing to report: an
                        absence has to read as one, not as 0%. */}
                    {quota.known && (
                      <circle
                        cx="13" cy="13" r="9.5" fill="none"
                        stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"
                        strokeDasharray={RING_CIRCUMFERENCE}
                        strokeDashoffset={RING_CIRCUMFERENCE * (1 - quota.percent / 100)}
                        transform="rotate(-90 13 13)"
                        style={{ transition: "stroke-dashoffset var(--dur-med) var(--ease-out-warm), stroke var(--dur-fast) var(--ease-out-warm)" }}
                      />
                    )}
                    <circle cx="13" cy="13" r="2" fill="currentColor" opacity="0.72" />
                  </svg>
                </button>

                {contextPopoverOpen && (
                  <QuotaPopover
                    quota={quota}
                    provider={quotaProvider ?? null}
                    modelName={displayModelName}
                    now={usageNow}
                  />
                )}
              </div>

            {/* Primary action: Send (idle) / Stop (running) */}
            {isStreaming ? (
              <button
                type="button"
                onClick={isCompacting ? onAbortCompaction : onAbort}
                title={t("chatInput.stopAgent")}
                style={{
                  display: "flex", alignItems: "center", gap: 6,
                  height: 28,
                  padding: "0 14px",
                  background: "var(--accent-strong)",
                  border: "none",
                  borderRadius: 8,
                  color: "var(--on-accent)",
                  cursor: "pointer",
                  fontSize: 12,
                  fontWeight: 600,
                  transition: "background var(--dur-fast) var(--ease-out-warm)",
                }}
              >
                <svg width="9" height="9" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                  <rect x="1.5" y="1.5" width="7" height="7" rx="1.5" fill="currentColor" />
                </svg>
                {t("chatInput.stop")}
              </button>
            ) : (
              <button
                type="button"
                onClick={handleSend}
                // Sending while an attachment is still being prepared would
                // send the message without it.
                disabled={preparingImageCount > 0 || (!value.trim() && !attachedImages.length && !attachedTextFiles.length)}
                style={{
                  display: "flex", alignItems: "center", gap: 6,
                  height: 28,
                  padding: "0 14px",
                  background: (value.trim() || attachedImages.length || attachedTextFiles.length) ? "var(--accent-strong)" : "var(--bg-panel)",
                  border: "none",
                  borderRadius: 8,
                  color: (value.trim() || attachedImages.length || attachedTextFiles.length) ? "var(--on-accent)" : "var(--text-dim)",
                  cursor: (value.trim() || attachedImages.length || attachedTextFiles.length) ? "pointer" : "not-allowed",
                  fontSize: 12,
                  fontWeight: 600,
                  boxShadow: (value.trim() || attachedImages.length || attachedTextFiles.length) ? "var(--shadow-card)" : "none",
                  transition: "background var(--dur-fast) var(--ease-out-warm), box-shadow var(--dur-fast) var(--ease-out-warm)",
                }}
              >
                <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="2" y1="7" x2="11" y2="7" />
                  <polyline points="7.5 3 12 7 7.5 11" />
                </svg>
                {t("chatInput.send")}
              </button>
            )}
          </div>
          </div>
        </div>

        {/* Bash mode status label */}
        {bashMode && (
          <div className="text-xs px-2 py-1" style={{ color: bashExcluded ? "var(--text-muted)" : "var(--accent)", marginTop: 4 }}>
            {bashExcluded ? t("chatInput.shellLocal") : t("chatInput.shellToModel")}
          </div>
        )}


      </div>
    </div>
  );
}));
