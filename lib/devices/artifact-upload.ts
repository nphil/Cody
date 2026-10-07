/**
 * The page's half of "Save to server": a resumable upload of browser-held
 * files to the artifact vault (./artifact-vault.ts), which packs them into ONE
 * compressed archive.
 *
 * Nothing is read into memory beyond one slice. The save is announced with every
 * file's name, size and SHA-256 and a key made of those, so announcing the same
 * save again (a retry, a reload, an agent asking twice) finds the stored bytes
 * instead of starting over, and a save that is already complete answers as such.
 * Each file goes up in 4 MiB slices at the offset the server says it has, is
 * re-read from the server's disk to check its SHA-256, and only then does the
 * server write the archive. A dropped connection, a slice the framework cut short
 * and a response that never arrived are retried after asking the server what it
 * holds; a file that arrives damaged is sent again once.
 *
 * Writing the archive of a large save takes longer than a request should wait, so
 * the server answers `building` and this asks again about once a second until it
 * is `complete`. A build that fails is reported with the server's own words; the
 * files stay on the server, so pressing Save again starts the packing again and
 * sends nothing twice.
 *
 * Cancelling stops at once and keeps what already arrived, so pressing Save
 * again carries on instead of repeating the part that went through. A build the
 * server is already running carries on; saving again finds it finished.
 */

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { isRecord } from "../type-guards";
import { operationInfos } from "./artifact-archive";
import { DeviceArtifactError, type ArtifactProvenance, type ServerSaveResult, type TransferProgress } from "./artifact-model";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export const SAVES_ROUTE = "/api/devices/artifacts/saves";
/** Well under the 10 MB a request body is buffered to, and under the server's 8 MiB cap. */
export const UPLOAD_SLICE_BYTES = 4 * 1024 * 1024;
const RETRY_DELAYS_MS: readonly number[] = [400, 1500, 4000, 9000];
/** How often a build in progress is asked about. */
const BUILD_POLL_MS = 1000;
/** A server that has forgotten the build this many times in a row is not going to finish it. */
const MAX_BUILD_RESTARTS = 3;
/** A server that loses the save this many times while its files are still arriving is not going to keep it. */
const MAX_REANNOUNCES = 3;
/** What the server calls a build that stopped for want of room. */
const NO_ROOM_CODES: readonly string[] = ["disk_full", "quota_exceeded"];
/** What the server calls a build that failed: a second `complete` would only fail the same way, so it is not retried blindly. */
const BUILD_FAILED_CODES: readonly string[] = ["archive_check_failed", "changed", "build_failed"];

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
  /** The file's full path inside the archive. */
  readonly entry: string;
  readonly size: number;
  readonly sha256: string;
  readonly received: number;
  readonly verified: boolean;
}

export interface ServerSaveBuildError {
  /** `disk_full`, `quota_exceeded`, `archive_check_failed`, `changed` or `build_failed`. */
  readonly code: string;
  readonly message: string;
}

export interface ServerSave {
  readonly saveId: string;
  /** `building`: every file is verified and the server is writing the archive. */
  readonly state: "uploading" | "building" | "complete";
  readonly label: string;
  readonly sessionId: string;
  /** The one .zip the save is, or will be once it completes. */
  readonly archive: string;
  /** What the finished archive is on the server's disk. */
  readonly archiveBytes?: number;
  /** While building: the original bytes packed so far. */
  readonly packedBytes?: number;
  readonly files: readonly ServerSaveFile[];
  readonly totalBytes: number;
  readonly receivedBytes: number;
  readonly createdAt: number;
  readonly completedAt?: number;
  readonly verified: boolean;
  readonly existing?: boolean;
  readonly resumed?: boolean;
  readonly buildError?: ServerSaveBuildError;
}

/** What the caller learns as soon as the server has accepted the announcement, before any byte moves. */
export interface SaveBegun {
  readonly saveId: string;
  /** Where the archive will be, or already is. */
  readonly archive: string;
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
  /** How often a build in progress is asked about; a second by default. */
  readonly pollMs?: number;
  /** The person's IANA time zone, so the archive is dated the day they made the save. */
  readonly timeZone?: string;
}

/** A failure of the network itself, which is the only kind worth retrying blindly. */
class NetworkFailure extends Error {}

