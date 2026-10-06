/**
 * The page's half of "Save to server": a resumable upload of browser-held
 * files to the artifact vault (./artifact-vault.ts).
 *
 * Nothing is read into memory beyond one slice. The save is announced with every
 * file's name, size and SHA-256 and a key made of those, so announcing the same
 * save again (a retry, a reload, an agent asking twice) finds the stored bytes
 * instead of starting over, and a save that is already complete answers as such.
 * Each file goes up in 4 MiB slices at the offset the server says it has, is
 * re-read from the server's disk to check its SHA-256, and only then does the
 * save finish. A dropped connection, a slice the framework cut short and a
 * response that never arrived are retried after asking the server what it holds;
 * a file that arrives damaged is sent again once.
 *
 * Cancelling stops at once and keeps what already arrived, so pressing Save
 * again carries on instead of repeating the part that went through.
 */

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { isRecord } from "../type-guards";
import { DeviceArtifactError, type ArtifactProvenance, type ServerSaveResult, type TransferProgress } from "./artifact-model";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export const SAVES_ROUTE = "/api/devices/artifacts/saves";
/** Well under the 10 MB a request body is buffered to, and under the server's 8 MiB cap. */
export const UPLOAD_SLICE_BYTES = 4 * 1024 * 1024;
const RETRY_DELAYS_MS: readonly number[] = [400, 1500, 4000, 9000];

export interface UploadFile {
  readonly artifactId: string;
  readonly name: string;
  readonly size: number;
  readonly sha256: string;
  readonly kind: string;
  readonly source: string;
  readonly createdAt: number;
  readonly provenance?: ArtifactProvenance;
  readonly blob: Blob;
}

/** What the server answers about a save (lib/devices/artifact-vault.ts `SaveStatus`). */
export interface ServerSaveFile {
  readonly index: number;
  readonly name: string;
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
  readonly received: number;
  readonly verified: boolean;
}

export interface ServerSave {
  readonly saveId: string;
  readonly state: "uploading" | "complete";
  readonly label: string;
  readonly sessionId: string;
  readonly folder: string;
  readonly manifestPath?: string;
  readonly files: readonly ServerSaveFile[];
  readonly totalBytes: number;
  readonly receivedBytes: number;
  readonly createdAt: number;
  readonly completedAt?: number;
  readonly verified: boolean;
  readonly existing?: boolean;
  readonly resumed?: boolean;
}

/** What the caller learns as soon as the server has accepted the announcement, before any byte moves. */
export interface SaveBegun {
  readonly saveId: string;
  /** Where the save will be, or already is. */
  readonly folder: string;
  readonly files: number;
  readonly bytes: number;
  readonly resumed: boolean;
  readonly alreadySaved: boolean;
}

export interface UploadOptions {
  readonly sessionId: string;
  readonly label: string;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: TransferProgress) => void;
  readonly onBegun?: (begun: SaveBegun) => void;
  readonly fetch?: FetchLike;
  readonly sliceBytes?: number;
  readonly retryDelaysMs?: readonly number[];
  /** The person's IANA time zone, so the folder is dated the day they made the save. */
  readonly timeZone?: string;
}

/** A failure of the network itself, which is the only kind worth retrying blindly. */
class NetworkFailure extends Error {}

interface Failure {
  readonly status: number;
  readonly code: string | undefined;
  readonly message: string;
  readonly received: number | undefined;
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException ? error.name === "AbortError" : error instanceof Error && error.name === "AbortError";
}

function cancelled(): DeviceArtifactError {
  return new DeviceArtifactError("Saving to the server was cancelled. What already arrived is kept, so saving again carries on from there.", "aborted");
}

async function readFailure(response: Response): Promise<Failure> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    // A body that is not JSON (a proxy's error page) is described by its status below.
  }
  const record = isRecord(body) ? body : {};
  return {
    status: response.status,
    code: typeof record.code === "string" ? record.code : undefined,
    message: typeof record.error === "string" ? record.error : "",
    received: typeof record.received === "number" ? record.received : undefined,
  };
}

/** A save description from the server, checked on the fields this module reads: anything else is a server that is not ours. */
function saveFrom(value: unknown): ServerSave {
  if (!isRecord(value) || typeof value.saveId !== "string" || typeof value.folder !== "string" || !Array.isArray(value.files) || (value.state !== "uploading" && value.state !== "complete")) {
    throw new DeviceArtifactError("The server did not answer with a save description. Cody on the server may be an older version without this feature.", "server-refused");
  }
  return value as unknown as ServerSave;
}

function receivedFrom(value: unknown): number {
  if (isRecord(value) && typeof value.received === "number") return value.received;
  throw new DeviceArtifactError("The server did not say how much of the slice it kept.", "server-refused");
}

