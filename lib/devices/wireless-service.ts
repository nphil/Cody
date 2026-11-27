import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { networkInterfaces } from "node:os";
import { getAccountsDir } from "../auth/paths";
import { getSessionOwner } from "../auth/session-owners";
import { findUserById } from "../auth/users";
import { isRecord } from "../type-guards";
import {
  parseWirelessAddress,
  wirelessClientName,
  wirelessTransport,
  WirelessTransportError,
  type WirelessConnection,
} from "./wireless-transport";
import {
  NOT_SENT_EXIT,
  prepareWirelessOperation,
  prepareWirelessPull,
  prepareWirelessPush,
  wirelessApprovalReason,
  wirelessCommandText,
  wirelessHumanCommand,
  WirelessServiceError,
  WIRELESS_CONNECTION_PROBE,
  type WirelessPreparedCommand,
} from "./wireless-service-command";
import type {
  WirelessAction,
  WirelessAgentOperation,
  WirelessApprovalResult,
  WirelessCommandResult,
  WirelessDevice,
  WirelessFailure,
  WirelessRootRequest,
  WirelessSnapshot,
  WirelessShellAction,
  WirelessStatus,
} from "./wireless-types";

export { WirelessServiceError } from "./wireless-service-command";

const MAX_PAIRINGS = 32;
const MAX_OWNER_PAIRINGS = 8;
const MAX_PAIR_ATTEMPTS = 40;
const MAX_CONNECTION_ATTEMPTS = 4;
const MAX_OPERATIONS = 6;
const MAX_APPROVALS = 8;
const APPROVAL_MS = 2 * 60_000;
const HISTORY_MS = 15 * 60_000;
const PAIR_WINDOW_MS = 10 * 60_000;
const CONNECT_WINDOW_MS = 60_000;
const RETRY_MS = 2_000;
const RETRY_CAP_MS = 60_000;
const HEALTH_MS = 60_000;
const PROBE_LIMIT = 4096;
const PROBE_MS = 5_000;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/;
const PAIRING_ID = /^[0-9a-f]{32}$/;

interface RecordOnDisk {
  readonly ownerId: string;
  readonly sessionId: string;
  readonly pairingId: string;
  readonly address: string;
  readonly pairedAt: number;
  readonly label: string;
  readonly lastConnectedAt?: number;
  /** Explicit disconnect is durable, as is a revoked mapping whose custody cleanup still needs to finish. */
  readonly enabled: boolean;
  readonly revoked?: true;
}

interface Approval {
  readonly view: Omit<WirelessRootRequest, "state">;
  readonly link: WirelessConnection;
  outcome: WirelessApprovalResult;
}

interface Slot {
  readonly sessionId: string;
  selectionId: string;
  status: WirelessStatus;
  error?: WirelessFailure;
  link?: WirelessConnection;
  work?: { controller: AbortController; done: Promise<void> };
  stopping?: Promise<void>;
  operation?: AbortController;
  timer?: ReturnType<typeof setTimeout>;
  deleting?: boolean;
  reapedFor?: string;
  paused: boolean;
  failures: number;
  readonly approvals: Map<string, Approval>;
}

interface ConnectedTablet {
  readonly row: RecordOnDisk;
  readonly slot: Slot;
  readonly link: WirelessConnection;
}

interface Options {
  readonly path: string;
  readonly transport: Pick<typeof wirelessTransport, "available" | "pair" | "connect" | "disconnect" | "revoke" | "reap">;
  readonly ownsSession: (ownerId: string, sessionId: string) => boolean;
  readonly now?: () => number;
  readonly retryMs?: number;
}

function problem(code: string, message: string, status?: number): never {
  throw new WirelessServiceError(code, message, status);
}

function details(error: WirelessServiceError): WirelessFailure {
  return { code: error.code, message: error.message };
}

function storageError(): WirelessServiceError {
  return new WirelessServiceError("storage_error", "Cody could not save the tablet’s pairing settings.", 500);
}

function sessionMissing(): WirelessServiceError {
  return new WirelessServiceError("session_not_found", "Open a signed-in Cody chat you own to use wireless ADB.", 404);
}

function cleanLabel(value: string): string {
  return value.replace(/[\p{C}\p{Zl}\p{Zp}]/gu, " ").trim().slice(0, 80);
}

function storedDevice(row: RecordOnDisk, selectionId: string): WirelessDevice {
  const [host, port] = row.address.split(":");
  return { selectionId, label: row.label, host, connectPort: Number(port), pairedAt: row.pairedAt, lastConnectedAt: row.lastConnectedAt, clientName: wirelessClientName(row.pairingId) };
}

