/**
 * The server's copy of device artifacts: ONE compressed, verified archive per save.
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
 *  - Only when every file has verified is the archive built: the verified files
 *    are packed with the shared writer (./artifact-archive.ts) into
 *    `.incoming/<saveId>/.archive.part`, which an independent reader
 *    (./artifact-archive-verify.ts) then re-reads from disk, checking every file's
 *    SHA-256 and CRC-32. Only then does it move, in one rename, to
 *    `<root>/<label>-<date>.zip` and the raw files are deleted. A reader of the root
 *    sees finished archives and nothing half-written, and the vault holds one
 *    file per save.
 *
 * The archive carries its own `manifest.json`, which is how a finished save is
 * recognised, listed and owned: nothing else is kept about it. Anything else in
 * the root (a person's own files, folders saved by version 0.53.0) is ignored.
 *
 * Packing a multi-gigabyte save takes minutes, so `completeSave` starts a build in
 * the background, waits a short while and then answers `building`; the page asks
 * again until it is `complete`. A build that fails leaves the save as it was, with
 * every file still verified and the reason in `buildError`: nothing is uploaded
 * again, and completing again retries.
 *
 * Everything it creates is owner-only (directories 0700, files 0600). A name the
 * sender chose never reaches the filesystem as a path: file names are reduced to
 * one safe segment, the archive's name is built here, and ids are generated here.
 */

import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import * as fsp from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import * as path from "node:path";
import { Readable } from "node:stream";
import { describeDiskError, getDiskSpace } from "../disk-space";
import { readEnv } from "../env";
import { getAgentDir } from "../omp/paths";
import { isRecord } from "../type-guards";
import { ArchiveError, buildArchiveManifest, MANIFEST_FORMAT, metadataSources, writeArchive, type ArchiveSource, type ManifestFile, type ManifestOperation } from "./artifact-archive";
import { ArchiveCheckError, readArchiveManifest, verifyArchiveFile, type ExpectedArchive } from "./artifact-archive-verify";
import type { BackupScope } from "./artifact-model";
import { isVaultInternalName, labelSlug, partName, STATE_NAME, uniqueFileNames } from "./artifact-names";

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

export interface VaultLimits {
  /** One chunk request. Kept under the 10 MB the framework buffers a request body to once a proxy is in front of a route. */
  readonly maxChunkBytes: number;
  readonly maxFileBytes: number;
  readonly maxSaveBytes: number;
  readonly maxFiles: number;
  /** What every finished archive and every unfinished save's archive-to-be (its files plus a packing allowance) may hold together; 0 is no cap. */
  readonly maxVaultBytes: number;
  /** Free space that must remain on the disk at every point of a save: while the files arrive, and while the archive is written beside them. */
  readonly minFreeBytes: number;
  /** An unfinished save nobody touched for this long is deleted. */
  readonly incomingTtlMs: number;
  /** How long a `complete` call waits for the archive to be built before it answers `building` and the page asks again. */
  readonly completeWaitMs: number;
}

export const DEFAULT_VAULT_LIMITS: VaultLimits = {
  maxChunkBytes: 8 * MiB,
  maxFileBytes: 32 * GiB,
  maxSaveBytes: 64 * GiB,
  maxFiles: 4096,
  maxVaultBytes: 256 * GiB,
  minFreeBytes: GiB,
  incomingTtlMs: 7 * 24 * 60 * 60 * 1000,
  completeWaitMs: 20_000,
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
  readonly operation?: ManifestOperation;
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
  /** The file's full path inside the archive: `<folder>/<name>`. */
  readonly entry: string;
  readonly size: number;
  readonly sha256: string;
  readonly received: number;
  readonly verified: boolean;
}

/** Why the last attempt to write the archive stopped. The files are still on the server, verified. */
export interface SaveBuildError {
  /** `disk_full`, `quota_exceeded`, `archive_check_failed`, `changed` or `build_failed`. */
  readonly code: string;
  readonly message: string;
}

export interface SaveStatus {
  readonly saveId: string;
  /** `uploading`: files are still arriving, or are all here and the archive is not being built (yet, or any more). `building`: the archive is being written. */
  readonly state: "uploading" | "building" | "complete";
  readonly label: string;
  readonly sessionId: string;
  readonly owner: string | null;
  /** The one .zip the save is, or will be once it completes. */
  readonly archive: string;
  /** What the finished archive is on the disk. */
  readonly archiveBytes?: number;
  /** While building: the original bytes packed so far. */
  readonly packedBytes?: number;
  readonly files: readonly SaveFileStatus[];
  /** The files before packing. */
  readonly totalBytes: number;
  readonly receivedBytes: number;
  readonly createdAt: number;
  readonly completedAt?: number;
  /** The server re-read the finished archive from disk and every file in it matched its SHA-256 and CRC-32. */
  readonly verified: boolean;
  /** A begin that found the same save already complete answers with it instead of asking for the bytes again. */
  readonly existing?: boolean;
  /** A begin that found an unfinished save to carry on with. */
  readonly resumed?: boolean;
  readonly buildError?: SaveBuildError;
}

/** Options of the one call that starts a build. HTTP never passes them: they exist so a test can prove ZIP64 end to end on a small save. */
export interface CompleteOptions {
  readonly forceZip64?: boolean;
}

interface StoredFile extends SaveFileInput {
  readonly fileName: string;
  verified?: boolean;
}

interface StoredSave {
  readonly version: 2;
  readonly saveId: string;
  readonly key?: string;
  readonly owner: string | null;
  readonly ownerName?: string;
  readonly sessionId: string;
  readonly label: string;
  /** The archive's planned file name, e.g. `Lenovo-EDL-backup-2026-10-06.zip`; its folder is this without `.zip`. */
  readonly archiveName: string;
  readonly createdAt: number;
  readonly files: StoredFile[];
}

/** What `manifest.json` inside a finished archive says (the fields this module reads; the writer adds more). */
interface ArchiveManifest {
  readonly format: typeof MANIFEST_FORMAT;
  readonly saveId: string;
  readonly key?: string;
  readonly label: string;
  readonly sessionId: string;
  readonly owner: { readonly id: string | null; readonly name?: string };
  readonly createdAt: string;
  readonly completedAt: string;
  readonly totalBytes: number;
  readonly verified: true;
  readonly files: readonly { readonly name: string; readonly path: string; readonly size: number; readonly sha256: string }[];
}

