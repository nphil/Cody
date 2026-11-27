import { isRecord } from "../type-guards";
import { WIRELESS_MAX_COMMAND_CHARS, WIRELESS_MAX_FILE_BYTES } from "./wireless-types";

export class WirelessServiceError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) {
    super(message);
    this.name = "WirelessServiceError";
  }
}

const MAX_OUTPUT_BYTES = 64 * 1024;
const COMMAND_MS = 20_000;
const TRANSFER_MS = 60_000;
const NONDISPLAY = /[\p{C}\p{Zl}\p{Zp}]/u;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
export const NOT_SENT_EXIT = 73;

export interface WirelessPreparedCommand {
  readonly command: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly mayWrite: boolean;
  readonly stdin?: Buffer;
}

function invalid(message: string): never {
  throw new WirelessServiceError("invalid_operation", message, 400);
}

/** The exact printable, single-line string shown for a decision is the string passed to sh or su. */
export function wirelessCommandText(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > WIRELESS_MAX_COMMAND_CHARS || NONDISPLAY.test(value)) {
    invalid(`Enter one printable shell command, up to ${WIRELESS_MAX_COMMAND_CHARS} characters.`);
  }
  return value;
}

export function wirelessApprovalReason(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > 240 || NONDISPLAY.test(value)) invalid("Use a short, printable reason for the command.");
  return value.trim() || undefined;
}

function quote(word: string): string {
  return `'${word.replaceAll("'", "'\\''")}'`;
}

/** Never do useful work on userdebug adbd running as root, including if it was elevated out of band. */
function ordinaryShell(body: string): string {
  return `PATH=/system/bin; export PATH; [ "$(id -u)" = 2000 ] || { echo 'Android must be running an ordinary ADB shell (UID 2000).' >&2; exit ${NOT_SENT_EXIT}; }; ${body}`;
}

export const WIRELESS_CONNECTION_PROBE = ordinaryShell("getprop ro.product.model");

function prepared(body: string, mayWrite = false, timeoutMs = COMMAND_MS, maxOutputBytes = MAX_OUTPUT_BYTES, stdin?: Buffer): WirelessPreparedCommand {
  return { command: ordinaryShell(body), timeoutMs, maxOutputBytes, mayWrite, stdin };
}

export function wirelessHumanCommand(command: unknown, elevated: boolean): WirelessPreparedCommand {
  const literal = quote(wirelessCommandText(command));
  // Unrestricted commands can request elevation themselves. Both branches require explicit, exact approval.
  return prepared(elevated ? `exec /system/bin/su -c ${literal}` : `exec /system/bin/sh -c ${literal}`, true, elevated ? 60_000 : COMMAND_MS);
}

const INSPECT = {
  identity: "id; getenforce",
  battery: "dumpsys battery",
  storage: "df -h /data /sdcard",
  memory: "cat /proc/meminfo",
  display: "wm size; wm density",
  uptime: "uptime",
  processes: "ps -A",
} as const;

function inspect(query: unknown, filter: unknown): WirelessPreparedCommand {
  if (filter !== undefined && (typeof filter !== "string" || !TOKEN.test(filter))) invalid("Use a property name or package filter made of letters, numbers, dots, underscores or hyphens.");
  if (query === "properties") return prepared(`getprop${filter === undefined ? "" : ` ${quote(filter)}`}`);
  if (query === "packages") return prepared(`pm list packages${filter === undefined ? "" : ` ${quote(filter)}`}`);
  if (filter !== undefined || typeof query !== "string" || !Object.hasOwn(INSPECT, query)) invalid("Choose a supported Android diagnostic.");
  return prepared(INSPECT[query as keyof typeof INSPECT]);
}

function logcat(args: Record<string, unknown>): WirelessPreparedCommand {
  const { buffer = "main", lines = 100, priority = "I", tag } = args;
  if (buffer !== "main" && buffer !== "system" && buffer !== "crash" && buffer !== "events") invalid("Choose the main, system, crash, or events log.");
  if (typeof lines !== "number" || !Number.isInteger(lines) || lines < 1 || lines > 1000) invalid("Read 1 to 1000 log lines at a time.");
  if (typeof priority !== "string" || !/^[VDIWEF]$/.test(priority)) invalid("Choose a valid Android log priority.");
  if (tag !== undefined && (typeof tag !== "string" || !TOKEN.test(tag))) invalid("Use a plain Android log tag.");
  return prepared(`logcat -d -b ${buffer} -t ${lines} ${quote(`${tag ?? "*"}:${priority}`)}${tag ? " '*:S'" : ""}`);
}