/** The server says the save is already complete: another tab, or an earlier attempt, finished it while this one was sending. */
class FinishedElsewhere extends Error {}

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
  if (
    !isRecord(value) ||
    typeof value.saveId !== "string" ||
    typeof value.archive !== "string" ||
    !Array.isArray(value.files) ||
    (value.state !== "uploading" && value.state !== "building" && value.state !== "complete") ||
    (value.state === "complete" && typeof value.archiveBytes !== "number")
  ) {
    throw new DeviceArtifactError("The server did not answer with a save description. Cody on the server may be an older version without this feature.", "server-refused");
  }
  return value as unknown as ServerSave;
}

/** Why the server's last attempt to write the archive stopped, if it did and said so. */
function buildErrorOf(save: ServerSave): ServerSaveBuildError | undefined {
  const failure: unknown = save.buildError;
  return isRecord(failure) && typeof failure.code === "string" && typeof failure.message === "string" ? { code: failure.code, message: failure.message } : undefined;
}

/** The server's own words, with the code that tells the caller whether more room would help. */
function buildFailure(failure: ServerSaveBuildError): DeviceArtifactError {
  return new DeviceArtifactError(failure.message, NO_ROOM_CODES.includes(failure.code) ? "disk-full" : "server-refused");
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
  if (failure.code !== undefined && BUILD_FAILED_CODES.includes(failure.code)) return false;
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
  return {
    saveId: save.saveId,
    archive: save.archive,
    archiveBytes: save.archiveBytes ?? 0,
    files: save.files.length,
    bytes: save.totalBytes,
    verified: save.verified,
    resumed,
    ...(alreadySaved ? { alreadySaved: true } : {}),
  };
}

/** The finished saves of a chat that the server holds, oldest first. Throws when the server cannot be asked, or when `signal` ends the asking. */
export async function listServerSaves(sessionId: string, fetchImpl: FetchLike = fetch, signal?: AbortSignal): Promise<readonly ServerSave[]> {
  const response = await fetchImpl(`${SAVES_ROUTE}?sessionId=${encodeURIComponent(sessionId)}`, { credentials: "same-origin", ...(signal ? { signal } : {}) });
  if (!response.ok) throw explain(await readFailure(response));
  const body: unknown = await response.json();
  const saves = isRecord(body) && Array.isArray(body.saves) ? body.saves.map(saveFrom) : [];
  return saves.sort((left, right) => (left.completedAt ?? left.createdAt) - (right.completedAt ?? right.createdAt));
}

/**
 * Uploads `files`, has the server pack them into one archive, and returns where it is. Throws a DeviceArtifactError
 * whose message can be shown as it is: `aborted` for a cancel, `unreachable`, `unauthorized`, `too-large`, `disk-full`
 * (also when the server ran out of room while packing), `hash-mismatch` or `server-refused`.
 *
 * Progress: `uploading` and `verifying` count the bytes sent; `writing` is the server packing, and its `bytes` start
 * again from 0 and count the original bytes packed so far.
 */
