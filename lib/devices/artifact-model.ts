/**
 * What a device artifact, a set of them and a transfer of them ARE, with no
 * IndexedDB, DOM or Node import: the store (./artifacts.ts), the pure set
 * grouping (./artifact-sets.ts), the zip planner, the server vault and the
 * Devices panel all share these, and a test can import them without a browser.
 */

export type DeviceArtifactKind = "input" | "output";
export type DeviceArtifactSource = "picker" | "drop" | "server-file" | "device";

/**
 * Which operation made an output, kept with its bytes. After a reload there are no operation snapshots, so this is
 * what lets the panel group a backup's files into one set again. Inputs and files saved before it existed have none.
 */
export interface ArtifactProvenance {
  readonly operationId: string;
  readonly deviceId: string;
  readonly protocol: string;
  readonly action: string;
  /** The partition or path the request named, when it named one. */
  readonly target?: string;
  /** The first word of an `exec` command ("backup", "printgpt"): `exec` alone says nothing about what ran. */
  readonly command?: string;
  /** What the person calls the device (the Devices card title) when the file was saved; it outlives the connection. */
  readonly label?: string;
}

/**
 * The server holds a verified copy of one file. Never stored in the browser: the page asks the server which of a
 * session's files it has (matching SHA-256 and size), so the answer survives a reload and disappears with the copy.
 */
export interface ArtifactServerCopy {
  readonly saveId: string;
  /** The file, as the server's own filesystem names it. */
  readonly path: string;
  /** The folder of the save it belongs to. */
  readonly folder: string;
  readonly savedAt: number;
  /** The server re-read the file from disk and its SHA-256 matched. */
  readonly verified: boolean;
}

/** Metadata is intentionally separate from the Blob so consumers can render a
 * session's artifact list without taking ownership of the bytes. */
export interface DeviceArtifact {
  readonly id: string;
  readonly name: string;
  readonly size: number;
  readonly mime: string;
  readonly sha256: string;
  readonly kind: DeviceArtifactKind;
  readonly source: DeviceArtifactSource;
  readonly createdAt: number;
  readonly provenance?: ArtifactProvenance;
  readonly server?: ArtifactServerCopy;
}

export type DeviceArtifactErrorCode =
  | "aborted"
  | "not-found"
  | "unsupported"
  | "too-large"
  | "disk-full"
  | "unauthorized"
  | "unreachable"
  | "hash-mismatch"
  | "server-refused"
  | "unknown";

/** Every message is plain English for the person; the code is for a caller that wants to react. */
export class DeviceArtifactError extends Error {
  readonly code: DeviceArtifactErrorCode;

  constructor(message: string, code: DeviceArtifactErrorCode = "unknown") {
    super(message);
    this.name = "DeviceArtifactError";
    this.code = code;
  }
}

/** A group of an operation's files, derived from the artifacts alone (see ./artifact-sets.ts). */
export interface ArtifactSet {
  /** Stable across a reload and while the burst grows at its newer end: `set:` plus the oldest file's id. */
  readonly id: string;
  readonly deviceId?: string;
  readonly protocol?: string;
  readonly action?: string;
  readonly command?: string;
  readonly label?: string;
  readonly startedAt: number;
  readonly endedAt: number;
  /** Oldest first. */
  readonly artifactIds: readonly string[];
  readonly count: number;
  readonly totalBytes: number;
  /** Empty for a legacy set. */
  readonly operationIds: readonly string[];
  /** Saved before provenance existed: grouped by file name and time, so deviceId and action may be unknown. */
  readonly legacy: boolean;
}

export type SetSaveState =
  | { readonly state: "none" }
  | { readonly state: "partial"; readonly saved: number; readonly total: number }
  | { readonly state: "saved"; readonly path: string; readonly savedAt: number; readonly verified: boolean; readonly files: number; readonly bytes: number };

export interface TransferProgress {
  readonly phase: "checking" | "writing" | "uploading" | "verifying";
  /** Files finished. */
  readonly done: number;
  /** Files in all. */
  readonly total: number;
  readonly bytes: number;
  readonly totalBytes: number;
  readonly currentName?: string;
}

export interface TransferOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: TransferProgress) => void;
}

export interface DownloadResult {
  readonly fileName: string;
  readonly files: number;
  readonly bytes: number;
  /** `file-picker`: written straight to the file the person chose. `browser-download`: handed to the browser's own download. */
  readonly method: "file-picker" | "browser-download";
}

export interface ServerSaveResult {
  readonly saveId: string;
  /** The save's folder on the server. */
  readonly path: string;
  readonly manifestPath: string;
  readonly files: number;
  readonly bytes: number;
  /** The server re-read every file from disk and each SHA-256 matched. */
  readonly verified: boolean;
  /** The save carried on from bytes an earlier attempt had already stored. */
  readonly resumed: boolean;
}

export interface TransferJob {
  readonly id: string;
  readonly kind: "download" | "save";
  readonly setId?: string;
  readonly artifactIds: readonly string[];
  readonly label: string;
  readonly state: "running" | "succeeded" | "failed" | "cancelled";
  readonly progress: TransferProgress;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly error?: { readonly code: DeviceArtifactErrorCode; readonly message: string };
  readonly result?: DownloadResult | ServerSaveResult;
  readonly origin: "user" | "agent";
}
