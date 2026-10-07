/**
 * "Download all": one compressed .zip of any number of artifacts, however large.
 *
 * Nothing is read into memory beyond one slice. The shared writer (./artifact-archive.ts) deflates each file as it
 * streams through and takes its CRC-32 on the way, so there is nothing to measure first, and then the archive goes to
 * disk one of two ways:
 *
 *  - Where the browser has a Save-as picker (desktop Chrome and Edge) the person chooses the file first and the archive
 *    is streamed into it. A stored copy that has gone bad stops the write instead of becoming a quietly broken archive,
 *    and a cancel or a failure discards the half-written file.
 *  - Everywhere else (Android Chrome has no picker) the compressed chunks are gathered into ONE Blob, which is handed to
 *    the browser's own download. The Blob is rebuilt around its pending chunks every ~64 MiB so the page's JavaScript
 *    memory stays flat: the browser pages a Blob's bytes out to disk by itself, but not an array of chunks it cannot see.
 *
 * Inside the zip, beside the files, are `SHA256SUMS` and `manifest.json` (the same two a save to the server writes), so
 * the copy can be verified on any machine with `sha256sum -c SHA256SUMS`.
 */

import {
  ArchiveError,
  blobSource,
  buildArchiveManifest,
  metadataSources,
  operationInfo,
  writeArchive,
  type ArchiveSource,
  type ManifestFile,
} from "./artifact-archive";
import { DeviceArtifactError, type ArtifactProvenance, type DownloadResult, type TransferProgress } from "./artifact-model";
import { labelSlug, uniqueFileNames } from "./artifact-names";

declare global {
  interface Window {
    /** The File System Access API's Save-as picker: desktop Chromium only. */
    showSaveFilePicker?: (options: { suggestedName: string; types: { description: string; accept: Record<string, string[]> }[] }) => Promise<FileSystemFileHandle>;
  }
}

/** Where the finished archive goes. */
export interface DownloadSink {
  /**
   * Ask where to save, called in the click that asked for the download (the picker needs that click's user activation).
   * Resolves to a stream into the chosen file, or undefined when this browser cannot ask: the archive is then handed to
   * the browser's own download. A person who closes the picker rejects with code `aborted`.
   */
  choose(suggestedName: string): Promise<WritableStream<Uint8Array> | undefined>;
  hand(blob: Blob, fileName: string): void;
}

/** The sink for a real page. */
export const browserDownloadSink: DownloadSink = {
  async choose(suggestedName) {
    if (typeof window === "undefined" || typeof window.showSaveFilePicker !== "function") return undefined;
    try {
      const handle = await window.showSaveFilePicker({ suggestedName, types: [{ description: "ZIP archive", accept: { "application/zip": [".zip"] } }] });
      return await handle.createWritable();
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw new DeviceArtifactError("Saving the archive was cancelled.", "aborted");
      // Blocked here (no user activation, a frame, a policy) or not implemented: the browser's own download still works.
      return undefined;
    }
  },
  hand(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    // The browser has resolved the URL by the time the click returns; a late revoke only frees the reference.
    setTimeout(() => URL.revokeObjectURL(url), 5 * 60_000);
  },
};

export interface ArchiveInput {
  readonly id: string;
  readonly name: string;
  readonly size: number;
  readonly sha256: string;
  readonly kind: string;
  readonly source: string;
  readonly createdAt: number;
  readonly provenance?: ArtifactProvenance;
  readonly blob: Blob;
  /** CRC-32 taken when the file was saved. The write checks the bytes against it; absent for files saved before it was recorded. */
  readonly crc32?: number;
}

export interface ExportOptions {
  readonly sessionId: string;
  readonly label: string;
  readonly fileName: string;
  readonly sink: DownloadSink;
  /** The picker's answer, asked for in the click (see DownloadSink.choose). */
  readonly chosen: Promise<WritableStream<Uint8Array> | undefined>;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: TransferProgress) => void;
  readonly now?: number;
  readonly forceZip64?: boolean;
}

/** Pending chunks are folded into the Blob once they add up to this much. */
const FOLD_BYTES = 64 * 1024 * 1024;

function cancelled(): DeviceArtifactError {
  return new DeviceArtifactError("The download was cancelled.", "aborted");
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** `<label>-<yyyymmdd>-<hhmm>.zip`, in the person's own clock. */
export function archiveFileName(label: string, now: number): string {
  const moment = new Date(now);
  return `${labelSlug(label)}-${moment.getFullYear()}${pad(moment.getMonth() + 1)}${pad(moment.getDate())}-${pad(moment.getHours())}${pad(moment.getMinutes())}.zip`;
}

/**
 * One Blob of everything the stream delivers. The chunks are folded into the Blob every `foldBytes`: a Blob made of a
 * Blob and a few fresh chunks keeps the old bytes by reference, where one long array of chunks would sit in the heap.
 */
export async function blobFromStream(stream: ReadableStream<Uint8Array>, foldBytes = FOLD_BYTES): Promise<Blob> {
  const type = "application/zip";
  const reader = stream.getReader();
  let blob = new Blob([], { type });
  let pending: Uint8Array<ArrayBuffer>[] = [];
  let pendingBytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      // The archive writer's chunks are ordinary, never shared, memory; the stream type just does not say so.
      pending.push(next.value as Uint8Array<ArrayBuffer>);
      pendingBytes += next.value.length;
      if (pendingBytes >= foldBytes) {
        blob = new Blob([blob, ...pending], { type });
        pending = [];
        pendingBytes = 0;
      }
    }
  } finally {
    reader.releaseLock();
  }
  return pending.length === 0 ? blob : new Blob([blob, ...pending], { type });
}

