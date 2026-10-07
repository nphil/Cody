import type { OperationArtifacts } from "./operations";
import { encodeFilePathForApi } from "@/lib/file-paths";
import { hashBlobWithCrc } from "./blob-stream";
import type { StreamArtifact } from "./flasher";
import { combinedSetName, effectiveSetName, groupArtifactSets, olderSetOf, setFileLabel, setSaveState } from "./artifact-sets";
import { usableSetName } from "./set-name";
import { archiveFileName, browserDownloadSink, exportArchive, type ArchiveInput, type DownloadSink } from "./artifact-download";
import { listServerSaves, uploadToServer, type SaveBegun, type ServerSave, type UploadFile } from "./artifact-upload";
import {
  DeviceArtifactError,
  type ArtifactProvenance,
  type BackupScope,
  type ArtifactServerCopy,
  type ArtifactSet,
  type DeviceArtifact,
  type DeviceArtifactKind,
  type DeviceArtifactSource,
  type SetSaveState,
  type DownloadResult,
  type ServerSaveResult,
  type TransferJob,
  type TransferOptions,
  type TransferProgress,
} from "./artifact-model";

export { DeviceArtifactError } from "./artifact-model";
export type {
  ArtifactProvenance,
  ArtifactServerCopy,
  ArtifactSet,
  BackupScope,
  DeviceArtifact,
  DeviceArtifactErrorCode,
  DeviceArtifactKind,
  DeviceArtifactSource,
  DownloadResult,
  ServerSaveResult,
  SetSaveState,
  TransferJob,
  TransferOptions,
  TransferProgress,
} from "./artifact-model";

interface StoredDeviceArtifact extends DeviceArtifact {
  readonly blob: Blob;
  /** CRC-32 of the bytes, taken with the SHA-256 when the file was saved, so a download can prove the stored bytes are the ones that were saved. Files saved earlier have none. */
  readonly crc32?: number;
}

interface PersistedDeviceArtifact {
  readonly key: string;
  readonly sessionId: string;
  readonly artifact: StoredDeviceArtifact;
}

/**
 * The set name a person filed one artifact under (Combine), in a row of its own next to the artifact's. Writing it into the
 * artifact's row would copy that row's Blob, gigabytes for a backup, to change a few characters.
 */
interface PersistedSetName {
  readonly key: string;
  readonly sessionId: string;
  readonly artifactId: string;
  readonly setName: string;
}

export interface AddDeviceArtifactOptions {
  readonly kind?: DeviceArtifactKind;
  readonly source?: DeviceArtifactSource;
  readonly provenance?: ArtifactProvenance;
}

export type DeviceArtifactListener = (artifacts: readonly DeviceArtifact[]) => void;

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const DATABASE_NAME = "cody-device-artifacts";
const DATABASE_VERSION = 1;
const STORE_NAME = "artifacts";

function cryptoApi(): Crypto {
  if (!globalThis.crypto?.subtle) throw new DeviceArtifactError("This browser cannot calculate SHA-256 for device artifacts.");
  return globalThis.crypto;
}

function normalizeName(value: string): string {
  const name = value.trim().replace(/[\\/]/g, "_");
  if (!name) throw new DeviceArtifactError("An artifact name is required.");
  return name;
}

function filenameFromPath(filePath: string): string {
  const segment = filePath.split(/[\\/]/).filter(Boolean).at(-1);
  return normalizeName(segment ?? "server-file");
}

function artifactMetadata(artifact: StoredDeviceArtifact, server?: ArtifactServerCopy): DeviceArtifact {
  return {
    id: artifact.id, name: artifact.name, size: artifact.size, mime: artifact.mime, sha256: artifact.sha256,
    kind: artifact.kind, source: artifact.source, createdAt: artifact.createdAt,
    ...(artifact.provenance ? { provenance: artifact.provenance } : {}),
    ...(artifact.setName ? { setName: artifact.setName } : {}),
    ...(server ? { server } : {}),
  };
}
function artifactKey(sessionId: string, artifactId: string): string {
  return `${sessionId}:${artifactId}`;
}

/** The row that holds a person's set name for one artifact (see PersistedSetName). It starts with a NUL, which no session id does, so it never equals an artifact row's key. */
function setNameKey(sessionId: string, artifactId: string): string {
  return `\u0000set-name:${artifactKey(sessionId, artifactId)}`;
}

const MAX_PROVENANCE_TEXT = 200;
/** A partition name in a stored scope: as long as a GPT partition name can be. */
const MAX_SCOPE_NAME_CHARS = 80;
const MAX_SCOPE_NAMES = 1024;

