import type { OperationArtifacts } from "./operations";
import { encodeFilePathForApi } from "@/lib/file-paths";
import { hashBlobWithCrc } from "./blob-stream";
import type { StreamArtifact } from "./flasher";
import { groupArtifactSets, setSaveState } from "./artifact-sets";
import {
  DeviceArtifactError,
  type ArtifactProvenance,
  type ArtifactServerCopy,
  type ArtifactSet,
  type DeviceArtifact,
  type DeviceArtifactKind,
  type DeviceArtifactSource,
  type SetSaveState,
} from "./artifact-model";

export { DeviceArtifactError } from "./artifact-model";
export type {
  ArtifactProvenance,
  ArtifactServerCopy,
  ArtifactSet,
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
  /** CRC-32 of the bytes, taken with the SHA-256 when the file was saved; a ZIP entry needs it. Files saved earlier have none. */
  readonly crc32?: number;
}

interface PersistedDeviceArtifact {
  readonly key: string;
  readonly sessionId: string;
  readonly artifact: StoredDeviceArtifact;
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
    ...(server ? { server } : {}),
  };
}
function artifactKey(sessionId: string, artifactId: string): string {
  return `${sessionId}:${artifactId}`;
}

const MAX_PROVENANCE_TEXT = 200;

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
  return { operationId, deviceId, protocol, action, ...(target ? { target } : {}), ...(command ? { command } : {}), ...(label ? { label } : {}) };
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
    const request = transaction.objectStore(STORE_NAME).get(artifactKey(sessionId, artifactId)) as IDBRequest<PersistedDeviceArtifact | undefined>;
    const value = await waitForTransaction(transaction, request);
    return value?.artifact;
  }

  async list(sessionId: string): Promise<readonly StoredDeviceArtifact[]> {
    const database = await this.open();
    const transaction = database.transaction(STORE_NAME, "readonly");
    const request = transaction.objectStore(STORE_NAME).index("sessionId").getAll(sessionId) as IDBRequest<PersistedDeviceArtifact[]>;
    return (await waitForTransaction(transaction, request)).map(({ artifact }) => artifact);
  }

  async delete(sessionId: string, artifactId: string): Promise<void> {
    const database = await this.open();
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const request = transaction.objectStore(STORE_NAME).delete(artifactKey(sessionId, artifactId));
    await waitForTransaction(transaction, request);
  }
}

/**
 * A page-session artifact store. Browser Blobs remain out of operation frames;
 * only opaque ids and hashes cross the operation boundary. Each add/save waits
 * for IndexedDB commit, allowing escrow to survive a reload before a flash.
 */
export class DeviceArtifactStore implements OperationArtifacts {
  private readonly sessions = new Map<string, Map<string, StoredDeviceArtifact>>();
  private readonly listeners = new Map<string, Set<DeviceArtifactListener>>();
  private readonly persistence = new IndexedDbArtifactPersistence();

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
    return [...this.entries(sessionId).values()]
      .sort((left, right) => right.createdAt - left.createdAt)
      .map((artifact) => artifactMetadata(artifact));
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
    let removed = 0;
    try {
      for (const id of new Set(artifactIds)) {
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

  async removeSet(sessionId: string, setId: string): Promise<number> {
    const set = this.sets(sessionId).find((candidate) => candidate.id === setId);
    if (!set) throw new DeviceArtifactError("This set is no longer in the current session.", "not-found");
    return this.removeMany(sessionId, set.artifactIds);
  }

  getSetSaveState(sessionId: string, setId: string): SetSaveState {
    const artifacts = this.list(sessionId);
    const set = groupArtifactSets(artifacts).find((candidate) => candidate.id === setId);
    return set ? setSaveState(set, artifacts) : { state: "none" };
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
