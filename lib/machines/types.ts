/**
 * The machines Cody shows CPU and memory meters for: the server Cody itself
 * runs on, plus any machine reachable over ssh.
 *
 * This file is imported by the top bar, the Settings card AND the server, so it
 * holds no Node import and no `@/` alias: `bin/cody-server.js` loads
 * `lib/machines/` through a bare jiti (`lib/server-import-graph.test.mjs`).
 */

export const LOCAL_MACHINE_ID = "local";
export const DEFAULT_LOCAL_MACHINE_NAME = "This server";

/** This server plus every ssh machine. Each ssh machine is one long-lived
 * connection while someone is looking, so the list is bounded. */
export const MAX_MACHINES = 12;
export const MAX_SSH_MACHINES = MAX_MACHINES - 1;
export const MAX_NAME_LENGTH = 24;
export const MAX_DESTINATION_LENGTH = 96;

/** How often a machine is read while a browser is watching. */
export const SAMPLE_INTERVAL_MS = 2_000;

export type MachineKind = "local" | "ssh";

/** A saved machine, as Settings edits it. `destination` is an ssh alias from
 * `~/.ssh/config` (`proxmox`) or `user@host`; the local entry has none.
 * `worker` and `workerFacts` belong to ssh machines only (see `WorkerFacts`). */
export interface MachineConfig {
  id: string;
  kind: MachineKind;
  name: string;
  destination?: string;
  /** Settings' "Use as worker" switch: Cody may send heavy jobs here. */
  worker?: boolean;
  /** What the last good check read from the machine's `/etc/cody-worker.json`;
   * null (or absent) until one succeeded. */
  workerFacts?: WorkerFacts | null;
}

/**
 * - `online`: readings are arriving.
 * - `connecting`: no answer yet (first attempt, or a quick retry after a drop).
 * - `offline`: Cody could not reach it; `reason` says why.
 * - `unavailable`: reachable, but its CPU and memory cannot be read (not Linux).
 *
 * A list as well as a type: every entry has plain copy under
 * `machines.status.<status>` in each locale, and a test holds the files to it.
 */
export const MACHINE_STATUSES = ["online", "connecting", "offline", "unavailable"] as const;
export type MachineStatus = (typeof MACHINE_STATUSES)[number];

/** Why a machine is not `online`. A code, never prose: the browser turns it
 * into plain copy in the reader's language (`machines.reason.<reason>`). */
export const MACHINE_REASONS = [
  "starting",
  "no_ssh",
  "auth",
  "host_key",
  "unknown_host",
  "refused",
  "unreachable",
  "dropped",
  "failed",
  "not_linux",
  "read_failed",
] as const;
export type MachineReason = (typeof MACHINE_REASONS)[number];

export interface MachineMetrics {
  /** 0–100 over the last interval; null until a second reading exists. */
  cpuPercent: number | null;
  /** Logical CPUs, null when the machine did not say. */
  cores: number | null;
  /** One-minute load average. */
  load1: number | null;
  memTotalBytes: number;
  memUsedBytes: number;
  /** 0–100 of memory in use, caches not counted (`MemAvailable`). */
  memPercent: number;
  /** Epoch ms of the reading. */
  at: number;
}

// ── Workers ──────────────────────────────────────────────────────────────────
// An ssh machine can be switched on as a WORKER: a machine Cody sends heavy
// jobs to (the agent tool `run_on_worker`, lib/workers/). A worker describes
// itself in `/etc/cody-worker.json`; Cody reads that file over ssh and keeps
// the last good reading as the machine's `workerFacts`.

export const WORKER_ARCHES = ["x86_64", "aarch64"] as const;
export type WorkerArch = (typeof WORKER_ARCHES)[number];

/** What a worker says about itself in `/etc/cody-worker.json`. */
export interface WorkerFacts {
  /** The worker's own name for itself (not the label the person gave it in Settings). */
  name: string;
  arch: WorkerArch;
  cpus: number;
  memMB: number;
  /** How many jobs may run on it at once. */
  slots: number;
  /** Toolchains it has, lower case: `node`, `bun`, `rust`, `go`, `python3`, `docker`, … */
  tools: string[];
  /** `limits.onlyWhenIdle`: the machine has other work of its own, so a job starts only while it is quiet. */
  onlyWhenIdle: boolean;
}

/** Why a worker check found a problem besides a failed connection (those are
 * {@link MachineReason}s). A code, never prose: plain copy lives under
 * `machines.worker.problem.<code>` in each locale. */
