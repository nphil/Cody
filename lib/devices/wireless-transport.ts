import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, rm, rmdir, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAccountsDir } from "../auth/paths";
import {
  checkAbort, deadline, openAdbSocket, query, request, response, shell, WirelessTransportError,
  type WirelessRunOptions, type WirelessRunResult,
} from "./wireless-transport-socket";

export { WirelessTransportError, type WirelessTransportErrorCode, type WirelessRunOptions, type WirelessRunResult } from "./wireless-transport-socket";

const ADB = "/usr/local/libexec/cody/adb-wireless";
const ADB_ABI = "cody-adb-wireless-v1\n";
const CONNECT_MS = 14_000;
const PAIR_MS = 25_000;
const MAX_LIVE_DAEMONS = 8;
const MAX_PAIRS_PER_SCOPE = 8;
const MAX_IO = 32 * 1024 * 1024;
const PAIRING_ID = /^[0-9a-f]{32}(?![\s\S])/;
const GUID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}(?![\s\S])/;

export interface WirelessScope {
  readonly ownerId: string;
  readonly sessionId: string;
}

export interface WirelessConnection {
  readonly address: string;
  readonly closed: AbortSignal;
  run(args: readonly string[], options?: WirelessRunOptions): Promise<WirelessRunResult>;
  close(): Promise<void>;
}

export function parseWirelessAddress(input: string): string {
  const match = /^([0-9.]{7,15}):([1-9][0-9]{0,4})(?![\s\S])/.exec(input);
  if (match && isIP(match[1]) === 4) {
    const [a, b] = match[1].split(".").map(Number);
    const port = Number(match[2]);
    const privateLan = a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
    if (privateLan && port >= 1024 && port <= 65535 && port !== 5555 && port !== 5037) {
      return `${match[1]}:${port}`;
    }
  }
  throw new WirelessTransportError("invalid_address");
}

export function wirelessClientName(pairingId: string): string {
  return `Cody@${pairingId.slice(0, 8)}`;
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

async function privateDirectory(path: string): Promise<boolean> {
  try {
    const stat = await lstat(path);
    if (stat.isDirectory() && stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o700) return true;
    throw new WirelessTransportError("unavailable");
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}

async function verifyPrivateFile(path: string, maxBytes: number) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || stat.size < 1 || stat.size > maxBytes) {
      throw new WirelessTransportError("unavailable");
    }
    return file;
  } catch (error) {
    await file.close();
    throw error;
  }
}

/** Only short, server-control commands (the version probe and pair via stdin). */
async function control(binary: string, args: readonly string[], env: NodeJS.ProcessEnv, signal: AbortSignal, input?: Buffer): Promise<string | undefined> {
  if (signal.aborted) return;
  const child = spawn(binary, args, { env, stdio: [input ? "pipe" : "ignore", "pipe", "ignore"] });
  const { promise, resolve } = Promise.withResolvers<number | null>();
  const terminate = () => { child.kill("SIGKILL"); };
  const output: Buffer[] = [];
  let size = 0;
  child.on("error", terminate);
  child.once("close", resolve);
  child.stdout?.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > 4096) terminate();
    else output.push(chunk);
  });
  signal.addEventListener("abort", terminate, { once: true });
  if (input) {
    child.stdin?.on("error", terminate);
    child.stdin?.end(input);
  }
  try {
    if (await promise === 0 && !signal.aborted && size <= 4096) return Buffer.concat(output, size).toString("utf8");
  } finally {
    signal.removeEventListener("abort", terminate);
  }
}

interface Daemon {
  readonly path: string;
  readonly spec: string;
  readonly env: NodeJS.ProcessEnv;
  readonly closed: AbortSignal;
  close(): Promise<void>;
}