function userAddress(host: unknown, port: unknown): string {
  if (typeof host !== "string" || !/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host)) {
    problem("invalid_host", "Enter the tablet’s numeric private IPv4 address exactly as Android shows it.", 400);
  }
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1024 || port > 65535 || port === 5555 || port === 5037) {
    problem("invalid_port", "Enter the port Android shows for Wireless debugging (not 5555 or the ADB server port).", 400);
  }
  let address: string;
  try { address = parseWirelessAddress(`${host}:${port}`); }
  catch { return problem("invalid_host", "Use a private Wi-Fi IPv4 address; hostnames and public addresses are not allowed.", 400); }
  if (Object.values(networkInterfaces()).some((group) => group?.some((item) => item.address === host))) {
    problem("invalid_host", "Enter the tablet’s address, not this Cody server’s address.", 400);
  }
  return address;
}

function loadRows(path: string): Map<string, RecordOnDisk> {
  const rows = new Map<string, RecordOnDisk>();
  let file: unknown;
  try { file = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return rows;
    throw storageError();
  }
  if (!isRecord(file) || file.version !== 1 || !Array.isArray(file.records) || file.records.length > MAX_PAIRINGS) throw storageError();
  for (const raw of file.records) {
    if (!isRecord(raw) || typeof raw.ownerId !== "string" || !SESSION_ID.test(raw.ownerId)
      || typeof raw.sessionId !== "string" || !SESSION_ID.test(raw.sessionId) || rows.has(raw.sessionId)
      || typeof raw.pairingId !== "string" || !PAIRING_ID.test(raw.pairingId) || typeof raw.address !== "string"
      || typeof raw.pairedAt !== "number" || !Number.isSafeInteger(raw.pairedAt) || typeof raw.label !== "string"
      || typeof raw.enabled !== "boolean") throw storageError();
    try { if (parseWirelessAddress(raw.address) !== raw.address || raw.address.endsWith(":5037")) throw storageError(); }
    catch { throw storageError(); }
    rows.set(raw.sessionId, {
      ownerId: raw.ownerId, sessionId: raw.sessionId, pairingId: raw.pairingId, address: raw.address,
      pairedAt: raw.pairedAt, label: cleanLabel(raw.label) || raw.address,
      lastConnectedAt: typeof raw.lastConnectedAt === "number" && Number.isSafeInteger(raw.lastConnectedAt) ? raw.lastConnectedAt : undefined,
      enabled: raw.enabled && raw.revoked !== true, revoked: raw.revoked === true ? true : undefined,
    });
  }
  return rows;
}

/** Never expose a pairing child's output, private code, raw adb errors, socket paths, keys, or GUID. */
function transportFailure(error: unknown, phase: "pair" | "connect" | "command"): WirelessServiceError {
  if (error instanceof WirelessServiceError) return error;
  const code = error instanceof WirelessTransportError ? error.code : undefined;
  switch (code) {
    case "unavailable": return new WirelessServiceError("unavailable", "This Cody server does not have wireless ADB available.", 503);
    case "busy": case "limit": return new WirelessServiceError("busy", "Wireless ADB is busy. Try again shortly.", 429);
    case "cancelled": return new WirelessServiceError("cancelled", "The wireless ADB request was cancelled.");
    case "not_found": return new WirelessServiceError("needs_pairing", "Cody no longer has a pairing for this tablet. Forget it here and pair again.");
    case "connection_authentication_failed": return new WirelessServiceError(code, "The ADB connection failed authentication. Check that Cody is still listed under Paired devices on Android.", 503);
    case "connection_not_established": return new WirelessServiceError(code, "Cody reached the address, but the encrypted ADB connection did not finish opening. Keep Wireless debugging on and try reconnecting.", 503);
    case "connection_rejected": return new WirelessServiceError(code, "Cody’s ADB program reported that the encrypted connection failed. Check the connection address on Android’s main Wireless debugging screen.", 503);
    case "transport_not_ready": return new WirelessServiceError(code, "Android’s ADB connection was not ready. Keep Wireless debugging on and try reconnecting.", 503);
    case "transport_unsupported": return new WirelessServiceError(code, "Android’s ADB connection does not support the shell protocol Cody needs to check the tablet’s identity.", 503);
    case "guid_check_failed": return new WirelessServiceError(code, "Cody could not read the tablet’s paired identity. Keep Wireless debugging on and try reconnecting.", 503);
    case "identity_mismatch": return new WirelessServiceError("identity_mismatch", "That address did not identify the paired tablet. Check its Wireless debugging address.");
    case "output_limit": return new WirelessServiceError("output_limit", "Android returned more than the allowed amount of data. Ask for a smaller result.", 413);
    default:
      if (phase === "pair") return new WirelessServiceError("pairing_failed", "Android did not accept pairing. Open a fresh pairing dialog and check the address, pairing port and code.");
      if (phase === "connect") return new WirelessServiceError("unreachable", "Cody could not open encrypted ADB to the tablet. Check that Wireless debugging is on and verify its connection address.", 503);
      return new WirelessServiceError(code === "timeout" ? "timeout" : "connection_lost", "The wireless ADB command ended before Cody received a result.");
  }
}

