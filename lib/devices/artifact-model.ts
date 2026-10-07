/**
 * What a device artifact, a set of them and a transfer of them ARE, with no
 * IndexedDB, DOM or Node import: the store (./artifacts.ts), the pure set
 * grouping (./artifact-sets.ts), the archive writer, the server vault and the
 * Devices panel all share these, and a test can import them without a browser.
 */

export type DeviceArtifactKind = "input" | "output";
export type DeviceArtifactSource = "picker" | "drop" | "server-file" | "device";

/**
 * Which partitions a backup took, and every partition the device listed when it was taken. A backup of everything has
 * `chosen` equal to `all`; a backup of chosen partitions has fewer, and says so wherever it is shown or packed.
 */
export interface BackupScope {
  /** Partition names this backup holds, in the order they were read. */
  readonly chosen: readonly string[];
  /** Every partition the device listed at the time. */
  readonly all: readonly string[];
}

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
  /**
   * When the operation began working with the device, milliseconds since the epoch. A read that takes ten minutes saves
   * its file at the END of those minutes, so grouping measures the quiet time between runs from this, not from the
   * file's creation. Files saved before it was recorded have none (the grouping estimates it).
   */
  readonly startedAt?: number;
  /**
   * The backup name the agent gave (`set` on the device tools). Every output on one device carrying the same name is one
   * set, whenever and with whatever command it was made.
   */
  readonly set?: string;
  /** Which partitions a backup operation took, when it said (the EDL `backup` command does). */
  readonly scope?: BackupScope;
}

/**
 * The server holds a verified copy of one file, inside one archive. Never stored in the browser: the page asks the
 * server which of a session's files it has (matching SHA-256 and size), so the answer survives a reload and disappears
 * with the copy.
 */
export interface ArtifactServerCopy {
  readonly saveId: string;
  /** The archive (one .zip) holding this file, as the server's own filesystem names it. */
  readonly archive: string;
  /** This file's path inside that archive. */
  readonly entry: string;
  /** What the archive is on the server's disk. */
  readonly archiveBytes: number;
  /** What the files in that archive added up to before they were packed. */
  readonly originalBytes: number;
  readonly savedAt: number;
  /** The server re-read the archive from disk and every file in it matched its SHA-256 and CRC-32. */
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
  /**
   * The set name a person filed this file under (Combine with the older backup). Kept beside the bytes in the browser's
   * database, so it survives a reload, and wins over `provenance.set`. Never an agent's: see ./artifact-sets.ts.
   */
  readonly setName?: string;
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
  | "busy"
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
  /** For a legacy set of Qualcomm files: the unit tag in their names ("edl-<unit>-…"), the only identity such files have. */
  readonly unit?: string;
  readonly protocol?: string;
  readonly action?: string;
  readonly command?: string;
  readonly label?: string;
  /**
   * The name the set was filed under by an agent (`set`) or kept from one when a person combined sets; shown on the card.
   * Absent for a set grouped by timing alone and for one a person combined without any name in play.
   */
  readonly name?: string;
  /**
   * What the set says about partitions, when it is one or more backup operations that said which partitions they took
   * (and nothing else that could hold a partition): `chosen` of `total`, the union of what they declared, and whether
   * the set holds every file those backups saved (`complete`). A backup that stopped part-way, or a set a file was
   * removed from, is not complete, and nothing shows or packs it as a full backup. A backup of everything has `chosen`
   * and `total` equal.
   */
  readonly scope?: { readonly chosen: number; readonly total: number; readonly complete: boolean };
  /** When the first run began (recorded, or estimated for files saved before it was). */
  readonly startedAt: number;
  /** When the last file was saved. */
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
  | {
      readonly state: "saved";
      /** The newest archive that holds the set. */
      readonly path: string;
      readonly savedAt: number;
      readonly verified: boolean;
      /** Files in the set. */
      readonly files: number;
      /** The files of the archives that hold the set, before packing (normally the set itself). */
      readonly bytes: number;
      /** Those archives on the server's disk. */
      readonly archiveBytes: number;
      /** How many archives hold the set: one, unless its files were saved in separate groups. */
      readonly archives: number;
    };

export interface TransferProgress {
  /** `writing` is packing the zip: in the browser for a download, on the server after an upload. */
  readonly phase: "writing" | "uploading" | "verifying";
  /** Files finished. */
  readonly done: number;
  /** Files in all. */
  readonly total: number;
  /** Bytes of the original files handled so far (read, uploaded or packed). */
  readonly bytes: number;
  /** Bytes of the original files in all. */
  readonly totalBytes: number;
  readonly currentName?: string;
}

export interface TransferOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: TransferProgress) => void;
}

export interface DownloadResult {
  /** The one .zip that was written. */
  readonly fileName: string;
  /** Device files inside it. */
  readonly files: number;
  /** Those files before packing. */
  readonly bytes: number;
  /** The archive as written. */
  readonly archiveBytes: number;
  /** `file-picker`: written straight to the file the person chose. `browser-download`: handed to the browser's own download. */
  readonly method: "file-picker" | "browser-download";
}

export interface ServerSaveResult {
  readonly saveId: string;
  /** The one .zip the save became, as the server's own filesystem names it. */
  readonly archive: string;
  /** What that archive is on the server's disk. */
  readonly archiveBytes: number;
  /** Device files inside it. */
  readonly files: number;
  /** Those files before packing. */
  readonly bytes: number;
  /** The server re-read the finished archive from disk and every file in it matched its SHA-256 and CRC-32. */
  readonly verified: boolean;
  /** The save carried on from bytes an earlier attempt had already stored. */
  readonly resumed: boolean;
  /** The same files were already saved here, so nothing was sent. */
  readonly alreadySaved?: boolean;
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