function cleanNames(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SCOPE_NAMES) return undefined;
  const names: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") return undefined;
    names.push(entry.slice(0, MAX_SCOPE_NAME_CHARS));
  }
  return names;
}

/** The provenance an operation hands over, bounded and stripped to its known fields before it is stored. */
function cleanProvenance(provenance: ArtifactProvenance | undefined): ArtifactProvenance | undefined {
  if (!provenance) return undefined;
  const text = (value: string | undefined): string | undefined => (typeof value === "string" && value.trim() ? value.slice(0, MAX_PROVENANCE_TEXT) : undefined);
  const operationId = text(provenance.operationId);
  const deviceId = text(provenance.deviceId);
  const protocol = text(provenance.protocol);
  const action = text(provenance.action);
  if (!operationId || !deviceId || !protocol || !action) return undefined;
  const target = text(provenance.target);
  const command = text(provenance.command);
  const label = text(provenance.label);
  const startedAt = typeof provenance.startedAt === "number" && Number.isFinite(provenance.startedAt) && provenance.startedAt > 0 ? Math.floor(provenance.startedAt) : undefined;
  const set = typeof provenance.set === "string" ? usableSetName(provenance.set) : undefined;
  const chosen = cleanNames(provenance.scope?.chosen);
  const all = cleanNames(provenance.scope?.all);
  const scope: BackupScope | undefined = chosen && all && chosen.length <= all.length ? { chosen, all } : undefined;
  return {
    operationId, deviceId, protocol, action,
    ...(target ? { target } : {}),
    ...(command ? { command } : {}),
    ...(label ? { label } : {}),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(set ? { set } : {}),
    ...(scope ? { scope } : {}),
  };
}

function waitForTransaction<T>(transaction: IDBTransaction, request: IDBRequest<T>): Promise<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
    let value: T;
    let completed = false;
    request.addEventListener("success", () => {
      value = request.result;
      completed = true;
    }, { once: true });
    request.addEventListener("error", () => reject(request.error ?? new DeviceArtifactError("Artifact database request failed.")), { once: true });
    transaction.addEventListener("abort", () => reject(transaction.error ?? new DeviceArtifactError("Artifact database transaction was aborted.")), { once: true });
    transaction.addEventListener("error", () => reject(transaction.error ?? new DeviceArtifactError("Artifact database transaction failed.")), { once: true });
    transaction.addEventListener("complete", () => {
      if (!completed) {
        reject(new DeviceArtifactError("Artifact database transaction completed without a result."));
        return;
      }
      resolve(value);
    }, { once: true });
  return promise;
}

/**
 * Browser-owned escrow. A returned id means its Blob transaction has committed,
 * so a destructive flasher never accepts an in-memory-only backup reference.
 */
class IndexedDbArtifactPersistence {
  private database: Promise<IDBDatabase> | undefined;

  private open(): Promise<IDBDatabase> {
    if (this.database) return this.database;
    if (typeof indexedDB === "undefined") {
      return Promise.reject(new DeviceArtifactError("Persistent browser storage is unavailable; refusing to create device artifact escrow."));
    }
    const { promise, resolve, reject } = Promise.withResolvers<IDBDatabase>();
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.addEventListener("upgradeneeded", () => {
        const database = request.result;
        const store = database.objectStoreNames.contains(STORE_NAME)
          ? request.transaction?.objectStore(STORE_NAME)
          : database.createObjectStore(STORE_NAME, { keyPath: "key" });
        if (store && !store.indexNames.contains("sessionId")) store.createIndex("sessionId", "sessionId", { unique: false });
      });
      request.addEventListener("success", () => resolve(request.result), { once: true });
      request.addEventListener("error", () => reject(request.error ?? new DeviceArtifactError("Could not open persistent artifact storage.")), { once: true });
      request.addEventListener("blocked", () => reject(new DeviceArtifactError("Persistent artifact storage is blocked by another browser tab.")), { once: true });
    this.database = promise;
    return this.database;
  }

  async put(sessionId: string, artifact: StoredDeviceArtifact): Promise<void> {
    const database = await this.open();
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const request = transaction.objectStore(STORE_NAME).put({ key: artifactKey(sessionId, artifact.id), sessionId, artifact } satisfies PersistedDeviceArtifact);
    await waitForTransaction(transaction, request);
  }

  async get(sessionId: string, artifactId: string): Promise<StoredDeviceArtifact | undefined> {
    const database = await this.open();
    const transaction = database.transaction(STORE_NAME, "readonly");
    const store = transaction.objectStore(STORE_NAME);
    const artifactRequest = store.get(artifactKey(sessionId, artifactId)) as IDBRequest<PersistedDeviceArtifact | undefined>;
    const setName = await waitForTransaction(transaction, store.get(setNameKey(sessionId, artifactId)) as IDBRequest<PersistedSetName | undefined>);
    const artifact = artifactRequest.result?.artifact;
    return artifact && setName ? { ...artifact, setName: setName.setName } : artifact;
  }