function explain(failure: Failure): DeviceArtifactError {
  const message = failure.message || `The server answered ${failure.status}.`;
  if (failure.status === 401) return new DeviceArtifactError("The server no longer accepts this browser's sign-in. Sign in again and press Save to server: what already arrived is kept.", "unauthorized");
  if (failure.status === 403) return new DeviceArtifactError(message, "unauthorized");
  if (failure.code === "hash_mismatch") return new DeviceArtifactError(message, "hash-mismatch");
  if (failure.status === 413) return new DeviceArtifactError(message, "too-large");
  if (failure.status === 507) return new DeviceArtifactError(message, "disk-full");
  return new DeviceArtifactError(message, "server-refused");
}

/** True for a failure another attempt can fix: the network, a gateway, or a slice the framework cut short. */
function worthRetrying(failure: Failure): boolean {
  return (failure.status >= 500 && failure.status !== 507) || failure.status === 408 || failure.status === 429 || failure.code === "truncated";
}

function pause(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  if (signal?.aborted) {
    reject(cancelled());
    return promise;
  }
  const onAbort = (): void => {
    clearTimeout(timer);
    reject(cancelled());
  };
  const timer = setTimeout(() => {
    signal?.removeEventListener("abort", onAbort);
    resolve();
  }, milliseconds);
  signal?.addEventListener("abort", onAbort, { once: true });
  return promise;
}

/** One key for one save: the same chat, label and files always give the same one, whatever order they are listed in. */
export function saveKey(sessionId: string, label: string, files: readonly { name: string; size: number; sha256: string }[]): string {
  const lines = files.map((file) => `${file.sha256}:${file.size}:${file.name}`).sort();
  return bytesToHex(sha256(new TextEncoder().encode([sessionId, label, ...lines].join("\n"))));
}

function toResult(save: ServerSave, resumed: boolean, alreadySaved: boolean): ServerSaveResult {
  const separator = save.folder.includes("\\") && !save.folder.includes("/") ? "\\" : "/";
  return {
    saveId: save.saveId,
    path: save.folder,
    manifestPath: save.manifestPath ?? `${save.folder}${separator}manifest.json`,
    files: save.files.length,
    bytes: save.totalBytes,
    verified: save.verified,
    resumed,
    ...(alreadySaved ? { alreadySaved: true } : {}),
  };
}

/** The finished saves of a chat that the server holds, oldest first. Throws when the server cannot be asked. */
export async function listServerSaves(sessionId: string, fetchImpl: FetchLike = fetch): Promise<readonly ServerSave[]> {
  const response = await fetchImpl(`${SAVES_ROUTE}?sessionId=${encodeURIComponent(sessionId)}`, { credentials: "same-origin" });
  if (!response.ok) throw explain(await readFailure(response));
  const body: unknown = await response.json();
  const saves = isRecord(body) && Array.isArray(body.saves) ? body.saves.map(saveFrom) : [];
  return saves.sort((left, right) => (left.completedAt ?? left.createdAt) - (right.completedAt ?? right.createdAt));
}

/**
 * Uploads `files` and returns where they are. Throws a DeviceArtifactError whose message can be shown as it is:
 * `aborted` for a cancel, `unreachable`, `unauthorized`, `too-large`, `disk-full`, `hash-mismatch` or `server-refused`.
 */
