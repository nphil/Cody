/**
 * The server's copy of device artifacts: a folder per save, every file's
 * SHA-256 re-checked from disk, and a manifest an agent or a NAS can trust.
 *
 * The bytes live in the person's browser (IndexedDB), so a save is an UPLOAD the
 * page makes, a slice at a time (see ./artifact-upload.ts). This module is the
 * receiving end, and it never trusts the sender:
 *
 *  - A save is announced first, with every file's name, size and SHA-256, and is
 *    written under `.incoming/<saveId>/` where nothing else looks. A file is
 *    appended in order (`offset` must equal what is already stored, so a retry
 *    can never duplicate or skip bytes) and a restart or a dropped connection
 *    carries on from the stored length.
 *  - Each finished file is read back FROM DISK and hashed (not the bytes that
 *    went by): a mismatch deletes that file's partial copy and says which file.
 *  - Only when every file has verified does the folder get its `manifest.json`
 *    and `SHA256SUMS` and move, in one rename, to `<root>/<date>-<label>/`, so
 *    a reader of the root sees finished saves and nothing half-written.
 *
 * Everything it creates is owner-only (directories 0700, files 0600). A name the
 * sender chose never reaches the filesystem as a path: file names are reduced to
 * one safe segment, the folder is built here, and ids are generated here.
 */

import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { getDiskSpace } from "../disk-space";
import { readEnv } from "../env";
import { getAgentDir } from "../omp/paths";
import { isRecord } from "../type-guards";
import { labelSlug, MANIFEST_NAME, SUMS_NAME, uniqueFileNames } from "./artifact-names";

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

export interface VaultLimits {
  /** One chunk request. Kept under the 10 MB the framework buffers a request body to once a proxy is in front of a route. */
  readonly maxChunkBytes: number;
  readonly maxFileBytes: number;
  readonly maxSaveBytes: number;
  readonly maxFiles: number;
  /** What every finished and unfinished save may hold together; 0 is no cap. */
  readonly maxVaultBytes: number;
  /** Free space that must remain after a save. */
  readonly minFreeBytes: number;
  /** An unfinished save nobody touched for this long is deleted. */
  readonly incomingTtlMs: number;
}

export const DEFAULT_VAULT_LIMITS: VaultLimits = {
  maxChunkBytes: 8 * MiB,
  maxFileBytes: 32 * GiB,
  maxSaveBytes: 64 * GiB,
  maxFiles: 4096,
  maxVaultBytes: 256 * GiB,
  minFreeBytes: GiB,
  incomingTtlMs: 7 * 24 * 60 * 60 * 1000,
};

export interface VaultConfig {
  readonly root: string;
  readonly limits: VaultLimits;
}

/**
 * Where saves go and how much they may take. `CODY_DEVICE_ARTIFACTS_DIR` moves the root (default: `cody-device-artifacts`
 * in Cody's data directory, next to its other state, so it is on the volume a deployment already keeps) and
 * `CODY_DEVICE_ARTIFACTS_MAX_GB` caps the whole vault (default 256, 0 for no cap).
 */
export function vaultConfig(env: NodeJS.ProcessEnv = process.env): VaultConfig {
  const configured = readEnv("DEVICE_ARTIFACTS_DIR", env)?.trim();
  const cap = readEnv("DEVICE_ARTIFACTS_MAX_GB", env)?.trim();
  const capGiB = cap !== undefined && /^\d+(?:\.\d+)?$/.test(cap) ? Number(cap) : undefined;
  return {
    root: configured ? path.resolve(configured) : path.join(getAgentDir(), "cody-device-artifacts"),
    limits: capGiB === undefined ? DEFAULT_VAULT_LIMITS : { ...DEFAULT_VAULT_LIMITS, maxVaultBytes: Math.floor(capGiB * GiB) },
  };
}

/** Always a plain-English message, a stable code, and the HTTP status a route answers with. */
export class VaultError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "VaultError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface SaveActor {
  /** The account id; null on an open instance (no accounts). */
  readonly owner: string | null;
  readonly ownerName?: string;
}