interface FinishedSave {
  /** The archive's path in the root. */
  readonly archive: string;
  readonly archiveBytes: number;
  /** The folder every entry lives in, as stored. */
  readonly folder: string;
  readonly manifest: ArchiveManifest;
}

const INCOMING = ".incoming";
/** The archive while it is being written: never visible under a final name. */
const ARCHIVE_PART = ".archive.part";
const SAVE_ID = /^[a-f0-9]{32}$/;
const SHA256 = /^[a-f0-9]{64}$/i;
const KEY = /^[a-f0-9]{16,64}$/;
/** What an archive's file name can be: `labelSlug` (letters, digits, dot, dash, underscore; never starting with a dot or a dash), a date, maybe a number, `.zip`. A state file naming anything else is not one the vault wrote. */
const ARCHIVE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,150}\.zip$/;
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
/** A partial archive nobody has written to for this long belongs to a build that died with its server. */
const ABANDONED_PARTIAL_MS = 60 * 60 * 1000;
/** How much archive is written between two looks at what the rest of the vault holds and at the disk's free space. */
const REFRESH_BYTES = 64 * MiB;
const MANIFEST_CACHE_LIMIT = 512;
const MAX_PARTITIONS = 1024;
const MAX_PARTITION_NAME = 80;
const MAX_SET_NAME = 80;
/** The furthest a JavaScript date reaches: anything beyond cannot be written into a manifest. */
const MAX_TIME_MS = 8.64e15;

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

