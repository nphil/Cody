/**
 * "Download all": one .zip of any number of artifacts, however large.
 *
 * Nothing is read into memory beyond one slice. Each file's CRC-32 is taken from
 * when it was saved (files saved before that existed are read once, here, and the
 * answer remembered), the archive is planned from exact sizes (./artifact-zip.ts),
 * and then it goes to disk one of two ways:
 *
 *  - Where the browser has a Save-as picker (desktop Chrome and Edge) the person
 *    chooses the file first and the archive is streamed into it, each entry's
 *    CRC re-proved on the way, so a stored copy that has gone bad stops the write
 *    instead of becoming a quietly broken archive. A cancel discards the
 *    half-written file.
 *  - Everywhere else (Android Chrome has no picker) the archive is one lazy Blob
 *    made of the stored Blobs by reference, handed to the browser's own download,
 *    which reads it from disk as it saves it.
 *
 * Inside the zip, beside the files, are `SHA256SUMS` and `manifest.json` (the same
 * two a save to the server writes), so the copy can be verified on any machine
 * with `sha256sum -c SHA256SUMS`.
 */

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { crc32, Crc32 } from "./crc32";
import { labelSlug, MANIFEST_NAME, SUMS_NAME, uniqueFileNames } from "./artifact-names";
import { DeviceArtifactError, type ArtifactProvenance, type DownloadResult, type TransferProgress } from "./artifact-model";
import { planZip, zipBlob, zipStream, ZipPlanError, type ZipSource } from "./artifact-zip";

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
  /** CRC-32 taken when the file was saved; absent for files saved before it was recorded. */
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
  /** A checksum worked out earlier this page session, or undefined. */
  readonly knownCrc?: (entry: ArchiveInput) => number | undefined;
  readonly rememberCrc?: (entry: ArchiveInput, crc: number) => void;
  readonly now?: number;
  readonly forceZip64?: boolean;
}

function cancelled(): DeviceArtifactError {
  return new DeviceArtifactError("The download was cancelled.", "aborted");
}