export interface SaveFileInput {
  readonly name: string;
  readonly size: number;
  readonly sha256: string;
  readonly kind: string;
  readonly source: string;
  readonly createdAt: number;
  readonly artifactId?: string;
  readonly operation?: { id: string; deviceId: string; deviceLabel?: string; protocol: string; action: string; target?: string; command?: string };
}

export interface SaveRequest {
  readonly sessionId: string;
  readonly label: string;
  readonly key?: string;
  readonly timeZone?: string;
  readonly files: readonly SaveFileInput[];
}

export interface SaveFileStatus {
  readonly index: number;
  /** The name the browser file had. */
  readonly name: string;
  /** The file's name in the save's folder. */
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
  readonly received: number;
  readonly verified: boolean;
}

export interface SaveStatus {
  readonly saveId: string;
  readonly state: "uploading" | "complete";
  readonly label: string;
  readonly sessionId: string;
  readonly owner: string | null;
  /** The folder the save is in, or will be in once it completes. */
  readonly folder: string;
  readonly manifestPath?: string;
  readonly sums?: string;
  readonly files: readonly SaveFileStatus[];
  readonly totalBytes: number;
  readonly receivedBytes: number;
  readonly createdAt: number;
  readonly completedAt?: number;
  /** Every file was re-read from disk and matched its SHA-256. */
  readonly verified: boolean;
  readonly manifestSha256?: string;
  /** A begin that found the same save already complete answers with it instead of asking for the bytes again. */
  readonly existing?: boolean;
  /** A begin that found an unfinished save to carry on with. */
  readonly resumed?: boolean;
}

interface StoredFile extends SaveFileInput {
  readonly fileName: string;
  verified?: boolean;
}

interface StoredSave {
  readonly version: 1;
  readonly saveId: string;
  readonly key?: string;
  readonly owner: string | null;
  readonly ownerName?: string;
  readonly sessionId: string;
  readonly label: string;
  readonly folderName: string;
  readonly createdAt: number;
  readonly files: StoredFile[];
}

interface Manifest {
  readonly format: "cody-device-artifacts/1";
  readonly saveId: string;
  readonly key?: string;
  readonly label: string;
  readonly sessionId: string;
  readonly owner: { readonly id: string | null; readonly name?: string };
  readonly createdAt: string;
  readonly completedAt: string;
  readonly totalBytes: number;
  readonly verified: true;
  readonly files: readonly {
    readonly name: string;
    readonly path: string;
    readonly size: number;
    readonly sha256: string;
    readonly kind: string;
    readonly source: string;
    readonly createdAt: string;
    readonly artifactId?: string;
    readonly operation?: SaveFileInput["operation"];
  }[];
}

const INCOMING = ".incoming";
const STATE_NAME = "state.json";
const SAVE_ID = /^[a-f0-9]{32}$/;
const SHA256 = /^[a-f0-9]{64}$/i;
const KEY = /^[a-f0-9]{16,64}$/;
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;

/** The date in the person's own time zone (the browser says which), so a save at 23:30 is dated the day they made it. */
function dateIn(timeZone: string | undefined, now: number): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: timeZone || "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
    const pick = (type: string): string | undefined => parts.find((part) => part.type === type)?.value;
    if (pick("year") && pick("month") && pick("day")) return `${pick("year")}-${pick("month")}-${pick("day")}`;
  } catch {
    // An unknown zone falls back to UTC below.
  }
  return new Date(now).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------------------------------------------------
// Files and locks
// ---------------------------------------------------------------------------------------------------------------------

function locks(): Map<string, Promise<unknown>> {
  const scope = globalThis as typeof globalThis & { __codyVaultLocks?: Map<string, Promise<unknown>> };
  return (scope.__codyVaultLocks ??= new Map());
}

/** One writer at a time per key, whatever order the requests arrive in; the next waits for the last, failed or not. */
async function withLock<T>(key: string, work: () => Promise<T>): Promise<T> {
  const registry = locks();
  const previous = registry.get(key) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(work);
  const tail = run.catch(() => undefined);
  registry.set(key, tail);
  try {
    return await run;
  } finally {
    if (registry.get(key) === tail) registry.delete(key);
  }
}