  async list(sessionId: string): Promise<readonly StoredDeviceArtifact[]> {
    const database = await this.open();
    const transaction = database.transaction(STORE_NAME, "readonly");
    const rows = await waitForTransaction(transaction, transaction.objectStore(STORE_NAME).index("sessionId").getAll(sessionId) as IDBRequest<(PersistedDeviceArtifact | PersistedSetName)[]>);
    const names = new Map<string, string>();
    for (const row of rows) if ("setName" in row) names.set(row.artifactId, row.setName);
    return rows.flatMap((row) => {
      if (!("artifact" in row)) return [];
      const setName = names.get(row.artifact.id);
      return [setName ? { ...row.artifact, setName } : row.artifact];
    });
  }

  /** Files these artifacts under set names, each in a small row of its own: the Blobs are not touched. */
  async putSetNames(sessionId: string, entries: readonly (readonly [artifactId: string, setName: string])[]): Promise<void> {
    if (entries.length === 0) return;
    const database = await this.open();
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    let last: IDBRequest<IDBValidKey> | undefined;
    for (const [artifactId, setName] of entries) last = store.put({ key: setNameKey(sessionId, artifactId), sessionId, artifactId, setName } satisfies PersistedSetName);
    await waitForTransaction(transaction, last!);
  }

  async delete(sessionId: string, artifactId: string): Promise<void> {
    const database = await this.open();
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    store.delete(setNameKey(sessionId, artifactId));
    await waitForTransaction(transaction, store.delete(artifactKey(sessionId, artifactId)));
  }
}

export interface DeviceArtifactStoreOptions {
  /** The network, for tests; a page uses its own `fetch`. */
  readonly fetch?: FetchLike;
  /** Where a downloaded archive goes, for tests; a page uses the browser's picker or download. */
  readonly sink?: DownloadSink;
  /** How long an upload waits before trying a failed request again, for tests; the uploader's own schedule otherwise. */
  readonly retryDelaysMs?: readonly number[];
}

export type TransferJobListener = (jobs: readonly TransferJob[]) => void;

/** How many finished transfers a session keeps listed. */
const MAX_FINISHED_JOBS = 20;
/** Progress reaches listeners at most this often, like an operation's does. */
const JOB_NOTIFY_MS = 200;

function copyKey(artifact: { readonly sha256: string; readonly size: number }): string {
  return `${artifact.sha256}:${artifact.size}`;
}

function asArtifactError(error: unknown): DeviceArtifactError {
  if (error instanceof DeviceArtifactError) return error;
  return new DeviceArtifactError(error instanceof Error ? error.message : String(error));
}

/**
 * A page-session artifact store. Browser Blobs remain out of operation frames;
 * only opaque ids and hashes cross the operation boundary. Each add/save waits
 * for IndexedDB commit, allowing escrow to survive a reload before a flash.
 *
 * It also turns a session's files into the two things a person wants of a backup: ONE zip to keep
 * (`downloadArtifacts`, `downloadSet`) and a verified copy on the server (`saveArtifactsToServer`,
 * `saveSetToServer`). Both stream, and both are listed as transfers (`jobs`, `subscribeJobs`, `cancelJob`) whether
 * the person or an agent started them.
 */
export class DeviceArtifactStore implements OperationArtifacts {
  private readonly sessions = new Map<string, Map<string, StoredDeviceArtifact>>();
  private readonly listeners = new Map<string, Set<DeviceArtifactListener>>();
  private readonly persistence = new IndexedDbArtifactPersistence();
  private readonly fetchImpl: FetchLike;
  private readonly sink: DownloadSink;
  private readonly retryDelaysMs: readonly number[] | undefined;
  /** What the server holds of each session's files, by SHA-256 and size (see ArtifactServerCopy). */
  private readonly serverCopies = new Map<string, Map<string, ArtifactServerCopy>>();
  private readonly transfers = new Map<string, TransferJob[]>();
  private readonly transferControllers = new Map<string, AbortController>();
  private readonly transferListeners = new Map<string, Set<TransferJobListener>>();
  private readonly transferTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(options: DeviceArtifactStoreOptions = {}) {
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.sink = options.sink ?? browserDownloadSink;
    this.retryDelaysMs = options.retryDelaysMs;
  }

  private entries(sessionId: string): Map<string, StoredDeviceArtifact> {
    let entries = this.sessions.get(sessionId);
    if (!entries) {
      entries = new Map();
      this.sessions.set(sessionId, entries);
    }
    return entries;
  }

