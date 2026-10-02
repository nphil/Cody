"use client";

import React, { useRef, useState, useCallback, useEffect, useImperativeHandle, forwardRef, memo, KeyboardEvent } from "react";
import { AlertTriangle, ChevronDown, Clock, Footprints, Gauge, ListChecks, Loader2, Paperclip, Pin, RefreshCw, ShieldCheck, SlidersHorizontal, Sparkles, Split, Target, TriangleAlert, Zap, ZapOff } from "lucide-react";
import type { SessionModeOption } from "@/hooks/useAgentSession";
import type { OutboxEntry } from "@/lib/outbox";
import type { PendingInput, PendingInputResponse, RewoundDraft } from "@/lib/pending-input";
import { ALL_CAPABILITIES, OMP_ENGINE_ID, type ActiveEngineInfo, type EngineCapabilities } from "./SettingsTabs";

import type { BuiltinSlashCommandResult, CompactResultInfo, SlashCommandInfo } from "@/hooks/useAgentSession";
import type { SessionPresetResponse } from "@/lib/model-presets/types";
import { formatSmartTriggerLabel, type ComposerPresetOption, type PendingPresetPick } from "@/hooks/session-preset-state";
import type { ParsedPresetSelector } from "@/lib/model-presets/selector";
import type { ActiveGoal, ActivePlan } from "@/lib/web-mode-state";
import { formatGoalElapsed } from "@/lib/web-mode-state";
import { toast } from "@/components/ui/toast";
import { formatCompactNumber } from "@/lib/format";
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
  prepareImageBatchForAttachment,
  prepareImageForAttachment,
  SUPPORTED_IMAGE_FORMAT_LABEL,
  UnsupportedImageError,
} from "@/lib/image-compress";
import {
  buildEntriesFromFiles, buildAtInsertText, extractAtQuery, filterFileEntries,
  type AtQueryMatch, type FileIndexEntry,
} from "@/lib/file-fuzzy";
import { FolderIcon, getFileIcon } from "./FileIcons";
import { InputDock } from "./InputDock";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useIsCoarsePointer } from "@/hooks/useIsCoarsePointer";
import { useWordCompletion } from "@/hooks/useWordCompletion";
import { ComposerGhostText } from "./ComposerGhostText";
import { useResetCredits, useUsage } from "@/hooks/useUsage";
import { useOpenRouterAccount } from "@/hooks/useOpenRouterAccount";
import { ModelIcon, ProviderIcon } from "./ProviderIcon";
import { useI18n } from "@/lib/i18n";
import { selectableThinkingLevels } from "@/lib/thinking-levels";
import { thinkingLevelLabel } from "@/lib/thinking-level-labels";
import { STORAGE_EVENTS } from "@/lib/storage-keys";
import { migrateComposerAllowlist, mirrorServerVisibility, modelVisibilityKey, pushRecentModel, readComposerVisibility, type ComposerVisibility } from "@/lib/composer-model-visibility";
import { fetchSettingsRoute, useSettingsRoute } from "@/hooks/useSettingsData";
import { patchSettingsSchema } from "@/hooks/useConfigWriter";
import { deriveFastModeState } from "@/lib/fast-mode-state";
import { useSettingsOpener } from "./settings/shell-context";
import { formatModelDisplayName } from "@/lib/model-display";
import type { SessionActiveModel } from "@/lib/session-active-models";
import { PromptProfileIndicator, type LocalModelProfileBody } from "./LocalModelProfile";
import { QuotaPopover, buildQuotaView, isPrepaidProvider, usageProviderFor, modelLimitReached, formatResetTime } from "./QuotaPopover";

export interface AttachedImage {
  data: string;   // base64, no prefix (already compressed if it needed to be)
  mimeType: string;
  previewUrl: string; // object URL for display
  /** Original file name, when there was one — named in over-budget errors. */
  name?: string;
  /** Original browser file retained for adaptive re-encoding at send time. */
  source?: File;
}

export type AttachedTextFile = AttachedTextFileData;

interface ModelOption {
  provider: string;
  modelId: string;
  name: string;
}

/** Stable empty list, so a composer without modes never re-renders for a fresh `[]`. */
const NO_MODES: SessionModeOption[] = [];
/** Stable empty list keeps quota derivation memo-friendly when no session is live. */
const NO_ACTIVE_MODELS: readonly SessionActiveModel[] = [];
/** Stable empty list keeps the preset section memo-friendly when presets
 *  are unsupported or not yet loaded. */
const NO_PRESETS: ComposerPresetOption[] = [];
/** Stable empty list keeps the outbox rows memo-friendly before a session's
 *  first send. */
const NO_OUTBOX: OutboxEntry[] = [];
const NO_PENDING_INPUTS: PendingInput[] = [];
interface Props {
  onSend: (message: string, images?: AttachedImage[]) => void | boolean | Promise<void | boolean>;
  onAbort: () => void;
  isStreaming: boolean;
  /** The engine can accept this send while a turn is running (steer or
   *  queued follow-up, decided by the Settings submit-during-run preference
   *  inside the session hook) — Enter/Send still go through `onSend`, this
   *  only gates whether that is allowed to happen while `isStreaming`. */
  canSendWhileStreaming?: boolean;
  /** The active session accepts a follow-up/steer while it is running. */
  canAttachWhileStreaming?: boolean;
  /** The active session also accepts image payloads while it is running. */
  canAttachImagesWhileStreaming?: boolean;
  /** Everything the ACTIVE engine can serve. The composer gates on several
   * of these (chatExtras for the rpc-dialect affordances, models for omp's
   * role resolution, skills for the "/" palette lookup), so the whole set
   * travels as one prop rather than as a hand-picked handful — the missing
   * flags are exactly how omp-only controls leaked onto pi. */
  capabilities?: EngineCapabilities;
  /** Who the active engine is, for labels that used to say "omp" whatever
   * was running, and to scope per-engine browser storage. */
  engine?: ActiveEngineInfo | null;
  model?: { provider: string; modelId: string } | null;
  /** Lets the profile API distinguish planned from applied session state. */
  sessionId?: string | null;
  /** Every concrete model with work attributable to this session. */
  activeModels?: readonly SessionActiveModel[];
  isAutoModelSelection?: boolean;
  modelNames?: Record<string, string>;
  modelList?: { id: string; name: string; provider: string; supportsFastMode?: boolean }[];
  modelError?: string | null;
  /** Classified `modelError`: see ModelErrorBanner. */
  modelErrorCode?: "no_credentials" | null;
  modelsLoading?: boolean;
  /** Bumped when models.yml or the curation changed: the picker re-reads
   * the new-models line and its visibility mirror. */
  modelsRefreshKey?: number;
  onModelChange?: (provider: string, modelId: string, selection?: "manual" | "smart") => void | boolean | Promise<boolean>;
  /** Return a NEW session to auto ("Smart") model resolution. Answers false
   * once the session has spawned (a Local-only pick spawns it early); the
   * Smart row then resolves the OMP roles default itself and calls
   * onModelChange, exactly as on a live session. */
  onSelectSmartModel?: () => boolean | void;
  /** Backend-confirmed local-only routing for this session. Absent when the
   * active engine cannot support this routing mode. */
  localOnly?: { active: boolean; pending: boolean; supported: boolean; error?: string };
  onSelectLocalOnly?: () => Promise<boolean>;
  /** Every configured preset — "Base settings" is implicit and not included
   *  here. Empty/absent hides the preset section entirely, alongside
   *  Smart's own capabilities.models gate. */
  presets?: ComposerPresetOption[];
  /** The user's base config.yml `default` role, for the "Base settings"
   *  row's own muted hint. */
  baseDefaultModel?: ParsedPresetSelector | null;
  /** This chat's bound preset; null = Base settings; undefined = not yet
   *  known (nothing preset-related renders while unknown). */
  activePresetId?: string | null;
  /** A preset pick the engine deferred with 409 session_busy, held until
   *  the run ends. */
  pendingPresetPick?: PendingPresetPick | null;
  /** Switch this chat's preset (or set a new chat's spawn default). Absent
   *  hides the preset section, matching every other capability-gated
   *  control here. */
  onPresetChange?: (presetId: string | null, name: string) => void;
  /** The engine's last unprompted model switch for this session (retry
   * fallback, usage-aware routing). Renders a persistent marker beside the
   * model control naming what moved and why — the switch outlives its toast. */
  autoModelSwitch?: {
    from: string;
    to: string;
    role?: string;
    reason?: string;
    /** Classified reason; decides which sentence the detail toast uses. */
    reasonKind?: "refusal" | "usage" | null;
    job?: { kind: "main" | "subagent"; subagentId?: string; agent?: string; roleLabelKey: string };
  } | null;
  /** RPC-dialect engines can queue a safe model switch while a turn is running. */
  modelChangeWhileStreaming?: boolean;
  /** A live model switch queued for the next safe provider-call boundary. */
  modelSwitchPending?: { provider: string; modelId: string; name: string; phase: "waiting" | "applying" } | null;
  fastModeEnabled?: boolean;
  fastModeActive?: boolean;
  fastModeCapable?: boolean;
  fastModeSupported?: boolean;
  /** A Fast request is in flight; prevent a second click until the engine replies. */
  fastModePending?: boolean;
  /** The engine explicitly rejected Fast for this model/session. */
  fastModeUnavailable?: boolean;
  onFastModeChange?: (enabled: boolean) => void;
  onAbortCompaction?: () => void;
  isCompacting?: boolean;
  compactResult?: CompactResultInfo | null;
  thinkingLevel?: string;
  onThinkingLevelChange?: (level: string, source?: "manual" | "preset") => void;
  /** A reasoning-level command is awaiting engine acknowledgement. */
  thinkingLevelPending?: boolean;
  /** The requested reasoning level while an acknowledgement is pending. */
  thinkingLevelTarget?: string | null;
  /** The engine's own session modes (ACP `session/new` → `modes`): its
   * permission posture — Manual / Accept edits / Plan / Auto on Claude.
   * Empty for an engine without the surface, and an empty list renders nothing. */
  availableModes?: SessionModeOption[];
  currentModeId?: string | null;
  onModeChange?: (modeId: string) => void;
  availableThinkingLevels?: string[] | null;
  /** Display name for the current model when the catalog does not know it. */
  modelNameOverride?: string | null;
  retryInfo?: { attempt: number; maxAttempts: number; errorMessage?: string } | null;
  onAbortRetry?: () => void;
  inputHistory?: string[];
  /** Remove one queued message from the queue panel (Edit/Delete/Steer). */
  onRemoveQueuedMessage?: (id: string) => void;
  onEditQueuedMessage?: (id: string) => void;
  /** "Steer now": make the agent read a queued message at once (cuts its
   *  current reply short; running tools and subagents keep going). */
  onSteerQueuedNow?: (id: string) => void;
  /** Per-session send outbox (lib/outbox.ts): every send not yet confirmed
   *  delivered, rendered as a chip/row (sending → queued|started →
   *  delivered, or failed with Retry + Edit). */
  outbox?: OutboxEntry[];
  /** Re-arm a failed outbox entry for an immediate retry attempt. */
  onRetryOutboxEntry?: (id: string) => void;
  /** Remove a failed outbox entry and hand its text + images back so the
   *  composer can restore them for editing. */
  onEditOutboxEntry?: (id: string) => { text: string; images: OutboxEntry["images"] } | null;
  pendingInputs?: PendingInput[];
  onRespondToInput?: (item: PendingInput, response: PendingInputResponse) => void | Promise<void>;
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
  prependDraft: (draft: RewoundDraft) => void;
  addFiles: (files: File[]) => void;
}


const COMPOSITION_END_ENTER_GRACE_MS = 100;
/** Circumference of the composer ring (r = 9.5). */
const RING_CIRCUMFERENCE = 2 * Math.PI * 9.5;
/** Dashed track drawn when there is no quota to fill the ring with. */
const RING_ABSENT_DASH = "2.5 3.5";
/** How often the popover re-renders so "updated 2 min ago" stays true. */
const USAGE_FRESHNESS_TICK_MS = 30_000;

/** One switch inside the model dropdown (Fast, Prewalk, Task prewalk). It
 * mirrors the Smart and Local-only rows exactly — checkmark slot, glyph,
 * label over a muted hint — so the panel reads as one list of decisions
 * rather than a menu with widgets bolted on. */