async function exists(file: string): Promise<boolean> {
  return fsp.access(file).then(() => true, () => false);
}

async function ensureRoot(config: VaultConfig): Promise<string> {
  const rootExisted = await exists(config.root);
  await fsp.mkdir(path.join(config.root, INCOMING), { recursive: true, mode: DIRECTORY_MODE });
  // Only a root this call made is narrowed: a folder the owner prepared keeps the permissions they gave it.
  if (!rootExisted) await fsp.chmod(config.root, DIRECTORY_MODE).catch(() => undefined);
  await fsp.chmod(path.join(config.root, INCOMING), DIRECTORY_MODE).catch(() => undefined);
  return path.join(config.root, INCOMING);
}

async function writeJson(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${randomUUID().slice(0, 8)}.tmp`;
  const handle = await fsp.open(temporary, "w", FILE_MODE);
  try {
    await handle.writeFile(JSON.stringify(value, null, 2) + "\n");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.rename(temporary, file);
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await fsp.readFile(file, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

async function sizeOf(file: string): Promise<number> {
  return fsp.stat(file).then((stat) => stat.size, () => 0);
}

async function hashFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file, { highWaterMark: MiB })) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function syncFile(file: string): Promise<void> {
  const handle = await fsp.open(file, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function incomingDirectory(config: VaultConfig, saveId: string): string {
  if (!SAVE_ID.test(saveId)) throw new VaultError(404, "unknown_save", "That save does not exist.");
  return path.join(config.root, INCOMING, saveId);
}

// ---------------------------------------------------------------------------------------------------------------------
// Reading what is stored
// ---------------------------------------------------------------------------------------------------------------------

function parseStored(raw: unknown): StoredSave | undefined {
  if (!isRecord(raw) || raw.version !== 1 || typeof raw.saveId !== "string" || !SAVE_ID.test(raw.saveId) || !Array.isArray(raw.files)) return undefined;
  return raw as unknown as StoredSave;
}

async function readIncoming(config: VaultConfig, saveId: string): Promise<StoredSave | undefined> {
  return parseStored(await readJson(path.join(incomingDirectory(config, saveId), STATE_NAME)));
}

function parseManifest(raw: unknown): Manifest | undefined {
  if (!isRecord(raw) || raw.format !== "cody-device-artifacts/1" || typeof raw.saveId !== "string" || !Array.isArray(raw.files)) return undefined;
  return raw as unknown as Manifest;
}

interface Finished {
  readonly folder: string;
  readonly manifest: Manifest;
}

async function finishedSaves(config: VaultConfig): Promise<Finished[]> {
  const entries = await fsp.readdir(config.root, { withFileTypes: true }).catch(() => []);
  const found: Finished[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const folder = path.join(config.root, entry.name);
    const manifest = parseManifest(await readJson(path.join(folder, MANIFEST_NAME)));
    if (manifest) found.push({ folder, manifest });
  }
  return found;
}

async function incomingSaves(config: VaultConfig): Promise<StoredSave[]> {
  const entries = await fsp.readdir(path.join(config.root, INCOMING), { withFileTypes: true }).catch(() => []);
  const found: StoredSave[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !SAVE_ID.test(entry.name)) continue;
    const stored = await readIncoming(config, entry.name);
    if (stored) found.push(stored);
  }
  return found;
}

async function statusOfIncoming(config: VaultConfig, stored: StoredSave): Promise<SaveStatus> {
  const directory = incomingDirectory(config, stored.saveId);
  const files: SaveFileStatus[] = [];
  for (const [index, file] of stored.files.entries()) {
    files.push({
      index,
      name: file.name,
      path: file.fileName,
      size: file.size,
      sha256: file.sha256,
      received: file.verified ? file.size : Math.min(await sizeOf(path.join(directory, `${index}.part`)), file.size),
      verified: file.verified === true,
    });
  }
  return {
    saveId: stored.saveId,
    state: "uploading",
    label: stored.label,
    sessionId: stored.sessionId,
    owner: stored.owner,
    folder: path.join(config.root, stored.folderName),
    files,
    totalBytes: files.reduce((total, file) => total + file.size, 0),
    receivedBytes: files.reduce((total, file) => total + file.received, 0),
    createdAt: stored.createdAt,
    verified: false,
  };
}

function statusOfFinished({ folder, manifest }: Finished, manifestSha256?: string): SaveStatus {
  return {
    saveId: manifest.saveId,
    state: "complete",
    label: manifest.label,
    sessionId: manifest.sessionId,
    owner: manifest.owner.id,
    folder,
    manifestPath: path.join(folder, MANIFEST_NAME),
    sums: path.join(folder, SUMS_NAME),
    files: manifest.files.map((file, index) => ({ index, name: file.name, path: file.path, size: file.size, sha256: file.sha256, received: file.size, verified: true })),
    totalBytes: manifest.totalBytes,
    receivedBytes: manifest.totalBytes,
    createdAt: Date.parse(manifest.createdAt),
    completedAt: Date.parse(manifest.completedAt),
    verified: true,
    ...(manifestSha256 ? { manifestSha256 } : {}),
  };
}

/** The save with this id, finished or not, or undefined. */
export async function saveStatus(config: VaultConfig, saveId: string): Promise<SaveStatus | undefined> {
  if (!SAVE_ID.test(saveId)) return undefined;
  const stored = await readIncoming(config, saveId);
  if (stored) return statusOfIncoming(config, stored);
  const finished = (await finishedSaves(config)).find((entry) => entry.manifest.saveId === saveId);
  return finished ? statusOfFinished(finished, await hashFile(path.join(finished.folder, MANIFEST_NAME)).catch(() => undefined)) : undefined;
}

/** Who a save belongs to and which chat it is for: all an access check needs, without counting its files. */
export async function saveOwnership(config: VaultConfig, saveId: string): Promise<{ owner: string | null; sessionId: string } | undefined> {
  if (!SAVE_ID.test(saveId)) return undefined;
  const stored = await readIncoming(config, saveId);
  if (stored) return { owner: stored.owner, sessionId: stored.sessionId };
  const done = (await finishedSaves(config)).find((entry) => entry.manifest.saveId === saveId);
  return done ? { owner: done.manifest.owner.id, sessionId: done.manifest.sessionId } : undefined;
}

export interface SaveListFilter {
  readonly sessionId?: string;
  /** Include unfinished saves. */
  readonly unfinished?: boolean;
}

/** Saves, newest first, for a caller that may see `accept`ed ones. */
export async function listSaves(config: VaultConfig, filter: SaveListFilter, accept: (save: { owner: string | null; sessionId: string }) => boolean): Promise<SaveStatus[]> {
  const found: SaveStatus[] = [];
  for (const entry of await finishedSaves(config)) {
    const owner = entry.manifest.owner.id;
    if (filter.sessionId !== undefined && entry.manifest.sessionId !== filter.sessionId) continue;
    if (accept({ owner, sessionId: entry.manifest.sessionId })) found.push(statusOfFinished(entry));
  }
  if (filter.unfinished) {
    for (const stored of await incomingSaves(config)) {
      if (filter.sessionId !== undefined && stored.sessionId !== filter.sessionId) continue;
      if (accept({ owner: stored.owner, sessionId: stored.sessionId })) found.push(await statusOfIncoming(config, stored));
    }
  }
  return found.sort((left, right) => (right.completedAt ?? right.createdAt) - (left.completedAt ?? left.createdAt));
}

// ---------------------------------------------------------------------------------------------------------------------
// Beginning a save
// ---------------------------------------------------------------------------------------------------------------------

function text(value: unknown, limit: number): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, limit) : undefined;
}

function cleanOperation(value: unknown): SaveFileInput["operation"] | undefined {
  if (!isRecord(value)) return undefined;
  const id = text(value.id, 200);
  const deviceId = text(value.deviceId, 200);
  const protocol = text(value.protocol, 64);
  const action = text(value.action, 64);
  if (!id || !deviceId || !protocol || !action) return undefined;
  const deviceLabel = text(value.deviceLabel, 200);
  const target = text(value.target, 200);
  const command = text(value.command, 200);
  return { id, deviceId, protocol, action, ...(deviceLabel ? { deviceLabel } : {}), ...(target ? { target } : {}), ...(command ? { command } : {}) };
}

/** A begin request, checked against the limits. The message names the first thing wrong. */
export function parseSaveRequest(raw: unknown, limits: VaultLimits, now: number): SaveRequest {
  const refuse = (message: string, code = "invalid_request", status = 400): never => {
    throw new VaultError(status, code, message);
  };
  if (!isRecord(raw)) return refuse("The save request is not a JSON object.");
  const sessionId = text(raw.sessionId, 256);
  if (!sessionId) return refuse("A save names the chat session its files belong to.");
  if (!Array.isArray(raw.files) || raw.files.length === 0) return refuse("There are no files to save.");
  if (raw.files.length > limits.maxFiles) return refuse(`A save holds at most ${limits.maxFiles} files; this one has ${raw.files.length}.`, "too_many_files", 413);
  if (raw.key !== undefined && (typeof raw.key !== "string" || !KEY.test(raw.key))) return refuse("The save key must be 16 to 64 lowercase hexadecimal characters.");
  const timeZone = text(raw.timeZone, 64);
  const files: SaveFileInput[] = [];
  let total = 0;
  for (const [index, item] of raw.files.entries()) {
    if (!isRecord(item)) return refuse(`File ${index + 1} is not an object.`);
    const name = text(item.name, 512);
    if (!name) return refuse(`File ${index + 1} has no name.`);
    const size = item.size;
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) return refuse(`"${name}" has no valid size.`);
    if (size > limits.maxFileBytes) return refuse(`"${name}" is ${size} bytes; one file may be at most ${limits.maxFileBytes} bytes.`, "too_large", 413);
    if (typeof item.sha256 !== "string" || !SHA256.test(item.sha256)) return refuse(`"${name}" has no valid SHA-256.`);
    total += size;
    const operation = cleanOperation(item.operation);
    const artifactId = text(item.artifactId, 100);
    const created = typeof item.createdAt === "number" && Number.isFinite(item.createdAt) ? item.createdAt : now;
    files.push({
      name,
      size,
      sha256: item.sha256.toLowerCase(),
      kind: text(item.kind, 16) ?? "output",
      source: text(item.source, 32) ?? "device",
      createdAt: created,
      ...(artifactId ? { artifactId } : {}),
      ...(operation ? { operation } : {}),
    });
  }
  if (total > limits.maxSaveBytes) return refuse(`These files total ${total} bytes; one save may hold at most ${limits.maxSaveBytes} bytes. Save them in smaller groups.`, "too_large", 413);
  return { sessionId, label: text(raw.label, 120) ?? "artifacts", ...(raw.key === undefined ? {} : { key: raw.key as string }), ...(timeZone ? { timeZone } : {}), files };
}

async function sweepStale(config: VaultConfig, now: number): Promise<void> {
  const entries = await fsp.readdir(path.join(config.root, INCOMING), { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || !SAVE_ID.test(entry.name)) continue;
    const directory = path.join(config.root, INCOMING, entry.name);
    const touched = await fsp.readdir(directory).then(async (names) => {
      let latest = 0;
      for (const name of names) latest = Math.max(latest, await fsp.stat(path.join(directory, name)).then((stat) => stat.mtimeMs, () => 0));
      return latest;
    }, () => 0);
    if (now - touched > config.limits.incomingTtlMs) await fsp.rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function takenNames(config: VaultConfig): Promise<Set<string>> {
  const taken = new Set<string>();
  for (const entry of await fsp.readdir(config.root, { withFileTypes: true }).catch(() => [])) taken.add(entry.name.toLowerCase());
  for (const stored of await incomingSaves(config)) taken.add(stored.folderName.toLowerCase());
  return taken;
}

function describeBytes(bytes: number): string {
  if (bytes >= GiB) return `${(bytes / GiB).toFixed(1)} GB`;
  if (bytes >= MiB) return `${(bytes / MiB).toFixed(1)} MB`;
  return `${bytes} bytes`;
}

/**
 * Starts a save, or finds the one this is: the same `key` from the same account either has a finished save (answered as
 * `existing`, nothing to upload) or an unfinished one (answered with what is already stored, so the upload carries on).
 */
export async function beginSave(config: VaultConfig, actor: SaveActor, raw: unknown, now = Date.now()): Promise<SaveStatus> {
  const request = parseSaveRequest(raw, config.limits, now);
  await ensureRoot(config);
  await sweepStale(config, now);

  const finished = await finishedSaves(config);
  const unfinished = await incomingSaves(config);
  if (request.key) {
    const done = finished.find((entry) => entry.manifest.key === request.key && entry.manifest.owner.id === actor.owner && entry.manifest.sessionId === request.sessionId);
    if (done) return { ...statusOfFinished(done), existing: true };
    const open = unfinished.find((stored) => stored.key === request.key && stored.owner === actor.owner && stored.sessionId === request.sessionId);
    if (open) {
      const status = await statusOfIncoming(config, open);
      return { ...status, resumed: status.receivedBytes > 0 };
    }
  }

  const total = request.files.reduce((sum, file) => sum + file.size, 0);
  let held = 0;
  for (const entry of finished) held += entry.manifest.totalBytes;
  for (const stored of unfinished) held += stored.files.reduce((sum, file) => sum + file.size, 0);
  if (config.limits.maxVaultBytes > 0 && held + total > config.limits.maxVaultBytes) {
    throw new VaultError(507, "quota_exceeded", `The server's artifact folder holds ${describeBytes(held)} and is limited to ${describeBytes(config.limits.maxVaultBytes)}, so ${describeBytes(total)} more does not fit. Delete an older save first.`);
  }
  const space = getDiskSpace(config.root);
  if (space && space.availableBytes < total + config.limits.minFreeBytes) {
    throw new VaultError(507, "disk_full", `The server has ${describeBytes(space.availableBytes)} free and this save needs ${describeBytes(total)} plus ${describeBytes(config.limits.minFreeBytes)} to spare. Free some space or save fewer files.`);
  }

  const saveId = randomUUID().replaceAll("-", "");
  const taken = await takenNames(config);
  const base = `${dateIn(request.timeZone, now)}-${labelSlug(request.label)}`;
  let folderName = base;
  for (let counter = 2; taken.has(folderName.toLowerCase()); counter += 1) folderName = `${base}-${counter}`;
  const names = uniqueFileNames(request.files.map((file) => file.name));
  const stored: StoredSave = {
    version: 1,
    saveId,
    ...(request.key ? { key: request.key } : {}),
    owner: actor.owner,
    ...(actor.ownerName ? { ownerName: actor.ownerName } : {}),
    sessionId: request.sessionId,
    label: request.label,
    folderName,
    createdAt: now,
    files: request.files.map((file, index) => ({ ...file, fileName: names[index]! })),
  };
  const directory = incomingDirectory(config, saveId);
  await fsp.mkdir(directory, { mode: DIRECTORY_MODE });
  await writeJson(path.join(directory, STATE_NAME), stored);
  return statusOfIncoming(config, stored);
}