/** The folder inside an archive is its file name without `.zip`. */
function folderOf(archiveName: string): string {
  return archiveName.replace(/\.zip$/i, "");
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

/** The lock for everything that picks or takes a final name in the root: beginning a save and publishing an archive. */
function rootLock(config: VaultConfig): string {
  return `${config.root}\u0000finalize`;
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
  // Dotted like every file the vault keeps for itself, so it cannot be mistaken for, or overwritten by, a person's file.
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID().slice(0, 8)}.tmp`);
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

/** Makes a rename durable before the raw files it replaces are deleted. A platform that cannot sync a directory just skips it. */
async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await fsp.open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Not every platform lets a directory be opened or synced.
  }
}

function incomingDirectory(config: VaultConfig, saveId: string): string {
  if (!SAVE_ID.test(saveId)) throw new VaultError(404, "unknown_save", "That save does not exist.");
  return path.join(config.root, INCOMING, saveId);
}

function describeBytes(bytes: number): string {
  if (bytes >= GiB) return `${(bytes / GiB).toFixed(1)} GB`;
  if (bytes >= MiB) return `${(bytes / MiB).toFixed(1)} MB`;
  return `${bytes} bytes`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Builds in progress
// ---------------------------------------------------------------------------------------------------------------------

interface BuildFailure {
  readonly status: number;
  readonly code: string;
  readonly message: string;
}

/**
 * One attempt to write a save's archive. Kept on `globalThis` like the locks: the routes and the agent's status tool are
 * bundled apart, and all of them have to see the same build.
 */
interface BuildRecord {
  readonly saveId: string;
  readonly controller: AbortController;
  readonly totalBytes: number;
  /** `building` until the attempt is over; `failed` stays until a new attempt or the save's removal. */
  state: "building" | "done" | "failed" | "aborted";
  /** Original bytes packed so far. */
  packedBytes: number;
  /** Settles when the attempt is over and its leftovers are cleaned up. Never rejects. */
  done: Promise<void>;
  error?: BuildFailure;
  result?: FinishedSave;
}

function builds(): Map<string, BuildRecord> {
  const scope = globalThis as typeof globalThis & { __codyVaultBuilds?: Map<string, BuildRecord> };
  return (scope.__codyVaultBuilds ??= new Map());
}

// ---------------------------------------------------------------------------------------------------------------------
// Reading what is stored
// ---------------------------------------------------------------------------------------------------------------------

function parseStoredFile(raw: unknown): StoredFile | undefined {
  if (!isRecord(raw) || typeof raw.name !== "string" || !raw.name) return undefined;
  if (typeof raw.size !== "number" || !Number.isSafeInteger(raw.size) || raw.size < 0 || typeof raw.sha256 !== "string" || !SHA256.test(raw.sha256)) return undefined;
  if (typeof raw.fileName !== "string" || !raw.fileName || raw.fileName.includes("/") || raw.fileName.includes("\\") || raw.fileName === "." || raw.fileName === ".." || isVaultInternalName(raw.fileName)) return undefined;
  if (typeof raw.kind !== "string" || typeof raw.source !== "string" || validTime(raw.createdAt) === undefined) return undefined;
  if (raw.verified !== undefined && typeof raw.verified !== "boolean") return undefined;
  if (raw.artifactId !== undefined && typeof raw.artifactId !== "string") return undefined;
  if (raw.operation !== undefined && cleanOperation(raw.operation) === undefined) return undefined;
  return raw as unknown as StoredFile;
}

/**
 * A save's record as this vault wrote it, or nothing: a record that is damaged, hand-edited or in another folder than
 * its own id names is not a save of ours, so no slice, verify or build can act on it and nothing counts it.
 */
function parseStored(raw: unknown, saveId: string): StoredSave | undefined {
  if (!isRecord(raw) || raw.version !== 2 || raw.saveId !== saveId || typeof raw.archiveName !== "string" || !ARCHIVE_NAME.test(raw.archiveName)) return undefined;
  if (typeof raw.sessionId !== "string" || typeof raw.label !== "string" || (raw.owner !== null && typeof raw.owner !== "string") || validTime(raw.createdAt) === undefined) return undefined;
  if (raw.key !== undefined && (typeof raw.key !== "string" || !KEY.test(raw.key))) return undefined;
  if (raw.ownerName !== undefined && typeof raw.ownerName !== "string") return undefined;
  if (!Array.isArray(raw.files) || !raw.files.every((file) => parseStoredFile(file) !== undefined)) return undefined;
  return raw as unknown as StoredSave;
}

async function readIncoming(config: VaultConfig, saveId: string): Promise<StoredSave | undefined> {
  return parseStored(await readJson(path.join(incomingDirectory(config, saveId), STATE_NAME)), saveId);
}

function parseArchiveManifest(raw: unknown): ArchiveManifest | undefined {
  if (!isRecord(raw) || raw.format !== MANIFEST_FORMAT || typeof raw.saveId !== "string" || !SAVE_ID.test(raw.saveId)) return undefined;
  if (typeof raw.sessionId !== "string" || typeof raw.label !== "string" || !isRecord(raw.owner) || (raw.owner.id !== null && typeof raw.owner.id !== "string")) return undefined;
  if (typeof raw.createdAt !== "string" || typeof raw.completedAt !== "string" || typeof raw.totalBytes !== "number" || raw.verified !== true || !Array.isArray(raw.files)) return undefined;
  const wellFormed = raw.files.every((file) => isRecord(file) && typeof file.name === "string" && typeof file.path === "string" && typeof file.size === "number" && typeof file.sha256 === "string");
  return wellFormed ? (raw as unknown as ArchiveManifest) : undefined;
}

/** What was read from an archive, keyed by where it is and what it looked like: the agent asks for a save's status every second. */
const manifestCache = new Map<string, { readonly size: number; readonly mtimeMs: number; readonly save: FinishedSave | undefined }>();

/** The save an archive file is, or undefined when it is not one of ours (a person's own zip, a half-copied file). */
async function finishedAt(file: string): Promise<FinishedSave | undefined> {
  const stat = await fsp.stat(file).catch(() => undefined);
  if (!stat?.isFile()) return undefined;
  const cached = manifestCache.get(file);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.save;
  const read = await readArchiveManifest(file);
  const manifest = read ? parseArchiveManifest(read.manifest) : undefined;
  const save: FinishedSave | undefined = read && manifest ? { archive: file, archiveBytes: stat.size, folder: read.folder, manifest } : undefined;
  manifestCache.delete(file);
  manifestCache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, save });
  for (const oldest of manifestCache.keys()) {
    if (manifestCache.size <= MANIFEST_CACHE_LIMIT) break;
    manifestCache.delete(oldest);
  }
  return save;
}

async function finishedSaves(config: VaultConfig): Promise<FinishedSave[]> {
  const entries = await fsp.readdir(config.root, { withFileTypes: true }).catch(() => []);
  const found: FinishedSave[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    // A symbolic link is never followed: a save is a plain file that is a direct child of the root.
    if (!entry.isFile() || entry.name.startsWith(".") || !entry.name.toLowerCase().endsWith(".zip")) continue;
    const file = path.join(config.root, entry.name);
    seen.add(file);
    const save = await finishedAt(file);
    if (save) found.push(save);
  }
  for (const cached of manifestCache.keys()) if (path.dirname(cached) === config.root && !seen.has(cached)) manifestCache.delete(cached);
  return found.sort((left, right) => (left.archive < right.archive ? -1 : 1));
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

async function statusOfIncoming(config: VaultConfig, stored: StoredSave, build?: BuildRecord): Promise<SaveStatus> {
  const directory = incomingDirectory(config, stored.saveId);
  const folder = folderOf(stored.archiveName);
  const building = build?.state === "building";
  const files: SaveFileStatus[] = [];
  for (const [index, file] of stored.files.entries()) {
    files.push({
      index,
      name: file.name,
      entry: `${folder}/${file.fileName}`,
      size: file.size,
      sha256: file.sha256,
      received: file.verified ? file.size : Math.min(await sizeOf(path.join(directory, partName(index))), file.size),
      verified: file.verified === true,
    });
  }
  return {
    saveId: stored.saveId,
    state: building ? "building" : "uploading",
    label: stored.label,
    sessionId: stored.sessionId,
    owner: stored.owner,
    archive: path.join(config.root, stored.archiveName),
    ...(building ? { packedBytes: build.packedBytes } : {}),
    files,
    totalBytes: files.reduce((total, file) => total + file.size, 0),
    receivedBytes: files.reduce((total, file) => total + file.received, 0),
    createdAt: stored.createdAt,
    verified: false,
    ...(build?.state === "failed" && build.error ? { buildError: { code: build.error.code, message: build.error.message } } : {}),
  };
}

function statusOfFinished({ archive, archiveBytes, folder, manifest }: FinishedSave): SaveStatus {
  return {
    saveId: manifest.saveId,
    state: "complete",
    label: manifest.label,
    sessionId: manifest.sessionId,
    owner: manifest.owner.id,
    archive,
    archiveBytes,
    files: manifest.files.map((file, index) => ({ index, name: file.name, entry: `${folder}/${file.path}`, size: file.size, sha256: file.sha256, received: file.size, verified: true })),
    totalBytes: manifest.totalBytes,
    receivedBytes: manifest.totalBytes,
    createdAt: Date.parse(manifest.createdAt),
    completedAt: Date.parse(manifest.completedAt),
    verified: true,
  };
}

/** The save with this id, finished or not, or undefined. */
export async function saveStatus(config: VaultConfig, saveId: string): Promise<SaveStatus | undefined> {
  if (!SAVE_ID.test(saveId)) return undefined;
  const build = builds().get(saveId);
  const stored = await readIncoming(config, saveId);
  // Files still arriving cannot have an archive yet; everything else may have one whose cleanup a crash interrupted.
  const settled = stored === undefined || (build?.state !== "building" && stored.files.every((file) => file.verified));
  if (settled) {
    const finished = (await finishedSaves(config)).find((entry) => entry.manifest.saveId === saveId);
    if (finished) return statusOfFinished(finished);
  }
  return stored ? statusOfIncoming(config, stored, build) : undefined;
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
  const finished = await finishedSaves(config);
  const done = new Set(finished.map((entry) => entry.manifest.saveId));
  for (const entry of finished) {
    const owner = entry.manifest.owner.id;
    if (filter.sessionId !== undefined && entry.manifest.sessionId !== filter.sessionId) continue;
    if (accept({ owner, sessionId: entry.manifest.sessionId })) found.push(statusOfFinished(entry));
  }
  if (filter.unfinished) {
    for (const stored of await incomingSaves(config)) {
      // The leftover of a save whose archive is already in place is not an unfinished save.
      if (done.has(stored.saveId)) continue;
      if (filter.sessionId !== undefined && stored.sessionId !== filter.sessionId) continue;
      if (accept({ owner: stored.owner, sessionId: stored.sessionId })) found.push(await statusOfIncoming(config, stored, builds().get(stored.saveId)));
    }
  }
  return found.sort((left, right) => (right.completedAt ?? right.createdAt) - (left.completedAt ?? left.createdAt));
}

/**
 * What the vault will hold for an unfinished save once it is an archive: its files, plus what packing may add. Deflate can
 * grow data by about 0.04 % at worst, and the archive adds a few hundred bytes of headers per file and the checksums and
 * the manifest beside them (a few hundred bytes per file, plus a backup's partition lists once).
 */
function reservedBytes(save: { readonly files: readonly { readonly size: number }[] }): number {
  const total = save.files.reduce((sum, file) => sum + file.size, 0);
  return total + Math.ceil(total / 1000) + (save.files.length + 1) * 4096;
}

/**
 * What the vault holds against its cap: every finished archive as it is on the disk and what every unfinished save
 * reserves (its archive-to-be, whether its files are still arriving or being packed), except `ignore`'s. The raw files
 * and the partial archive of one save sit beside each other only while it is packed, and that is the disk's business
 * (`minFreeBytes`), not the cap's: a save the cap admits can always finish.
 */
function heldBytes(finished: readonly FinishedSave[], unfinished: readonly StoredSave[], ignore?: string): number {
  let held = 0;
  for (const entry of finished) held += entry.archiveBytes;
  for (const stored of unfinished) if (stored.saveId !== ignore) held += reservedBytes(stored);
  return held;
}

/** How long an unfinished save that nobody is sending to keeps disk room for its missing bytes: a tab closed for longer than this is not about to send them. */
const OWED_GRACE_MS = 60 * 60 * 1000;

/** When a save's folder was last written to: a slice appended, a file verified, the save announced. */
async function lastTouched(directory: string): Promise<number> {
  const names = await fsp.readdir(directory).catch(() => []);
  let latest = 0;
  for (const name of names) latest = Math.max(latest, await fsp.stat(path.join(directory, name)).then((stat) => stat.mtimeMs, () => 0));
  return latest;
}

/** An unfinished save whose bytes are still to come, and that someone is still sending (touched within OWED_GRACE_MS). */
interface OwedSave {
  readonly label: string;
  readonly saveId: string;
  readonly bytes: number;
  /** Milliseconds since it was last written to. */
  readonly idleMs: number;
}

/**
 * The unfinished saves still owed bytes (every file not yet verified, less what is already stored of it) whose sender is
 * still at it. One untouched for OWED_GRACE_MS is not about to need the room: its folder stays (the retention period
 * decides that), but a new save is not refused on its account.
 */
async function owedSaves(config: VaultConfig, unfinished: readonly StoredSave[], now: number): Promise<OwedSave[]> {
  const owed: OwedSave[] = [];
  for (const stored of unfinished) {
    const directory = incomingDirectory(config, stored.saveId);
    let bytes = 0;
    for (const [index, file] of stored.files.entries()) {
      if (!file.verified) bytes += Math.max(0, file.size - (await sizeOf(path.join(directory, partName(index)))));
    }
    if (bytes === 0) continue;
    const idleMs = now - (await lastTouched(directory));
    if (idleMs <= OWED_GRACE_MS) owed.push({ label: stored.label, saveId: stored.saveId, bytes, idleMs });
  }
  return owed;
}

function describeIdle(idleMs: number): string {
  const minutes = Math.round(idleMs / 60_000);
  return minutes < 1 ? "moments ago" : `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
}