export async function uploadToServer(files: readonly UploadFile[], options: UploadOptions): Promise<ServerSaveResult> {
  if (files.length === 0) throw new DeviceArtifactError("There are no files to save.", "not-found");
  const fetchImpl = options.fetch ?? fetch;
  const { signal } = options;
  const sliceBytes = options.sliceBytes ?? UPLOAD_SLICE_BYTES;
  const delays = options.retryDelaysMs ?? RETRY_DELAYS_MS;
  const totalBytes = files.reduce((total, file) => total + file.size, 0);
  const progress = { done: 0, bytes: 0 };
  const report = (phase: TransferProgress["phase"], currentName?: string): void => {
    options.onProgress?.({ phase, done: progress.done, total: files.length, bytes: Math.min(progress.bytes, totalBytes), totalBytes, ...(currentName ? { currentName } : {}) });
  };

  /** One request, with the network's failures told apart from the server's answers. */
  const request = async (url: string, init: RequestInit): Promise<Response> => {
    if (signal?.aborted) throw cancelled();
    try {
      return await fetchImpl(url, { ...init, ...(signal ? { signal } : {}), credentials: "same-origin" });
    } catch (error) {
      if (signal?.aborted || isAbort(error)) throw cancelled();
      throw new NetworkFailure(error instanceof Error ? error.message : String(error));
    }
  };
  const unreachable = (cause: NetworkFailure): DeviceArtifactError =>
    new DeviceArtifactError(`Could not reach the Cody server (${cause.message}). Check the connection and press Save to server again: what already arrived is kept.`, "unreachable");

  /** A call that is safe to repeat, retried on a network failure or a 5xx; anything else the server said is final. */
  const repeatable = async (url: string, init: RequestInit): Promise<Response> => {
    for (let attempt = 0; ; attempt += 1) {
      let failure: Failure | undefined;
      try {
        const response = await request(url, init);
        if (response.ok) return response;
        failure = await readFailure(response);
        if (!worthRetrying(failure)) throw explain(failure);
      } catch (error) {
        if (!(error instanceof NetworkFailure)) throw error;
        if (attempt >= delays.length) throw unreachable(error);
      }
      if (failure && attempt >= delays.length) throw explain(failure);
      await pause(delays[Math.min(attempt, delays.length - 1)] ?? 0, signal);
    }
  };

  const announcement = {
    sessionId: options.sessionId,
    label: options.label,
    key: saveKey(options.sessionId, options.label, files),
    ...(options.timeZone ? { timeZone: options.timeZone } : {}),
    files: files.map((file) => ({
      name: file.name,
      size: file.size,
      sha256: file.sha256,
      kind: file.kind,
      source: file.source,
      createdAt: file.createdAt,
      artifactId: file.artifactId,
      ...(file.provenance
        ? { operation: { id: file.provenance.operationId, deviceId: file.provenance.deviceId, protocol: file.provenance.protocol, action: file.provenance.action, ...(file.provenance.label ? { deviceLabel: file.provenance.label } : {}), ...(file.provenance.target ? { target: file.provenance.target } : {}), ...(file.provenance.command ? { command: file.provenance.command } : {}) } }
        : {}),
    })),
  };
  const announce = async (): Promise<ServerSave> =>
    saveFrom(await (await repeatable(SAVES_ROUTE, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(announcement) })).json());

  let save = await announce();
  const begun: SaveBegun = { saveId: save.saveId, folder: save.folder, files: files.length, bytes: totalBytes, resumed: save.resumed === true, alreadySaved: save.state === "complete" };
  options.onBegun?.(begun);
  if (save.state === "complete") {
    progress.done = files.length;
    progress.bytes = totalBytes;
    report("verifying");
    return toResult(save, false, true);
  }
  const resumed = save.resumed === true;
  progress.done = save.files.filter((file) => file.verified).length;
  progress.bytes = save.files.reduce((total, file) => total + file.received, 0);

  const route = (): string => `${SAVES_ROUTE}/${save.saveId}`;
  /** What the server holds of a file now, after a failure that left it unclear whether a slice landed. */
  const stored = async (index: number): Promise<number> => {
    const response = await repeatable(route(), { method: "GET" });
    const current = saveFrom(await response.json());
    return current.files[index]?.received ?? 0;
  };

  const sendSlice = async (index: number, offset: number, blob: Blob): Promise<number> => {
    for (let attempt = 0; ; attempt += 1) {
      let failure: Failure | undefined;
      try {
        const response = await request(`${route()}?file=${index}&offset=${offset}`, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: blob });
        if (response.ok) return receivedFrom(await response.json());
        failure = await readFailure(response);
        // The server holds a different length than we thought (an earlier try landed, or the save was restarted): take its word.
        if (failure.status === 409 && failure.code === "offset_mismatch" && failure.received !== undefined) return failure.received;
        if (failure.status === 404 && failure.code === "unknown_save") {
          save = await announce();
          return save.files[index]?.received ?? 0;
        }
        if (!worthRetrying(failure)) throw explain(failure);
      } catch (error) {
        if (!(error instanceof NetworkFailure)) throw error;
        if (attempt >= delays.length) throw unreachable(error);
      }
      if (failure && attempt >= delays.length) throw explain(failure);
      await pause(delays[Math.min(attempt, delays.length - 1)] ?? 0, signal);
      // The slice may have landed even though its answer did not: ask before sending it again.
      const held = await stored(index);
      if (held !== offset) return held;
    }
  };

  for (const [index, file] of files.entries()) {
    const status = save.files[index];
    if (status?.verified) continue;
    let offset = status?.received ?? 0;
    for (let sends = 0; ; sends += 1) {
      while (offset < file.size) {
        report("uploading", file.name);
        const end = Math.min(offset + sliceBytes, file.size);
        const received = await sendSlice(index, offset, file.blob.slice(offset, end));
        progress.bytes += received - offset;
        offset = received;
      }
      report("verifying", file.name);
      try {
        await repeatable(route(), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "verify", file: index }) });
        break;
      } catch (error) {
        // The server deleted the damaged copy; one more try from the first byte, then say so.
        if (error instanceof DeviceArtifactError && error.code === "hash-mismatch" && sends === 0) {
          progress.bytes -= offset;
          offset = 0;
          continue;
        }
        throw error;
      }
    }
    progress.done += 1;
    report("uploading", file.name);
  }

  report("verifying");
  const finished = saveFrom(await (await repeatable(route(), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "complete" }) })).json());
  progress.bytes = totalBytes;
  report("verifying");
  return toResult(finished, resumed, false);
}