function DropdownToggleRow({ icon, label, hint, pressed, pending, isMobile, testId, onToggle }: {
  icon: React.ReactNode;
  label: string;
  hint: string;
  pressed: boolean;
  pending: boolean;
  isMobile: boolean;
  testId: string;
  onToggle: () => void;
}) {
  return (
    <button
      className="dropdown-item"
      type="button"
      data-testid={testId}
      aria-pressed={pressed}
      disabled={pending}
      onClick={onToggle}
      style={{
        display: "flex", alignItems: "flex-start", gap: 8,
        width: "100%", padding: "7px 12px",
        minHeight: isMobile ? 44 : undefined,
        background: pressed ? "var(--bg-selected)" : "transparent",
        border: "none",
        color: pressed ? "var(--text)" : "var(--text-muted)",
        cursor: pending ? "wait" : "pointer", fontSize: 12, textAlign: "left",
        fontWeight: pressed ? 600 : 400, opacity: pending ? 0.6 : 1,
      }}
      onMouseEnter={(event) => { if (!pressed && !pending) event.currentTarget.style.background = "var(--bg-hover)"; }}
      onMouseLeave={(event) => { if (!pressed) event.currentTarget.style.background = "transparent"; }}
    >
      {pressed
        ? <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 3 }}><polyline points="1.5 5 4 7.5 8.5 2.5" /></svg>
        : <span style={{ width: 10, flexShrink: 0 }} />}
      {icon}
      <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
        <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{label}</span>
        <span style={{ fontSize: 11, color: "var(--text-dim)", fontWeight: 400, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{hint}</span>
      </span>
    </button>
  );
}

/** What /api/models/visibility answers; the composer only reads it to keep
 * the browser mirror current. */
interface VisibilityBody {
  instanceHidden?: string[];
  hidden?: string[];
  pinned?: string[];
}

interface NewModelsPeek {
  newModels?: { provider: string; id: string }[];
  pending?: true;
}

/** Engines whose retired allowlist this page has already converted, so a
 * re-render or a second composer instance cannot migrate twice. */
const migratedEngines = new Set<string>();

