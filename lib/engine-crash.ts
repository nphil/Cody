/**
 * Why a chat's engine stopped when nobody asked it to.
 *
 * The wrapper learns that the child died (code, signal, the tail of its
 * stderr); this module turns that into ONE plain reason a person can act on,
 * and into the words that go in the pop-up, the line in the chat and the push
 * notification. Pure and browser-safe on purpose: the page renders the same
 * notice in its own language, so it imports this file and nothing here may
 * touch `fs`, `os` or any Cody server module (the disk-error patterns below
 * mirror `describeDiskError` in lib/disk-space.ts for that reason, and
 * lib/engine-crash.test.mjs runs both on the same inputs).
 *
 * The reasons, in the order they are decided:
 *  1. out_of_memory — the kernel killed it (SIGKILL while the container's
 *     `oom_kill` counter moved), or its own last words say memory ran out.
 *  2. disk_full — the last stderr line is an ENOSPC / EDQUOT error.
 *  3. too_many_processes — the thread pool or a fork was refused (the pids
 *     limit): a `ThreadPoolBuildError … WouldBlock` line, or the container's
 *     `pids.events max` counter moved while it died.
 *  4. crashed — anything else, with its last error line, sanitized.
 * `server_restarted` is never classified from an exit: boot resume says it.
 * Nor is `token_burn`, where nothing died: the burn guard
 * (lib/run-recovery/burn-guard.ts) stopped a run, or one helper of it
 * (`recovery: "automatic"`, the rest of the chat carries on), for spending
 * tokens far faster than work does.
 */

import { isRecord } from "./type-guards";

export type EngineCrashReason = "out_of_memory" | "disk_full" | "too_many_processes" | "crashed" | "server_restarted" | "token_burn";

/** What Cody does next: restart the chat by itself, stopped trying, or waits for the person. */
export type EngineCrashRecovery = "automatic" | "gave_up" | "manual";

export type EngineCrashDisk = "tmp" | "data";

export const ENGINE_CRASH_REASONS: readonly EngineCrashReason[] = ["out_of_memory", "disk_full", "too_many_processes", "crashed", "server_restarted", "token_burn"];
export const ENGINE_CRASH_RECOVERIES: readonly EngineCrashRecovery[] = ["automatic", "gave_up", "manual"];

/** `customType` of the persistent line a crash leaves in a chat's transcript. */
export const ENGINE_CRASH_CUSTOM_TYPE = "cody-engine-crash";

/** The longest last-error line kept. */
export const ENGINE_CRASH_DETAIL_MAX = 160;

// ---------------------------------------------------------------------------
// The container's own record (cgroup counters)
// ---------------------------------------------------------------------------

/** Counters read from the container's cgroup, or null when the file is not there. */
export interface CgroupCounters {
  /** `memory.events` → `oom_kill`: processes the kernel killed for want of memory. */
  oomKill: number | null;
  /** `pids.events` → `max`: forks and threads refused by the pids limit. */
  pidsMax: number | null;
}

/** How far each counter moved between the engine's start and its exit; 0 when either end is unknown. */
export interface CgroupDeltas {
  oomKill: number;
  pidsMax: number;
}

/** `memory.events` / `pids.events` are `key value` lines. Anything else is ignored. */
export function parseCgroupEvents(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of text.split("\n")) {
    const match = /^\s*([A-Za-z_][\w.]*)\s+(\d+)\s*$/.exec(line);
    if (match) out[match[1]] = Number(match[2]);
  }
  return out;
}

export function cgroupDeltas(before: CgroupCounters | null | undefined, after: CgroupCounters | null | undefined): CgroupDeltas {
  const delta = (a: number | null | undefined, b: number | null | undefined): number => (
    typeof a === "number" && typeof b === "number" && b > a ? b - a : 0
  );
  return { oomKill: delta(before?.oomKill, after?.oomKill), pidsMax: delta(before?.pidsMax, after?.pidsMax) };
}

// ---------------------------------------------------------------------------
// Classifying an exit
// ---------------------------------------------------------------------------

export interface EngineExitInput {
  code: number | null;
  signal: string | null;
  stderrTail: string;
  cgroup?: Partial<CgroupDeltas>;
  /** The disks Cody knows about, so a full one can be named. */
  diskAreas?: ReadonlyArray<{ id: EngineCrashDisk; path: string; freeFraction: number }>;
}

/** What went wrong, serializable: the notice, the stored record and the SSE frame all carry exactly this. */
export interface EngineCrashInfo {
  reason: EngineCrashReason;
  /** The engine's last error line, sanitized; null when it left none or the reason says it all. */
  detail: string | null;
  /** Which disk, for `disk_full`; null when it could not be told. */
  disk: EngineCrashDisk | null;
  /** The disk is under a quota rather than full. */
  quota: boolean;
  code: number | null;
  signal: string | null;
}