// ---------------------------------------------------------------------------------------------------------------------
// Receiving
// ---------------------------------------------------------------------------------------------------------------------

async function requireIncoming(config: VaultConfig, saveId: string): Promise<StoredSave> {
  const stored = await readIncoming(config, saveId);
  if (stored) return stored;
  const finished = (await finishedSaves(config)).some((entry) => entry.manifest.saveId === saveId);
  if (finished) throw new VaultError(409, "already_complete", "This save is already complete.");
  throw new VaultError(404, "unknown_save", "That save does not exist, or it was cleaned up after sitting unfinished.");
}

function fileAt(stored: StoredSave, index: number): StoredFile {
  const file = stored.files[index];
  if (!Number.isInteger(index) || !file) throw new VaultError(404, "unknown_file", `This save has no file number ${index}.`);
  return file;
}

/**
 * Appends one slice of a file. `offset` must be exactly what is already stored: a slice that arrives twice, late or
 * out of order is refused with the stored length (`received`), which is all the sender needs to carry on correctly.
 */
export async function appendChunk(config: VaultConfig, saveId: string, index: number, offset: number, bytes: Uint8Array): Promise<{ received: number }> {
  if (bytes.byteLength > config.limits.maxChunkBytes) throw new VaultError(413, "chunk_too_large", `One slice may be at most ${config.limits.maxChunkBytes} bytes.`);
  return withLock(saveId, async () => {
    const stored = await requireIncoming(config, saveId);
    const file = fileAt(stored, index);
    if (file.verified) throw new VaultError(409, "already_verified", `"${file.name}" is already stored and verified.`, { received: file.size });
    const part = path.join(incomingDirectory(config, saveId), `${index}.part`);
    const received = await sizeOf(part);
    if (offset !== received) throw new VaultError(409, "offset_mismatch", `"${file.name}" has ${received} bytes stored, not ${offset}.`, { received });
    if (received + bytes.byteLength > file.size) throw new VaultError(400, "too_long", `That slice runs past the end of "${file.name}" (${file.size} bytes).`, { received });
    const handle = await fsp.open(part, "a", FILE_MODE);
    try {
      await handle.write(bytes);
    } finally {
      await handle.close();
    }
    return { received: received + bytes.byteLength };
  });
}