/** The CRC-32 of a Blob, read a slice at a time. */
export async function crcOfBlob(blob: Blob, signal?: AbortSignal, onBytes?: (bytes: number) => void): Promise<number> {
  const crc = new Crc32();
  const reader = blob.stream().getReader();
  try {
    for (;;) {
      if (signal?.aborted) throw cancelled();
      const next = await reader.read();
      if (next.done) return crc.digest();
      crc.update(next.value);
      onBytes?.(next.value.byteLength);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** `<label>-<yyyymmdd>-<hhmm>.zip`, in the person's own clock. */
export function archiveFileName(label: string, now: number): string {
  const moment = new Date(now);
  return `${labelSlug(label)}-${moment.getFullYear()}${pad(moment.getMonth() + 1)}${pad(moment.getDate())}-${pad(moment.getHours())}${pad(moment.getMinutes())}.zip`;
}

function isoTime(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}

/** The archive's entries: every file under one folder, then the checksums and the manifest. */
export function archiveSources(entries: readonly ArchiveInput[], crcs: readonly number[], options: { sessionId: string; label: string; folder: string; now: number }): ZipSource[] {
  const names = uniqueFileNames(entries.map((entry) => entry.name));
  const encoder = new TextEncoder();
  const manifest = {
    format: "cody-device-artifacts/1",
    createdAt: isoTime(options.now),
    label: options.label,
    sessionId: options.sessionId,
    totalBytes: entries.reduce((total, entry) => total + entry.size, 0),
    files: entries.map((entry, index) => ({
      name: entry.name,
      path: names[index],
      size: entry.size,
      sha256: entry.sha256,
      kind: entry.kind,
      source: entry.source,
      createdAt: isoTime(entry.createdAt),
      artifactId: entry.id,
      ...(entry.provenance
        ? { operation: { id: entry.provenance.operationId, deviceId: entry.provenance.deviceId, protocol: entry.provenance.protocol, action: entry.provenance.action, ...(entry.provenance.label ? { deviceLabel: entry.provenance.label } : {}), ...(entry.provenance.target ? { target: entry.provenance.target } : {}), ...(entry.provenance.command ? { command: entry.provenance.command } : {}) } }
        : {}),
    })),
  };
  const manifestBytes = encoder.encode(`${JSON.stringify(manifest, null, 2)}\n`);
  const sumsBytes = encoder.encode([...entries.map((entry, index) => `${entry.sha256}  ${names[index]}\n`), `${bytesToHex(sha256(manifestBytes))}  ${MANIFEST_NAME}\n`].join(""));
  return [
    ...entries.map((entry, index) => ({ name: `${options.folder}/${names[index]}`, data: entry.blob, crc32: crcs[index]!, modified: entry.createdAt })),
    { name: `${options.folder}/${SUMS_NAME}`, data: sumsBytes, crc32: crc32(sumsBytes), modified: options.now },
    { name: `${options.folder}/${MANIFEST_NAME}`, data: manifestBytes, crc32: crc32(manifestBytes), modified: options.now },
  ];
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * Writes the archive and says how it went. `chosen` is the picker's answer, which the caller asked for in the click: the
 * checksums are worked out while the picker is open, so a legacy backup does not wait for them afterwards.
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
  const report = (phase: TransferProgress["phase"], done: number, bytes: number, currentName?: string): void => {
    options.onProgress?.({ phase, done, total: entries.length, bytes, totalBytes, ...(currentName ? { currentName } : {}) });
  };

  try {
    const crcs: number[] = [];
    const checking = (async () => {
      let read = 0;
      for (const [index, entry] of entries.entries()) {
        let crc = entry.crc32 ?? options.knownCrc?.(entry);
        if (crc === undefined) {
          report("checking", index, read, entry.name);
          crc = await crcOfBlob(entry.blob, work.signal, (bytes) => {
            read += bytes;
            report("checking", index, read, entry.name);
          });
          options.rememberCrc?.(entry, crc);
        } else {
          read += entry.size;
        }
        crcs.push(crc);
      }
    })();
    // If the picker is closed first the checking is abandoned, and whatever it would have thrown is not news.
    checking.catch(() => undefined);
    let target: WritableStream<Uint8Array> | undefined;
    try {
      target = await options.chosen;
    } catch (error) {
      stop();
      throw error;
    }
    await checking;
    if (work.signal.aborted) throw cancelled();

    const plan = planZip(archiveSources(entries, crcs, { sessionId: options.sessionId, label: options.label, folder, now }), { ...(options.forceZip64 ? { forceZip64: true } : {}) });
    const ends = plan.layout.slice(0, entries.length).map((entry) => entry.dataOffset + entry.size);
    if (target) {
      let written = 0;
      report("writing", 0, 0);
      const archive = zipStream(plan, {
        signal: work.signal,
        verify: true,
        onBytes: (bytes) => {
          written += bytes;
          const done = Math.min(ends.filter((end) => end <= written).length, entries.length);
          report("writing", done, Math.min(written, totalBytes));
        },
      });
      await archive.pipeTo(target, { signal: work.signal });
      report("writing", entries.length, totalBytes);
      return { fileName: options.fileName, files: entries.length, bytes: totalBytes, method: "file-picker" };
    }
    options.sink.hand(zipBlob(plan), options.fileName);
    report("writing", entries.length, totalBytes);
    return { fileName: options.fileName, files: entries.length, bytes: totalBytes, method: "browser-download" };
  } catch (error) {
    if (error instanceof DeviceArtifactError) throw error;
    if (signal?.aborted || isAbort(error)) throw cancelled();
    if (error instanceof ZipPlanError) throw new DeviceArtifactError(error.message, /checksum|changed size/.test(error.message) ? "hash-mismatch" : "unknown");
    throw new DeviceArtifactError(error instanceof Error ? `The archive could not be written: ${error.message}` : "The archive could not be written.", "unknown");
  } finally {
    signal?.removeEventListener("abort", stop);
  }
}