/** Mirrors describeDiskError (lib/disk-space.ts), which this module cannot import. */
function diskErrorKind(text: string): "quota" | "full" | null {
  if (!text) return null;
  if (/\bEDQUOT\b|quota exceeded/i.test(text)) return "quota";
  if (/(?:errno|error)\s*-(?:122|69)\b|system error -(?:122|69)\b/i.test(text)) return "quota";
  if (/\bENOSPC\b|no space left on device/i.test(text)) return "full";
  return null;
}

const OOM_TEXT = /\bENOMEM\b|Cannot allocate memory|out of memory|bad_alloc|memory allocation of \d+ bytes failed|JavaScript heap out of memory/i;
const THREAD_TEXT = /ThreadPoolBuildError|pthread_create|(?:thread|fork|spawn)[^\n]*(?:\bEAGAIN\b|WouldBlock|temporarily unavailable)|(?:\bEAGAIN\b|WouldBlock|temporarily unavailable)[^\n]*(?:thread|fork|spawn)/i;

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;
/** Lines that say nothing on their own: stack frames, carets, lone braces, the runtime's version footer. */
const NOISE_LINE = /^\s*(?:at\s|[\^~]+\s*$|[{}()[\],;]+\s*$|(?:Node\.js|Bun)\s+v?\d)/i;

function stderrLines(tail: string): string[] {
  return tail.replace(ANSI, "").split(/\r?\n/).map((line) => line.replace(CONTROL, " ").trim()).filter((line) => line !== "");
}

/** Strip anything that looks like a credential, squeeze to one line and cap it. */
export function sanitizeCrashLine(line: string): string {
  let text = line.replace(ANSI, "").replace(CONTROL, " ").replace(/\s+/g, " ").trim();
  text = text
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 …")
    .replace(/\b(api[_-]?key|token|secret|password|passwd|authorization)(["']?\s*[=:]\s*)\S+/gi, "$1$2…")
    .replace(/\b(?:sk|pk|rk|ghp|gho|ghs|github_pat|xox[a-z]|AKIA)[-_A-Za-z0-9]{12,}/g, "…")
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, "…")
    .replace(/[A-Za-z0-9+/_-]{40,}={0,2}/g, "…");
  if (text.length > ENGINE_CRASH_DETAIL_MAX) text = `${text.slice(0, ENGINE_CRASH_DETAIL_MAX - 1).trimEnd()}…`;
  return text;
}

/** The engine's last error line: the last one that is not a stack frame or a footer. */
export function lastErrorLine(stderrTail: string): string | null {
  const lines = stderrLines(stderrTail);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!NOISE_LINE.test(lines[index])) return sanitizeCrashLine(lines[index]) || null;
  }
  return lines.length > 0 ? sanitizeCrashLine(lines[lines.length - 1]) || null : null;
}