  private publish(sessionId: string): void {
    const artifacts = this.list(sessionId);
    for (const listener of this.listeners.get(sessionId) ?? []) listener(artifacts);
  }

  async hydrate(sessionId: string): Promise<readonly DeviceArtifact[]> {
    const entries = this.entries(sessionId);
    const persisted = await this.persistence.list(sessionId);
    for (const artifact of persisted) entries.set(artifact.id, artifact);
    this.publish(sessionId);
    void this.refreshServerCopies(sessionId);
    return this.list(sessionId);
  }

  async add(sessionId: string, file: Blob, name: string, options: AddDeviceArtifactOptions = {}): Promise<DeviceArtifact> {
    if (!(file instanceof Blob)) throw new DeviceArtifactError("A browser Blob is required for a device artifact.");
    cryptoApi();
    const { sha256, crc32 } = await hashBlobWithCrc(file);
    const provenance = cleanProvenance(options.provenance);
    const artifact: StoredDeviceArtifact = {
      id: cryptoApi().randomUUID(),
      name: normalizeName(name),
      size: file.size,
      mime: file.type || "application/octet-stream",
      sha256,
      crc32,
      kind: options.kind ?? "input",
      source: options.source ?? "picker",
      createdAt: Date.now(),
      ...(provenance ? { provenance } : {}),
      blob: file,
    };
    await this.persistence.put(sessionId, artifact);
    this.entries(sessionId).set(artifact.id, artifact);
    this.publish(sessionId);
    return artifactMetadata(artifact);
  }

  /** Spool to browser-private disk; commit the Blob to escrow before deleting
   * the spool. No full-file JS array is ever constructed. */
  async saveStream(sessionId: string, name: string, chunks: AsyncIterable<Uint8Array>, signal: AbortSignal, provenance?: ArtifactProvenance): Promise<StreamArtifact> {
    if (!navigator.storage?.getDirectory) throw new DeviceArtifactError("This browser has no streaming file storage (OPFS).");
    const directory = await navigator.storage.getDirectory();
    const temporary = "cody-transfer-" + cryptoApi().randomUUID();
    const handle = await directory.getFileHandle(temporary, { create: true });
    const writer = await handle.createWritable();
    let closed = false;
    try {
      for await (const chunk of chunks) {
        signal.throwIfAborted();
        await writer.write(chunk as Uint8Array<ArrayBuffer>);
      }
      signal.throwIfAborted();
      await writer.close();
      closed = true;
      const artifact = await this.add(sessionId, await handle.getFile(), name, { kind: "output", source: "device", ...(provenance ? { provenance } : {}) });
      // Keep the independently escrowed Blob, not a File backed by the spool.
      const persisted = await this.persistence.get(sessionId, artifact.id);
      if (!persisted) throw new DeviceArtifactError("Streamed artifact escrow could not be read back.");
      this.entries(sessionId).set(artifact.id, persisted);
      return { fileId: artifact.id, sha256: artifact.sha256, length: artifact.size };
    } finally {
      if (!closed) await writer.abort().catch(() => undefined);
      await directory.removeEntry(temporary);
    }
  }

  async addInput(sessionId: string, file: File, name = file.name, source: Extract<DeviceArtifactSource, "picker" | "drop"> = "picker"): Promise<DeviceArtifact> {
    return this.add(sessionId, file, name, { kind: "input", source });
  }

  async importAuthorizedFile(sessionId: string, filePath: string, fetchImpl: FetchLike = fetch): Promise<DeviceArtifact> {
    const response = await fetchImpl(authorizedArtifactDownloadUrl(sessionId, filePath), { credentials: "same-origin" });
    if (!response.ok) throw new DeviceArtifactError(`Could not import the authorized file (${response.status}).`);
    return this.add(sessionId, await response.blob(), filenameFromPath(filePath), { kind: "input", source: "server-file" });
  }

  list(sessionId: string): readonly DeviceArtifact[] {
    const copies = this.serverCopies.get(sessionId);
    return [...this.entries(sessionId).values()]
      .sort((left, right) => right.createdAt - left.createdAt)
      .map((artifact) => artifactMetadata(artifact, copies?.get(copyKey(artifact))));
  }

  async getInput(sessionId: string, fileId: string): Promise<Blob | undefined> {
    const entries = this.entries(sessionId);
    const inMemory = entries.get(fileId);
    if (inMemory) return inMemory.blob;
    const persisted = await this.persistence.get(sessionId, fileId);
    if (!persisted) return undefined;
    entries.set(fileId, persisted);
    this.publish(sessionId);
    return persisted.blob;
  }