/** The archive's entries: every file under one folder, then the checksums and the manifest. */
function archiveSources(entries: readonly ArchiveInput[], options: { sessionId: string; label: string; folder: string; now: number }): ArchiveSource[] {
  const names = uniqueFileNames(entries.map((entry) => entry.name));
  const files: ManifestFile[] = entries.map((entry, index) => ({
    name: entry.name,
    path: names[index]!,
    size: entry.size,
    sha256: entry.sha256,
    kind: entry.kind,
    source: entry.source,
    createdAt: entry.createdAt,
    artifactId: entry.id,
    ...(entry.provenance ? { operation: operationInfo(entry.provenance) } : {}),
  }));
  const manifest = buildArchiveManifest({ label: options.label, sessionId: options.sessionId, createdAt: options.now, files });
  return [
    // The size is the one the manifest and the checksums list: a Blob that holds another number of bytes stops the write.
    ...entries.map((entry, index) => ({ ...blobSource(`${options.folder}/${names[index]}`, entry.blob, entry.createdAt, entry.crc32), size: entry.size })),
    ...metadataSources({ folder: options.folder, files, manifest: manifest.bytes, modified: options.now }),
  ];
}

/**
 * Settles like `promise`, or as cancelled the moment `signal` fires. A sink stuck in a write holds its stream's abort
 * back until the write ends, and a cancelled download must not stay "running" because of that.
 */
function untilCancelled<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  const aborted = new Promise<never>((_, reject) => {
    if (signal.aborted) reject(cancelled());
    else signal.addEventListener("abort", () => reject(cancelled()), { once: true });
  });
  return Promise.race([promise, aborted]);
}

/** What went wrong, as the person and the transfer code understand it: a cancel, a stored copy that no longer matches, or a plain message. */
function failure(error: unknown, signal: AbortSignal | undefined): DeviceArtifactError {
  if (error instanceof DeviceArtifactError) return error;
  if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) return cancelled();
  if (error instanceof ArchiveError) return new DeviceArtifactError(error.message, error.code === "damaged" || error.code === "changed" ? "hash-mismatch" : "unknown");
  return new DeviceArtifactError(error instanceof Error ? `The archive could not be written: ${error.message}` : "The archive could not be written.", "unknown");
}

/**
 * Writes the archive and says how it went. `chosen` is the picker's answer, which the caller asked for in the click.
 * A failure or a cancel leaves no half-written file behind: the chosen target is aborted, and nothing is handed on.
 */
export async function exportArchive(entries: readonly ArchiveInput[], options: ExportOptions): Promise<DownloadResult> {
  if (entries.length === 0) throw new DeviceArtifactError("There is nothing to download.", "not-found");
  const { signal } = options;
  const totalBytes = entries.reduce((total, entry) => total + entry.size, 0);
  const now = options.now ?? Date.now();
  const folder = options.fileName.replace(/\.zip$/i, "");
  const work = new AbortController();
  const stop = (): void => work.abort();
  signal?.addEventListener("abort", stop, { once: true });
  if (signal?.aborted) stop();
  // The writer's progress also counts the checksums and the manifest it adds; the person's numbers are their own files.
  const report = (done: number, bytes: number): void => {
    options.onProgress?.({ phase: "writing", done: Math.min(done, entries.length), total: entries.length, bytes: Math.min(bytes, totalBytes), totalBytes });
  };
  let target: WritableStream<Uint8Array> | undefined;

  try {
    try {
      target = await options.chosen;
    } catch (error) {
      stop();
      throw error;
    }
    if (work.signal.aborted) throw cancelled();

    const archive = writeArchive(archiveSources(entries, { sessionId: options.sessionId, label: options.label, folder, now }), {
      signal: work.signal,
      ...(options.forceZip64 ? { forceZip64: true } : {}),
      onProgress: (progress) => report(progress.entriesDone, progress.readBytes),
    });
    report(0, 0);
    let method: DownloadResult["method"];
    if (target) {
      await untilCancelled(archive.stream.pipeTo(target, { signal: work.signal }), work.signal);
      method = "file-picker";
    } else {
      options.sink.hand(await blobFromStream(archive.stream), options.fileName);
      method = "browser-download";
    }
    const summary = await archive.summary;
    report(entries.length, totalBytes);
    return { fileName: options.fileName, files: entries.length, bytes: totalBytes, archiveBytes: summary.bytes, method };
  } catch (error) {
    // The pipe throws away the file it was writing when the archive fails; a file that never got that far is thrown away here.
    if (target && !target.locked) await target.abort(error).catch(() => undefined);
    throw failure(error, signal);
  } finally {
    signal?.removeEventListener("abort", stop);
  }
}