/** Refuses with `disk_full` when the disk under the vault has less than the floor to spare; a disk that cannot be asked is never refused. */
function requireFreeSpace(config: VaultConfig, wanted: number, message: (available: number) => string): void {
  const space = getDiskSpace(config.root);
  if (space && space.availableBytes < wanted) throw new VaultError(507, "disk_full", message(space.availableBytes));
}

// ---------------------------------------------------------------------------------------------------------------------
// Beginning a save
// ---------------------------------------------------------------------------------------------------------------------

function text(value: unknown, limit: number): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, limit) : undefined;
}

/** A time a manifest can hold: a finite number a date can represent. */
function validTime(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= MAX_TIME_MS ? value : undefined;
}

function partitionNames(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_PARTITIONS) return undefined;
  const names: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0 || item.length > MAX_PARTITION_NAME) return undefined;
    names.push(item);
  }
  return names;
}

/** Which partitions a backup took, or nothing when the list is not a plausible one: a record is either whole or absent. */
function cleanScope(value: unknown): BackupScope | undefined {
  if (!isRecord(value)) return undefined;
  const chosen = partitionNames(value.chosen);
  const all = partitionNames(value.all);
  return chosen && all ? { chosen, all } : undefined;
}

function cleanOperation(value: unknown): ManifestOperation | undefined {
  if (!isRecord(value)) return undefined;
  const id = text(value.id, 200);
  const deviceId = text(value.deviceId, 200);
  const protocol = text(value.protocol, 64);
  const action = text(value.action, 64);
  if (!id || !deviceId || !protocol || !action) return undefined;
  const deviceLabel = text(value.deviceLabel, 200);
  const target = text(value.target, 200);
  const command = text(value.command, 200);
  const startedAt = validTime(value.startedAt);
  const set = text(value.set, MAX_SET_NAME);
  const partitions = cleanScope(value.partitions);
  return {
    id,
    deviceId,
    protocol,
    action,
    ...(deviceLabel ? { deviceLabel } : {}),
    ...(target ? { target } : {}),
    ...(command ? { command } : {}),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(set ? { set } : {}),
    ...(partitions ? { partitions } : {}),
  };
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
    files.push({
      name,
      size,
      sha256: item.sha256.toLowerCase(),
      kind: text(item.kind, 16) ?? "output",
      source: text(item.source, 32) ?? "device",
      createdAt: validTime(item.createdAt) ?? now,
      ...(artifactId ? { artifactId } : {}),
      ...(operation ? { operation } : {}),
    });
  }
  if (total > limits.maxSaveBytes) return refuse(`These files total ${total} bytes; one save may hold at most ${limits.maxSaveBytes} bytes. Save them in smaller groups.`, "too_large", 413);
  return { sessionId, label: text(raw.label, 120) ?? "artifacts", ...(raw.key === undefined ? {} : { key: raw.key as string }), ...(timeZone ? { timeZone } : {}), files };
}