/** One process per live pairing or pairing attempt. Never start or use the host's ADB server. */
async function startDaemon(binary: string, home: string, pairingId: string, target: { pair: string } | { connect: string }, signal: AbortSignal): Promise<Daemon> {
  const baseEnv = { NODE_ENV: "production" as const, LC_ALL: "C", CODY_ADB_PARENT_PID: String(process.pid) };
  if (await control(binary, ["cody-wireless-abi"], baseEnv, signal) !== ADB_ABI) {
    throw new WirelessTransportError("unavailable");
  }
  const runtime = await mkdtemp(join(tmpdir(), "cw-adb-")); // 0700, short Linux Unix socket path
  const path = join(runtime, "adb.sock");
  const spec = `localfilesystem:${path}`;
  const env = {
    ...baseEnv,
    HOME: home, TMPDIR: runtime,
    ADB_USB: "0", ADB_MDNS: "0", ADB_EMU: "0", ANDROID_ADB_LOG_PATH: "/dev/null",
    CODY_ADB_CLIENT_LABEL: wirelessClientName(pairingId),
    ...("pair" in target ? { CODY_ADB_PAIR_ADDRESS: target.pair } : { CODY_ADB_CONNECT_ADDRESS: target.connect }),
  };
  if (signal.aborted || Buffer.byteLength(path) >= 108) {
    await rm(runtime, { recursive: true, force: true });
    throw new WirelessTransportError("unavailable");
  }
  const child = spawn(binary, ["-L", spec, "server", "nodaemon", "--reply-fd", "3"], { cwd: runtime, env, stdio: ["ignore", "ignore", "ignore", "pipe"] });
  const { promise: exited, resolve: exit } = Promise.withResolvers<void>();
  const { promise: ready, resolve: markReady } = Promise.withResolvers<boolean>();
  const lifetime = new AbortController();
  let stopping: Promise<void> | undefined;
  const close = () => stopping ??= (async () => {
    lifetime.abort();
    child.kill("SIGKILL");
    await exited;
    await rm(runtime, { recursive: true, force: true });
  })();
  child.on("error", () => markReady(false));
  child.once("close", () => {
    exit();
    lifetime.abort();
    markReady(false);
  });
  const pipe = child.stdio[3];
  let ack = "";
  if (pipe && "read" in pipe) {
    pipe.on("error", () => markReady(false));
    pipe.on("data", (chunk: Buffer) => {
      if (ack.length + chunk.length > 3) markReady(false);
      else ack += chunk.toString("latin1");
    });
    pipe.once("end", () => markReady(ack === "OK\n"));
  } else markReady(false);
  const abort = () => markReady(false);
  signal.addEventListener("abort", abort, { once: true });
  try {
    if (signal.aborted || !await ready || lifetime.signal.aborted) throw new WirelessTransportError("unavailable");
    return { path, spec, env, closed: lifetime.signal, close };
  } catch (error) {
    await close();
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

function deviceId(list: string, address: string): string | undefined {
  if (!list.startsWith(address + " ") || !list.endsWith("\n") || list.indexOf("\n") !== list.length - 1) return;
  const match = /^ +device(?: [^\n]*)? transport_id:([1-9][0-9]{0,19})\n$/.exec(list.slice(address.length));
  return match?.[1];
}

interface LiveConnection {
  readonly stop: AbortController;
  readonly opening: Promise<WirelessConnection>;
}

export class WirelessTransport {
  private readonly pairing = new Set<string>();
  private readonly live = new Map<string, LiveConnection>();
  private readonly revoking = new Map<string, Promise<void>>();
  constructor(private readonly options: { root?: string; binary?: string } = {}) {}

  available(): boolean {
    if (process.platform !== "linux") return false;
    try {
      accessSync(this.options.binary ?? ADB, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  private scopeDir(scope: WirelessScope): { root: string; dir: string } {
    if (!scope.ownerId || !scope.sessionId) throw new WirelessTransportError("not_found");
    const root = this.options.root ?? join(getAccountsDir(), "adb-wireless");
    const digest = createHash("sha256").update(JSON.stringify([scope.ownerId, scope.sessionId])).digest("hex");
    return { root, dir: join(root, digest) };
  }

  private home(scope: WirelessScope, pairingId: string): string {
    if (!PAIRING_ID.test(pairingId)) throw new WirelessTransportError("not_found");
    return join(this.scopeDir(scope).dir, pairingId);
  }

  async pair(scope: WirelessScope, pairingAddress: string, code: string, source?: AbortSignal): Promise<string> {
    const address = parseWirelessAddress(pairingAddress);
    if (code.length !== 6 || !/^[0-9]{6}$/.test(code)) throw new WirelessTransportError("invalid_code");
    if (!this.available()) throw new WirelessTransportError("unavailable");
    const { root, dir } = this.scopeDir(scope);
    if (this.pairing.has(dir)) throw new WirelessTransportError("busy");
    if (this.pairing.size + this.live.size >= MAX_LIVE_DAEMONS) throw new WirelessTransportError("limit");
    this.pairing.add(dir);
    const signal = deadline(PAIR_MS, source);
    const id = randomBytes(16).toString("hex");
    const home = join(dir, id);
    let created = false;
    let complete = false;
    try {
      checkAbort(signal, source);
      await mkdir(root, { recursive: true, mode: 0o700 });
      await privateDirectory(root);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await privateDirectory(dir);
      if ((await readdir(dir)).filter((name) => PAIRING_ID.test(name)).length >= MAX_PAIRS_PER_SCOPE) throw new WirelessTransportError("limit");
      await mkdir(home, { mode: 0o700 });
      created = true;
      await mkdir(join(home, ".android"), { mode: 0o700 });
      const binary = this.options.binary ?? ADB;
      const daemon = await startDaemon(binary, home, id, { pair: address }, signal);
      let output: string | undefined;
      const secret = Buffer.alloc(7);
      try {
        secret.write(code, "ascii");
        secret[6] = 10;
        output = await control(binary, ["-L", daemon.spec, "pair", address], daemon.env, signal, secret);
      } finally {
        secret.fill(0);
        await daemon.close();
      }
      checkAbort(signal, source);
      const prefix = `Enter pairing code: Successfully paired to ${address} [guid=`;
      const guid = output?.startsWith(prefix) && output.endsWith("]\n") ? output.slice(prefix.length, -2) : "";
      if (!GUID.test(guid)) throw new WirelessTransportError("pairing_failed");
      await (await verifyPrivateFile(join(home, ".android", "adbkey"), 4096)).close();
      // AOSP's mDNS cache is not a source of trust for Cody.
      await rm(join(home, ".android", "adb_known_hosts.pb"), { force: true });
      await writeFile(join(home, "guid"), guid, { mode: 0o600, flag: "wx" });
      checkAbort(signal, source);
      complete = true;
      return id;
    } catch (error) {
      checkAbort(signal, source);
      throw error instanceof WirelessTransportError ? error : new WirelessTransportError("unavailable");
    } finally {
      try {
        if (created && !complete) await rm(home, { recursive: true, force: true });
      } finally {
        this.pairing.delete(dir);
      }
    }
  }

  async connect(scope: WirelessScope, pairingId: string, connectAddress: string, source?: AbortSignal): Promise<WirelessConnection> {
    const address = parseWirelessAddress(connectAddress);
    if (!this.available()) throw new WirelessTransportError("unavailable");
    const home = this.home(scope, pairingId);
    if (this.live.has(home) || this.revoking.has(home)) throw new WirelessTransportError("busy");
    if (this.pairing.size + this.live.size >= MAX_LIVE_DAEMONS) throw new WirelessTransportError("limit");
    const stop = new AbortController();
    const cancellation = source ? AbortSignal.any([source, stop.signal]) : stop.signal;
    const release = () => {
      if (this.live.get(home)?.stop === stop) this.live.delete(home);
    };
    const opening = this.open(scope, home, pairingId, address, cancellation, release).catch((error: unknown) => {
      release();
      throw error;
    });
    this.live.set(home, { stop, opening });
    return opening;
  }

  private async open(scope: WirelessScope, home: string, pairingId: string, address: string, source: AbortSignal, release: () => void): Promise<WirelessConnection> {
    const signal = deadline(CONNECT_MS, source);
    let daemon: Daemon | undefined;
    let accepted = false;
    try {
      checkAbort(signal, source);
      const { root, dir } = this.scopeDir(scope);
      if (!await privateDirectory(root) || !await privateDirectory(dir) || !await privateDirectory(home) || !await privateDirectory(join(home, ".android"))) {
        throw new WirelessTransportError("not_found");
      }
      let guid: string;
      try {
        const pin = await verifyPrivateFile(join(home, "guid"), 128);
        try { guid = await pin.readFile("utf8"); } finally { await pin.close(); }
        await (await verifyPrivateFile(join(home, ".android", "adbkey"), 4096)).close();
      } catch (error) {
        if (missing(error)) throw new WirelessTransportError("not_found");
        throw error;
      }
      if (!GUID.test(guid)) throw new WirelessTransportError("not_found");
      const candidate = await startDaemon(this.options.binary ?? ADB, home, pairingId, { connect: address }, signal);
      daemon = candidate;
      const connected = await query(candidate.path, `host:connect:${address}`, signal);
      if (connected !== `connected to ${address}`) throw new WirelessTransportError("connection_failed");
      const id = deviceId(await query(candidate.path, "host:devices-l", signal), address);
      if (!id) throw new WirelessTransportError("connection_failed");
      // Pairing authenticates the GUID, not adbd's unrelated transient TLS cert.
      // This compares the same device-reported value over the exact live transport.
      const probe = await shell(candidate.path, id, "/system/bin/getprop persist.adb.wifi.guid", { maxOutputBytes: 256 }, signal);
      if (probe.exitCode !== 0 || probe.stdout.toString("utf8").trimEnd() !== guid) throw new WirelessTransportError("identity_mismatch");
      checkAbort(signal, source);
      if (candidate.closed.aborted) throw new WirelessTransportError("connection_failed");
      const close = async () => {
        try { await candidate.close(); } finally { release(); }
      };
      const tracking = openAdbSocket(candidate.path, candidate.closed);
      void (async () => {
        try {
          await request(tracking, "host:track-devices-l");
          while (deviceId(await response(tracking), address) === id) { /* wait for a changed device list */ }
        } catch {
          // The native server or the pinned transport went away.
        } finally {
          tracking.destroy();
          await close();
        }
      })().catch(() => { /* close already signalled the link loss */ });
      let running = false;
      accepted = true;
      return {
        address, closed: candidate.closed, close,
        async run(args, options = {}) {
          if (candidate.closed.aborted) throw new WirelessTransportError("connection_lost");
          if (running) throw new WirelessTransportError("busy");
          if (args.length !== 3 || args[0] !== "shell" || args[1] !== "-T" || !args[2] || args[2].includes("\0") || Buffer.byteLength(args[2]) > 16_384) {
            throw new WirelessTransportError("limit");
          }
          const timeoutMs = options.timeoutMs ?? 20_000;
          const maxOutputBytes = options.maxOutputBytes ?? 65_536;
          if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000 || !Number.isInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > MAX_IO ||
              (options.stdin !== undefined && (!Buffer.isBuffer(options.stdin) || options.stdin.length > MAX_IO))) {
            throw new WirelessTransportError("limit");
          }
          const runSignal = deadline(timeoutMs, options.signal, candidate.closed);
          checkAbort(runSignal, options.signal, candidate.closed);
          running = true;
          try {
            return await shell(candidate.path, id, args[2], { ...options, maxOutputBytes }, runSignal);
          } catch (error) {
            checkAbort(runSignal, options.signal, candidate.closed);
            throw error instanceof WirelessTransportError ? error : new WirelessTransportError("connection_lost");
          } finally {
            running = false;
          }
        },
      };
    } catch (error) {
      checkAbort(signal, source);
      if (error instanceof WirelessTransportError && error.code !== "connection_lost" && error.code !== "output_limit") throw error;
      throw new WirelessTransportError("connection_failed");
    } finally {
      if (!accepted) await daemon?.close();
    }
  }

  async disconnect(scope: WirelessScope, pairingId: string): Promise<void> {
    const entry = this.live.get(this.home(scope, pairingId));
    if (!entry) return;
    entry.stop.abort();
    // A canceled open already cleaned up the daemon; a completed open must close it now.
    const link = await entry.opening.catch(() => undefined);
    await link?.close();
  }

  async revoke(scope: WirelessScope, pairingId: string): Promise<void> {
    const home = this.home(scope, pairingId);
    const existing = this.revoking.get(home);
    if (existing) return existing;
    const revoking = (async () => {
      try {
        await this.disconnect(scope, pairingId);
        const { root, dir } = this.scopeDir(scope);
        if (await privateDirectory(root) && await privateDirectory(dir)) await rm(home, { recursive: true, force: true });
      } finally {
        this.revoking.delete(home);
      }
    })();
    this.revoking.set(home, revoking);
    return revoking;
  }

  async reap(scope: WirelessScope, keep: ReadonlySet<string>): Promise<void> {
    const { root, dir } = this.scopeDir(scope);
    if (this.pairing.has(dir)) throw new WirelessTransportError("busy");
    if (!await privateDirectory(root) || !await privateDirectory(dir)) return;
    for (const id of await readdir(dir)) {
      if (PAIRING_ID.test(id) && !keep.has(id)) await this.revoke(scope, id);
    }
    try { await rmdir(dir); } catch (error) {
      if (!missing(error) && (error as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw error;
    }
  }
}

const state = globalThis as typeof globalThis & { __codyWirelessTransport?: WirelessTransport };
export const wirelessTransport = state.__codyWirelessTransport ??= new WirelessTransport();
