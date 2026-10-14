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
 * `~/.ssh/config` (`proxmox`) or `user@host`; the local entry has none. */
export interface MachineConfig {
  id: string;
  kind: MachineKind;
  name: string;
  destination?: string;
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

/** What the live stream carries for one machine. No address and no raw ssh
 * output: a signed-in member sees how a machine is doing, not how to reach it. */
export interface MachineState {
  id: string;
  name: string;
  kind: MachineKind;
  status: MachineStatus;
  reason: MachineReason | null;
  metrics: MachineMetrics | null;
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

// ── HTTP payloads ────────────────────────────────────────────────────────────

/** `GET /api/machines`, and what `PUT` answers with. `destination` is present
 * only when the caller may edit (an admin, or anyone on an open instance). */
export interface MachinesPayload {
  machines: MachineConfig[];
  canEdit: boolean;
  /** False when this server has no `ssh` program, so no ssh machine can work. */
  sshAvailable: boolean;
}

/** `PUT /api/machines`. A field left out is left alone. `machines` is the whole
 * ssh list as it should be afterwards: an entry whose `id` is a saved machine
 * keeps that machine (and its place in the stream), one without is added, and a
 * saved machine missing from the list is removed. */
export interface MachinesUpdate {
  localName?: string;
  machines?: Array<{ id?: string; name: string; destination: string }>;
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