function nameDisk(lines: string[], areas: EngineExitInput["diskAreas"]): EngineCrashDisk | null {
  if (!areas || areas.length === 0) return null;
  let best: { id: EngineCrashDisk; length: number } | null = null;
  for (const line of lines) {
    for (const match of line.matchAll(/\/[^\s'"`),:;]+/g)) {
      for (const area of areas) {
        const root = area.path.replace(/\/+$/, "");
        if (!root) continue;
        if ((match[0] === root || match[0].startsWith(`${root}/`)) && (!best || root.length > best.length)) best = { id: area.id, length: root.length };
      }
    }
  }
  if (best) return best.id;
  // No path to go by: the fullest disk is the likeliest culprit.
  return [...areas].sort((a, b) => a.freeFraction - b.freeFraction)[0]?.id ?? null;
}

export function classifyEngineExit(input: EngineExitInput): EngineCrashInfo {
  const { code, signal } = input;
  const lines = stderrLines(input.stderrTail);
  const recent = lines.slice(-5);
  const killed = signal === "SIGKILL" || code === 137;
  const oomKills = input.cgroup?.oomKill ?? 0;
  const pidRefusals = input.cgroup?.pidsMax ?? 0;
  const base = { detail: null, disk: null, quota: false, code, signal };

  // The kernel's own record beats anything the engine managed to say before it died.
  if (killed && oomKills > 0) return { ...base, reason: "out_of_memory" };

  const diskKind = recent.slice(-4).map(diskErrorKind).find((kind) => kind !== null) ?? null;
  if (diskKind) return { ...base, reason: "disk_full", disk: nameDisk(recent, input.diskAreas), quota: diskKind === "quota" };

  if (recent.some((line) => THREAD_TEXT.test(line))) return { ...base, reason: "too_many_processes" };
  // A refused fork while it died, and nothing else it said points elsewhere.
  if (pidRefusals > 0 && (lines.length === 0 || signal !== null)) return { ...base, reason: "too_many_processes" };

  if (recent.some((line) => OOM_TEXT.test(line))) return { ...base, reason: "out_of_memory" };

  return { ...base, reason: "crashed", detail: lastErrorLine(input.stderrTail) };
}

// ---------------------------------------------------------------------------
// The words
// ---------------------------------------------------------------------------

/** English for every key the pop-up, the line in the chat and the push use. lib/i18n/locales/en.json carries the same strings (engine-crash.test.mjs keeps them equal). */
export const ENGINE_CRASH_TEXT = {
  "engineCrash.out_of_memory": "The server ran out of memory and stopped this chat's engine.",
  "engineCrash.disk_full.tmp": "The server's temporary disk space is full, so this chat's engine stopped.",
  "engineCrash.disk_full.data": "The server's data disk space is full, so this chat's engine stopped.",
  "engineCrash.disk_full.any": "The server's disk is full, so this chat's engine stopped.",
  "engineCrash.disk_full.quota": "The server's disk quota is used up, so this chat's engine stopped.",
  "engineCrash.too_many_processes": "The server hit its limit on running programs, so this chat's engine stopped.",
  "engineCrash.crashed": "The engine crashed on its own.",
  "engineCrash.crashedCode": "The engine crashed on its own (exit code {code}).",
  "engineCrash.crashedSignal": "The engine crashed on its own (stopped by {signal}).",
  "engineCrash.server_restarted": "Cody's server restarted, which stopped this chat's engine.",
  "engineCrash.token_burn.chat": "Cody stopped this chat's run because it was using tokens far faster than normal.",
  "engineCrash.token_burn.helper": "Cody stopped a helper in this chat because it was using tokens far faster than normal.",
  "engineCrash.token_burn.unstopped": "A helper in this chat is using tokens far faster than normal, and Cody could not stop it.",
  "engineCrash.token_burn.detail": "What Cody saw: {detail}.",
  "engineCrash.detail": "Last error: {detail}",
  "engineCrash.next.automatic": "Cody is restarting this chat automatically.",
  "engineCrash.next.automaticDisk": "Cody will restart this chat automatically once there is room on the disk.",
  "engineCrash.next.serverRestarted": "Cody is picking this chat back up.",
  "engineCrash.next.gaveUp": "Cody already restarted this chat several times, so it stopped trying. Send a message to continue.",
  "engineCrash.next.manual": "Send a message to continue.",
  "engineCrash.next.tokenBurnHelper": "The rest of the chat carries on without it.",
  "engineCrash.next.tokenBurnUnstopped": "Open the chat and press Stop.",
} as const;

export type EngineCrashTextKey = keyof typeof ENGINE_CRASH_TEXT;

export type EngineCrashTranslator = (key: EngineCrashTextKey, params?: Record<string, string | number>) => string;

/** The English the server writes (push notifications, logs). */
export const englishCrashText: EngineCrashTranslator = (key, params) => (
  ENGINE_CRASH_TEXT[key].replace(/\{(\w+)\}/g, (whole, name: string) => String(params?.[name] ?? whole))
);

/** What happened and what happens next, as one notice: what the pop-up, the chat line and the push are made of. */
export interface EngineCrashNotice extends EngineCrashInfo {
  recovery: EngineCrashRecovery;
  /** Epoch milliseconds. */
  at: number;
}

export interface EngineCrashWords {
  headline: string;
  /** "Last error: …", when the engine left one; for `token_burn`, what the guard saw. */
  detail: string | null;
  next: string;
}

export function describeEngineCrash(notice: EngineCrashInfo & { recovery: EngineCrashRecovery }, tr: EngineCrashTranslator = englishCrashText): EngineCrashWords {
  let headline: string;
  switch (notice.reason) {
    case "disk_full":
      headline = tr(notice.quota ? "engineCrash.disk_full.quota" : notice.disk === "tmp" ? "engineCrash.disk_full.tmp" : notice.disk === "data" ? "engineCrash.disk_full.data" : "engineCrash.disk_full.any");
      break;
    case "crashed":
      if (notice.detail !== null) headline = tr("engineCrash.crashed");
      else if (notice.signal) headline = tr("engineCrash.crashedSignal", { signal: notice.signal });
      else if (notice.code !== null) headline = tr("engineCrash.crashedCode", { code: notice.code });
      else headline = tr("engineCrash.crashed");
      break;
    case "out_of_memory":
      headline = tr("engineCrash.out_of_memory");
      break;
    case "too_many_processes":
      headline = tr("engineCrash.too_many_processes");
      break;
    case "server_restarted":
      headline = tr("engineCrash.server_restarted");
      break;
    case "token_burn":
      headline = tr(notice.recovery === "automatic" ? "engineCrash.token_burn.helper" : notice.recovery === "gave_up" ? "engineCrash.token_burn.unstopped" : "engineCrash.token_burn.chat");
      break;
  }
  let next: string;
  if (notice.reason === "token_burn") {
    // Nothing is restarted: a helper is gone and the chat goes on, or the run is stopped until the person says otherwise.
    next = tr(notice.recovery === "automatic" ? "engineCrash.next.tokenBurnHelper" : notice.recovery === "gave_up" ? "engineCrash.next.tokenBurnUnstopped" : "engineCrash.next.manual");
  } else if (notice.recovery === "automatic") {
    next = tr(notice.reason === "server_restarted" ? "engineCrash.next.serverRestarted" : notice.reason === "disk_full" ? "engineCrash.next.automaticDisk" : "engineCrash.next.automatic");
  } else {
    next = notice.recovery === "gave_up" ? tr("engineCrash.next.gaveUp") : tr("engineCrash.next.manual");
  }
  const detail = notice.detail === null ? null : tr(notice.reason === "token_burn" ? "engineCrash.token_burn.detail" : "engineCrash.detail", { detail: notice.detail });
  return { headline, detail, next };
}

/** The whole notice as one line of English: the notice's `message`, the push body and the log line. */
export function engineCrashSentence(notice: EngineCrashInfo & { recovery: EngineCrashRecovery }): string {
  const { headline, detail, next } = describeEngineCrash(notice);
  return [headline, detail, next].filter((part): part is string => part !== null).join(" ");
}

/** The persistent line a crash leaves in the transcript: a custom message the viewer renders from `details`, with the English as its fallback text. */
export function engineCrashRow(notice: EngineCrashNotice): { role: "custom"; customType: typeof ENGINE_CRASH_CUSTOM_TYPE; content: string; display: true; timestamp: number; details: EngineCrashNotice } {
  return { role: "custom", customType: ENGINE_CRASH_CUSTOM_TYPE, content: engineCrashSentence(notice), display: true, timestamp: notice.at, details: notice };
}

// ---------------------------------------------------------------------------
// Reading one back (a stored record, an SSE frame, a message's details)
// ---------------------------------------------------------------------------

/** A notice from untrusted JSON, or null when it is not one. Field by field, so a hand-edited file can never put anything else in a row. */
export function readEngineCrashNotice(value: unknown): EngineCrashNotice | null {
  if (!isRecord(value)) return null;
  const raw = value;
  const reason = ENGINE_CRASH_REASONS.find((candidate) => candidate === raw.reason);
  const recovery = ENGINE_CRASH_RECOVERIES.find((candidate) => candidate === raw.recovery);
  if (!reason || !recovery || typeof raw.at !== "number" || !Number.isFinite(raw.at)) return null;
  const disk = raw.disk === "tmp" || raw.disk === "data" ? raw.disk : null;
  const detail = typeof raw.detail === "string" && raw.detail.trim() !== "" ? sanitizeCrashLine(raw.detail) : null;
  return {
    reason,
    recovery,
    at: raw.at,
    detail,
    disk,
    quota: raw.quota === true,
    code: typeof raw.code === "number" && Number.isFinite(raw.code) ? raw.code : null,
    signal: typeof raw.signal === "string" && /^SIG[A-Z0-9]{1,12}$/.test(raw.signal) ? raw.signal : null,
  };
}

/** Entry id the client gives a crash row (the transcript's parallel `entryIds`), so it never collides with omp's own ids. */
export function engineCrashEntryId(notice: EngineCrashNotice): string {
  return `cody-crash-${notice.at}`;
}

/**
 * Lay the crash lines among a transcript's messages by time: each goes before
 * the first message stamped later than it, or at the end. A message with no
 * stamp (a compaction summary) is never a landmark. `entryIds` stays parallel
 * to `messages`. Returns the inputs untouched when there is nothing to add.
 */
export function withEngineCrashRows<M extends { timestamp?: unknown }>(
  messages: M[],
  entryIds: string[],
  notices: readonly EngineCrashNotice[],
  toMessage: (notice: EngineCrashNotice) => M,
): { messages: M[]; entryIds: string[] } {
  if (notices.length === 0) return { messages, entryIds };
  const outMessages = [...messages];
  const outIds = [...entryIds];
  const alreadyThere = new Set(outIds);
  for (const notice of [...notices].sort((a, b) => a.at - b.at)) {
    const id = engineCrashEntryId(notice);
    if (alreadyThere.has(id)) continue;
    const index = outMessages.findIndex((message) => typeof message.timestamp === "number" && message.timestamp > notice.at);
    const at = index === -1 ? outMessages.length : index;
    outMessages.splice(at, 0, toMessage(notice));
    // The id list can be shorter than the messages (an engine without entry ids): keep it parallel where it was.
    if (outIds.length >= at) outIds.splice(at, 0, id);
    alreadyThere.add(id);
  }
  return { messages: outMessages, entryIds: outIds };
}