export async function uploadToServer(files: readonly UploadFile[], options: UploadOptions): Promise<ServerSaveResult> {
  if (files.length === 0) throw new DeviceArtifactError("There are no files to save.", "not-found");
  const fetchImpl = options.fetch ?? fetch;
  const { signal } = options;
  const sliceBytes = options.sliceBytes ?? UPLOAD_SLICE_BYTES;
  const delays = options.retryDelaysMs ?? RETRY_DELAYS_MS;
  const pollMs = options.pollMs ?? BUILD_POLL_MS;
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

  /**
   * A call that is safe to repeat, retried on a network failure or a 5xx; anything else the server said is final.
   * `describe` gets the first word on a failure the caller knows better than the generic explanation.
   */
  const repeatable = async (url: string, init: RequestInit, describe?: (failure: Failure) => Error | undefined): Promise<Response> => {
    for (let attempt = 0; ; attempt += 1) {
      let failure: Failure | undefined;
      try {
        const response = await request(url, init);
        if (response.ok) return response;
        failure = await readFailure(response);
        const known = describe?.(failure);
        if (known) throw known;
        if (!worthRetrying(failure)) throw explain(failure);
      } catch (error) {
        if (!(error instanceof NetworkFailure)) throw error;
        if (attempt >= delays.length) throw unreachable(error);
      }
      if (failure && attempt >= delays.length) throw explain(failure);
      await pause(delays[Math.min(attempt, delays.length - 1)] ?? 0, signal);
    }
  };

  const operations = operationInfos(files.map((file) => file.provenance));
  const announcement = {
    sessionId: options.sessionId,
    label: options.label,
    key: saveKey(options.sessionId, options.label, files),
    ...(options.timeZone ? { timeZone: options.timeZone } : {}),
    files: files.map((file, index) => ({
      name: file.name,
      size: file.size,
      sha256: file.sha256,
      kind: file.kind,
      source: file.source,
      createdAt: file.createdAt,
      artifactId: file.artifactId,
      ...(operations[index] ? { operation: operations[index] } : {}),
    })),
  };
  const announce = async (): Promise<ServerSave> =>
    saveFrom(await (await repeatable(SAVES_ROUTE, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(announcement) })).json());

  let save = await announce();
  const begun: SaveBegun = { saveId: save.saveId, archive: save.archive, files: files.length, bytes: totalBytes, resumed: save.resumed === true, alreadySaved: save.state === "complete" };
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
  const finishedElsewhere = (failure: Failure): Error | undefined => (failure.status === 409 && failure.code === "already_complete" ? new FinishedElsewhere() : undefined);
  /** What the server holds of a file now, after a failure that left it unclear whether a slice landed. */
  const stored = async (index: number): Promise<number> => {
    const response = await repeatable(route(), { method: "GET" }, finishedElsewhere);
    const current = saveFrom(await response.json());
    return current.files[index]?.received ?? 0;
  };

  let reannounced = 0;
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
          // The save is gone from under the upload (deleted, or swept): announce it again and carry on from what the server holds, a few times.
          reannounced += 1;
          if (reannounced > MAX_REANNOUNCES) {
            throw new DeviceArtifactError("The server keeps losing this save before its files have all arrived, so the upload was stopped. Check the server's artifact folder and press Save to server again.", "server-refused");
          }
          save = await announce();
          if (save.state === "complete") throw new FinishedElsewhere();
          return save.files[index]?.received ?? 0;
        }
        const elsewhere = finishedElsewhere(failure);
        if (elsewhere) throw elsewhere;
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

  try {
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
          await repeatable(route(), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "verify", file: index }) }, finishedElsewhere);
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
  } catch (error) {
    if (!(error instanceof FinishedElsewhere)) throw error;
    // Somebody else finished this very save (the same key finds it): its archive is the result, and nothing more is sent.
    const finished = await announce();
    if (finished.state !== "complete") throw new DeviceArtifactError("The server said this save was already complete, but does not list it as finished. Press Save to server again.", "server-refused");
    progress.done = files.length;
    progress.bytes = totalBytes;
    report("verifying");
    return toResult(finished, resumed, true);
  }

  // Every file is on the server and verified: it packs them into the archive. A small save is done within one answer;
  // for a large one the server says `building` and is asked again until it is done.
  progress.done = files.length;
  progress.bytes = 0;
  report("writing");
  // A save the server no longer has (somebody deleted it, or it was cleaned up) is the same news whichever question finds out.
  const gone = (failure: Failure): DeviceArtifactError | undefined =>
    failure.status === 404 && failure.code === "unknown_save"
      ? new DeviceArtifactError("The server no longer has this save, so its archive could not be finished: it was deleted, or cleaned up. Press Save to server again.", "server-refused")
      : undefined;
  const complete = async (): Promise<ServerSave> =>
    saveFrom(await (await repeatable(route(), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "complete" }) }, gone)).json());
  const building = async (): Promise<ServerSave> => saveFrom(await (await repeatable(route(), { method: "GET" }, gone)).json());

  let finished = await complete();
  for (let restarts = 0; ; ) {
    const failed = buildErrorOf(finished);
    if (failed) throw buildFailure(failed);
    if (finished.state === "complete") break;
    if (finished.state === "building") {
      progress.bytes = finished.packedBytes ?? 0;
      report("writing");
      await pause(pollMs, signal);
      finished = await building();
      continue;
    }
    // `uploading` with every file verified and no error: the server forgot the build (it restarted). Ask again, but a
    // server that keeps forgetting is not going to finish it.
    if (!finished.files.every((file) => file.verified)) {
      throw new DeviceArtifactError("The server lost some of the uploaded files before it could pack them. Press Save to server again: only the lost files are sent again.", "server-refused");
    }
    restarts += 1;
    if (restarts > MAX_BUILD_RESTARTS) {
      throw new DeviceArtifactError("The server keeps stopping before it finishes packing the archive. Your files are on the server, so press Save to server again later: nothing is sent twice.", "server-refused");
    }
    finished = await complete();
  }
  progress.bytes = totalBytes;
  report("writing");
  return toResult(finished, resumed, false);
}