  /**
   * A file of this session whose bytes have the given SHA-256 (any case), looked up in memory first and then in the
   * persisted escrow. The digest is the store's own record from when the file was added; callers that rely on the bytes hash
   * them again.
   */
  async findBySha256(sessionId: string, sha256: string): Promise<Blob | undefined> {
    const wanted = sha256.toLowerCase();
    const entries = this.entries(sessionId);
    for (const artifact of entries.values()) if (artifact.sha256.toLowerCase() === wanted) return artifact.blob;
    const persisted = (await this.persistence.list(sessionId)).find((artifact) => artifact.sha256.toLowerCase() === wanted);
    if (!persisted) return undefined;
    entries.set(persisted.id, persisted);
    this.publish(sessionId);
    return persisted.blob;
  }

  async save(sessionId: string, name: string, blob: Blob, provenance?: ArtifactProvenance): Promise<string> {
    const artifact = await this.add(sessionId, blob, name, { kind: "output", source: "device", ...(provenance ? { provenance } : {}) });
    return artifact.id;
  }

  subscribe(sessionId: string, listener: DeviceArtifactListener): () => void {
    let listeners = this.listeners.get(sessionId);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(sessionId, listeners);
    }
    listeners.add(listener);
    listener(this.list(sessionId));
    return () => {
      const current = this.listeners.get(sessionId);
      current?.delete(listener);
      if (current?.size === 0) this.listeners.delete(sessionId);
    };
  }

  async remove(sessionId: string, artifactId: string): Promise<boolean> {
    return (await this.removeMany(sessionId, [artifactId])) === 1;
  }

  /** Every listed file of this session that exists, gone from memory and from the escrow; how many that was. */
  async removeMany(sessionId: string, artifactIds: readonly string[]): Promise<number> {
    const entries = this.entries(sessionId);
    const doomed = new Set(artifactIds);
    // A transfer of a file the person just removed is stopped, not left to finish with bytes they asked to drop.
    for (const job of this.jobs(sessionId)) {
      if (job.state === "running" && job.artifactIds.some((id) => doomed.has(id))) this.transferControllers.get(job.id)?.abort();
    }
    let removed = 0;
    try {
      for (const id of doomed) {
        if (!entries.has(id)) continue;
        await this.persistence.delete(sessionId, id);
        entries.delete(id);
        removed += 1;
      }
    } finally {
      if (removed > 0) this.publish(sessionId);
    }
    return removed;
  }

  /** The sets of this session's outputs, newest first (see ./artifact-sets.ts). */
  sets(sessionId: string): readonly ArtifactSet[] {
    return groupArtifactSets(this.list(sessionId));
  }

  private requireSet(sessionId: string, setId: string): ArtifactSet {
    const set = this.sets(sessionId).find((candidate) => candidate.id === setId);
    if (!set) throw new DeviceArtifactError("This set is no longer in the current session.", "not-found");
    return set;
  }

  async removeSet(sessionId: string, setId: string): Promise<number> {
    return this.removeMany(sessionId, this.requireSet(sessionId, setId).artifactIds);
  }

  /**
   * Joins a set to the next older one of the same device by filing every file of both under one set name. The name is the
   * older set's (an agent's, or one made up that no card shows). It is kept beside the files in the browser's database, so
   * the combined set is still one set after a reload. Refused while a transfer is reading either set: those files must not
   * move under it. Resolves to the combined set.
   */
  async combineWithOlder(sessionId: string, setId: string): Promise<ArtifactSet> {
    const sets = this.sets(sessionId);
    const newer = sets.find((candidate) => candidate.id === setId);
    if (!newer) throw new DeviceArtifactError("This set is no longer in the current session.", "not-found");
    const older = olderSetOf(sets, newer);
    if (!older) throw new DeviceArtifactError("There is no older backup of this device to combine this one with.", "not-found");
    const members = new Set([...newer.artifactIds, ...older.artifactIds]);
    if (this.jobs(sessionId).some((job) => job.state === "running" && job.artifactIds.some((id) => members.has(id)))) {
      throw new DeviceArtifactError("Wait until the transfer of these files has finished, then combine them.", "busy");
    }
    const entries = this.entries(sessionId);
    const nameOf = (set: ArtifactSet): string | undefined => set.artifactIds.map((id) => entries.get(id)).flatMap((stored) => (stored ? [effectiveSetName(stored)] : [])).find((name) => name !== undefined);
    const name = nameOf(older) ?? nameOf(newer) ?? combinedSetName(cryptoApi().randomUUID());
    const changed = [...members].filter((id) => {
      const stored = entries.get(id);
      return stored !== undefined && effectiveSetName(stored) !== name;
    });
    await this.persistence.putSetNames(sessionId, changed.map((id) => [id, name] as const));
    for (const id of changed) entries.set(id, { ...entries.get(id)!, setName: name });
    this.publish(sessionId);
    const combined = this.sets(sessionId).find((candidate) => candidate.artifactIds.includes(older.artifactIds[0]!));
    if (!combined) throw new DeviceArtifactError("The combined set could not be found again. Refresh the list.", "not-found");
    return combined;
  }

  getSetSaveState(sessionId: string, setId: string): SetSaveState {
    const artifacts = this.list(sessionId);
    const set = groupArtifactSets(artifacts).find((candidate) => candidate.id === setId);
    return set ? setSaveState(set, artifacts) : { state: "none" };
  }

  /**
   * Asks the server which of this session's files it holds a verified copy of, and marks them (`artifact.server`).
   * Never throws: a server that cannot be asked just means nothing new is shown as saved.
   */
  async refreshServerCopies(sessionId: string): Promise<void> {
    let saves: readonly ServerSave[];
    try {
      saves = await listServerSaves(sessionId, this.fetchImpl);
    } catch {
      return;
    }
    const next = new Map<string, ArtifactServerCopy>();
    for (const save of saves) {
      for (const file of save.files) {
        next.set(copyKey(file), { saveId: save.saveId, archive: save.archive, entry: file.entry, archiveBytes: save.archiveBytes ?? 0, originalBytes: save.totalBytes, savedAt: save.completedAt ?? save.createdAt, verified: save.verified });
      }
    }
    const previous = this.serverCopies.get(sessionId);
    const unchanged = previous && previous.size === next.size && [...next].every(([key, copy]) => previous.get(key)?.saveId === copy.saveId && previous.get(key)?.savedAt === copy.savedAt);
    if (unchanged) return;
    this.serverCopies.set(sessionId, next);
    this.publish(sessionId);
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Transfers: one zip to keep, a verified copy on the server
  // -------------------------------------------------------------------------------------------------------------------

  /** Every transfer of this session in the order they started, the person's and an agent's alike; the latest 20 finished ones stay listed. */
  jobs(sessionId: string): readonly TransferJob[] {
    return this.transfers.get(sessionId) ?? [];
  }

  subscribeJobs(sessionId: string, listener: TransferJobListener): () => void {
    let listeners = this.transferListeners.get(sessionId);
    if (!listeners) {
      listeners = new Set();
      this.transferListeners.set(sessionId, listeners);
    }
    listeners.add(listener);
    listener(this.jobs(sessionId));
    return () => {
      const current = this.transferListeners.get(sessionId);
      current?.delete(listener);
      if (current?.size === 0) this.transferListeners.delete(sessionId);
    };
  }

  /** Stops a running transfer; false when there is none by that id. A cancelled save keeps what already reached the server. */
  cancelJob(sessionId: string, jobId: string): boolean {
    const job = this.jobs(sessionId).find((candidate) => candidate.id === jobId);
    if (job?.state !== "running") return false;
    this.transferControllers.get(jobId)?.abort();
    return true;
  }

  private notifyJobs(sessionId: string, immediately: boolean): void {
    const flush = (): void => {
      clearTimeout(this.transferTimers.get(sessionId));
      this.transferTimers.delete(sessionId);
      const snapshot = [...this.jobs(sessionId)];
      for (const listener of this.transferListeners.get(sessionId) ?? []) listener(snapshot);
    };
    if (immediately) flush();
    else if (!this.transferTimers.has(sessionId)) this.transferTimers.set(sessionId, setTimeout(flush, JOB_NOTIFY_MS));
  }

  private putJob(sessionId: string, job: TransferJob, immediately: boolean): void {
    const jobs = [...this.jobs(sessionId)];
    const index = jobs.findIndex((candidate) => candidate.id === job.id);
    if (index >= 0) jobs[index] = job;
    else jobs.push(job);
    // Finished transfers beyond the latest MAX_FINISHED_JOBS are forgotten, oldest first; a running one never is.
    let finished = jobs.filter((candidate) => candidate.state !== "running").length;
    for (let at = 0; at < jobs.length && finished > MAX_FINISHED_JOBS;) {
      if (jobs[at]!.state === "running") at += 1;
      else {
        jobs.splice(at, 1);
        finished -= 1;
      }
    }
    this.transfers.set(sessionId, jobs);
    this.notifyJobs(sessionId, immediately);
  }

  private runTransfer<Result extends DownloadResult | ServerSaveResult>(
    sessionId: string,
    spec: { kind: TransferJob["kind"]; setId?: string; artifactIds: readonly string[]; label: string; origin: TransferJob["origin"]; total: number; totalBytes: number; phase: TransferProgress["phase"] },
    outer: AbortSignal | undefined,
    work: (control: { signal: AbortSignal; progress: (progress: TransferProgress) => void }) => Promise<Result>,
  ): { id: string; finished: Promise<Result> } {
    const id = cryptoApi().randomUUID();
    const controller = new AbortController();
    if (outer?.aborted) controller.abort();
    else outer?.addEventListener("abort", () => controller.abort(), { once: true });
    this.transferControllers.set(id, controller);
    let job: TransferJob = {
      id,
      kind: spec.kind,
      ...(spec.setId ? { setId: spec.setId } : {}),
      artifactIds: spec.artifactIds,
      label: spec.label,
      state: "running",
      progress: { phase: spec.phase, done: 0, total: spec.total, bytes: 0, totalBytes: spec.totalBytes },
      startedAt: Date.now(),
      origin: spec.origin,
    };
    this.putJob(sessionId, job, true);
    const settle = (patch: Partial<TransferJob>): void => {
      job = { ...job, ...patch, endedAt: Date.now() };
      this.transferControllers.delete(id);
      this.putJob(sessionId, job, true);
    };
    const finished = work({
      signal: controller.signal,
      progress: (progress) => {
        job = { ...job, progress };
        this.putJob(sessionId, job, false);
      },
    }).then(
      (result) => {
        settle({ state: "succeeded", result });
        return result;
      },
      (error: unknown) => {
        const failure = asArtifactError(error);
        settle(failure.code === "aborted" ? { state: "cancelled" } : { state: "failed", error: { code: failure.code, message: failure.message } });
        throw failure;
      },
    );
    return { id, finished };
  }

  /** The stored files for these ids, oldest first, loaded from the escrow when they are not in memory. */
  private async loadStored(sessionId: string, artifactIds: readonly string[]): Promise<StoredDeviceArtifact[]> {
    const found: StoredDeviceArtifact[] = [];
    for (const id of new Set(artifactIds)) {
      await this.getInput(sessionId, id);
      const stored = this.entries(sessionId).get(id);
      if (!stored) throw new DeviceArtifactError("One of the selected files is no longer in this session. Refresh the list and try again.", "not-found");
      found.push(stored);
    }
    return found.sort((left, right) => left.createdAt - right.createdAt || (left.name < right.name ? -1 : 1));
  }

  private selectedBytes(sessionId: string, artifactIds: readonly string[]): number {
    const entries = this.entries(sessionId);
    return artifactIds.reduce((total, id) => total + (entries.get(id)?.size ?? 0), 0);
  }

  /**
   * One .zip of these files, deflate-compressed (ZIP64 where a size needs it, with `SHA256SUMS` and `manifest.json` inside),
   * whatever the device and however many files. Call it straight from the click: where the browser has a Save-as picker it
   * opens first, which needs that click's user activation. Resolves when the archive is fully written (picker) or handed to
   * the browser's download.
   */
  async downloadArtifacts(sessionId: string, artifactIds: readonly string[], options: TransferOptions & { archiveName?: string; label?: string; setId?: string; origin?: TransferJob["origin"] } = {}): Promise<DownloadResult> {
    const ids = [...new Set(artifactIds)];
    if (ids.length === 0) throw new DeviceArtifactError("There is nothing to download.", "not-found");
    const label = options.label ?? "Device files";
    const fileName = options.archiveName ?? archiveFileName(label, Date.now());
    const chosen = this.sink.choose(fileName);
    chosen.catch(() => undefined);
    const { finished } = this.runTransfer(
      sessionId,
      { kind: "download", ...(options.setId ? { setId: options.setId } : {}), artifactIds: ids, label, origin: options.origin ?? "user", total: ids.length, totalBytes: this.selectedBytes(sessionId, ids), phase: "writing" },
      options.signal,
      async ({ signal, progress }) => {
        const stored = await this.loadStored(sessionId, ids);
        const entries: ArchiveInput[] = stored.map((artifact) => ({
          id: artifact.id,
          name: artifact.name,
          size: artifact.size,
          sha256: artifact.sha256,
          kind: artifact.kind,
          source: artifact.source,
          createdAt: artifact.createdAt,
          ...(artifact.provenance ? { provenance: artifact.provenance } : {}),
          ...(artifact.crc32 === undefined ? {} : { crc32: artifact.crc32 }),
          blob: artifact.blob,
        }));
        return exportArchive(entries, {
          sessionId,
          label,
          fileName,
          sink: this.sink,
          chosen,
          signal,
          onProgress: (value) => {
            progress(value);
            options.onProgress?.(value);
          },
        });
      },
    );
    // A file the person picked but that was never written to (the transfer failed first) is not left half-open.
    finished.catch(async () => {
      const target = await chosen.catch(() => undefined);
      if (target && !target.locked) await target.abort().catch(() => undefined);
    });
    return finished;
  }

  async downloadSet(sessionId: string, setId: string, options: TransferOptions & { label?: string } = {}): Promise<DownloadResult> {
    const set = this.requireSet(sessionId, setId);
    return this.downloadArtifacts(sessionId, set.artifactIds, { ...options, label: options.label ?? setFileLabel(set), setId });
  }

  /**
   * Begins saving these files to the server as ONE archive and returns at once: `begun` settles when the server has accepted
   * the announcement (so the archive's name is known), `finished` when every file is stored, packed and the finished archive
   * has been re-read from the server's disk and matched. An agent's save uses this so it can answer the agent before the
   * bytes have moved.
   */
  startServerSave(sessionId: string, artifactIds: readonly string[], options: TransferOptions & { label?: string; setId?: string; origin?: TransferJob["origin"] } = {}): { jobId: string; begun: Promise<SaveBegun>; finished: Promise<ServerSaveResult> } {
    const ids = [...new Set(artifactIds)];
    if (ids.length === 0) throw new DeviceArtifactError("There are no files to save.", "not-found");
    const label = options.label ?? "Device files";
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const begun = Promise.withResolvers<SaveBegun>();
    begun.promise.catch(() => undefined);
    const { id, finished } = this.runTransfer(
      sessionId,
      { kind: "save", ...(options.setId ? { setId: options.setId } : {}), artifactIds: ids, label, origin: options.origin ?? "user", total: ids.length, totalBytes: this.selectedBytes(sessionId, ids), phase: "uploading" },
      options.signal,
      async ({ signal, progress }) => {
        try {
          const stored = await this.loadStored(sessionId, ids);
          const files: UploadFile[] = stored.map((artifact) => ({
            artifactId: artifact.id,
            name: artifact.name,
            size: artifact.size,
            sha256: artifact.sha256,
            kind: artifact.kind,
            source: artifact.source,
            createdAt: artifact.createdAt,
            ...(artifact.provenance ? { provenance: artifact.provenance } : {}),
            blob: artifact.blob,
          }));
          const result = await uploadToServer(files, {
            sessionId,
            label,
            signal,
            fetch: this.fetchImpl,
            ...(this.retryDelaysMs ? { retryDelaysMs: this.retryDelaysMs } : {}),
            ...(timeZone ? { timeZone } : {}),
            onBegun: (info) => begun.resolve(info),
            onProgress: (value) => {
              progress(value);
              options.onProgress?.(value);
            },
          });
          await this.refreshServerCopies(sessionId);
          return result;
        } catch (error) {
          begun.reject(asArtifactError(error));
          throw error;
        }
      },
    );
    return { jobId: id, begun: begun.promise, finished };
  }

  /** Saves these files to the server as one archive and resolves when it is finished and verified (see startServerSave). */
  saveArtifactsToServer(sessionId: string, artifactIds: readonly string[], options: TransferOptions & { label?: string; setId?: string } = {}): Promise<ServerSaveResult> {
    return this.startServerSave(sessionId, artifactIds, options).finished;
  }

  saveSetToServer(sessionId: string, setId: string, options: TransferOptions & { label?: string } = {}): Promise<ServerSaveResult> {
    const set = this.requireSet(sessionId, setId);
    return this.startServerSave(sessionId, set.artifactIds, { ...options, label: options.label ?? setFileLabel(set), setId }).finished;
  }

  /** Deliberate user export: no automatic downloads are created for device output. */
  download(sessionId: string, artifactId: string): void {
    const artifact = this.entries(sessionId).get(artifactId);
    if (!artifact) throw new DeviceArtifactError("This artifact is not available in the current session.");
    const url = URL.createObjectURL(artifact.blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = artifact.name;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

interface DeviceArtifactGlobal {
  store?: DeviceArtifactStore;
}

const artifactGlobal = globalThis as typeof globalThis & { __codyDeviceArtifacts?: DeviceArtifactGlobal };
const singleton = (artifactGlobal.__codyDeviceArtifacts ??= {});

/** Shared by the panel and the page-side operation manager. IndexedDB is the escrow boundary. */
export const deviceArtifacts = singleton.store ??= new DeviceArtifactStore();

export function authorizedArtifactDownloadUrl(sessionId: string, filePath: string): string {
  if (!sessionId.trim()) throw new DeviceArtifactError("A device session is required to import a server file.");
  if (!filePath.trim()) throw new DeviceArtifactError("A file path is required.");
  return `/api/files/${encodeFilePathForApi(filePath)}?type=download&sessionId=${encodeURIComponent(sessionId)}`;
}