/**
 * Deletes what nobody will come back for: an unfinished save untouched for the retention period, the leftovers of a save
 * whose archive is already in place (the cleanup after its rename never ran), and a partial archive whose build died.
 * A save whose archive is being written right now is never touched.
 */
async function sweepIncoming(config: VaultConfig, now: number, finished: readonly FinishedSave[]): Promise<void> {
  const done = new Set(finished.map((entry) => entry.manifest.saveId));
  const entries = await fsp.readdir(path.join(config.root, INCOMING), { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || !SAVE_ID.test(entry.name)) continue;
    const build = builds().get(entry.name);
    if (build?.state === "building") continue;
    const directory = path.join(config.root, INCOMING, entry.name);
    if (done.has(entry.name)) {
      await fsp.rm(directory, { recursive: true, force: true }).catch(() => undefined);
      builds().delete(entry.name);
      continue;
    }
    if (now - (await lastTouched(directory)) > config.limits.incomingTtlMs) {
      await fsp.rm(directory, { recursive: true, force: true }).catch(() => undefined);
      builds().delete(entry.name);
      continue;
    }
    const partial = path.join(directory, ARCHIVE_PART);
    const written = await fsp.stat(partial).then((stat) => stat.mtimeMs, () => undefined);
    if (written !== undefined && now - written > ABANDONED_PARTIAL_MS) await fsp.rm(partial, { force: true }).catch(() => undefined);
  }
}

/** Every name in the root, and every archive name an unfinished save has reserved, lowercase: a share seen from Windows is case-insensitive. */
async function takenNames(config: VaultConfig, unfinished: readonly StoredSave[]): Promise<Set<string>> {
  const taken = new Set<string>();
  for (const entry of await fsp.readdir(config.root, { withFileTypes: true }).catch(() => [])) taken.add(entry.name.toLowerCase());
  for (const stored of unfinished) taken.add(stored.archiveName.toLowerCase());
  return taken;
}

/**
 * Starts a save, or finds the one this is: the same `key` from the same account either has a finished save (answered as
 * `existing`, nothing to upload) or an unfinished one (answered with what is already stored, so the upload carries on).
 */