/**
 * Reads a finished file back from disk and hashes it. The hash is of what is on the disk now, not of what went by, which
 * is what makes "verified" mean something. A mismatch deletes the partial copy so the file can be sent again.
 */
export async function verifyFile(config: VaultConfig, saveId: string, index: number): Promise<{ sha256: string }> {
  return withLock(saveId, async () => {
    const directory = incomingDirectory(config, saveId);
    const stored = await requireIncoming(config, saveId);
    const file = fileAt(stored, index);
    if (file.verified) return { sha256: file.sha256 };
    const part = path.join(directory, `${index}.part`);
    // A file with no bytes is never sent a slice, so there is no partial copy until now.
    if (file.size === 0 && !(await exists(part))) await fsp.writeFile(part, "", { mode: FILE_MODE });
    const received = await sizeOf(part);
    if (received !== file.size) throw new VaultError(409, "incomplete", `"${file.name}" has ${received} of ${file.size} bytes stored.`, { received });
    if (file.size > 0) await syncFile(part);
    const actual = await hashFile(part);
    if (actual !== file.sha256) {
      await fsp.rm(part, { force: true });
      throw new VaultError(422, "hash_mismatch", `"${file.name}" arrived damaged: the copy on the server hashes to ${actual} but it should be ${file.sha256}. The partial copy was deleted; send it again.`, { index, expected: file.sha256, actual });
    }
    file.verified = true;
    await writeJson(path.join(directory, STATE_NAME), stored);
    return { sha256: actual };
  });
}