function compareModelOptions(collator: Intl.Collator, a: ModelOption, b: ModelOption): number {
  return collator.compare(a.name || a.modelId, b.name || b.modelId)
    || collator.compare(a.provider, b.provider)
    || collator.compare(a.modelId, b.modelId);
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

type SlashCommandSource = "builtin" | "extension" | "prompt" | "skill" | "engineBuiltin";

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

interface BuiltinSlashCommandDef {
  name: string;
  descriptionKey: string;
  argumentHintKey?: string;
}

/** Prompt-composing commands the WEB UI expands itself before anything is
 * sent (goal/plan/... are TUI-only in omp and never execute over the RPC
 * prompt path — see lib/web-slash-commands.ts). They need nothing from the
 * engine, so every engine gets them. */
const WEB_SLASH_COMMAND_DEFS: BuiltinSlashCommandDef[] = WEB_SLASH_COMMANDS.map((command) => ({
  name: command.name,
  descriptionKey: command.descriptionKey,
  argumentHintKey: command.argumentHintKey,
}));

/** Commands that are really rpc-dialect RPC calls wearing a slash: `compact`,
 * `set_session_name`, `get_session_stats`, `get_last_assistant_text`, and the
 * wrapper's own session restart. An ACP engine answers all of them
 * `unsupported` (lib/harness/acp-session.ts SUPPORTED_COMMANDS), so offering
 * them there is offering five guaranteed red notices. */
const RPC_SLASH_COMMAND_DEFS: BuiltinSlashCommandDef[] = [
  { name: "compact", descriptionKey: "chatInput.cmdCompact" },
  { name: "reload", descriptionKey: "chatInput.cmdReload" },
  { name: "name", descriptionKey: "chatInput.cmdName" },
  { name: "session", descriptionKey: "chatInput.cmdSession" },
  { name: "copy", descriptionKey: "chatInput.cmdCopy" },
];

/** Every name the client intercepts itself, whatever the engine — the dedupe
 * key against engine-reported commands, and the reason a hand-typed `/compact`
 * still reaches the dispatcher (which answers with the engine's own honest
 * "unsupported" message) instead of being sent to the model as prose. */
const CLIENT_BUILTIN_COMMAND_NAMES = new Set(
  [...WEB_SLASH_COMMAND_DEFS, ...RPC_SLASH_COMMAND_DEFS].map((def) => def.name),
);

const SLASH_SOURCES: SlashCommandSource[] = ["builtin", "extension", "prompt", "skill", "engineBuiltin"];

const SLASH_SOURCE_GROUP_LABEL_KEYS: Record<SlashCommandSource, string> = {
  builtin: "chatInput.groupBuiltin",
  extension: "chatInput.groupExtensions",
  prompt: "chatInput.groupPrompts",
  skill: "chatInput.groupSkills",
  engineBuiltin: "chatInput.groupEngineBuiltin",
};

const SLASH_SOURCE_ORDER: Record<SlashCommandSource, number> = {
  builtin: 0,
  extension: 1,
  prompt: 2,
  skill: 3,
  engineBuiltin: 4,
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

export function ModelErrorBanner({ error, code }: {
  error?: string | null;
  /** "no_credentials": the engine has nothing signed in. Its own text says to
   * use a slash command or hand-write models.yml, neither of which is how a
   * Cody user fixes it, so Cody answers in its own words instead. */
  code?: "no_credentials" | null;
}) {
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
        <div style={{ fontWeight: 600 }}>{code === "no_credentials" ? t("chatInput.modelErrorNoCredentialsTitle") : t("chatInput.modelError")}</div>
        <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
          {code === "no_credentials" ? t("chatInput.modelErrorNoCredentials") : error}
        </div>
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
  onSend, onAbort, isStreaming, canSendWhileStreaming = false, canAttachWhileStreaming = false, canAttachImagesWhileStreaming = false, capabilities = ALL_CAPABILITIES, engine = null, model, sessionId, activeModels = NO_ACTIVE_MODELS, isAutoModelSelection, modelNames, modelList, modelError, modelErrorCode, modelsLoading, modelsRefreshKey, onModelChange, onSelectSmartModel, localOnly, onSelectLocalOnly, presets = NO_PRESETS, baseDefaultModel = null, activePresetId, pendingPresetPick = null, onPresetChange, autoModelSwitch, modelSwitchPending, modelChangeWhileStreaming = false, fastModeEnabled, fastModeActive, fastModeCapable, fastModeSupported, fastModePending, fastModeUnavailable, onFastModeChange,
  onAbortCompaction, isCompacting, compactResult,
  thinkingLevel, onThinkingLevelChange, thinkingLevelPending, thinkingLevelTarget, availableModes = NO_MODES, currentModeId = null, onModeChange, availableThinkingLevels, modelNameOverride,
  retryInfo, inputHistory = [], onAbortRetry,
  slashCommands, slashCommandsLoading, onLoadSlashCommands,
  onBuiltinCommand,
  onAudioUnlock,
  outbox = NO_OUTBOX,
  pendingInputs = NO_PENDING_INPUTS,
  onRespondToInput,
  onRetryOutboxEntry,
  onEditOutboxEntry,
  onRemoveQueuedMessage,
  onEditQueuedMessage,
  onSteerQueuedNow,
  draftKey,
  cwd,
  activeGoal,
  activePlan,
  advisorEnabled,
}: Props, ref) {
  const isMobile = useIsMobile();
  const { t, tn, locale } = useI18n();
  // A plain-English fallback for a key `lib/i18n` does not have yet: `t()`
  // itself returns the raw key when every dictionary misses it (see
  // `translate()`), so a caller that notices that and swaps in its own
  // template still renders something a person can read instead of a literal
  // "chatInput.modelLimitReached" — and picks the translation back up the
  // moment the key is added, with no further code change.
  const tOrFallback = useCallback((key: string, fallback: string, vars?: Record<string, string | number>) => {
    const value = t(key, vars);
    if (value !== key) return value;
    if (!vars) return fallback;
    return fallback.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match));
  }, [t]);
  // Unpacked once from the flag set rather than plumbed in one flag at a
  // time: the composer needs several, and the ones it was never given are
  // what let omp-only controls render on other engines.
  const chatExtras = capabilities.chatExtras;
  // What to call the engine in copy that used to hardcode "omp". Falls back
  // to the product name while /api/info is still in flight, so no string ever
  // renders with an empty hole in it.
  const engineName = engine?.shortName ?? "Cody";
  // /api/usage is engine-neutral: it answers whenever omp is installed on
  // this box, reading omp's own tracked provider accounts regardless of
  // which engine is actually driving this session. So the read itself is no
  // longer gated on the active engine — only whether a ring or a picker
  // badge can say anything about THIS model is, once its provider is
  // translated to the omp provider id that actually meters it (see
  // `usageProviderFor` below) and the snapshot confirms a matching account.
  const {
    snapshot: usageSnapshot,
    loading: usageLoading,
    failed: usageFailed,
    refresh: refreshUsage,
  } = useUsage(true, sessionId ?? null);
  // Banked reset credits stay keyed to the active engine: the server route
  // itself still answers `available:false` for anything but omp (they are
  // redeemed through omp's own credential store specifically, not a generic
  // provider-account read), so polling under any other engine would just be
  // a wasted request for a value it already returns without one.
  const resetCreditsSupported = engine?.id === OMP_ENGINE_ID;
  const resetCredits = useResetCredits(resetCreditsSupported);
  const refreshResetCredits = resetCredits.refresh;
  const modelCollator = React.useMemo(
    () => new Intl.Collator(locale, { numeric: true, sensitivity: "base" }),
    [locale],
  );
  const [value, setValue] = useState(() => (draftKey ? getDraft(draftKey)?.value ?? "" : ""));
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const [modelDropdownRect, setModelDropdownRect] = useState<{ top: number; left: number; width: number } | null>(null);
  const [thinkingDropdownOpen, setThinkingDropdownOpen] = useState(false);
  const [modeDropdownOpen, setModeDropdownOpen] = useState(false);
  // The reasoning and mode panels detach to the viewport on narrow screens.
  const [thinkingAnchorTop, setThinkingAnchorTop] = useState<number | null>(null);
  const [modeAnchorTop, setModeAnchorTop] = useState<number | null>(null);
  const [contextPopoverAnchor, setContextPopoverAnchor] = useState<{ top: number; right: number } | null>(null);
  const [contextPopoverOpen, setContextPopoverOpen] = useState(false);
  const [attachedImages, setAttachedImages] = useState<AttachedImage[]>(() => (
    draftKey ? draftImagesToAttachedImages(getDraft(draftKey)?.images) : []
  ));
  const [attachedTextFiles, setAttachedTextFiles] = useState<AttachedTextFile[]>(() => (
    draftKey ? draftFilesToAttachedFiles(getDraft(draftKey)?.files) : []
  ));
  const [pendingRewoundDraft, setPendingRewoundDraft] = useState<RewoundDraft | null>(null);
  const [attachError, setAttachError] = useState<string | null>(null);
  /** Images being decoded/compressed right now — the attach button spins and
   *  the composer will not send until they have landed. */
  const [preparingImageCount, setPreparingImageCount] = useState(0);
  const [sendPreparing, setSendPreparing] = useState(false);
  const [failedPreparations, setFailedPreparations] = useState<Array<{ id: string; text: string; images: AttachedImage[]; files: AttachedTextFile[]; detail: string }>>([]);
  const failedPreparationIdRef = useRef(0);
  const trimmedValue = value.trimStart();
  // Shell mode is an rpc-dialect affordance: an ACP session's vocabulary has no
  // `bash` command, so tinting the composer and promising "output sent to model"
  // on one of those engines advertises something it will reject. There a leading
  // `!` is just the first character of the prompt.
  const bashMode = chatExtras && attachedImages.length === 0 && attachedTextFiles.length === 0 && trimmedValue.startsWith("!");
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
  const modeDropdownRef = useRef<HTMLDivElement>(null);

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
  useEffect(() => {
    const onBalanceIncrease = (event: Event) => {
      const detail = (event as CustomEvent<{ label?: string; delta?: number }>).detail;
      const delta = detail?.delta;
      if (typeof delta !== "number" || !Number.isFinite(delta) || delta <= 0) return;
      toast.success(t("usage.resetCreditBalanceIncreased", { count: delta, account: detail.label ?? t("usage.account") }));
    };
    window.addEventListener("cody:reset-credit-balance-increased", onBalanceIncrease);
    return () => window.removeEventListener("cody:reset-credit-balance-increased", onBalanceIncrease);
  }, [t]);
  valueRef.current = value;
  attachedImagesRef.current = attachedImages;
  attachedTextFilesRef.current = attachedTextFiles;
  const applyRewoundDraft = useCallback((draft: RewoundDraft) => {
    setValue(draft.text);
    setAtQuery(null);
    setAttachedImages((previous) => {
      previous.forEach(revokeImagePreview);
      return draftImagesToAttachedImages(draft.images);
    });
    setAttachedTextFiles([]);
    setPendingRewoundDraft(null);
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(draft.text.length, draft.text.length);
      ta.style.height = "auto";
      ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
    });
  }, []);

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
    prependDraft(draft: RewoundDraft) {
      const ta = textareaRef.current;
      const currentText = ta ? ta.value : valueRef.current;
      const composerHasContent = Boolean(currentText.trim())
        || attachedImagesRef.current.length > 0
        || attachedTextFilesRef.current.length > 0
        || pendingImageCountRef.current > 0
        || pendingTextFileCountRef.current > 0;
      if (composerHasContent) {
        setPendingRewoundDraft(draft);
        return;
      }
      applyRewoundDraft(draft);
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
            source: file,
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
    if (isStreaming && !canAttachWhileStreaming) {
      setAttachError("Attachments are disabled while the agent is running.");
      return;
    }
    const imageFiles = files.filter((file) => file.type.startsWith("image/"));
    const otherFiles = files.filter((file) => !file.type.startsWith("image/"));
    if (imageFiles.length > 0 && isStreaming && !canAttachImagesWhileStreaming) {
      setAttachError("Image attachments are unavailable while the agent is running.");
    } else {
      void processImageFiles(imageFiles);
    }
    void processTextFiles(otherFiles);
  }, [isStreaming, canAttachWhileStreaming, canAttachImagesWhileStreaming, processImageFiles, processTextFiles]);

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
    valueRef.current = "";
    attachedImagesRef.current = [];
    attachedTextFilesRef.current = [];
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
  /** Prepares the complete image batch immediately before any accepted prompt. */
  const prepareOutgoingImages = useCallback(async (composedMessage: string): Promise<AttachedImage[] | null> => {
    if (preparingImageCount > 0) return null;
    if (!attachedImages.length) {
      const tooLarge = budgetError(composedMessage, []);
      if (tooLarge) setAttachError(tooLarge);
      return tooLarge ? null : [];
    }
    if (attachedImages.some((image) => !image.source)) {
      const tooLarge = budgetError(composedMessage, attachedImages);
      if (tooLarge) setAttachError(tooLarge);
      return tooLarge ? null : attachedImages;
    }
    setPreparingImageCount((count) => count + 1);
    try {
      const batch = await prepareImageBatchForAttachment({
        files: attachedImages.map((image) => image.source!),
        message: composedMessage,
        unsupportedMessage: (fileName) => t("chatInput.imageUndecodable", { name: fileName, formats: SUPPORTED_IMAGE_FORMAT_LABEL }),
      });
      const outgoing = attachedImages.map((image, index) => ({
        ...image,
        data: batch[index].data,
        mimeType: batch[index].mimeType,
      }));
      const tooLarge = budgetError(composedMessage, outgoing);
      if (tooLarge) {
        setAttachError(tooLarge);
        return null;
      }
      return outgoing;
    } catch (error) {
      setAttachError(error instanceof Error ? error.message : t("chatInput.imageReadFailed", { name: attachedImages[0]?.name ?? t("chatInput.attachFile") }));
      return null;
    } finally {
      setPreparingImageCount((count) => Math.max(0, count - 1));
    }
  }, [attachedImages, budgetError, preparingImageCount, t]);
  // Re-entrancy guard: a second Enter while the first send's image prep or
  // builtin command is still awaiting would snapshot the same composer text
  // again and send it twice. The guard covers only that window; once the
  // send is dispatched it releases, so queued sends go out in order.
  const sendInFlightRef = useRef(false);
  const handleSend = useCallback(async () => {
    const msg = value.trim();
    if (!msg && !attachedImages.length && !attachedTextFiles.length) return;
    if (isStreaming && !canSendWhileStreaming) return;
    if (preparingImageCount > 0 || sendInFlightRef.current) return;
    sendInFlightRef.current = true;
    const textSnapshot = value;
    const imageSnapshot = attachedImages;
    const fileSnapshot = attachedTextFiles;
    const restoreSnapshot = (detail = t("chatInput.imageReadFailed")) => {
      if (valueRef.current || attachedImagesRef.current.length || attachedTextFilesRef.current.length) {
        setFailedPreparations((items) => [...items, { id: `preparation-${++failedPreparationIdRef.current}`, text: textSnapshot, images: imageSnapshot, files: fileSnapshot, detail }]);
        setAttachError(null);
        return;
      }
      const restoredImages = imageSnapshot.map((image) => ({
        ...image,
        previewUrl: image.source ? URL.createObjectURL(image.source) : `data:${image.mimeType};base64,${image.data}`,
      }));
      valueRef.current = textSnapshot;
      attachedImagesRef.current = restoredImages;
      attachedTextFilesRef.current = fileSnapshot;
      setValue(textSnapshot);
      setAttachedImages(restoredImages);
      setAttachedTextFiles(fileSnapshot);
      setAttachError(null);
    };
    const dispatchSend = async (message: string, images?: AttachedImage[]) => {
      // The message is prepared and the composer already cleared: from here
      // it belongs to the outbox, so the next Enter must not wait on this
      // one (a new chat's first send waits for the chat to be created).
      sendInFlightRef.current = false;
      setSendPreparing(false);
      try {
        if (await onSend(message, images) === false) restoreSnapshot();
      } catch (error) {
        restoreSnapshot();
        throw error;
      }
    };
    setSendPreparing(true);
    clearInput();
    try {
      onAudioUnlock?.();
      const composedMessage = composeMessageWithTextAttachments(msg, attachedTextFiles);
      if (!isStreaming && !attachedImages.length && !attachedTextFiles.length && msg.startsWith("/") && onBuiltinCommand) {
        const result = await onBuiltinCommand(msg).catch((error) => {
          restoreSnapshot();
          throw error;
        });
        if (result.handled) {
          if (result.error || result.retainInput) restoreSnapshot();
          return;
        }
      }
      let preparationError: string | undefined;
      const outgoingImages = await prepareOutgoingImages(composedMessage).catch((error) => {
        preparationError = error instanceof Error ? error.message : String(error);
        return null;
      });
      setSendPreparing(false);
      if (outgoingImages === null) {
        restoreSnapshot(preparationError);
        return;
      }
      if (isStreaming && !outgoingImages.length && !attachedTextFiles.length && msg.startsWith("/")) {
        const expansion = expandWebSlashCommand(msg);
        if (expansion.kind === "usage-error") {
          toast.error(t("chatInput.commandUsageTitle"), t("agentSession.commandRequiresArgs", {
            command: expansion.command,
            usage: t(expansion.argumentHintKey),
          }));
          restoreSnapshot();
          return;
        }
        await dispatchSend(expansion.kind === "expand" ? expansion.prompt : composedMessage);
        return;
      }
      await dispatchSend(composedMessage, outgoingImages.length ? outgoingImages : undefined);
    } finally {
      setSendPreparing(false);
      sendInFlightRef.current = false;
    }
  }, [value, attachedImages, attachedTextFiles, isStreaming, canSendWhileStreaming, preparingImageCount, prepareOutgoingImages, onBuiltinCommand, onSend, clearInput, onAudioUnlock, t]);

  const slashQuery = value.startsWith("/") && !/\s/.test(value.slice(1))
    ? value.slice(1).toLowerCase()
    : null;
  const [dormantSkillNames, setDormantSkillNames] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    if (slashQuery === null || !cwd) return;
    if (!capabilities.skills) return;
    const controller = new AbortController();
    // Capability-gated: an engine with no skills surface must not be asked to
    // scan for skills. Claude Code and Codex report `skills: false`, and
    // without this they ran a full filesystem scan on every "/" keystroke.
    void fetch(`/api/skills?cwd=${encodeURIComponent(cwd)}`, { signal: controller.signal })
      .then((response) => response?.ok ? response.json() as Promise<{ skills?: Array<{ name?: string; disableModelInvocation?: boolean }> }> : null)
      .then((data) => {
        if (!data) return;
        setDormantSkillNames(new Set((data.skills ?? []).flatMap((skill) => skill.disableModelInvocation && skill.name ? [skill.name] : [])));
      })
      .catch(() => {});
    return () => controller.abort();
  }, [cwd, slashQuery, capabilities.skills]);

  const builtinSlashCommands: SlashCommandPaletteItem[] = React.useMemo(
    () => [...WEB_SLASH_COMMAND_DEFS, ...(chatExtras ? RPC_SLASH_COMMAND_DEFS : [])].map((def) => ({
      name: def.name,
      description: t(def.descriptionKey),
      ...(def.argumentHintKey ? { argumentHint: t(def.argumentHintKey) } : {}),
      source: "builtin" as const,
    })),
    [t, chatExtras],
  );

  // Externally reported commands (extension/prompt/skill/engineBuiltin) group
  // below the client built-ins; any name the web UI intercepts itself —
  // whether an omp builtin or a user extension — is dropped so each command
  // appears exactly once and the client interception behavior is unchanged.
  const externalSlashCommands: SlashCommandPaletteItem[] = React.useMemo(
    () => (slashCommands ?? []).flatMap((command): SlashCommandPaletteItem[] => {
      const source = command.source as string;
      if (CLIENT_BUILTIN_COMMAND_NAMES.has(command.name)) return [];
      // Whatever the engine calls its own builtins on the wire ("builtin"
      // from pi's get_commands, "ompBuiltin" from omp's), they are the
      // ENGINE's, not the web UI's, and group under the engine's own name.
      if (source === "builtin" || source === "ompBuiltin") {
        return [{ name: command.name, description: command.description, source: "engineBuiltin" }];
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

  // ── Send outbox rows ────────────────────────────────────────────────────
  // The per-session outbox (lib/outbox.ts) is where every composer send
  // lives from the moment the composer clears until the engine has it:
  // sending → queued|started → delivered, or failed with Retry + Edit.
  const handleOutboxEdit = useCallback((id: string) => {
    const restored = onEditOutboxEntry?.(id);
    if (!restored) return;
    setValue(restored.text);
    setAttachedImages((prev) => {
      prev.forEach(revokeImagePreview);
      return draftImagesToAttachedImages(restored.images);
    });
    setAttachError(null);
    setAtQuery(null);
    setHistoryMenuOpen(false);
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(restored.text.length, restored.text.length);
      ta.style.height = "auto";
      ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
    });
  }, [onEditOutboxEntry]);

  const handlePreparationEdit = useCallback((id: string) => {
    const failed = failedPreparations.find((item) => item.id === id);
    if (!failed) return;
    const restoredText = [failed.text, valueRef.current].filter(Boolean).join("\n\n");
    valueRef.current = restoredText;
    setValue(restoredText);
    const restoredImages = failed.images.map((image) => ({
      ...image,
      previewUrl: image.source ? URL.createObjectURL(image.source) : `data:${image.mimeType};base64,${image.data}`,
    }));
    attachedImagesRef.current = [...restoredImages, ...attachedImagesRef.current];
    setAttachedImages((current) => [...restoredImages, ...current]);
    attachedTextFilesRef.current = [...failed.files, ...attachedTextFilesRef.current];
    setAttachedTextFiles((current) => [...failed.files, ...current]);
    setFailedPreparations((current) => current.filter((item) => item.id !== id));
    setAttachError(null);
    setAtQuery(null);
    setHistoryMenuOpen(false);
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(restoredText.length, restoredText.length);
      ta.style.height = "auto";
      ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
    });
  }, [failedPreparations]);
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

  // Inline word completion (omp 18.4 `predict_word`): ghost text after the
  // caret, Tab / Right-arrow to accept. Touch devices have no Tab key, and
  // every open menu (slash, @, history) owns Tab and the arrows already.
  const isCoarsePointer = useIsCoarsePointer();
  const [caret, setCaret] = useState(-1);
  const [composing, setComposing] = useState(false);
  const wordCompletion = useWordCompletion({
    sessionId,
    enabled:
      engine?.id === OMP_ENGINE_ID && !isCoarsePointer && !sendPreparing && !composing && !bashMode &&
      !slashMenuOpen && !atMenuOpen && !historyMenuOpen,
    textareaRef,
    value,
    caret,
  });
  const trackCaret = useCallback((el: HTMLTextAreaElement) => {
    setCaret(el.selectionStart === el.selectionEnd ? el.selectionStart : -1);
  }, []);
  const acceptWordCompletion = useCallback((withSpace: boolean) => {
    const accepted = wordCompletion.accept(withSpace);
    if (!accepted) return false;
    // insertText goes through the browser's own edit path, so Ctrl+Z undoes
    // the completion; it also fires the input event React's onChange reads.
    if (document.execCommand("insertText", false, accepted.inserted)) return true;
    setValue(accepted.value);
    setHistoryMenuOpen(false);
    updateAtQuery(accepted.value, accepted.cursor);
    requestAnimationFrame(() => textareaRef.current?.setSelectionRange(accepted.cursor, accepted.cursor));
    scheduleAutosize();
    return true;
  }, [wordCompletion.accept, updateAtQuery, scheduleAutosize]);

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

      // Word-completion ghost text. Only reached with every menu closed (they
      // return above), and only while a suggestion is actually showing, so
      // Tab and Right-arrow behave as they always did the rest of the time.
      if (wordCompletion.shown && !isComposing) {
        const plain = !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey;
        if (plain && (e.key === "Tab" || e.key === "ArrowRight") && acceptWordCompletion(e.key === "Tab")) {
          e.preventDefault();
          return;
        }
        if (e.key === "Escape") {
          wordCompletion.reject();
          // While a turn runs, Esc still stops it (below).
          if (!(isStreaming && onAbort)) {
            e.preventDefault();
            return;
          }
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
        // Enter always sends, running or not. What a mid-run send means
        // (steer vs. queued follow-up) is the Settings submit-during-run
        // preference, resolved inside the session hook — and whether the
        // engine accepts one at all is `canSendWhileStreaming`, which
        // handleSend also checks.
        void handleSend();
      }
    },
    [isStreaming, onAbort, slashMenuOpen, slashQuery, filteredSlashCommands, slashActiveIndex, applySlashCommand, handleSend, getNextSlashIndex, atMenuOpen, atQuery, atMatches, atActiveIndex, applyAtCompletion, historyMenuOpen, inputHistory, historyActiveIndex, applyHistoryInput, value, wordCompletion.shown, wordCompletion.reject, acceptWordCompletion]
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

  // Which models this user hides or pinned, and picked recently — the
  // browser mirror of /api/models/visibility (lib/composer-model-visibility).
  // The mirror paints on the first frame; the server's answer refreshes it.
  const engineId = engine?.id ?? null;
    const profileRoute = useSettingsRoute<LocalModelProfileBody>(
      model ? `/api/local-model-profile?provider=${encodeURIComponent(model.provider)}&modelId=${encodeURIComponent(model.modelId)}${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ""}` : null,
      { enabled: engineId === OMP_ENGINE_ID && model !== null, ttlMs: 60_000 },
    );
  const [visibility, setVisibility] = useState<ComposerVisibility>(() => readComposerVisibility(engineId));
  useEffect(() => {
    const refresh = () => setVisibility(readComposerVisibility(engineId));
    refresh();
    window.addEventListener(STORAGE_EVENTS.composerVisibilityChange, refresh);
    window.addEventListener(STORAGE_EVENTS.recentModelsChange, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(STORAGE_EVENTS.composerVisibilityChange, refresh);
      window.removeEventListener(STORAGE_EVENTS.recentModelsChange, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, [engineId]);
  const visibilityRoute = useSettingsRoute<VisibilityBody>("/api/models/visibility", { enabled: engineId !== null, ttlMs: 60_000 });
  useEffect(() => {
    if (visibilityRoute.data) mirrorServerVisibility(engineId, visibilityRoute.data);
  }, [visibilityRoute.data, engineId]);
  // The new-models line reads the CACHED diff only (`?cached=1` never starts
  // an engine child); once per load, and again when the catalog changed.
  const newModelsRoute = useSettingsRoute<NewModelsPeek>("/api/models/new?cached=1", { enabled: engineId !== null, ttlMs: 5 * 60_000 });
  const reloadNewModels = newModelsRoute.reload;
  const lastRefreshKeyRef = useRef(modelsRefreshKey);
  useEffect(() => {
    if (lastRefreshKeyRef.current === modelsRefreshKey) return;
    lastRefreshKeyRef.current = modelsRefreshKey;
    void reloadNewModels();
  }, [modelsRefreshKey, reloadNewModels]);
  const newModelCount = newModelsRoute.data?.newModels?.length ?? 0;
  const openSettings = useSettingsOpener();
  // The omp provider order, when the engine keeps one (config.yml); other
  // engines have no such setting and the route refuses. `capabilities` is
  // the all-on default until /api/info answers, so the read also waits for
  // the engine identity — otherwise every engine asked once on first paint.
  const ompSettingsRoute = useSettingsRoute<{ settings?: { modelProviderOrder?: string[] } }>("/api/omp-settings", { enabled: engineId !== null && capabilities.configEditor, ttlMs: 60_000 });
  const providerOrder = ompSettingsRoute.data?.settings?.modelProviderOrder;

  // The retired allowlist (`cody:composer-models`) becomes the account's
  // hidden list the first time a catalog arrives, after the server's own
  // lists are known so the union is complete. Once per page per engine.
  const visibilitySettled = visibilityRoute.data !== null || visibilityRoute.error !== null || visibilityRoute.unsupported;
  useEffect(() => {
    if (!engineId || migratedEngines.has(engineId) || !modelList || modelList.length === 0 || !visibilitySettled) return;
    migratedEngines.add(engineId);
    void migrateComposerAllowlist(engineId, modelList.map(modelVisibilityKey), { serverHidden: visibilityRoute.data?.hidden })
      .then((result) => {
        if (!result.migrated) return;
        toast.info(t("chatInput.allowlistMigrated"), t("chatInput.allowlistMigratedDetail", { count: result.hidden.length }), { durationMs: 10_000 });
      })
      .catch(() => { migratedEngines.delete(engineId); });
    // `visibilityRoute.data` is read once at migration time; re-running on
    // its later changes would be a second migration of nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engineId, modelList, visibilitySettled, t]);

  // omp's two prewalk switches, surfaced in the model dropdown. Only the two
  // values are fetched — the full schema payload is ~550 keys and the
  // composer loads on every chat.
  const prewalkSupported = engineId === OMP_ENGINE_ID && capabilities.nativeSettings;
  const prewalkRoute = useSettingsRoute<{ values?: Record<string, unknown> }>(
    "/api/omp-settings/schema?values=prewalk.enabled,task.prewalk",
    { enabled: prewalkSupported, ttlMs: 60_000 },
  );
  const [prewalkPending, setPrewalkPending] = useState<string | null>(null);
  const reloadPrewalk = prewalkRoute.reload;
  const setPrewalkSetting = useCallback((path: string, value: boolean) => {
    setPrewalkPending(path);
    // `applyNow` restarts idle engine children, so the switch reaches the
    // conversation on screen at its next turn rather than only the next
    // session — which is what "or in the middle of a session" requires.
    patchSettingsSchema({ [path]: value }, { applyNow: true })
      .then(() => reloadPrewalk())
      .catch((error: unknown) => toast.error(t("chatInput.prewalkSaveFailed"), error instanceof Error ? error.message : String(error)))
      .finally(() => setPrewalkPending((current) => (current === path ? null : current)));
  }, [reloadPrewalk, t]);

  // Fast and both prewalk switches are model-ROUTING decisions, so they live
  // in the model dropdown rather than the controls row — which on a phone has
  // no width left for them (lib/…/ChatInput: the row is nowrap below 640px).
  // An unavailable Fast renders NOTHING (see lib/fast-mode-state.ts).
  const fastState = deriveFastModeState({
    capable: Boolean(fastModeCapable && onFastModeChange),
    supported: fastModeSupported,
    enabled: fastModeEnabled,
    active: fastModeActive,
    unavailable: fastModeUnavailable,
    pending: fastModePending,
  });
  const fastRow = fastState !== "unavailable" && onFastModeChange ? (() => {
    const labels: Record<string, string> = {
      checking: t("chatInput.fastModeChecking"),
      requested: t("chatInput.fastModeRequested"),
      inactive: t("chatInput.fastModeInactive"),
      unverified: t("chatInput.fastModeUnverified"),
      off: t("chatInput.fastModeOff"),
    };
    const hints: Record<string, string> = {
      checking: t("chatInput.fastModeCheckingHint"),
      requested: t("chatInput.fastModeRequestedHint"),
      inactive: t("chatInput.fastModeInactiveHint"),
      unverified: t("chatInput.fastModeUnverifiedHint"),
      off: t("chatInput.fastModeOffHint"),
    };
    const warning = fastState === "inactive";
    return (
      <DropdownToggleRow
        testId="fast-mode-toggle"
        icon={fastState === "checking"
          ? <Loader2 size={13} strokeWidth={1.8} aria-hidden="true" style={{ flexShrink: 0, marginTop: 2, animation: "spin 0.8s linear infinite" }} />
          : React.createElement(warning ? TriangleAlert : fastModeEnabled ? Zap : ZapOff, { size: 13, strokeWidth: 1.8, "aria-hidden": true, style: { flexShrink: 0, marginTop: 2, color: warning ? "var(--status-warning)" : fastModeEnabled ? "var(--accent)" : "var(--text-dim)" } })}
        label={labels[fastState]}
        hint={hints[fastState]}
        pressed={Boolean(fastModeEnabled)}
        pending={Boolean(fastModePending)}
        isMobile={isMobile}
        onToggle={() => { if (!fastModePending) onFastModeChange(!fastModeEnabled); }}
      />
    );
  })() : null;

  const prewalkValues = prewalkRoute.data?.values;
  const prewalkEnabled = prewalkValues?.["prewalk.enabled"] === true;
  const taskPrewalkEnabled = prewalkValues?.["task.prewalk"] === true;
  const prewalkRows = prewalkSupported && prewalkValues ? (
    <>
      <DropdownToggleRow
        testId="prewalk-toggle"
        icon={<Footprints size={13} strokeWidth={1.8} aria-hidden="true" style={{ flexShrink: 0, marginTop: 2, color: prewalkEnabled ? "var(--accent)" : "var(--text-dim)" }} />}
        label={t("chatInput.prewalk")}
        hint={t("chatInput.prewalkHint")}
        pressed={prewalkEnabled}
        pending={prewalkPending === "prewalk.enabled"}
        isMobile={isMobile}
        onToggle={() => setPrewalkSetting("prewalk.enabled", !prewalkEnabled)}
      />
      <DropdownToggleRow
        testId="task-prewalk-toggle"
        icon={<Split size={13} strokeWidth={1.8} aria-hidden="true" style={{ flexShrink: 0, marginTop: 2, color: taskPrewalkEnabled ? "var(--accent)" : "var(--text-dim)" }} />}
        label={t("chatInput.taskPrewalk")}
        hint={t("chatInput.taskPrewalkHint")}
        pressed={taskPrewalkEnabled}
        pending={prewalkPending === "task.prewalk"}
        isMobile={isMobile}
        onToggle={() => setPrewalkSetting("task.prewalk", !taskPrewalkEnabled)}
      />
    </>
  ) : null;

  // Muted "model · level" hint for one preset's `default` role — or a
  // fallback when unconfigured/unparsable, so a row never shows literally
  // nothing. Not exported from hooks/session-preset-state.ts: it needs t()
  // and modelNames, which only exist inside a component.
  const formatPresetHint = (split: ParsedPresetSelector | null): string => {
    if (!split) return t("chatInput.presetNoDefault");
    const name = formatModelDisplayName(split.modelId, modelNames?.[`${split.provider}:${split.modelId}`]);
    return split.thinkingLevel ? `${name} \u00b7 ${thinkingLevelLabel(split.thinkingLevel, t)}` : name;
  };
  // "Base settings" (id null) + every configured preset — Presets only ever
  // apply while the composer is on Smart (AGENTS.md "Composer model + tools
  // controls"), so this list is hidden the instant a manual pick leaves it,
  // exactly like the picker itself.
  const presetRows = capabilities.models && onPresetChange && isAutoModelSelection && presets.length > 0 ? (
    <div style={{ borderBottom: "1px solid var(--border)", background: "var(--bg-panel)" }}>
      <DropdownToggleRow
        testId="preset-base"
        icon={<Gauge size={13} strokeWidth={1.8} aria-hidden="true" style={{ flexShrink: 0, marginTop: 2, color: activePresetId === null ? "var(--accent)" : "var(--text-dim)" }} />}
        label={t("chatInput.presetBaseSettings")}
        hint={pendingPresetPick?.presetId === null ? t("chatInput.presetPending") : formatPresetHint(baseDefaultModel)}
        pressed={activePresetId === null}
        pending={pendingPresetPick?.presetId === null}
        isMobile={isMobile}
        onToggle={() => onPresetChange(null, t("chatInput.presetBaseSettings"))}
      />
      {presets.map((preset) => (
        <DropdownToggleRow
          key={preset.id}
          testId={`preset-${preset.id}`}
          icon={<Gauge size={13} strokeWidth={1.8} aria-hidden="true" style={{ flexShrink: 0, marginTop: 2, color: activePresetId === preset.id ? "var(--accent)" : "var(--text-dim)" }} />}
          label={preset.name}
          hint={pendingPresetPick?.presetId === preset.id ? t("chatInput.presetPending") : formatPresetHint(preset.defaultModel)}
          pressed={activePresetId === preset.id}
          pending={pendingPresetPick?.presetId === preset.id}
          isMobile={isMobile}
          onToggle={() => onPresetChange(preset.id, preset.name)}
        />
      ))}
    </div>
  ) : null;

  // Every model the session may pick: the catalog minus what is hidden. The
  // running model stays listed even when hidden, so the label always names
  // something the list has.
  const allModelOptions: ModelOption[] = React.useMemo(() => {
    if (modelList && modelList.length > 0) {
      return modelList.map((m) => ({ provider: m.provider, modelId: m.id, name: formatModelDisplayName(m.id, m.name) }))
        .filter((m) => {
          const key = `${m.provider}/${m.modelId}`;
          const isActive = model?.provider === m.provider && model?.modelId === m.modelId;
          return isActive || (!visibility.hidden.has(key) && !visibility.instanceHidden.has(key));
        })
        .sort((a, b) => compareModelOptions(modelCollator, a, b));
    }
    return Object.entries(modelNames ?? {}).map(([modelId, name]) => ({
      provider: model?.provider ?? "unknown",
      modelId,
      name: formatModelDisplayName(modelId, name),
    })).sort((a, b) => compareModelOptions(modelCollator, a, b));
  }, [modelList, modelNames, model?.provider, model?.modelId, visibility, modelCollator]);
  const modelOptions = allModelOptions;
  // Two providers serving a model under one display name (a vendor and a
  // gateway rebadging it) get their provider appended so the rows can be
  // told apart.
  const duplicateModelNames = React.useMemo(() => {
    const counts = new Map<string, number>();
    for (const opt of allModelOptions) counts.set(opt.name, (counts.get(opt.name) ?? 0) + 1);
    return new Set([...counts].filter(([, count]) => count > 1).map(([name]) => name));
  }, [allModelOptions]);

  // PINNED models only, one group per provider. The composer is the place
  // the user works from, not a catalog browser: everything else lives in
  // Settings › Models, which is also where an empty list points. The active
  // model's provider leads so the running model is never a scroll away.
  const modelGroups: { id: string; provider: string; options: ModelOption[] }[] = React.useMemo(() => {
    const pinned = allModelOptions.filter((opt) => visibility.pinned.has(`${opt.provider}/${opt.modelId}`));
    const providers = new Map<string, ModelOption[]>();
    for (const opt of pinned) {
      const list = providers.get(opt.provider) ?? [];
      list.push(opt);
      providers.set(opt.provider, list);
    }
    const names = [...providers.keys()].sort((a, b) => modelCollator.compare(a, b));
    const ordered = providerOrder
      ? [...providerOrder.filter((name) => providers.has(name)), ...names.filter((name) => !providerOrder.includes(name))]
      : names;
    if (model && providers.has(model.provider)) {
      ordered.splice(ordered.indexOf(model.provider), 1);
      ordered.unshift(model.provider);
    }
    return ordered.map((name) => ({
      id: `provider:${name}`,
      provider: name,
      options: (providers.get(name) ?? []).slice().sort((a, b) => compareModelOptions(modelCollator, a, b)),
    }));
  }, [allModelOptions, visibility, providerOrder, modelCollator, model]);
  const modelsByProvider = modelGroups;
  const activeModelHiddenByAdmin = Boolean(model && visibility.instanceHidden.has(`${model.provider}/${model.modelId}`));

  const pickModel = useCallback((provider: string, modelId: string) => {
    setModelDropdownOpen(false);
    pushRecentModel(engineId, `${provider}/${modelId}`);
    onModelChange?.(provider, modelId);
  }, [engineId, onModelChange]);

  const displayModelName = model
    ? (modelOptions.find((o) => o.modelId === model.modelId && o.provider === model.provider)?.name
        ?? modelNameOverride
        ?? modelNames?.[`${model.provider}:${model.modelId}`]
        ?? model.modelId)
    : null;
  const currentName = displayModelName;
  // The preset this chat is bound to, resolved to its CURRENT display name
  // (built-ins default to Max/High/Medium/Low but may be renamed) — never
  // derived from the id. Undefined/null activePresetId (not yet known, or
  // explicit Base settings) means no suffix: plain "Smart".
  const activePresetOptionName = activePresetId ? presets.find((preset) => preset.id === activePresetId)?.name ?? null : null;
  const smartTriggerLabel = formatSmartTriggerLabel(t("chatInput.smartModel"), activePresetOptionName);
  // A failed load surfaces modelError; only an in-flight load shows the
  // loading chip, so "no models" can only appear after the fetch settled.
  const showModelsLoading = Boolean(modelsLoading) && !modelError;
  const modelSelectorDisabled = (isStreaming && !modelChangeWhileStreaming) || (showModelsLoading && modelOptions.length === 0);
  const modelSwitchStatus = modelSwitchPending
    ? t(modelSwitchPending.phase === "waiting" ? "chatInput.modelSwitchWaiting" : "chatInput.modelSwitchApplying", { name: modelSwitchPending.name })
    : null;
  const autoSwitchJobKey = autoModelSwitch?.job?.roleLabelKey ?? "agentSession.job.default";
  const autoSwitchJobLabel = t(autoSwitchJobKey, {
    name: autoModelSwitch?.job?.agent ?? autoModelSwitch?.job?.subagentId ?? "",
    role: autoModelSwitch?.role ?? "",
  });
  const autoSwitchJob = autoSwitchJobLabel === autoSwitchJobKey
    ? t("agentSession.job.default")
    : autoSwitchJobLabel;
  // A refusal is not a limit: nothing is exhausted, waiting changes nothing,
  // and the engine pins the session to the fallback — so the detail says to
  // re-pick the model by hand instead of pointing at a healthy quota.
  const autoSwitchDetail = autoModelSwitch == null
    ? null
    : autoModelSwitch.reasonKind === "refusal"
      ? t("chatInput.autoSwitchDetailRefusal", { job: autoSwitchJob, from: autoModelSwitch.from, to: autoModelSwitch.to })
      : autoModelSwitch.reasonKind === "usage"
        ? t("chatInput.autoSwitchDetailUsage", { job: autoSwitchJob, from: autoModelSwitch.from, to: autoModelSwitch.to })
        : t("chatInput.autoSwitchDetail", {
            job: autoSwitchJob,
            from: autoModelSwitch.from,
            reason: autoModelSwitch.reason ?? t("chatInput.autoSwitchUnknownReason"),
            to: autoModelSwitch.to,
          });

  // Smart row on a LIVE session: there is no "auto" runtime state to fall
  // back into (the session already has a resolved model), so this reaches
  // for the same answer omp would give a brand-new session under the
  // chat's OWN bound preset (or Base settings) — GET
  // /api/sessions/[id]/preset's smartDefault — and pins the picker to it,
  // applying its reasoning level the same way a preset switch does. Fetched
  // fresh through the shared route cache (hooks/useSettingsData.ts) rather
  // than trusted from whatever hooks/useSessionPreset.ts last prefetched: a
  // click is a deliberate action and must never act on a stale read. Unset
  // or unmatched roles surface a toast rather than silently doing nothing.
  const handleSmartModelForLiveSession = useCallback(async () => {
    if (!onModelChange || !sessionId) return;
    try {
      const entry = await fetchSettingsRoute<SessionPresetResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/preset`);
      const smartDefault = entry.data?.smartDefault;
      if (!smartDefault) {
        toast.info(t("chatInput.smartModelUnavailable", { name: engineName }));
        return;
      }
      const match = modelList?.find((m) => m.provider === smartDefault.provider && m.id === smartDefault.modelId);
      if (!match) {
        toast.info(t("chatInput.smartModelUnavailable", { name: engineName }));
        return;
      }
      await onModelChange(match.provider, match.id, "smart");
      if (smartDefault.thinkingLevel && onThinkingLevelChange) onThinkingLevelChange(smartDefault.thinkingLevel, "preset");
    } catch (e) {
      console.error("Failed to resolve smart model:", e);
      toast.info(t("chatInput.smartModelUnavailable", { name: engineName }));
    }
  }, [modelList, onModelChange, onThinkingLevelChange, sessionId, t, engineName]);

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
  const currentThinkingDisplayLabel = (() => {
    const lvl = thinkingLevel ?? "auto";
    return thinkingLevelLabel(lvl, t);
  })();
  const thinkingDisplayLabel = thinkingLevelPending
    ? t("chatInput.reasoningApplyingLevel", {
        level: thinkingLevelLabel(thinkingLevelTarget ?? thinkingLevel ?? "auto", t),
      })
    : currentThinkingDisplayLabel;
  // The ring gauges the binding PLAN QUOTA window OF THE SELECTED MODEL; the
  // context window has its own readout in the top bar.
  //
  // A model switch is pure re-filtering: one `omp usage --json` read already
  // carries every provider and every tier, so the cached snapshot already
  // answers for whichever model is now selected. Switching must NOT fetch.
  const quotaProvider = model?.provider;
  const quotaModelId = model?.modelId;
  // The selected model's own provider ("claude", "codex", an omp provider id)
  // translated to the omp usage-provider id that actually meters it. Null
  // when the engine cannot be mapped with confidence (Pi, Hermes, anything
  // `usageProviderFor` does not cover) — the ring then has nothing honest to
  // gauge, rather than borrowing whichever account happens to sort first.
  const quotaUsageProvider = quotaProvider ? usageProviderFor(engineId, quotaProvider) : null;
  const quota = React.useMemo(
    () => buildQuotaView(
      usageSnapshot,
      usageLoading,
      usageFailed,
      quotaUsageProvider && quotaModelId ? { provider: quotaUsageProvider, modelId: quotaModelId } : null,
      activeModels,
    ),
    [usageSnapshot, usageLoading, usageFailed, quotaUsageProvider, quotaModelId, activeModels],
  );
  // The ring's render gate (below, alongside OpenRouter and reset credits):
  // true only once the snapshot actually answered AND it names an account for
  // the model's translated provider. An unmapped engine (no `quotaUsageProvider`
  // at all) or a provider the snapshot never mentions both read as "nothing to
  // show" rather than an empty ring.
  const hasMappedQuotaAccount = Boolean(
    usageSnapshot?.available
    && quotaUsageProvider
    && (usageSnapshot.accounts ?? []).some((account) => account.provider === quotaUsageProvider),
  );
  // A gateway balance matters whenever THIS session routes work through it,
  // including an OpenRouter subagent under a non-OpenRouter selected model.
  const openRouterSelected = isPrepaidProvider(quotaProvider);
  const openRouterActive = openRouterSelected || activeModels.some((active) => isPrepaidProvider(active.provider));
  const openRouterAccount = useOpenRouterAccount(openRouterActive);
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
  const refreshOpenRouter = openRouterAccount.refresh;
  useEffect(() => {
    if (!contextPopoverOpen) return;
    refreshUsage();
    refreshResetCredits();
    if (openRouterActive) refreshOpenRouter();
  }, [contextPopoverOpen, refreshUsage, refreshResetCredits, openRouterActive, refreshOpenRouter]);
  // The popover's own Refresh is the user asking again, so it is the one read
  // allowed to make the server re-check saved resets with the provider.
  const refreshQuotaNow = useCallback(() => {
    refreshUsage();
    refreshResetCredits(true);
  }, [refreshUsage, refreshResetCredits]);
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
  // A turn ending is the ONE moment the numbers provably changed: the run
  // just spent quota. Waiting out the hook's 90s cadence leaves the ring
  // reporting a pre-turn reading for up to a minute and a half after the
  // reply lands — long enough to pick the next model from a stale number.
  // Only the falling edge fires, so a run's start costs nothing, and the
  // hook's own in-flight guard drops a refresh that races the poll.
  const wasStreamingRef = useRef(false);
  useEffect(() => {
    const wasStreaming = wasStreamingRef.current;
    wasStreamingRef.current = Boolean(isStreaming);
    if (wasStreaming && !isStreaming) refreshUsage();
  }, [isStreaming, refreshUsage]);

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

  // The mode the engine reports, or its first offer while the report is
  // still in flight — never nothing, so the button always has a name.
  const currentMode = availableModes.find((mode) => mode.id === currentModeId) ?? availableModes[0] ?? null;

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
      if (modeDropdownRef.current && !modeDropdownRef.current.contains(e.target as Node)) {
        setModeDropdownOpen(false);
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
        // The composer is the app's bottom viewport edge wherever it renders,
        // so it is the one element that adds the home-indicator inset. Its
        // 16px sides ARE the chat column's gutter — callers must not wrap it in
        // a second one (see ChatWindow's docks).
        padding: "0 16px calc(8px + var(--safe-bottom))",
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
        disabled={isStreaming && !canAttachWhileStreaming}
        style={{ display: "none" }}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          processFiles(files);
          e.target.value = "";
        }}
      />
      <div style={{ maxWidth: CHAT_COLUMN_MAX_WIDTH, margin: "0 auto" }}>
        {/* A catalog error is worth reporting only where a picker exists to
            act on it. An engine whose models live on the session reports no
            catalog error at all — an empty global list is the honest answer
            there, not a failure — so what survives this gate is a real one. */}
        <ModelErrorBanner error={onModelChange ? modelError : null} code={onModelChange ? modelErrorCode : null} />
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
                        <span>{t(SLASH_SOURCE_GROUP_LABEL_KEYS[group.source], { name: engineName })}</span>
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
        {/* Waiting strip — shown when the engine cannot take anything until
            the current turn ends and nothing is queued yet. Visible even once
            the user has typed, which the placeholder alone would not be. */}
        {turnWaiting && !outbox.some((entry) => entry.status === "queued") && (
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
        {/* Send outbox rows — where each composer send lives from the moment
            the composer clears until the engine has it: sending → queued or
            started → delivered (briefly), or failed with Retry + Edit.
            Nothing a user typed is ever silently dropped. */}
        {outbox.filter((entry) => entry.status !== "delivered").map((entry, index) => {
          const failed = entry.status === "failed";
          // A row Cody's server still holds is shown as an editable follow-up.
          const held = entry.status === "queued" && entry.held === true;
          // Delete, Edit and Steer are offered on every queued row: a held one is
          // simply taken back, and one the engine already has is asked back out of
          // omp's own queue (omp 18.4.4+; moving a follow-up ahead needs 18.4.6+).
          // An older omp's refusal comes back as the existing "already handed to
          // the agent" warning, so the buttons are safe to show everywhere.
          const actionable = entry.status === "queued";
          return (
            <div
              key={entry.id}
              data-testid="outbox-row"
              data-outbox-status={entry.status}
              role="status"
              style={{
                border: "1px solid var(--border)",
                borderBottom: "none",
                borderRadius: index === 0 ? "var(--radius-card) var(--radius-card) 0 0" : 0,
                background: failed ? "color-mix(in srgb, var(--status-error) 6%, var(--bg-panel))" : "var(--bg-panel)",
                padding: "5px 8px 5px 12px",
                display: "flex",
                alignItems: "center",
                gap: 8,
                minWidth: 0,
              }}
            >
              {failed
                ? <AlertTriangle size={11} strokeWidth={2.2} style={{ flexShrink: 0, color: "var(--status-error)" }} aria-hidden="true" />
                : held
                  ? <Clock size={11} strokeWidth={2.2} style={{ flexShrink: 0, color: "var(--text-dim)" }} aria-hidden="true" />
                  : <Loader2 size={11} strokeWidth={2.2} style={{ flexShrink: 0, animation: "spin 0.8s linear infinite" }} aria-hidden="true" />}
              <span style={{
                flexShrink: 0,
                fontSize: 10,
                fontWeight: 600,
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                color: failed ? "var(--status-error)" : "var(--text-muted)",
              }}>
                {failed ? t("chatInput.outboxFailed")
                  : held ? t("chatInput.queuedFollowUp")
                  : entry.status === "queued" ? t("chatInput.outboxHandedOver")
                  : entry.status === "started" ? t("chatInput.outboxStarted")
                  : t("chatInput.outboxSending")}
              </span>
              <span
                title={entry.error ?? entry.text}
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
                {entry.text}
              </span>
              {actionable && (
                <>
                  <QueuedActionButton onClick={() => onEditQueuedMessage?.(entry.id)} title={t("chatInput.queuedEditTitle")}>
                    {t("chatInput.queuedEdit")}
                  </QueuedActionButton>
                  <QueuedActionButton onClick={() => onRemoveQueuedMessage?.(entry.id)} title={t("chatInput.queuedDeleteTitle")}>
                    {t("chatInput.queuedDelete")}
                  </QueuedActionButton>
                </>
              )}
              {actionable && (
                <QueuedActionButton onClick={() => onSteerQueuedNow?.(entry.id)} title={t("chatInput.queuedSteerTitle")} accent>
                  {t("chatInput.queuedSteerAction")}
                </QueuedActionButton>
              )}
              {failed && (
                <>
                  <QueuedActionButton
                    onClick={() => onRetryOutboxEntry?.(entry.id)}
                    title={t("chatInput.outboxRetryTitle")}
                    accent
                  >
                    <RefreshCw size={10} strokeWidth={2.2} aria-hidden="true" style={{ marginRight: 3 }} />
                    {t("chatInput.outboxRetry")}
                  </QueuedActionButton>
                  <QueuedActionButton onClick={() => handleOutboxEdit(entry.id)} title={t("chatInput.outboxEditTitle")}>
                    {t("chatInput.outboxEdit")}
                  </QueuedActionButton>
                </>
              )}
            </div>
          );
        })}
        {failedPreparations.map((preparation, index) => {
          const attachmentNames = [...preparation.files.map((file) => file.name), ...preparation.images.map((image) => image.name).filter(Boolean)];
          const label = preparation.text || attachmentNames.join(", ") || t("chatInput.imageReadFailed");
          return (
            <div key={preparation.id} data-testid="preparation-failed-row" role="status" style={{ border: "1px solid var(--border)", borderBottom: "none", borderRadius: outbox.length === 0 && index === 0 ? "var(--radius-card) var(--radius-card) 0 0" : 0, background: "color-mix(in srgb, var(--status-error) 6%, var(--bg-panel))", padding: "5px 8px 5px 12px", display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}> 
              <AlertTriangle size={11} strokeWidth={2.2} style={{ flexShrink: 0, color: "var(--status-error)" }} aria-hidden="true" />
              <span style={{ flexShrink: 0, fontSize: 10, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--status-error)" }}>{t("chatInput.outboxFailed")}</span>
              <span title={preparation.detail} style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12, color: "var(--text-muted)" }}>{label}</span>
              <QueuedActionButton onClick={() => handlePreparationEdit(preparation.id)} title={t("chatInput.outboxEditTitle")}>{t("chatInput.outboxEdit")}</QueuedActionButton>
            </div>
          );
        })}
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
          {pendingInputs.length > 0 && onRespondToInput && (
            <InputDock pendingInputs={pendingInputs} onRespond={onRespondToInput} composerRef={textareaRef} />
          )}
          {pendingRewoundDraft && (
            <div
              role="status"
              aria-live="polite"
              style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap", padding: "8px 10px", marginBottom: 8, borderRadius: "var(--radius-control)", background: "var(--bg-panel)", color: "var(--text-muted)", fontSize: 13 }}
            >
              <span>{t(pendingRewoundDraft.source === "queue" ? "chatInput.returnedQueuedNotice" : "refusal.rewoundDraftNotice")}</span>
              <button
                type="button"
                onClick={() => applyRewoundDraft(pendingRewoundDraft)}
                style={{ minHeight: 48, padding: "8px 12px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg)", color: "var(--text)", cursor: "pointer", font: "inherit" }}
              >
                {t(pendingRewoundDraft.source === "queue" ? "chatInput.useReturnedQueued" : "refusal.useRewoundDraft")}
              </button>
            </div>
          )}
          <div style={{ position: "relative" }}>
          <textarea
            ref={textareaRef}
            className="composer-textarea"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setHistoryMenuOpen(false);
              updateAtQuery(e.target.value, e.target.selectionStart);
              trackCaret(e.target);
            }}
            onSelect={(e) => {
              const el = e.currentTarget;
              updateAtQuery(el.value, el.selectionStart);
              trackCaret(el);
            }}
            onKeyDown={handleKeyDown}
            onBlur={wordCompletion.clear}
            onCompositionStart={() => {
              isComposingRef.current = true;
              setComposing(true);
            }}
            onCompositionEnd={(e) => {
              isComposingRef.current = false;
              setComposing(false);
              lastCompositionEndAtRef.current = Date.now();
              const el = e.currentTarget;
              updateAtQuery(el.value, el.selectionStart);
            }}
            onInput={handleInput}
            onPaste={handlePaste}
            // The full hint truncates to "…@ for" in a phone-width field, so
            // there the placeholder is only the part that still reads.
            disabled={sendPreparing}
            placeholder={turnWaiting
              ? t("chatInput.waitingForTurn")
              : isMobile ? t("chatInput.placeholderShort") : t("chatInput.placeholder")}
            rows={1}
            style={{
              display: "block",
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
          {wordCompletion.suggestion && (
            <ComposerGhostText
              textareaRef={textareaRef}
              suggestion={wordCompletion.suggestion}
              visible={wordCompletion.shown !== null}
              onFit={wordCompletion.reportFit}
            />
          )}
          </div>

          {/* Toolbar: attachment · model · settings · reasoning · fast · context ring · send/stop */}
          {/* On a phone this row used to wrap: Stop and the context ring fell
              to a second line and spilled out of the card. It is now a single
              nowrap row of 38px targets — every fixed control keeps its size,
              and the model selector is the ONLY thing that shrinks, ellipsising
              its name. Widths at 390px CSS: 332px of content box, minus attach
              38 + reasoning 38 + Fast 38 + ring 38 + Send 38 and five 4px gaps,
              leaves ~116px for the model name; an ACP mode button and an
              auto-switch marker can take that lower, and it still cannot spill.
              A wide toolbar keeps wrapping — it never needed to. */}
          <div style={{
            display: "flex",
            alignItems: "center",
            gap: isMobile ? 4 : 2,
            marginTop: 8,
            paddingTop: 8,
            borderTop: "1px solid color-mix(in srgb, var(--border) 62%, transparent)",
            flexWrap: isMobile ? "nowrap" : "wrap",
            rowGap: 4,
          }}>
            {/* Attachment */}
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={(isStreaming && !canAttachWhileStreaming) || preparingImageCount > 0}
              title={preparingImageCount > 0 ? t("chatInput.imagePreparing") : t("chatInput.attachFile")}
              aria-label={preparingImageCount > 0 ? t("chatInput.imagePreparing") : t("chatInput.attachFile")}
              style={{
                flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center",
                width: isMobile ? 38 : 28, height: isMobile ? 38 : 28, padding: 0,
                background: "none", border: "none",
                borderRadius: 7,
                color: (attachedImages.length || attachedTextFiles.length) ? "var(--accent)" : "var(--text-muted)",
                cursor: (isStreaming && !canAttachWhileStreaming) || preparingImageCount > 0 ? "not-allowed" : "pointer",
                opacity: isStreaming && !canAttachWhileStreaming ? 0.5 : 1,
                transition: "background var(--dur-fast) var(--ease-out-warm), color var(--dur-fast) var(--ease-out-warm)",
              }}
              onMouseEnter={(e) => {
                if ((isStreaming && !canAttachWhileStreaming) || preparingImageCount > 0) return;
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
              <div ref={dropdownRef} style={{ position: "relative", minWidth: 0, flex: isMobile ? "1 1 auto" : undefined, display: "flex", alignItems: "center", gap: 5 }}>
                <button
                  onClick={(e) => {
                    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    setModelDropdownRect({ top: rect.top, left: rect.left, width: rect.width });
                    setModelDropdownOpen((v) => !v);
                  }}
                  disabled={modelSelectorDisabled}
                  style={{
                    display: "flex", alignItems: "center", gap: 5,
                    height: isMobile ? 38 : 28,
                    // The one control that keeps its text on a phone, so it
                    // takes whatever width the icon-only neighbours leave
                    // rather than the fixed cap a wide toolbar can afford.
                    width: isMobile ? "100%" : undefined,
                    maxWidth: isMobile ? "100%" : 190,
                    // Without this the button's own icons (provider mark,
                    // Smart sparkle, chevron) set a min-content floor that a
                    // crowded phone row cannot honour, and the row overflows
                    // by exactly that much. It clips itself instead.
                    minWidth: 0,
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
                    if (modelSelectorDisabled) return;
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
                  {(localOnly?.active || isAutoModelSelection) && (
                    <span
                      role="img"
                      title={localOnly?.active ? t("chatInput.localOnly") : t("chatInput.smartRouting")}
                      aria-label={localOnly?.active ? t("chatInput.localOnly") : t("chatInput.smartRouting")}
                      style={{ display: "flex", flexShrink: 0, color: "var(--accent)" }}
                    >
                      {localOnly?.active ? <Target size={12} strokeWidth={2} aria-hidden="true" /> : <Sparkles size={12} strokeWidth={2} aria-hidden="true" />}
                    </span>
                  )}
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
                    {localOnly?.active
                      ? t("chatInput.localOnly")
                      : isAutoModelSelection
                        ? smartTriggerLabel
                        : currentName ?? (modelOptions.length > 0
                          ? t("chatInput.selectModel")
                          : showModelsLoading ? t("chatInput.loadingModels") : t("chatInput.noModels"))}
                  </span>
                  <ChevronDown size={12} strokeWidth={1.8} style={{ flexShrink: 0, opacity: 0.7 }} aria-hidden="true" />
                </button>
                {modelSwitchStatus && (
                  <span
                    data-testid="model-switch-pending"
                    role="status"
                    title={t("chatInput.modelSwitchHint")}
                    style={{ display: "inline-flex", alignItems: "center", gap: 4, minWidth: 0, color: "var(--text-dim)", fontSize: 11, whiteSpace: "nowrap" }}
                  >
                    <Loader2 size={11} strokeWidth={2} style={{ flexShrink: 0, animation: "spin 0.8s linear infinite" }} aria-hidden="true" />
                  </span>
                )}
                <PromptProfileIndicator
                  selection={profileRoute.data?.selection}
                  isMobile={isMobile}
                  onOpen={() => openSettings("models", { sub: "assignments", highlight: "local-model-prompt-profile" })}
                />
                {modelDropdownOpen && modelDropdownRect && (() => {
                  const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
                  const bottom = viewportHeight - modelDropdownRect.top + 6;
                  // These panels grow UPWARD from the composer, so the status
                  // bar is the edge they run into on a standalone install.
                  const maxH = `max(120px, calc(${Math.min(modelDropdownRect.top - 8, viewportHeight * 0.6)}px - var(--safe-top)))`;
                  const panelPos: React.CSSProperties = isMobile
                    ? { left: "max(8px, var(--safe-left))", right: "max(8px, var(--safe-right))" }
                    : { left: modelDropdownRect.left, width: "max-content", minWidth: modelDropdownRect.width, maxWidth: "calc(100vw - 16px)" };
                  return (
                    <div ref={modelDropdownPanelRef} className="dropdown-surface" style={{
                    position: "fixed",
                    bottom,
                    ...panelPos,
                    zIndex: 500,
                    overflow: "hidden", maxHeight: maxH, overflowY: "auto",
                    }}>
                    {/* Smart resolves the ACTIVE engine's configured model
                        ROLES (omp's config.yml, read through /api/model-roles).
                        pi has chatExtras but no models surface and no roles
                        file, so this row used to fetch omp's config on its
                        behalf and then report it as unavailable. */}
                    {capabilities.models && (
                    <button
                      className="dropdown-item"
                      key="smart-model-role"
                      onClick={() => {
                        setModelDropdownOpen(false);
                        if (!onSelectSmartModel || onSelectSmartModel() === false) void handleSmartModelForLiveSession();
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
                        <span style={{ fontSize: 11, color: "var(--text-dim)", fontWeight: 400, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t("chatInput.smartModelHint", { name: engineName })}</span>
                      </span>
                    </button>
                    )}
                    {localOnly?.supported && onSelectLocalOnly && (
                      <button
                        className="dropdown-item"
                        key="local-only"
                        type="button"
                        aria-pressed={localOnly.active}
                        disabled={localOnly.pending}
                        onClick={() => {
                          if (localOnly.pending) return;
                          void onSelectLocalOnly().then((selected) => {
                            if (selected) setModelDropdownOpen(false);
                          });
                        }}
                        style={{
                          display: "flex", alignItems: "flex-start", gap: 8,
                          width: "100%", padding: "7px 12px",
                          background: localOnly.active ? "var(--bg-selected)" : "transparent",
                          border: "none", borderBottom: "1px solid var(--border)",
                          color: localOnly.active ? "var(--text)" : "var(--text-muted)",
                          cursor: localOnly.pending ? "wait" : "pointer", fontSize: 12, textAlign: "left",
                          fontWeight: localOnly.active ? 600 : 400, opacity: localOnly.pending ? 0.6 : 1,
                        }}
                        onMouseEnter={(event) => { if (!localOnly.active && !localOnly.pending) event.currentTarget.style.background = "var(--bg-hover)"; }}
                        onMouseLeave={(event) => { if (!localOnly.active) event.currentTarget.style.background = "transparent"; }}
                      >
                        {localOnly.active
                          ? <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 3 }}><polyline points="1.5 5 4 7.5 8.5 2.5" /></svg>
                          : <span style={{ width: 10, flexShrink: 0 }} />}
                        {localOnly.pending ? <Loader2 size={13} strokeWidth={1.8} aria-hidden="true" style={{ flexShrink: 0, marginTop: 2, animation: "spin 0.8s linear infinite" }} /> : <Target size={13} strokeWidth={1.8} aria-hidden="true" style={{ flexShrink: 0, marginTop: 2, color: localOnly.active ? "var(--accent)" : "var(--text-dim)" }} />}
                        <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                          <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t("chatInput.localOnly")}</span>
                          <span style={{ fontSize: 11, color: "var(--text-dim)", fontWeight: 400, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{localOnly.pending ? t("chatInput.localOnlyChanging") : t("chatInput.localOnlyHint")}</span>
                        </span>
                      </button>
                    )}
                    {presetRows}
                    {(fastRow || prewalkRows) && (
                      <div style={{ borderBottom: "1px solid var(--border)", background: "var(--bg-panel)" }}>
                        {fastRow}
                        {prewalkRows}
                      </div>
                    )}
                    {modelsByProvider.length === 0 ? (
                      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 4, padding: "8px 12px" }}>
                        <span style={{ color: "var(--text-dim)", fontSize: 12 }}>
                          {showModelsLoading ? t("chatInput.loadingModels") : t("chatInput.noPinnedModels")}
                        </span>
                        {!showModelsLoading && (
                          <button
                            type="button"
                            onClick={() => { setModelDropdownOpen(false); openSettings("models", { sub: "catalog" }); }}
                            style={{ display: "inline-flex", alignItems: "center", gap: 5, minHeight: isMobile ? 44 : 24, padding: 0, border: "none", background: "transparent", color: "var(--accent)", fontSize: 11.5, fontWeight: 600, cursor: "pointer" }}
                          >
                            <Pin size={11} aria-hidden="true" />
                            {t("chatInput.pinModelsHint")}
                          </button>
                        )}
                      </div>
                    ) : modelsByProvider.map((group, gi) => (
                      <div key={group.id}>
                        {(modelsByProvider.length > 1) && (
                          <div style={{
                            display: "flex", alignItems: "center", gap: 6,
                            padding: "6px 12px 4px",
                            fontSize: 10, fontWeight: 600, color: "var(--text-dim)",
                            textTransform: "uppercase", letterSpacing: "0.07em",
                            borderTop: gi > 0 ? "1px solid var(--border)" : "none",
                            background: "var(--bg-panel)",
                          }}>
                            <ProviderIcon provider={group.provider} size={10} style={{ flexShrink: 0, color: "var(--text-dim)" }} />
                            {group.provider}
                          </div>
                        )}
                        {group.options.map((opt) => {
                          const isActive = opt.modelId === model?.modelId && opt.provider === model?.provider;
                          const showProvider = duplicateModelNames.has(opt.name) && modelsByProvider.length === 1;
                          // Every engine, not only omp: `usageProviderFor` inside
                          // `modelLimitReached` translates an ACP engine's bare
                          // provider ("claude", "codex") to the omp usage-provider
                          // id conservatively, and `resolveModelAvailability` is
                          // account-aware — a model with a healthy sibling account
                          // never marks. Still selectable when it does: the owner
                          // may want to queue it anyway.
                          const limitReached = modelLimitReached(usageSnapshot, engineId, opt.provider, opt.modelId);
                          const resetLabel = limitReached?.resetsAt ? formatResetTime(limitReached.resetsAt, locale, Date.now()) : null;
                          const limitText = resetLabel
                            ? tOrFallback("chatInput.modelLimitReachedReset", "Limit reached · resets {time}", { time: resetLabel })
                            : tOrFallback("chatInput.modelLimitReached", "Limit reached");
                          return (
                            <button
                              className="dropdown-item"
                              key={`${group.id}:${opt.provider}:${opt.modelId}`}
                              onClick={() => {
                                // Re-picking the current model is a no-op unless a live
                                // switch is still queued: then it is the cancel gesture.
                                if (!isActive || isAutoModelSelection || modelSwitchPending) pickModel(opt.provider, opt.modelId);
                                else setModelDropdownOpen(false);
                              }}
                              style={{
                                display: "flex", alignItems: "center", gap: 8,
                                width: "100%", padding: "7px 12px",
                                minHeight: isMobile ? 44 : undefined,
                                background: isActive ? "var(--bg-selected)" : "transparent",
                                border: "none",
                                color: isActive ? "var(--text)" : "var(--text-muted)",
                                cursor: "pointer", fontSize: 12, textAlign: "left",
                                fontWeight: isActive ? 600 : 400,
                                whiteSpace: "nowrap",
                                // Dimmed, never disabled: a spent model stays one
                                // click away for whoever wants to queue onto it
                                // anyway (see the comment above).
                                opacity: limitReached && !isActive ? 0.6 : 1,
                              }}
                              onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = "var(--bg-hover)"; }}
                              onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = "none"; }}
                            >
                              {isActive
                                ? <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><polyline points="1.5 5 4 7.5 8.5 2.5" /></svg>
                                : <span style={{ width: 10, flexShrink: 0 }} />}
                              <ModelIcon provider={opt.provider} modelId={opt.modelId} size={13} style={{ flexShrink: 0, color: isActive ? "var(--accent)" : "var(--text-dim)" }} />
                              <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{opt.name}</span>
                              {showProvider && <span style={{ fontSize: 10.5, color: "var(--text-dim)" }}>· {opt.provider}</span>}
                              {isActive && activeModelHiddenByAdmin && <span style={{ fontSize: 10.5, color: "var(--status-warning)" }}>· {t("chatInput.hiddenByAdmin")}</span>}
                              {limitReached && <span style={{ fontSize: 10.5, color: "var(--text-dim)", whiteSpace: "nowrap" }}>· {limitText}</span>}
                            </button>
                          );
                        })}
                      </div>
                    ))}
                    {newModelCount > 0 && (
                      <div style={{ display: "flex", padding: "6px 12px", borderTop: "1px solid var(--border)", background: "var(--bg-panel)" }}>
                        <button
                          type="button"
                          onClick={() => { setModelDropdownOpen(false); openSettings("models"); }}
                          style={{ display: "inline-flex", alignItems: "center", gap: 5, minHeight: isMobile ? 44 : 26, padding: "0 6px", border: "none", background: "transparent", color: "var(--accent)", fontSize: 11, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" }}
                        >
                          <Sparkles size={11} aria-hidden="true" />
                          {tn("chatInput.newModels", newModelCount, { count: newModelCount })} · {t("chatInput.reviewNewModels")}
                        </button>
                      </div>
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
                  if (autoSwitchDetail) toast.info(t("chatInput.autoSwitchChip"), autoSwitchDetail, { durationMs: 12_000, clamp: true });
                }}
                title={autoSwitchDetail ?? t("chatInput.autoSwitchTitle")}
                aria-label={autoSwitchDetail ?? t("chatInput.autoSwitchTitle")}
                style={{
                  display: "inline-flex", alignItems: "center", gap: 4,
                  // Icon-only on a phone: its text is what would push the
                  // single row wider than the screen, and the title and
                  // aria-label already say the same thing.
                  justifyContent: isMobile ? "center" : undefined,
                  height: isMobile ? 38 : 28,
                  width: isMobile ? 38 : undefined,
                  padding: isMobile ? 0 : "0 7px",
                  background: "none", border: "none", borderRadius: 7,
                  color: "var(--status-warning)", cursor: "pointer",
                  fontSize: 11, flexShrink: 0, whiteSpace: "nowrap",
                }}
              >
                <TriangleAlert size={isMobile ? 16 : 12} aria-hidden="true" style={{ flexShrink: 0 }} />
                {!isMobile && t("chatInput.autoSwitchChip")}
              </button>
            )}


            {onThinkingLevelChange && (
            <div style={{ display: "inline-flex", alignItems: "center", gap: 2, flexShrink: 0 }}>
            {/* Reasoning level selector stays available during an active run:
                an accepted change applies to the next model request. */}
            {onThinkingLevelChange && (
              <div ref={thinkingDropdownRef} style={{ position: "relative", flexShrink: isMobile ? 0 : undefined }}>
                <button
                  onClick={(e) => {
                    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    setThinkingAnchorTop(rect.top);
                    setThinkingDropdownOpen((v) => !v);
                  }}
                   disabled={thinkingLevelPending}
                   data-testid="thinking-level-toggle"
                   title={thinkingLevelPending ? t("chatInput.reasoningApplyingHint") : t("chatInput.reasoningChangeHint")}
                   aria-label={[t("chatInput.changeReasoning"), thinkingDisplayLabel].filter(Boolean).join(": ")}
                  style={{
                    display: "flex", alignItems: "center", gap: 5,
                    justifyContent: isMobile ? "center" : undefined,
                    height: isMobile ? 38 : 28,
                    width: isMobile ? 38 : undefined,
                    padding: isMobile ? 0 : "0 8px",
                    background: thinkingDropdownOpen ? "var(--bg-hover)" : "none",
                    border: "none",
                    borderRadius: 7,
                    color: "var(--text-muted)",
                     cursor: thinkingLevelPending ? "wait" : "pointer",
                     opacity: thinkingLevelPending ? 0.65 : 1,
                    fontSize: 12,
                    transition: "background var(--dur-fast) var(--ease-out-warm), color var(--dur-fast) var(--ease-out-warm)",
                  }}
                   onMouseEnter={(e) => {
                     if (thinkingLevelPending) return;
                     e.currentTarget.style.background = "var(--bg-hover)";
                     e.currentTarget.style.color = "var(--text)";
                   }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = thinkingDropdownOpen ? "var(--bg-hover)" : "none";
                    e.currentTarget.style.color = "var(--text-muted)";
                  }}
                >
                  <svg width={isMobile ? 16 : 11} height={isMobile ? 16 : 11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                    <path d="M9.5 2A5.5 5.5 0 0 0 4 7.5c0 1.7.78 3.21 2 4.21V14a1 1 0 0 0 1 1h5a1 1 0 0 0 1-1v-2.29c1.22-1 2-2.51 2-4.21A5.5 5.5 0 0 0 9.5 2z" />
                    <line x1="7" y1="18" x2="12" y2="18" />
                    <line x1="8" y1="21" x2="11" y2="21" />
                  </svg>
                   {!isMobile && <span style={{ whiteSpace: "nowrap" }}>{thinkingDisplayLabel}</span>}
                   {thinkingLevelPending && <Loader2 size={isMobile ? 13 : 11} strokeWidth={2} style={{ flexShrink: 0, animation: "spin 0.8s linear infinite" }} aria-hidden="true" />}
                   {!isMobile && <ChevronDown size={12} strokeWidth={1.8} style={{ flexShrink: 0, opacity: 0.7 }} aria-hidden="true" />}
                </button>
                {thinkingDropdownOpen && (
                  <div className="dropdown-surface" style={isMobile && thinkingAnchorTop != null ? {
                    // Same reason as the tool-preset panel above.
                    position: "fixed",
                    bottom: (window.visualViewport?.height ?? window.innerHeight) - thinkingAnchorTop + 6,
                    left: "max(8px, var(--safe-left))", right: "max(8px, var(--safe-right))",
                    zIndex: 500,
                    // Grows upward: the status-bar inset is its ceiling.
                    maxHeight: `max(120px, calc(${thinkingAnchorTop - 8}px - var(--safe-top)))`, overflowY: "auto",
                  } : {
                    position: "absolute", bottom: "calc(100% + 6px)", left: 0,
                    zIndex: 100, minWidth: 250, maxWidth: "calc(100vw - 32px)",
                  }}>
                    {thinkingLevelOptions.map((lvl) => {
                      const isActive = (thinkingLevel ?? "auto") === lvl;
                      const descKey = THINKING_LEVEL_DESC_KEYS[lvl];
                      // "auto" means "whatever the engine defaults to", so
                      // its description names the ACTIVE engine.
                      const desc = descKey ? t(descKey, { name: engineName }) : "";
                      const displayLabel = thinkingLevelLabel(lvl, t);
                      return (
                        <button
                          className="dropdown-item"
                          key={lvl}
                           disabled={thinkingLevelPending}
                           onClick={() => { setThinkingDropdownOpen(false); if (!isActive && !thinkingLevelPending) onThinkingLevelChange(lvl); }}
                          style={{
                            display: "flex", alignItems: "center", gap: 8,
                            width: "100%", padding: "7px 12px",
                            background: isActive ? "var(--bg-selected)" : "transparent",
                            border: "none",
                            color: isActive ? "var(--text)" : "var(--text-muted)",
                             cursor: thinkingLevelPending ? "wait" : "pointer", fontSize: 12, textAlign: "left",
                             fontWeight: isActive ? 600 : 400, opacity: thinkingLevelPending ? 0.65 : 1,
                            whiteSpace: "nowrap",
                          }}
                           onMouseEnter={(e) => { if (!isActive && !thinkingLevelPending) e.currentTarget.style.background = "var(--bg-hover)"; }}
                           onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = "transparent"; }}
                        >
                          {isActive
                            ? <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><polyline points="1.5 5 4 7.5 8.5 2.5" /></svg>
                            : <span style={{ width: 10, flexShrink: 0 }} />}
                          <span style={{ flexShrink: 0, whiteSpace: "nowrap" }}>{displayLabel}</span>
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
            </div>
            )}
            {/* Agent-mode selector — the engine's own session modes, offered
                only when it published a list for THIS session. Stays visible
                while the agent runs (disabled) so the mode never looks reset. */}
            {onModeChange && currentMode && (
              <div ref={modeDropdownRef} style={{ position: "relative", flexShrink: isMobile ? 0 : undefined }}>
                <button
                  onClick={(e) => {
                    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    setModeAnchorTop(rect.top);
                    setModeDropdownOpen((v) => !v);
                  }}
                  disabled={isStreaming}
                  title={t("chatInput.changeModeTitle", { mode: currentMode.name })}
                  aria-label={`${t("chatInput.changeMode")}: ${currentMode.name}`}
                  data-testid="agent-mode-button"
                  style={{
                    display: "flex", alignItems: "center", gap: 5,
                    justifyContent: isMobile ? "center" : undefined,
                    height: isMobile ? 38 : 28,
                    width: isMobile ? 38 : undefined,
                    padding: isMobile ? 0 : "0 8px",
                    background: modeDropdownOpen ? "var(--bg-hover)" : "none",
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
                    e.currentTarget.style.background = modeDropdownOpen ? "var(--bg-hover)" : "none";
                    e.currentTarget.style.color = "var(--text-muted)";
                  }}
                >
                  <SlidersHorizontal size={isMobile ? 16 : 11} strokeWidth={2} style={{ flexShrink: 0 }} aria-hidden="true" />
                  {!isMobile && <span style={{ whiteSpace: "nowrap" }}>{currentMode.name}</span>}
                  {!isMobile && <ChevronDown size={12} strokeWidth={1.8} style={{ flexShrink: 0, opacity: 0.7 }} aria-hidden="true" />}
                </button>
                {modeDropdownOpen && (
                  <div className="dropdown-surface" role="menu" data-testid="agent-mode-menu" style={isMobile && modeAnchorTop != null ? {
                    // Same reason as the tool-preset panel above.
                    position: "fixed",
                    bottom: (window.visualViewport?.height ?? window.innerHeight) - modeAnchorTop + 6,
                    left: "max(8px, var(--safe-left))", right: "max(8px, var(--safe-right))",
                    zIndex: 500,
                    // Grows upward: the status-bar inset is its ceiling.
                    maxHeight: `max(120px, calc(${modeAnchorTop - 8}px - var(--safe-top)))`, overflowY: "auto",
                  } : {
                    position: "absolute", bottom: "calc(100% + 6px)", left: 0,
                    zIndex: 100, minWidth: 250, maxWidth: "calc(100vw - 32px)",
                  }}>
                    {availableModes.map((mode) => {
                      const isActive = mode.id === currentMode.id;
                      return (
                        <button
                          className="dropdown-item"
                          role="menuitemradio"
                          aria-checked={isActive}
                          key={mode.id}
                          onClick={() => { setModeDropdownOpen(false); if (!isActive && !isStreaming) onModeChange(mode.id); }}
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
                          <span style={{ flexShrink: 0, whiteSpace: "nowrap" }}>{mode.name}</span>
                          {mode.description && (
                            <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 11, color: "var(--text-dim)", marginLeft: 8 }}>
                              {mode.description}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
            {/* Pushes the gauge and Send right on a wide toolbar; on a phone
                the model selector is the one that takes the slack instead. */}
            <div style={{ flex: isMobile ? "0 0 0px" : 1 }} />

            {/* Icon-only plan-quota gauge. The arc tracks the binding quota
                window; context usage lives in the top bar and, in detail,
                below the divider inside this popover. Hidden entirely when
                nothing has anything to say: no mapped account answers for
                the selected model's provider, no prepaid balance applies,
                and no banked reset credit exists either — there the ring
                could only ever be an empty dashed circle. An OpenRouter
                model is a reason to show it even when the engine reports no
                windows: the popover then carries the credit balance, which
                is the only spend signal that exists. omp keeps the ring from
                first paint ("Checking usage…"): it always meters its models. */}
              {(engine?.id === OMP_ENGINE_ID || hasMappedQuotaAccount || openRouterActive || Boolean(resetCredits.snapshot?.available)) && (
              <div
                ref={contextPopoverRef}
                // marginRight doubles the visual space between the gauge and
                // the Send/Stop button (owner request); the toolbar's own gap
                // supplies the other half. The 26px arc keeps its size on a
                // phone; only the box around it grows to the row's 38px target,
                // so the gauge is as tappable as the buttons beside it.
                style={{ position: "relative", width: isMobile ? 38 : 28, height: isMobile ? 38 : 28, flexShrink: 0, marginRight: 4 }}
              >
                <button
                  type="button"
                  title={quotaRingTitle}
                  aria-label={quotaRingLabel}
                  aria-expanded={contextPopoverOpen}
                  aria-haspopup="dialog"
                  onClick={(e) => {
                    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    setContextPopoverAnchor({ top: rect.top, right: rect.right });
                    setContextPopoverOpen((open) => !open);
                  }}
                  style={{
                    position: "relative",
                    width: isMobile ? 38 : 28,
                    height: isMobile ? 38 : 28,
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
                    resetCredits={resetCredits}
                    openRouter={openRouterActive ? openRouterAccount : undefined}
                    quota={quota}
                    activeModels={activeModels}
                    provider={quotaProvider ?? null}
                    modelName={displayModelName}
                    now={usageNow}
                    failed={usageFailed}
                    refreshing={usageLoading}
                    onRefresh={refreshQuotaNow}
                    anchorTop={contextPopoverAnchor?.top ?? null}
                    anchorRight={contextPopoverAnchor?.right ?? null}
                  />
                )}
              </div>
              )}

            {/* Primary action: Send (idle) / Stop (running) */}
            {isStreaming ? (
              <button
                type="button"
                onClick={isCompacting ? onAbortCompaction : onAbort}
                title={t("chatInput.stopAgent")}
                // Square glyph only on a phone, where the word would cost the
                // model selector most of its remaining width.
                aria-label={isMobile ? t("chatInput.stop") : undefined}
                style={{
                  display: "flex", alignItems: "center", justifyContent: isMobile ? "center" : undefined, gap: 6,
                  height: isMobile ? 38 : 28,
                  width: isMobile ? 38 : undefined,
                  flexShrink: isMobile ? 0 : undefined,
                  padding: isMobile ? 0 : "0 14px",
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
                <svg width={isMobile ? 13 : 9} height={isMobile ? 13 : 9} viewBox="0 0 10 10" fill="none" aria-hidden="true">
                  <rect x="1.5" y="1.5" width="7" height="7" rx="1.5" fill="currentColor" />
                </svg>
                {!isMobile && t("chatInput.stop")}
              </button>
            ) : (
              <button
                type="button"
                onClick={handleSend}
                // Sending while an attachment is still being prepared would
                // send the message without it.
                disabled={sendPreparing || preparingImageCount > 0 || (!value.trim() && !attachedImages.length && !attachedTextFiles.length)}
                // Arrow only on a phone; the word survives in the accessible
                // name, and the arrow grows to stay legible in a 38px target.
                aria-label={isMobile ? t("chatInput.send") : undefined}
                style={{
                  display: "flex", alignItems: "center", justifyContent: isMobile ? "center" : undefined, gap: 6,
                  height: isMobile ? 38 : 28,
                  width: isMobile ? 38 : undefined,
                  flexShrink: isMobile ? 0 : undefined,
                  padding: isMobile ? 0 : "0 14px",
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
                <svg width={isMobile ? 17 : 12} height={isMobile ? 17 : 12} viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="2" y1="7" x2="11" y2="7" />
                  <polyline points="7.5 3 12 7 7.5 11" />
                </svg>
                {!isMobile && t("chatInput.send")}
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