export async function beginSave(config: VaultConfig, actor: SaveActor, raw: unknown, now = Date.now()): Promise<SaveStatus> {
  const request = parseSaveRequest(raw, config.limits, now);
  await ensureRoot(config);
  // One announcement at a time: two of the same save, or of the same label on the same day, must see each other.
  return withLock(rootLock(config), async () => {
    const finished = await finishedSaves(config);
    await sweepIncoming(config, now, finished);
    const unfinished = await incomingSaves(config);
    if (request.key) {
      const done = finished.find((entry) => entry.manifest.key === request.key && entry.manifest.owner.id === actor.owner && entry.manifest.sessionId === request.sessionId);
      if (done) return { ...statusOfFinished(done), existing: true };
      const open = unfinished.find((stored) => stored.key === request.key && stored.owner === actor.owner && stored.sessionId === request.sessionId && !finished.some((entry) => entry.manifest.saveId === stored.saveId));
      if (open) {
        // Announcing the save again is trying again: what stopped the last build is no longer what the save says, so a
        // follower (the agent's status) does not report a failure the sender is already putting right.
        if (builds().get(open.saveId)?.state === "failed") builds().delete(open.saveId);
        const status = await statusOfIncoming(config, open, builds().get(open.saveId));
        return { ...status, resumed: status.receivedBytes > 0 };
      }
    }

    const total = request.files.reduce((sum, file) => sum + file.size, 0);
    const reserve = reservedBytes(request);
    const held = heldBytes(finished, unfinished);
    const cap = config.limits.maxVaultBytes;
    if (cap > 0 && held + reserve > cap) {
      throw new VaultError(507, "quota_exceeded", reserve > cap
        ? `This save (${describeBytes(total)}) is larger than the server's artifact folder allows (${describeBytes(cap)}, with room for packing). Save fewer files at a time.`
        : `The server's artifact folder holds ${describeBytes(held)} and is limited to ${describeBytes(cap)}, so ${describeBytes(total)} more does not fit. Delete an older save first.`);
    }
    // The files arrive first and the archive is then written beside them, so for a while the disk holds both: the raw
    // bytes still to come for every unfinished save somebody is sending, this save's files, as much again for its archive, and the floor.
    const owed = await owedSaves(config, unfinished, now);
    const owedBytes = owed.reduce((sum, save) => sum + save.bytes, 0);
    requireFreeSpace(config, owedBytes + total + reserve + config.limits.minFreeBytes, (available) => {
      const others = owed.map((save) => `${describeBytes(save.bytes)} for "${save.label}" (save ${save.saveId}, last sent to ${describeIdle(save.idleMs)})`).join(", ");
      const waiting = owed.length === 0 ? "" : ` ${describeBytes(owedBytes)} of that is still to arrive for ${owed.length === 1 ? "another save" : "other saves"}: ${others}. Let ${owed.length === 1 ? "it" : "them"} finish, or an hour after the last slice ${owed.length === 1 ? "it stops" : "they stop"} holding the room.`;
      return `The server has ${describeBytes(available)} free and this save needs ${describeBytes(total)} for its files, as much again while its zip is written beside them, and ${describeBytes(config.limits.minFreeBytes)} to spare.${waiting} Free some space or save fewer files at a time.`;
    });

    const saveId = randomUUID().replaceAll("-", "");
    const taken = await takenNames(config, unfinished);
    const base = `${labelSlug(request.label)}-${dateIn(request.timeZone, now)}`;
    let archiveName = `${base}.zip`;
    for (let counter = 2; taken.has(archiveName.toLowerCase()); counter += 1) archiveName = `${base}-${counter}.zip`;
    const names = uniqueFileNames(request.files.map((file) => file.name));
    // The vault's own files live beside the raw files while a save is unfinished. Names made by uniqueFileNames can never
    // be one of them; if a change ever broke that, a save must stop here rather than overwrite its own bookkeeping.
    if (names.some((name) => isVaultInternalName(name))) throw new VaultError(500, "unsafe_name", "A file name could not be made safe, so nothing was saved.");
    const stored: StoredSave = {
      version: 2,
      saveId,
      ...(request.key ? { key: request.key } : {}),
      owner: actor.owner,
      ...(actor.ownerName ? { ownerName: actor.ownerName } : {}),
      sessionId: request.sessionId,
      label: request.label,
      archiveName,
      createdAt: now,
      files: request.files.map((file, index) => ({ ...file, fileName: names[index]! })),
    };
    const directory = incomingDirectory(config, saveId);
    await fsp.mkdir(directory, { mode: DIRECTORY_MODE });
    await writeJson(path.join(directory, STATE_NAME), stored);
    return statusOfIncoming(config, stored);
  });
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
    const part = path.join(incomingDirectory(config, saveId), partName(index));
    const received = await sizeOf(part);
    if (offset !== received) throw new VaultError(409, "offset_mismatch", `"${file.name}" has ${received} bytes stored, not ${offset}.`, { received });
    if (received + bytes.byteLength > file.size) throw new VaultError(400, "too_long", `That slice runs past the end of "${file.name}" (${file.size} bytes).`, { received });
    requireFreeSpace(config, bytes.byteLength + config.limits.minFreeBytes, (available) =>
      `The server has ${describeBytes(available)} free, and it keeps ${describeBytes(config.limits.minFreeBytes)} to spare. Free some space and press Save to server again: what already arrived is kept.`);
    const handle = await fsp.open(part, "a", FILE_MODE);
    let written = 0;
    try {
      // One write may take only part of the slice (a disk filling up, a network share): go on until it is all down.
      while (written < bytes.byteLength) {
        const { bytesWritten } = await handle.write(bytes, written, bytes.byteLength - written);
        if (bytesWritten <= 0) break;
        written += bytesWritten;
      }
    } finally {
      await handle.close();
    }
    if (written < bytes.byteLength) {
      throw new VaultError(507, "disk_full", `The server's disk stopped taking data after ${written} of the ${bytes.byteLength} bytes of this slice. Free some space and press Save to server again: what already arrived is kept.`, { received: received + written });
    }
    return { received: received + written };
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
    const part = path.join(directory, partName(index));
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

// ---------------------------------------------------------------------------------------------------------------------
// Building the archive
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Whether the raw files are all there as announced. One that has gone missing or changed size fails the build with its
 * name; the files are looked at again when the build ends (see runBuild), so only the one that is not right is sent again.
 */
async function requireRawFiles(config: VaultConfig, stored: StoredSave): Promise<void> {
  const directory = incomingDirectory(config, stored.saveId);
  for (const [index, file] of stored.files.entries()) {
    if (file.size === 0) continue;
    if ((await sizeOf(path.join(directory, partName(index)))) === file.size) continue;
    throw new VaultError(409, "changed", `"${file.name}" is missing or changed on the server after it was verified. Press Save to server again: only that file is sent again.`);
  }
}

/** What every failure of the build tells the person first: the files they sent are safe. */
function filesAreSafe(count: number): string {
  return `Your ${count === 1 ? "file is" : `${count} files are`} still on the server.`;
}

/**
 * After a failure that could be the stored files' fault: hashes every raw file again, and a file that is not what was
 * verified loses its mark and its copy, so the next try sends just that one. Files that are fine stay verified, and so
 * does one that merely could not be read right now (a transient disk error is not damage): the next build looks again.
 * The record is written before any copy is deleted, so a record that cannot be written leaves every copy in place.
 */
async function recheckRaw(config: VaultConfig, saveId: string): Promise<void> {
  await withLock(saveId, async () => {
    const stored = await readIncoming(config, saveId);
    if (!stored) return;
    const directory = incomingDirectory(config, saveId);
    const damaged: string[] = [];
    for (const [index, file] of stored.files.entries()) {
      if (!file.verified || file.size === 0) continue;
      const part = path.join(directory, partName(index));
      if ((await sizeOf(part)) === file.size) {
        let actual: string;
        try {
          actual = await hashFile(part);
        } catch {
          continue;
        }
        if (actual === file.sha256) continue;
      }
      file.verified = false;
      damaged.push(part);
    }
    if (damaged.length === 0) return;
    await writeJson(path.join(directory, STATE_NAME), stored);
    for (const part of damaged) await fsp.rm(part, { force: true });
  });
}

/** What a failure of the build is called, said to the person, and the status a `complete` call that ends with it answers. */
function describeFailure(error: unknown, stored: StoredSave): BuildFailure {
  if (error instanceof VaultError) return { status: error.status, code: error.code, message: error.message };
  const safe = filesAreSafe(stored.files.length);
  if (error instanceof ArchiveCheckError) {
    return { status: 422, code: "archive_check_failed", message: `The archive was written but did not pass the server's own re-read, so it was thrown away: ${error.message} ${safe} Press Save to server again: nothing is uploaded twice.` };
  }
  const message = error instanceof Error ? error.message : String(error);
  const disk = describeDiskError(`${message} ${(error as NodeJS.ErrnoException | undefined)?.code ?? ""}`);
  if (disk) {
    return { status: 507, code: "disk_full", message: `The server's disk is full, so the archive could not be written. ${safe} Free some space, then press Save to server again: nothing is uploaded twice.` };
  }
  if (error instanceof ArchiveError && (error.code === "changed" || error.code === "damaged")) {
    return { status: 409, code: "changed", message: `The saved files changed on the server while the archive was being written (${message}). Press Save to server again: files that are still fine are not sent twice.` };
  }
  return { status: 500, code: "build_failed", message: `The server could not write the archive: ${message}. ${safe} Press Save to server again: nothing is uploaded twice.` };
}

/**
 * Writes everything the archive is made of into the partial file, stopping the writer the moment anything goes wrong. The
 * writer starts preparing its first chunk, and so opens the first file, as soon as it is made, so the reader is taken before
 * anything else can fail and every way out cancels it. Every REFRESH_BYTES it looks again at what the rest of the vault
 * holds (a cap lowered since the save began, or a save begun since) and at the disk, which must keep its floor free while
 * the raw files and the archive sit side by side.
 */
async function writeToDisk(config: VaultConfig, record: BuildRecord, stored: StoredSave, partial: string, stream: ReadableStream<Uint8Array>, summary: Promise<unknown>): Promise<void> {
  const { signal } = record.controller;
  const cap = config.limits.maxVaultBytes;
  const others = async (): Promise<number> => heldBytes(await finishedSaves(config), await incomingSaves(config), stored.saveId);
  const reader = stream.getReader();
  let handle: FileHandle | undefined;
  let closed = false;
  try {
    let baseline = 0;
    let written = 0;
    let refreshedAt = 0;
    const lookAgain = async (): Promise<void> => {
      refreshedAt = written;
      if (cap > 0) baseline = await others();
      requireFreeSpace(config, config.limits.minFreeBytes, (available) =>
        `The server's disk is down to ${describeBytes(available)} free, and it keeps ${describeBytes(config.limits.minFreeBytes)} to spare, so the archive (${describeBytes(written)} written so far) was stopped. ${filesAreSafe(stored.files.length)} Free some space, then press Save to server again: nothing is uploaded twice.`);
    };
    await lookAgain();
    handle = await fsp.open(partial, "w", FILE_MODE);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      signal.throwIfAborted();
      if (written - refreshedAt >= REFRESH_BYTES) await lookAgain();
      if (cap > 0 && baseline + written + value.byteLength > cap) {
        throw new VaultError(507, "quota_exceeded", `The server's artifact folder is limited to ${describeBytes(cap)} and the rest of it holds ${describeBytes(baseline)}, so the archive (${describeBytes(written)} written so far) does not fit. ${filesAreSafe(stored.files.length)} Delete an older save, then press Save to server again: nothing is uploaded twice.`);
      }
      // One write may take only part of the chunk (a disk filling up, a network share): go on until it is all down.
      let offset = 0;
      while (offset < value.byteLength) {
        const { bytesWritten } = await handle.write(value, offset, value.byteLength - offset);
        if (bytesWritten <= 0) throw new VaultError(507, "disk_full", `The server's disk is full: it stopped taking data after ${describeBytes(written + offset)} of the archive. ${filesAreSafe(stored.files.length)} Free some space, then press Save to server again: nothing is uploaded twice.`);
        offset += bytesWritten;
      }
      written += value.byteLength;
    }
    await summary;
    await handle.sync();
    closed = true;
    await handle.close();
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    if (!closed) await handle?.close().catch(() => undefined);
  }
}