export const WORKER_PROBLEMS = ["not_a_worker", "bad_facts", "no_work_root"] as const;
export type WorkerProblem = (typeof WORKER_PROBLEMS)[number];

/** One check of a worker: `POST /api/machines/worker-check` answers with this
 * (HTTP 200 either way). `detail` is ssh's or the file's own first line of
 * complaint, for the person who can read it. */
export type WorkerCheckResult =
  | { ok: true; facts: WorkerFacts; ms: number; at: number }
  | { ok: false; reason: MachineReason | WorkerProblem; detail: string; at: number };

/** The newest check of a worker, as `GET /api/machines` reports it. */
export type WorkerCheckSummary =
  | { ok: true; at: number }
  | { ok: false; reason: MachineReason | WorkerProblem; at: number };

/** What the live stream says about a worker. `jobs` is how many of Cody's jobs
 * are running on it now; `ready` is false while its last check found a
 * problem (or none has run yet). */
export interface MachineWorkerState {
  jobs: number;
  ready: boolean;
}

/** What the live stream carries for one machine. No address and no raw ssh
 * output: a signed-in member sees how a machine is doing, not how to reach it. */
export interface MachineState {
  id: string;
  name: string;
  kind: MachineKind;
  status: MachineStatus;
  reason: MachineReason | null;
  metrics: MachineMetrics | null;
  /** Present only for a machine used as a worker. */
  worker?: MachineWorkerState;
}

/** The frames of `GET /api/machines/stream`. */
export type MachineStreamFrame =
  | { type: "machines"; machines: MachineState[]; at: number }
  | { type: "heartbeat"; at: number };

// ── Validation ───────────────────────────────────────────────────────────────

export type MachineFieldCode =
  | "machine_name_required"
  | "machine_name_too_long"
  | "machine_name_invalid"
  | "machine_destination_required"
  | "machine_destination_too_long"
  | "machine_destination_invalid";

export type Checked<T> = { ok: true; value: T } | { ok: false; code: MachineFieldCode };

/** A display name: one line of printable text, at most `MAX_NAME_LENGTH`
 * characters. Any run of whitespace (line breaks and tabs included) collapses
 * to one space, so "Home  box" and "Home box" are one name and a name can never
 * span lines. React escapes it on the way out; it is never put in a shell. */
export function checkMachineName(raw: unknown): Checked<string> {
  if (typeof raw !== "string") return { ok: false, code: "machine_name_required" };
  const value = raw.trim().replace(/\s+/g, " ");
  if (!value) return { ok: false, code: "machine_name_required" };
  if (/\p{C}/u.test(value)) return { ok: false, code: "machine_name_invalid" };
  if ([...value].length > MAX_NAME_LENGTH) return { ok: false, code: "machine_name_too_long" };
  return { ok: true, value };
}

/**
 * The only shapes an ssh destination may take: an alias (`proxmox`) or
 * `user@host`, host being a DNS name, an IPv4 address or a bare IPv6 address.
 *
 * Deliberately a whitelist, not a blacklist. The value ends up as an argument
 * to `ssh`, and an `ssh_config` `ProxyCommand` such as `tailscale nc %h %p`
 * puts the host into a shell command line, so nothing outside letters,
 * digits and `. _ - : @` may pass. The first character of the user and of the
 * host is a letter, digit or underscore, so a destination can never begin
 * with `-` and be read as an ssh option.
 */
const DESTINATION_PATTERN = /^(?:[A-Za-z0-9_][A-Za-z0-9._-]{0,31}@)?[A-Za-z0-9_][A-Za-z0-9._:-]{0,62}$/;

export function checkMachineDestination(raw: unknown): Checked<string> {
  if (typeof raw !== "string") return { ok: false, code: "machine_destination_required" };
  const value = raw.trim();
  if (!value) return { ok: false, code: "machine_destination_required" };
  if (value.length > MAX_DESTINATION_LENGTH) return { ok: false, code: "machine_destination_too_long" };
  if (!DESTINATION_PATTERN.test(value)) return { ok: false, code: "machine_destination_invalid" };
  return { ok: true, value };
}

const WORKER_ARCH_ALIASES: Readonly<Record<string, WorkerArch>> = {
  x86_64: "x86_64",
  amd64: "x86_64",
  x64: "x86_64",
  aarch64: "aarch64",
  arm64: "aarch64",
};

/** An architecture name as the person or the agent writes it (`amd64`, `X64`, `arm64`), or null when it is none of them. */
export function normalizeWorkerArch(raw: unknown): WorkerArch | null {
  return typeof raw === "string" ? (WORKER_ARCH_ALIASES[raw.trim().toLowerCase()] ?? null) : null;
}