function sharedPath(value: unknown): { root: string; parts: string[] } {
  const refused = () => new WirelessServiceError("path_not_allowed", "Choose a path in Android shared storage, under /sdcard or /storage/emulated/<user>, outside Android/data and Android/obb.", 400);
  if (typeof value !== "string" || Buffer.byteLength(value) > 1024 || NONDISPLAY.test(value) || value.includes("\\")) throw refused();
  const match = /^(\/sdcard|\/storage\/emulated\/[0-9]{1,6})(?:\/(.*))?$/.exec(value);
  if (!match) throw refused();
  const parts = match[2]?.split("/") ?? [];
  if (parts.some((part) => !part.trim() || part === "." || part === ".." || Buffer.byteLength(part) > 255)) throw refused();
  if (parts[0]?.toLowerCase() === "android" && /^(data|obb)$/i.test(parts[1] ?? "")) throw refused();
  return { root: match[1], parts };
}

const SCOPE_ERROR = `echo 'The path is missing or is not a direct path in shared storage.' >&2; exit ${NOT_SENT_EXIT}`;

function fenceSharedStorage(root: string): string {
  // /sdcard is Android's own alias. No arbitrary symlink may redirect a file operation outside this mount.
  return `root=$(realpath -- ${quote(root)}) || { ${SCOPE_ERROR}; }; user=\${root#/storage/emulated/}; `
    + `case "$user" in ''|*[!0-9]*) ${SCOPE_ERROR};; esac; [ "$root" = "/storage/emulated/$user" ] || { ${SCOPE_ERROR}; }; `;
}

/** Validate and bind the destination before the service asks for any workspace bytes. */
export function prepareWirelessPush(path: string): (bytes: Uint8Array) => WirelessPreparedCommand {
  const { root, parts } = sharedPath(path);
  if (parts.length === 0) invalid("Choose a single file, not the shared storage folder.");
  const parent = parts.length === 1 ? '"$root"' : `"$root"/${quote(parts.slice(0, -1).join("/"))}`;
  const file = quote(parts[parts.length - 1]);
  const body = fenceSharedStorage(root) + `parent=${parent}; [ "$(realpath -- "$parent")" = "$parent" ] && [ -d "$parent" ] || { ${SCOPE_ERROR}; }; `
    + `file="$parent"/${file}; [ ! -e "$file" ] && [ ! -L "$file" ] || { echo 'That file already exists; nothing was overwritten.' >&2; exit ${NOT_SENT_EXIT}; }; `
    + `umask 077; set -C; cat > "$file" && `;
  return (bytes) => {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > WIRELESS_MAX_FILE_BYTES) invalid("Choose one file no larger than 16 MiB.");
    const input = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return prepared(body + `[ "$(wc -c < "$file")" = ${bytes.byteLength} ]`, true, TRANSFER_MS, MAX_OUTPUT_BYTES, input);
  };
}

function sharedFile(kind: "list" | "stat" | "pull", path: unknown): WirelessPreparedCommand {
  const { root, parts } = sharedPath(path);
  if (kind === "pull" && parts.length === 0) invalid("Choose a single file, not the shared storage folder.");
  const file = parts.length ? `"$root"/${quote(parts.join("/"))}` : '"$root"';
  const checked = fenceSharedStorage(root) + `file=${file}; [ "$(realpath -- "$file")" = "$file" ] || { ${SCOPE_ERROR}; }; `;
  if (kind === "list") return prepared(checked + 'ls -la -- "$file"');
  if (kind === "stat") return prepared(checked + 'stat -c "%F %s %n" -- "$file"');
  return prepared(checked + `[ -f "$file" ] && [ "$(stat -c %s -- "$file")" -le ${WIRELESS_MAX_FILE_BYTES} ] || { echo 'Pull requires a regular file no larger than 16 MiB.' >&2; exit ${NOT_SENT_EXIT}; }; cat -- "$file"`, false, TRANSFER_MS, WIRELESS_MAX_FILE_BYTES);
}

export function prepareWirelessPull(path: string): WirelessPreparedCommand {
  return sharedFile("pull", path);
}

/** Runtime validation is deliberate: tool arguments are data, not trusted TypeScript. */
export function prepareWirelessOperation(value: unknown): WirelessPreparedCommand {
  if (!isRecord(value)) invalid("Choose a supported Android operation.");
  switch (value.kind) {
    case "inspect": return inspect(value.query, value.filter);
    case "logcat": return logcat(value);
    case "list": case "stat": return sharedFile(value.kind, value.path);
    default: return invalid("Choose a supported Android operation. Arbitrary commands need the person’s approval.");
  }
}