/** One raw file as an archive entry: read straight from its partial copy on the disk, a slice at a time. */
function rawSource(directory: string, folder: string, file: StoredFile, index: number): ArchiveSource {
  return {
    name: `${folder}/${file.fileName}`,
    size: file.size,
    modified: file.createdAt,
    open: () =>
      file.size === 0
        ? new ReadableStream<Uint8Array>({ start: (controller) => controller.close() })
        : // Node's web stream and the DOM's are the same thing at run time; their type declarations are not.
          (Readable.toWeb(createReadStream(path.join(directory, partName(index)), { highWaterMark: MiB })) as unknown as ReadableStream<Uint8Array>),
  };
}

/**
 * Packs the verified raw files into the partial archive, re-reads it with the independent reader, and only then moves it
 * to its final name. Returns the finished save; throws, leaving the raw files where they are, when anything is wrong.
 */
async function buildArchive(config: VaultConfig, record: BuildRecord, stored: StoredSave, completedAt: number, options: CompleteOptions): Promise<FinishedSave> {
  const { signal } = record.controller;
  const directory = incomingDirectory(config, stored.saveId);
  const partial = path.join(directory, ARCHIVE_PART);
  const folder = folderOf(stored.archiveName);
  await requireRawFiles(config, stored);

  const manifestFiles: ManifestFile[] = stored.files.map((file) => ({
    name: file.name,
    path: file.fileName,
    size: file.size,
    sha256: file.sha256,
    kind: file.kind,
    source: file.source,
    createdAt: file.createdAt,
    ...(file.artifactId ? { artifactId: file.artifactId } : {}),
    ...(file.operation ? { operation: file.operation } : {}),
  }));
  const manifest = buildArchiveManifest({
    label: stored.label,
    sessionId: stored.sessionId,
    createdAt: stored.createdAt,
    files: manifestFiles,
    extra: {
      saveId: stored.saveId,
      ...(stored.key ? { key: stored.key } : {}),
      owner: { id: stored.owner, ...(stored.ownerName ? { name: stored.ownerName } : {}) },
      completedAt: new Date(completedAt).toISOString(),
      verified: true,
    },
  });
  // A save is recognised by its manifest alone, so a manifest this vault could not read back must stop the build before
  // anything is written, not after the archive has been given its final name.
  if (!parseArchiveManifest(manifest.json)) throw new Error("The archive writer produced a manifest this vault cannot read back.");
  const sources = [
    ...stored.files.map((file, index) => rawSource(directory, folder, file, index)),
    ...metadataSources({ folder, files: stored.files.map((file) => ({ path: file.fileName, sha256: file.sha256 })), manifest: manifest.bytes, modified: completedAt }),
  ];
  const expected: ExpectedArchive = {
    folder,
    files: stored.files.map((file) => ({ path: file.fileName, size: file.size, sha256: file.sha256 })),
    manifestSha256: createHash("sha256").update(manifest.bytes).digest("hex"),
  };

  const { stream, summary } = writeArchive(sources, {
    signal,
    onProgress: (progress) => {
      record.packedBytes = Math.min(progress.readBytes, record.totalBytes);
    },
    ...(options.forceZip64 ? { forceZip64: true } : {}),
  });
  // The writer reports a failure through the stream and through `summary`; the stream's is the one handled here.
  summary.catch(() => undefined);
  await writeToDisk(config, record, stored, partial, stream, summary);
  record.packedBytes = record.totalBytes;
  await verifyArchiveFile(partial, expected, { signal });

  // The final name is taken under the same lock as every other announcement and publication, so two saves of one label
  // and day can never take the same name. It was reserved when the save began; it is only changed if a file of the
  // person's has since taken it.
  const target = await withLock(rootLock(config), async () => {
    signal.throwIfAborted();
    const taken = await takenNames(config, (await incomingSaves(config)).filter((other) => other.saveId !== stored.saveId));
    let archiveName = stored.archiveName;
    for (let counter = 2; taken.has(archiveName.toLowerCase()) || (await exists(path.join(config.root, archiveName))); counter += 1) archiveName = `${folder}-${counter}.zip`;
    const file = path.join(config.root, archiveName);
    await fsp.rename(partial, file);
    await fsp.chmod(file, FILE_MODE).catch(() => undefined);
    await syncDirectory(config.root);
    return file;
  });
  const finished = await finishedAt(target);
  if (!finished) throw new Error("The archive was written but cannot be read back as a save.");
  // The archive is in place; from here nothing can fail the save. A cleanup that does not finish is completed by the
  // next call that sees the save (the leftovers of a finished save are recognised and removed).
  await fsp.rm(directory, { recursive: true, force: true }).catch(() => undefined);
  return finished;
}