/** A toolchain name in a worker's facts or in an agent's request: lower case, a short plain word. */
export const WORKER_TOOL_PATTERN = /^[a-z0-9][a-z0-9._+-]{0,31}$/;
export const MAX_WORKER_SLOTS = 64;
const MAX_WORKER_TOOLS = 64;

function wholeNumber(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : null;
}

/** Facts that passed, or the name of the first field that did not. */
export type WorkerFactsCheck = { ok: true; facts: WorkerFacts } | { ok: false; field: string };

/**
 * Facts a worker states about itself, checked and tidied: the one gate both
 * `/etc/cody-worker.json` (the file shape, `limits.onlyWhenIdle`) and what this
 * server saved earlier (`onlyWhenIdle`) go through, so a hand-edited file or
 * saved document can never put an odd value in front of the scheduler. A
 * failure names the first field that is missing or wrong. `slots` defaults to
 * one job at a time, `tools` to none and `onlyWhenIdle` to false; `amd64` and
 * `arm64` are read as the kernel's own `x86_64` and `aarch64`.
 */
export function checkWorkerFacts(raw: unknown): WorkerFactsCheck {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, field: "the file" };
  const record = raw as Record<string, unknown>;
  const name = checkMachineName(record.name);
  if (!name.ok) return { ok: false, field: "name" };
  const arch = typeof record.arch === "string" ? WORKER_ARCH_ALIASES[record.arch.trim().toLowerCase()] : undefined;
  if (!arch) return { ok: false, field: "arch" };
  const cpus = wholeNumber(record.cpus, 1, 4096);
  if (cpus === null) return { ok: false, field: "cpus" };
  const memMB = wholeNumber(record.memMB, 1, 16_777_216);
  if (memMB === null) return { ok: false, field: "memMB" };
  const slots = record.slots === undefined ? 1 : wholeNumber(record.slots, 1, MAX_WORKER_SLOTS);
  if (slots === null) return { ok: false, field: "slots" };

  const tools: string[] = [];
  if (record.tools !== undefined) {
    if (!Array.isArray(record.tools) || record.tools.length > MAX_WORKER_TOOLS) return { ok: false, field: "tools" };
    for (const entry of record.tools) {
      const tool = typeof entry === "string" ? entry.trim().toLowerCase() : "";
      if (!WORKER_TOOL_PATTERN.test(tool)) return { ok: false, field: "tools" };
      if (!tools.includes(tool)) tools.push(tool);
    }
  }

  const limits = record.limits;
  const idle = typeof limits === "object" && limits !== null && !Array.isArray(limits)
    ? (limits as Record<string, unknown>).onlyWhenIdle
    : record.onlyWhenIdle;
  if (idle !== undefined && typeof idle !== "boolean") return { ok: false, field: "limits.onlyWhenIdle" };
  return { ok: true, facts: { name: name.value, arch, cpus, memMB, slots, tools, onlyWhenIdle: idle === true } };
}

// ── HTTP payloads ────────────────────────────────────────────────────────────

/** `GET /api/machines`, and what `PUT` answers with. `destination` is present
 * only when the caller may edit (an admin, or anyone on an open instance). */
export interface MachinesPayload {
  machines: MachineConfig[];
  canEdit: boolean;
  /** False when this server has no `ssh` program, so no ssh machine can work. */
  sshAvailable: boolean;
  /** The newest worker check per machine id, for machines used as workers. */
  workerChecks?: Record<string, WorkerCheckSummary>;
}

/** `PUT /api/machines`. A field left out is left alone. `machines` is the whole
 * ssh list as it should be afterwards: an entry whose `id` is a saved machine
 * keeps that machine (and its place in the stream), one without is added, and a
 * saved machine missing from the list is removed. An entry's `worker` left out
 * keeps the machine's current setting. */
export interface MachinesUpdate {
  localName?: string;
  machines?: Array<{ id?: string; name: string; destination: string; worker?: boolean }>;
}

/** `POST /api/machines/test` `{destination}`: one real sample, answered with
 * HTTP 200 either way. `detail` is ssh's own first line of complaint. */
export type MachineTestResult =
  | {
    ok: true;
    ms: number;
    cpuPercent: number | null;
    cores: number | null;
    load1: number | null;
    memPercent: number;
    memTotalBytes: number;
    memUsedBytes: number;
  }
  | { ok: false; reason: MachineReason; detail: string };