export class WirelessService {
  private readonly rows: Map<string, RecordOnDisk>;
  private readonly stateError?: WirelessServiceError;
  private readonly slots = new Map<string, Slot>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly pairing = new Map<string, string>();
  private pairAttempts: { ownerId: string; at: number }[] = [];
  private connectAttempts: { ownerId: string; at: number }[] = [];
  private connecting = 0;
  private operating = 0;
  private readonly now: () => number;
  private readonly retryMs: number;

  constructor(private readonly options: Options) {
    try { this.rows = loadRows(options.path); }
    catch {
      // An unreadable store must not let a different tablet claim a session, or disable other Cody tools.
      this.rows = new Map();
      this.stateError = storageError();
    }
    this.now = options.now ?? Date.now;
    this.retryMs = options.retryMs ?? RETRY_MS;
    for (const row of this.rows.values()) this.arm(this.slot(row.sessionId), this.retryMs);
  }

  private slot(sessionId: string): Slot {
    let slot = this.slots.get(sessionId);
    if (!slot) {
      slot = { sessionId, selectionId: randomUUID(), status: "unpaired", paused: false, failures: 0, approvals: new Map() };
      this.slots.set(sessionId, slot);
    }
    return slot;
  }

  private save(sessionId: string, row?: RecordOnDisk): void {
    if (this.stateError) throw this.stateError;
    const records = [...this.rows.values()].filter((saved) => saved.sessionId !== sessionId);
    if (row) records.push(row);
    const path = this.options.path;
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(temp, `${JSON.stringify({ version: 1, records })}\n`, { flag: "wx", mode: 0o600 });
      renameSync(temp, path);
    } catch {
      try { rmSync(temp, { force: true }); } catch { /* report the underlying save failure */ }
      throw storageError();
    }
    if (row) this.rows.set(sessionId, row);
    else this.rows.delete(sessionId);
  }

  private owns(ownerId: string, sessionId: string): boolean {
    return SESSION_ID.test(sessionId) && SESSION_ID.test(ownerId) && this.options.ownsSession(ownerId, sessionId);
  }

  private assertOwner(ownerId: string, sessionId: string): void {
    if (this.stateError) throw this.stateError;
    const row = this.rows.get(sessionId);
    const pairing = this.pairing.get(sessionId);
    if (!this.owns(ownerId, sessionId) || (row && row.ownerId !== ownerId) || (pairing !== undefined && pairing !== ownerId)) throw sessionMissing();
  }

  private assertSelection(sessionId: string, selectionId: string): void {
    if (!this.rows.has(sessionId) || this.slots.get(sessionId)?.selectionId !== selectionId) {
      problem("selection_changed", "The tablet connection changed. Review the current tablet in Devices; nothing was sent.");
    }
  }

  private notify(sessionId: string): void {
    for (const run of this.listeners.get(sessionId) ?? []) {
      try { run(); } catch { /* an observer must not strand a tablet connection */ }
    }
  }

  subscribe(sessionId: string, listener: () => void): () => void {
    let group = this.listeners.get(sessionId);
    if (!group) this.listeners.set(sessionId, group = new Set());
    group.add(listener);
    return () => {
      group.delete(listener);
      if (group.size === 0 && this.listeners.get(sessionId) === group) this.listeners.delete(sessionId);
    };
  }

  private publish(slot: Slot, status: WirelessStatus, error?: WirelessServiceError): void {
    slot.status = status;
    slot.error = error ? details(error) : undefined;
    this.notify(slot.sessionId);
  }

  private snapshot(sessionId: string, row: RecordOnDisk | undefined, slot: Slot | undefined, page: boolean): WirelessSnapshot {
    const supported = !this.stateError && this.options.transport.available();
    const device = row && slot && (page || !row.revoked) ? storedDevice(row, slot.selectionId) : null;
    const status = !device && slot?.status !== "pairing" ? "unpaired"
      : row && !row.enabled ? "disconnected" : slot?.status === "unpaired" ? "offline" : slot?.status ?? "offline";
    const rootRequests: WirelessRootRequest[] = [];
    if (page && slot && device && !row?.revoked) {
      this.pruneApprovals(slot);
      for (const { view, outcome } of slot.approvals.values()) {
        if (outcome.state === "pending" || outcome.state === "approved") rootRequests.push({ ...view, state: outcome.state });
      }
    }
    return {
      sessionId, supported, reason: supported ? undefined : this.stateError?.message ?? "Wireless ADB is not available on this Cody server.",
      status, device, error: slot?.error, rootRequests,
    };
  }

  pageSnapshot(ownerId: string, sessionId: string): WirelessSnapshot {
    this.assertOwner(ownerId, sessionId);
    return this.snapshot(sessionId, this.rows.get(sessionId), this.slots.get(sessionId), true);
  }

  /** The caller binds sessionId from host dispatch or a verified session capability, never from tool args. */
  agentSnapshot(sessionId: string): WirelessSnapshot {
    const row = this.rows.get(sessionId);
    const visible = row && !row.revoked && this.owns(row.ownerId, sessionId) ? row : undefined;
    return this.snapshot(sessionId, visible, visible ? this.slots.get(sessionId) : undefined, false);
  }

  private arm(slot: Slot, delay: number): void {
    clearTimeout(slot.timer);
    slot.timer = setTimeout(() => {
      slot.timer = undefined;
      const row = this.rows.get(slot.sessionId);
      this.pruneApprovals(slot);
      if (!row) {
        if (!slot.work && !slot.stopping) this.slots.delete(slot.sessionId);
      } else if (row.revoked || !this.owns(row.ownerId, row.sessionId)) {
        void this.forgetSession(slot.sessionId).catch(() => this.arm(slot, HEALTH_MS));
      } else if (slot.link || !row.enabled || slot.paused || slot.status === "needs-pairing" || !this.options.transport.available()) {
        // Recheck the ownership of even a disconnected pairing, so a deleted account leaves no usable custody.
        this.arm(slot, HEALTH_MS);
      } else if (!slot.work && !slot.stopping) {
        if (this.connecting < MAX_CONNECTION_ATTEMPTS) void this.connect(slot, row, row.address).catch(() => this.arm(slot, this.retryMs));
        else this.arm(slot, this.retryMs);
      }
    }, delay);
    slot.timer.unref();
  }

  private schedule(slot: Slot): void {
    const row = this.rows.get(slot.sessionId);
    const retry = row && !row.revoked && row.enabled && !slot.paused && !slot.link && slot.status !== "needs-pairing" && this.options.transport.available();
    this.arm(slot, retry ? Math.min(RETRY_CAP_MS, this.retryMs * 2 ** Math.min(slot.failures, 8)) : row ? HEALTH_MS : PAIR_WINDOW_MS);
  }

  private begin(slot: Slot, fn: (signal: AbortSignal) => Promise<void>, signal?: AbortSignal): Promise<void> {
    if (slot.work || slot.stopping) problem("busy", "This chat is already changing its tablet connection.", 409);
    clearTimeout(slot.timer);
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
    const done = Promise.resolve().then(() => fn(combined)).finally(() => {
      slot.work = undefined;
      if (!slot.stopping) this.schedule(slot);
    });
    slot.work = { controller, done };
    return done;
  }

  private validateTurn(row: RecordOnDisk, signal: AbortSignal): void {
    if (signal.aborted) problem("cancelled", "The wireless ADB request was cancelled.");
    this.assertOwner(row.ownerId, row.sessionId);
  }

  private async pair(ownerId: string, action: Extract<WirelessAction, { action: "pair" }>, requestSignal?: AbortSignal): Promise<void> {
    const sessionId = action.sessionId;
    const pairAddress = userAddress(action.host, action.pairingPort);
    const address = userAddress(action.host, action.connectPort);
    if (pairAddress === address) problem("invalid_port", "The pairing port and the connection port are different on Android.", 400);
    if (typeof action.code !== "string" || !/^\d{6}$/.test(action.code)) problem("invalid_code", "Enter the six-digit code from Android’s pairing dialog.", 400);
    if (!this.options.transport.available()) problem("unavailable", "This Cody server does not have wireless ADB available.", 503);
    if (this.rows.has(sessionId)) problem("already_paired", "Forget this chat’s current pairing before pairing a different tablet.");
    if (this.pairing.has(sessionId) || [...this.pairing.values()].includes(ownerId) || this.pairing.size >= 2) problem("busy", "Another tablet is being paired. Try again shortly.", 429);
    if (this.rows.size + this.pairing.size >= MAX_PAIRINGS || [...this.rows.values()].filter((row) => row.ownerId === ownerId).length >= MAX_OWNER_PAIRINGS) {
      problem("limit", "Too many saved wireless pairings. Forget one before adding another.", 429);
    }
    const now = this.now();
    this.pairAttempts = this.pairAttempts.filter((attempt) => now - attempt.at < PAIR_WINDOW_MS);
    if (this.pairAttempts.length >= MAX_PAIR_ATTEMPTS || this.pairAttempts.filter((attempt) => attempt.ownerId === ownerId).length >= 5) {
      problem("limit", "Too many pairing attempts. Wait a few minutes before trying a new Android code.", 429);
    }
    const slot = this.slot(sessionId);
    if (slot.stopping || slot.work) problem("busy", "This chat is already changing its tablet connection.");
    if (slot.deleting) throw sessionMissing();
    const scope = { ownerId, sessionId };
    this.pairAttempts.push({ ownerId, at: now });
    this.pairing.set(sessionId, ownerId);
    try {
      const pending = this.begin(slot, async (signal) => {
        let row: RecordOnDisk | undefined;
        let saved = false;
        try {
          if (signal.aborted) problem("cancelled", "Pairing was cancelled.");
          await this.options.transport.reap(scope, new Set());
          if (signal.aborted || !this.owns(ownerId, sessionId)) problem("cancelled", "Pairing was cancelled.");
          slot.reapedFor = ownerId;
          const pairingId = await this.options.transport.pair(scope, pairAddress, action.code, signal);
          row = { ...scope, pairingId, address, label: address, pairedAt: this.now(), enabled: true };
          this.validateTurn(row, signal);
          this.save(sessionId, row);
          saved = true;
          slot.selectionId = randomUUID();
          slot.paused = false;
          slot.failures = 0;
          this.publish(slot, "offline");
        } catch (error) {
          if (row && !saved) {
            try { await this.options.transport.revoke(scope, row.pairingId); }
            catch { this.save(sessionId, { ...row, enabled: false, revoked: true }); }
          }
          const fault = transportFailure(error, "pair");
          if (!slot.stopping) this.publish(slot, "unpaired", fault);
          throw fault;
        }
      }, requestSignal);
      this.publish(slot, "pairing");
      await pending;
    } finally {
      this.pairing.delete(sessionId);
    }
    const row = this.rows.get(sessionId);
    if (row && !slot.paused && !slot.stopping && this.connecting < MAX_CONNECTION_ATTEMPTS) await this.connect(slot, row, address);
  }

  private connect(slot: Slot, row: RecordOnDisk, address: string): Promise<void> {
    if (this.connecting >= MAX_CONNECTION_ATTEMPTS) problem("busy", "Several tablets are reconnecting. Try again shortly.", 429);
    if (slot.work || slot.stopping) problem("busy", "This chat is already changing its tablet connection.");
    this.connecting++;
    // Lose the old generation as soon as a reconnect is accepted, before any await.
    const previous = slot.link;
    this.invalidate(slot);
    return this.begin(slot, async (signal) => {
      let link: WirelessConnection | undefined;
      try {
        await previous?.close();
        this.validateTurn(row, signal);
        const [host, port] = address.split(":");
        userAddress(host, Number(port));
        if (slot.reapedFor !== row.ownerId) {
          await this.options.transport.reap(row, new Set([row.pairingId]));
          this.validateTurn(row, signal);
          slot.reapedFor = row.ownerId;
        }
        this.publish(slot, "connecting");
        this.validateTurn(row, signal);
        link = await this.options.transport.connect(row, row.pairingId, address, signal);
        this.validateTurn(row, signal);
        const probe = await link.run(["shell", "-T", WIRELESS_CONNECTION_PROBE], { signal: AbortSignal.any([signal, link.closed]), timeoutMs: PROBE_MS, maxOutputBytes: PROBE_LIMIT });
        this.validateTurn(row, signal);
        if (link.closed.aborted) problem("connection_lost", "The tablet disconnected before Cody could check it.");
        if (probe.exitCode !== 0) problem("ordinary_shell_required", "Wireless ADB needs Android’s ordinary shell (UID 2000). Turn off any ADB-root mode and reconnect.");
        const model = cleanLabel(probe.stdout.toString("utf8"));
        this.save(row.sessionId, { ...row, address, lastConnectedAt: this.now(), label: model || row.label });
        slot.selectionId = randomUUID();
        slot.link = link;
        slot.failures = 0;
        link.closed.addEventListener("abort", () => {
          if (slot.link !== link) return;
          this.invalidate(slot);
          this.publish(slot, "offline", new WirelessServiceError("connection_lost", "The wireless connection to the tablet was lost."));
          if (!slot.stopping && !slot.work) this.schedule(slot);
        }, { once: true });
        this.publish(slot, "connected");
      } catch (error) {
        if (link && slot.link !== link) await link.close().catch(() => undefined);
        if (!slot.stopping) {
          const fault = transportFailure(error, "connect");
          const rePair = fault.code === "needs_pairing" || (fault.code === "identity_mismatch" && address === row.address);
          slot.failures++;
          this.publish(slot, rePair ? "needs-pairing" : "offline", fault);
        }
      } finally {
        this.connecting--;
      }
    });
  }

  private invalidate(slot: Slot): void {
    slot.selectionId = randomUUID();
    slot.link = undefined;
    slot.operation?.abort();
    for (const entry of slot.approvals.values()) {
      if (entry.outcome.state === "pending") entry.outcome = { state: "cancelled" };
    }
  }

  private stop(sessionId: string, revoke: boolean, deletingOwnerId?: string): Promise<void> {
    const row = this.rows.get(sessionId);
    const slot = this.slots.get(sessionId) ?? (deletingOwnerId ? this.slot(sessionId) : undefined);
    if (!slot) return Promise.resolve();
    if (deletingOwnerId) slot.deleting = true;
    if (slot.stopping) return slot.stopping.then(() => revoke ? this.stop(sessionId, true, deletingOwnerId) : undefined);
    const ownerId = row?.ownerId ?? this.pairing.get(sessionId) ?? deletingOwnerId;
    slot.paused = true;
    clearTimeout(slot.timer);
    slot.work?.controller.abort();
    this.invalidate(slot);
    let failure: WirelessServiceError | undefined;
    const done = Promise.resolve().then(async () => {
      try {
        if (row && (row.enabled || (revoke && !row.revoked))) this.save(sessionId, { ...row, enabled: false, revoked: revoke || row.revoked ? true : undefined });
      } finally {
        await slot.work?.done.catch(() => undefined);
        const final = this.rows.get(sessionId);
        if (final) {
          if (!revoke) await this.options.transport.disconnect(final, final.pairingId);
          else {
            await this.options.transport.revoke(final, final.pairingId);
            await this.options.transport.reap(final, new Set());
            this.save(sessionId);
          }
        } else if (revoke && ownerId) {
          await this.options.transport.reap({ ownerId, sessionId }, new Set());
        }
      }
      if (revoke) slot.approvals.clear();
    }).catch((error: unknown) => {
      failure = error instanceof WirelessServiceError ? error : new WirelessServiceError(
        revoke ? "revoke_failed" : "disconnect_failed",
        revoke ? "The pairing was disabled, but Cody could not finish deleting its key. Try Forget again." : "Cody could not finish closing the wireless connection.",
        503,
      );
      throw failure;
    }).finally(() => {
      slot.stopping = undefined;
      this.publish(slot, this.rows.get(sessionId)?.revoked || !this.rows.has(sessionId) ? "unpaired" : "disconnected", failure);
      this.schedule(slot);
    });
    slot.stopping = done;
    this.publish(slot, row ? "disconnected" : "unpaired");
    return done;
  }

  /** Used by session deletion before the owner row disappears. No reuse of the deleted session's custody. */
  forgetSession(sessionId: string, deletingOwnerId?: string): Promise<void> {
    if (this.stateError) throw this.stateError;
    return this.stop(sessionId, true, deletingOwnerId);
  }

  async pageAction(ownerId: string, action: WirelessAction, signal?: AbortSignal): Promise<WirelessSnapshot> {
    const sessionId = action.sessionId;
    this.assertOwner(ownerId, sessionId);
    if (action.action !== "pair") this.assertSelection(sessionId, action.selectionId);
    switch (action.action) {
      case "pair": await this.pair(ownerId, action, signal); break;
      case "connect": {
        const row = this.rows.get(sessionId);
        if (!row || row.revoked) problem("needs_pairing", "Pair the tablet before connecting.");
        if (!this.options.transport.available()) problem("unavailable", "This Cody server does not have wireless ADB available.", 503);
        const [host, port] = row.address.split(":");
        const address = userAddress(action.host ?? host, action.connectPort ?? Number(port));
        const slot = this.slot(sessionId);
        if (slot.work || slot.stopping) problem("busy", "This chat is already changing its tablet connection.");
        if (slot.deleting) throw sessionMissing();
        if (slot.link && !slot.link.closed.aborted && row.enabled && !slot.paused && row.address === address) break;
        if (this.connecting >= MAX_CONNECTION_ATTEMPTS) problem("busy", "Several tablets are reconnecting. Try again shortly.", 429);
        const now = this.now();
        this.connectAttempts = this.connectAttempts.filter((attempt) => now - attempt.at < CONNECT_WINDOW_MS);
        if (this.connectAttempts.length >= 40 || this.connectAttempts.filter((attempt) => attempt.ownerId === ownerId).length >= 8) {
          problem("limit", "Too many connection attempts. Wait a minute and check the tablet’s Wireless debugging address.", 429);
        }
        this.connectAttempts.push({ ownerId, at: now });
        const next = row.enabled ? row : { ...row, enabled: true };
        if (next !== row) this.save(sessionId, next);
        slot.paused = false;
        slot.failures = 0;
        await this.connect(slot, next, address);
        break;
      }
      case "disconnect": await this.stop(sessionId, false); break;
      case "forget": await this.stop(sessionId, true); break;
      case "root": this.decide(sessionId, action.requestId, action.decision); break;
    }
    return this.pageSnapshot(ownerId, sessionId);
  }

  private selected(sessionId: string): { row: RecordOnDisk; slot: Slot } {
    const row = this.rows.get(sessionId);
    const slot = this.slots.get(sessionId);
    if (!row || !slot || row.revoked || !this.owns(row.ownerId, sessionId)) problem("needs_pairing", "The person must pair a tablet in this chat’s Devices panel first.");
    return { row, slot };
  }

  private connected(sessionId: string): ConnectedTablet {
    const { row, slot } = this.selected(sessionId);
    const link = slot.link;
    if (!row.enabled || slot.paused || slot.work || slot.stopping || !link || link.closed.aborted) {
      problem("not_connected", "This chat’s paired tablet is not connected. Check the Devices panel; no command was sent.");
    }
    return { row, slot, link };
  }

  private async run(
    selected: ConnectedTablet,
    task: WirelessPreparedCommand | ((signal: AbortSignal) => Promise<WirelessPreparedCommand>),
    signal?: AbortSignal,
    saveBytes?: (bytes: Buffer, signal: AbortSignal) => Promise<void>,
  ): Promise<WirelessCommandResult> {
    const { row, slot, link } = selected;
    if (slot.operation || this.operating >= MAX_OPERATIONS) problem("busy", "Wireless ADB is busy. No command was sent.", 429);
    if (signal?.aborted || link.closed.aborted || slot.link !== link || !this.owns(row.ownerId, row.sessionId)) problem("cancelled", "The tablet connection changed or was cancelled. No command was sent.");
    const operation = new AbortController();
    slot.operation = operation;
    this.operating++;
    const combined = AbortSignal.any([link.closed, operation.signal, ...(signal ? [signal] : [])]);
    try {
      // Keep workspace/preflight failures outside the transport catch: no command was sent.
      let command: WirelessPreparedCommand;
      try { command = typeof task === "function" ? await task(combined) : task; }
      catch (error) {
        if (combined.aborted) problem("cancelled", "The tablet connection changed or was cancelled. No command was sent.");
        throw error;
      }
      if (combined.aborted || slot.link !== link || !this.owns(row.ownerId, row.sessionId)) problem("cancelled", "The tablet connection changed or was cancelled. No command was sent.");
      let result: WirelessCommandResult;
      try {
        result = await link.run(["shell", "-T", command.command], {
          signal: combined, timeoutMs: command.timeoutMs, maxOutputBytes: command.maxOutputBytes, stdin: command.stdin,
        });
        if (combined.aborted || slot.link !== link || !this.owns(row.ownerId, row.sessionId)) problem("cancelled", "The tablet connection changed while the command was running.");
        if (result.stdout.byteLength + result.stderr.byteLength > command.maxOutputBytes) problem("output_limit", "Android returned more than the allowed amount of data.", 413);
        if (command.stdin && result.exitCode !== 0 && result.exitCode !== NOT_SENT_EXIT) problem("completion_unknown", "The transfer stopped; a partial file may exist. Check Android before trying again.");
      } catch (error) {
        if (command.mayWrite && (!(error instanceof WirelessServiceError) || error.code !== "completion_unknown")) {
          problem("completion_unknown", "Cody did not receive a final result. The command may have run; check the tablet before trying again.");
        }
        throw transportFailure(error, "command");
      }
      // Downloads retain the pinned connection and global capacity through
      // workspace publication and cleanup, including on local failure.
      if (saveBytes && result.exitCode === 0) {
        try { await saveBytes(result.stdout, combined); }
        catch (error) {
          if (combined.aborted) problem("cancelled", "The tablet download was cancelled. Check the workspace before trying again.");
          throw error;
        }
      }
      return result;
    } finally {
      this.operating--;
      slot.operation = undefined;
    }
  }

  agentRun(sessionId: string, operation: WirelessAgentOperation, signal?: AbortSignal): Promise<WirelessCommandResult> {
    const command = prepareWirelessOperation(operation);
    return this.run(this.connected(sessionId), command, signal);
  }

  agentPull(sessionId: string, path: string, saveBytes: (bytes: Buffer, signal: AbortSignal) => Promise<void>, signal?: AbortSignal): Promise<WirelessCommandResult> {
    return this.run(this.connected(sessionId), prepareWirelessPull(path), signal, saveBytes);
  }

  agentPush(sessionId: string, path: string, loadBytes: (signal: AbortSignal) => Promise<Uint8Array>, signal?: AbortSignal): Promise<WirelessCommandResult> {
    const prepare = prepareWirelessPush(path);
    return this.run(this.connected(sessionId), async (pinnedSignal) => prepare(await loadBytes(pinnedSignal)), signal);
  }

  pageShell(ownerId: string, input: WirelessShellAction, signal?: AbortSignal): Promise<WirelessCommandResult> {
    const { sessionId, selectionId, command } = input;
    this.assertOwner(ownerId, sessionId);
    this.assertSelection(sessionId, selectionId);
    if (input.rootCapableConfirmed !== true) problem("command_confirmation_required", "Review and confirm the exact command; it can request root.", 400);
    return this.run(this.connected(sessionId), wirelessHumanCommand(command, false), signal);
  }

  private pruneApprovals(slot: Slot): void {
    const now = this.now();
    for (const [id, entry] of slot.approvals) {
      if (entry.outcome.state === "pending" && now >= entry.view.expiresAt) entry.outcome = { state: "expired" };
      if (entry.outcome.state !== "approved" && now >= entry.view.expiresAt + HISTORY_MS) slot.approvals.delete(id);
    }
  }

  requestApproval(sessionId: string, input: { command: string; elevated: boolean; reason?: string }): WirelessRootRequest {
    const command = wirelessCommandText(input.command);
    const { elevated } = input;
    if (typeof elevated !== "boolean") problem("invalid_operation", "Say whether the command needs Magisk root.", 400);
    const reason = wirelessApprovalReason(input.reason);
    const { slot, link } = this.connected(sessionId);
    this.pruneApprovals(slot);
    if (slot.approvals.size >= MAX_APPROVALS) {
      for (const [id, entry] of slot.approvals) {
        if (entry.outcome.state !== "pending" && entry.outcome.state !== "approved") slot.approvals.delete(id);
        if (slot.approvals.size < MAX_APPROVALS) break;
      }
      if (slot.approvals.size >= MAX_APPROVALS) problem("limit", "This chat already has too many unreviewed commands.", 429);
    }
    const requestedAt = this.now();
    const view = { id: randomUUID(), command, elevated, reason, requestedAt, expiresAt: requestedAt + APPROVAL_MS };
    slot.approvals.set(view.id, { view, link, outcome: { state: "pending" } });
    this.notify(sessionId);
    return { ...view, state: "pending" };
  }

  approvalResult(sessionId: string, id: string): WirelessApprovalResult {
    const { slot } = this.selected(sessionId);
    this.pruneApprovals(slot);
    const outcome = slot.approvals.get(id)?.outcome;
    if (!outcome) problem("approval_not_found", "That command request is no longer available in this chat; do not assume the command ran or retry it automatically.", 404);
    return outcome;
  }

  private decide(sessionId: string, id: string, decision: "approve" | "deny"): void {
    const { slot } = this.selected(sessionId);
    this.pruneApprovals(slot);
    const entry = slot.approvals.get(id);
    if (!entry || entry.outcome.state !== "pending") problem("approval_not_pending", "That command request was already answered, cancelled or expired.");
    if (decision === "deny") {
      entry.outcome = { state: "denied" };
      this.notify(sessionId);
      return;
    }
    if (decision !== "approve") problem("invalid_operation", "Choose Approve or Deny.", 400);
    const current = this.connected(sessionId);
    if (entry.link !== current.link) problem("approval_not_pending", "The tablet connection changed; approval did not send the command.");
    if (slot.operation || this.operating >= MAX_OPERATIONS) problem("busy", "Wireless ADB is busy. The command remains unapproved; try again shortly.", 429);
    entry.outcome = { state: "approved" };
    const run = this.run(current, wirelessHumanCommand(entry.view.command, entry.view.elevated));
    this.notify(sessionId);
    void run.then((result) => {
      entry.outcome = { state: "finished", result };
    }, (error: unknown) => {
      entry.outcome = { state: "finished", error: details(transportFailure(error, "command")) };
    }).finally(() => this.notify(sessionId));
  }
}

declare global {
  var __codyWirelessService: WirelessService | undefined;
}

export function wirelessService(): WirelessService {
  return globalThis.__codyWirelessService ??= new WirelessService({
    path: join(getAccountsDir(), "wireless-adb.json"),
    transport: wirelessTransport,
    ownsSession: (ownerId, sessionId) => getSessionOwner(sessionId) === ownerId && findUserById(ownerId) !== null,
  });
}

export async function forgetWirelessSession(sessionId: string): Promise<void> {
  const ownerId = getSessionOwner(sessionId);
  await wirelessService().forgetSession(sessionId, ownerId && SESSION_ID.test(sessionId) && SESSION_ID.test(ownerId) ? ownerId : undefined);
}