async function runBuild(config: VaultConfig, record: BuildRecord, stored: StoredSave, completedAt: number, options: CompleteOptions): Promise<void> {
  try {
    record.result = await buildArchive(config, record, stored, completedAt, options);
    record.state = "done";
  } catch (error) {
    await fsp.rm(path.join(incomingDirectory(config, stored.saveId), ARCHIVE_PART), { force: true }).catch(() => undefined);
    if (record.controller.signal.aborted) {
      record.state = "aborted";
    } else {
      record.error = describeFailure(error, stored);
      // Damage the stored files could have caused is looked for before the next try, so it sends only what has to be sent.
      if (record.error.code === "archive_check_failed" || record.error.code === "changed") await recheckRaw(config, stored.saveId).catch(() => undefined);
      record.state = "failed";
    }
  } finally {
    if (record.state !== "failed" && builds().get(stored.saveId) === record) builds().delete(stored.saveId);
  }
}

/** Starts the build of a save whose files are all verified, or joins the one that is running. Runs under the save's lock. */
async function startBuild(config: VaultConfig, saveId: string, now: number, options: CompleteOptions): Promise<{ record: BuildRecord } | { status: SaveStatus }> {
  const running = builds().get(saveId);
  if (running?.state === "building") return { record: running };
  const done = (await finishedSaves(config)).find((entry) => entry.manifest.saveId === saveId);
  if (done) {
    // The archive is in place; a crash between its rename and the cleanup left the raw files behind.
    await fsp.rm(incomingDirectory(config, saveId), { recursive: true, force: true });
    builds().delete(saveId);
    return { status: statusOfFinished(done) };
  }
  const stored = await readIncoming(config, saveId);
  if (!stored) throw new VaultError(404, "unknown_save", "That save does not exist, or it was cleaned up after sitting unfinished.");
  const directory = incomingDirectory(config, saveId);
  const missing: { index: number; name: string; received: number; size: number }[] = [];
  for (const [index, file] of stored.files.entries()) {
    const received = file.verified ? file.size : await sizeOf(path.join(directory, partName(index)));
    if (!file.verified || received !== file.size) missing.push({ index, name: file.name, received, size: file.size });
  }
  if (missing.length > 0) {
    const first = missing[0]!;
    throw new VaultError(409, "incomplete", `${missing.length} of ${stored.files.length} files are not stored and verified yet, starting with "${first.name}" (${first.received} of ${first.size} bytes).`, { missing: missing.slice(0, 50) });
  }
  const record: BuildRecord = {
    saveId,
    controller: new AbortController(),
    totalBytes: stored.files.reduce((sum, file) => sum + file.size, 0),
    state: "building",
    packedBytes: 0,
    done: Promise.resolve(),
  };
  builds().set(saveId, record);
  record.done = runBuild(config, record, stored, now, options);
  return { record };
}

/**
 * Finishes the save: every file must be stored in full and verified, then the archive is written, re-read and moved to
 * its final name. The build runs in the background and this waits for it a short while (`completeWaitMs`): a small save
 * answers `complete` in one round trip, a large one answers `building` with `packedBytes` and the sender asks again (a
 * second call joins the build that is running, it never starts another). A build that fails ends this call with its
 * error when it fails within the wait, and leaves `buildError` on the save either way. Calling it again after it
 * succeeded returns the same result.
 */
export async function completeSave(config: VaultConfig, saveId: string, now = Date.now(), options: CompleteOptions = {}): Promise<SaveStatus> {
  const started = await withLock(saveId, () => startBuild(config, saveId, now, options));
  if ("status" in started) return started.status;
  const { record } = started;

  const over = Promise.withResolvers<void>();
  const timer = setTimeout(over.resolve, config.limits.completeWaitMs);
  void record.done.then(() => {
    clearTimeout(timer);
    over.resolve();
  });
  await over.promise;

  if (record.state === "building") {
    const stored = await readIncoming(config, saveId);
    // The build may have ended while the record was read: then its outcome is the answer, not a save that is no longer there.
    if (record.state === "building") {
      if (!stored) throw new VaultError(404, "unknown_save", "That save does not exist, or it was cleaned up after sitting unfinished.");
      return statusOfIncoming(config, stored, record);
    }
  }
  if (record.state === "done") return statusOfFinished(record.result!);
  if (record.state === "aborted") throw new VaultError(409, "aborted", "This save was deleted while its archive was being written.");
  throw new VaultError(record.error!.status, record.error!.code, record.error!.message);
}

/**
 * Deletes a save by its id: an unfinished one (stopping its archive build if one is running), a finished one (the
 * archive, found by the id in its own manifest and a direct child of the root, never by a path the caller supplied), or
 * the leftovers of both.
 */
export async function removeSave(config: VaultConfig, saveId: string): Promise<boolean> {
  if (!SAVE_ID.test(saveId)) return false;
  for (;;) {
    // The build is stopped first, without holding the save's lock: the build takes it itself when it has to put the
    // stored files right after a failure, and a delete that held it while waiting would wait for ever.
    const running = builds().get(saveId);
    if (running?.state === "building") {
      running.controller.abort();
      await running.done;
    }
    const removed = await withLock(saveId, async (): Promise<boolean | undefined> => {
      // A complete that was waiting for the lock may have started a build since: it is stopped the same way, from outside.
      if (builds().get(saveId)?.state === "building") return undefined;
      builds().delete(saveId);
      let removed = false;
      const directory = incomingDirectory(config, saveId);
      if (await exists(directory)) {
        await fsp.rm(directory, { recursive: true, force: true });
        removed = true;
      }
      const done = (await finishedSaves(config)).find((entry) => entry.manifest.saveId === saveId);
      if (done && path.dirname(done.archive) === config.root) {
        await fsp.rm(done.archive, { force: true });
        manifestCache.delete(done.archive);
        removed = true;
      }
      return removed;
    });
    if (removed !== undefined) return removed;
  }
}