/**
 * Finishes the save: every file must be stored in full and verified, then the manifest and `SHA256SUMS` are written and
 * the folder takes its final name in one rename. Calling it again after it succeeded returns the same result.
 */
export async function completeSave(config: VaultConfig, saveId: string, now = Date.now()): Promise<SaveStatus> {
  return withLock(saveId, async () => {
    const stored = await readIncoming(config, saveId);
    if (!stored) {
      const done = (await finishedSaves(config)).find((entry) => entry.manifest.saveId === saveId);
      if (done) return statusOfFinished(done, await hashFile(path.join(done.folder, MANIFEST_NAME)).catch(() => undefined));
      throw new VaultError(404, "unknown_save", "That save does not exist, or it was cleaned up after sitting unfinished.");
    }
    const directory = incomingDirectory(config, saveId);
    const missing: { index: number; name: string; received: number; size: number }[] = [];
    for (const [index, file] of stored.files.entries()) {
      const received = file.verified ? file.size : await sizeOf(path.join(directory, `${index}.part`));
      if (!file.verified || received !== file.size) missing.push({ index, name: file.name, received, size: file.size });
    }
    if (missing.length > 0) {
      const first = missing[0]!;
      throw new VaultError(409, "incomplete", `${missing.length} of ${stored.files.length} files are not stored and verified yet, starting with "${first.name}" (${first.received} of ${first.size} bytes).`, { missing: missing.slice(0, 50) });
    }

    // Safe to repeat after an interruption: a file already renamed to its final name is left where it is.
    for (const [index, file] of stored.files.entries()) {
      const part = path.join(directory, `${index}.part`);
      const target = path.join(directory, file.fileName);
      if (await exists(part)) {
        if (await sizeOf(part) !== file.size) throw new VaultError(409, "changed", `"${file.name}" changed on the server after it was verified. Save again.`);
        await fsp.rename(part, target);
      } else if (await sizeOf(target) !== file.size || !(await exists(target))) {
        throw new VaultError(409, "changed", `"${file.name}" is missing on the server after it was verified. Save again.`);
      }
      await fsp.chmod(target, FILE_MODE).catch(() => undefined);
    }
    const manifest: Manifest = {
      format: "cody-device-artifacts/1",
      saveId,
      ...(stored.key ? { key: stored.key } : {}),
      label: stored.label,
      sessionId: stored.sessionId,
      owner: { id: stored.owner, ...(stored.ownerName ? { name: stored.ownerName } : {}) },
      createdAt: new Date(stored.createdAt).toISOString(),
      completedAt: new Date(now).toISOString(),
      totalBytes: stored.files.reduce((sum, file) => sum + file.size, 0),
      verified: true,
      files: stored.files.map((file) => ({
        name: file.name,
        path: file.fileName,
        size: file.size,
        sha256: file.sha256,
        kind: file.kind,
        source: file.source,
        createdAt: new Date(file.createdAt).toISOString(),
        ...(file.artifactId ? { artifactId: file.artifactId } : {}),
        ...(file.operation ? { operation: file.operation } : {}),
      })),
    };
    await writeJson(path.join(directory, MANIFEST_NAME), manifest);
    const manifestSha256 = await hashFile(path.join(directory, MANIFEST_NAME));
    const sums = [...stored.files.map((file) => `${file.sha256}  ${file.fileName}\n`), `${manifestSha256}  ${MANIFEST_NAME}\n`].join("");
    const sumsHandle = await fsp.open(path.join(directory, SUMS_NAME), "w", FILE_MODE);
    try {
      await sumsHandle.writeFile(sums);
      await sumsHandle.sync();
    } finally {
      await sumsHandle.close();
    }

    // The name was reserved when the save began; it is only taken again if something else has since used it. The
    // state file goes last, after the rename: a crash before it leaves a save the next call finishes the same way.
    return withLock(`${config.root}\u0000finalize`, async () => {
      const taken = await takenNames(config);
      taken.delete(stored.folderName.toLowerCase());
      let folderName = stored.folderName;
      for (let counter = 2; taken.has(folderName.toLowerCase()) || await exists(path.join(config.root, folderName)); counter += 1) folderName = `${stored.folderName}-${counter}`;
      const folder = path.join(config.root, folderName);
      await fsp.rename(directory, folder);
      await fsp.rm(path.join(folder, STATE_NAME), { force: true });
      return statusOfFinished({ folder, manifest }, manifestSha256);
    });
  });
}

/**
 * Deletes an unfinished save, or a finished one by its id: the folder is found by the id in its own manifest and must be
 * a direct child of the root, never by a path the caller supplied.
 */
export async function removeSave(config: VaultConfig, saveId: string): Promise<boolean> {
  if (!SAVE_ID.test(saveId)) return false;
  return withLock(saveId, async () => {
    const directory = incomingDirectory(config, saveId);
    if (await exists(directory)) {
      await fsp.rm(directory, { recursive: true, force: true });
      return true;
    }
    const done = (await finishedSaves(config)).find((entry) => entry.manifest.saveId === saveId);
    if (!done || path.dirname(done.folder) !== config.root) return false;
    await fsp.rm(done.folder, { recursive: true, force: true });
    return true;
  });
}
