import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { Readable, Transform, Writable, type TransformCallback } from "node:stream";
import { isInside } from "./files";

/**
 * The two halves of moving a project: packing the files that go out (the
 * system's `tar` reading a list of names), and unpacking what comes back.
 *
 * What comes back is NOT trusted. It is produced by a program running on
 * another machine, so the unpacker is Cody's own and refuses everything that is
 * not plain: it restores regular files and directories only, under the paths
 * the agent asked for, never through `..`, an absolute name, `.git`, or a
 * symlink that leads out of the project. Links and special files are skipped
 * and counted, never created.
 */

const BLOCK = 512;
/** pax and GNU long-name headers are a few hundred bytes; this only stops a flood. */
const MAX_META_BYTES = 1024 * 1024;
const MAX_SKIPPED_LISTED = 20;

export const DEFAULT_EXTRACT_LIMITS = { maxFiles: 200_000, maxBytes: 4 * 1024 * 1024 * 1024 } as const;

// ── Packing ──────────────────────────────────────────────────────────────────

export interface ArchiveProcess {
  stdout: Readable;
  /** Settles when `tar` has ended. `ok` is false for a fatal error; a file that changed while it was read is only a warning. */
  done: Promise<{ ok: boolean; code: number | null; stderr: string }>;
  kill(): void;
}

/** `tar` writing the named files (relative to `root`) to its stdout. Never throws. */
export function createArchive(root: string, files: readonly string[]): ArchiveProcess {
  const { promise: done, resolve } = Promise.withResolvers<{ ok: boolean; code: number | null; stderr: string }>();
  const child = spawn("tar", ["-c", "--null", "--no-recursion", "-C", root, "-T", "-", "-f", "-"], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-4096);
  });
  child.stdin?.on("error", () => {
    // tar ended before it read the whole list; its exit status says why
  });
  child.stdin?.end(files.length > 0 ? `${files.join("\0")}\0` : "");
  let settled = false;
  const settle = (code: number | null, extra = "") => {
    if (settled) return;
    settled = true;
    // 1 = "some files changed while they were read": the archive is still whole.
    resolve({ ok: code === 0 || code === 1, code, stderr: extra || stderr });
  };
  child.once("error", (error) => settle(null, error.message));
  child.once("close", (code) => settle(code));
  return {
    stdout: child.stdout as Readable,
    done,
    kill() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    },
  };
}

// ── Unpacking ────────────────────────────────────────────────────────────────

/** The stream is not something safe to unpack. The message is for the agent. */
export class TarProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TarProtocolError";
  }
}

export interface ExtractLimits {
  maxFiles: number;
  maxBytes: number;
}

export interface ExtractSkip {
  path: string;
  why: string;
}

export interface ExtractReport {
  files: number;
  directories: number;
  bytes: number;
  /** Entries that were not restored (links, special files): how many, and the first few. */
  skippedCount: number;
  skipped: ExtractSkip[];
  /** The end-of-archive marker (or an empty stream) was seen: nothing was cut off. */
  complete: boolean;
}

export interface ExtractOptions {
  /** The project's top directory: member names are relative to it. */
  root: string;
  /** Root-relative paths (with `/`) a member may be at or under; anything else is refused. */
  allowed: readonly string[];
  limits?: Partial<ExtractLimits>;
}

/** A member name as safe relative parts, or an explanation. The empty string is the archive root itself. */
export function checkMemberName(raw: string): string {
  if (raw.includes("\0")) throw new TarProtocolError("a result has a NUL character in its name");
  if (raw.startsWith("/") || raw.startsWith("\\")) throw new TarProtocolError(`a result has an absolute name: ${raw}`);
  const parts = raw.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.includes("..")) throw new TarProtocolError(`a result name leaves the project: ${raw}`);
  if (parts.includes(".git")) throw new TarProtocolError(`a result is inside .git: ${raw}`);
  return parts.join("/");
}

function readString(block: Buffer, start: number, length: number): string {
  const slice = block.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end < 0 ? slice.length : end).toString("utf8");
}

/** An octal field, or the base-256 form GNU tar uses past 8 GiB. */
function readNumber(block: Buffer, start: number, length: number): number {
  const field = block.subarray(start, start + length);
  if (field[0] & 0x80) {
    let value = field[0] & 0x7f;
    for (let i = 1; i < field.length; i += 1) {
      value = value * 256 + field[i];
      if (!Number.isSafeInteger(value)) throw new TarProtocolError("a result is impossibly large");
    }
    return value;
  }
  const text = field.toString("latin1").replace(/\0[\s\S]*$/, "").trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) throw new TarProtocolError("the archive has a damaged header");
  return Number.parseInt(text, 8);
}

function checksumOk(block: Buffer): boolean {
  let sum = 0;
  for (let i = 0; i < BLOCK; i += 1) sum += i >= 148 && i < 156 ? 32 : block[i];
  try {
    return readNumber(block, 148, 8) === sum;
  } catch {
    return false;
  }
}

interface Overrides {
  name?: string;
  size?: number;
  mtime?: number;
}

type Mode = "header" | "body" | "padding" | "done";
type BodyKind = "file" | "skip" | "pax" | "longname";

interface OpenFile {
  handle: fs.promises.FileHandle;
  temp: string;
  target: string;
  mode: number;
  mtime: number | null;
}

function parsePax(body: Buffer, into: Overrides): void {
  let position = 0;
  while (position < body.length) {
    const space = body.indexOf(0x20, position);
    if (space < 0) throw new TarProtocolError("the archive has a damaged extended header");
    const length = Number.parseInt(body.subarray(position, space).toString("latin1"), 10);
    if (!Number.isInteger(length) || length <= space - position + 1 || position + length > body.length) {
      throw new TarProtocolError("the archive has a damaged extended header");
    }
    const record = body.subarray(space + 1, position + length - 1).toString("utf8");
    const equals = record.indexOf("=");
    if (equals > 0) {
      const key = record.slice(0, equals);
      const value = record.slice(equals + 1);
      if (key === "path") into.name = value;
      else if (key === "size") {
        const size = Number.parseInt(value, 10);
        if (Number.isSafeInteger(size) && size >= 0) into.size = size;
      } else if (key === "mtime") {
        const mtime = Number.parseFloat(value);
        if (Number.isFinite(mtime)) into.mtime = mtime;
      }
    }
    position += length;
  }
}

const EMPTY = Buffer.alloc(0);

/**
 * Restores a tar stream under `root`, a writable the stream is piped into. It
 * fails (the pipe errors) on the first thing it will not accept; what it
 * already wrote stays, which is why a failed copy-back is reported as such.
 */
export class TarExtractor extends Writable {
  readonly report: ExtractReport = { files: 0, directories: 0, bytes: 0, skippedCount: 0, skipped: [], complete: false };

  private readonly root: string;
  private readonly allowed: readonly string[];
  private readonly limits: ExtractLimits;
  private rootReal: string | null = null;
  private readonly checkedDirectories = new Set<string>();
  private buffer: Buffer = EMPTY;
  private mode: Mode = "header";
  private bodyKind: BodyKind = "skip";
  private remaining = 0;
  private padding = 0;
  private zeroBlocks = 0;
  private received = 0;
  private overrides: Overrides = {};
  private meta: Buffer[] = [];
  private metaSize = 0;
  private metaType: "x" | "L" | "g" | "K" | null = null;
  private file: OpenFile | null = null;

  constructor(options: ExtractOptions) {
    super();
    this.root = options.root;
    this.allowed = options.allowed;
    this.limits = { ...DEFAULT_EXTRACT_LIMITS, ...options.limits };
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.received += chunk.length;
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    this.consume().then(() => callback(), (error: unknown) => callback(error instanceof Error ? error : new Error(String(error))));
  }

  override _final(callback: (error?: Error | null) => void): void {
    if (this.mode === "done" || this.received === 0) {
      this.report.complete = true;
      callback();
      return;
    }
    callback(new TarProtocolError("the transfer of the results was cut short"));
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    const open = this.file;
    this.file = null;
    if (!open) {
      callback(error);
      return;
    }
    open.handle.close().catch(() => {}).then(() => fs.promises.rm(open.temp, { force: true })).catch(() => {}).then(() => callback(error));
  }

  private async consume(): Promise<void> {
    for (;;) {
      if (this.mode === "done") {
        this.buffer = EMPTY;
        return;
      }
      if (this.mode === "header") {
        if (this.buffer.length < BLOCK) return;
        const block = this.buffer.subarray(0, BLOCK);
        this.buffer = this.buffer.subarray(BLOCK);
        await this.header(block);
        continue;
      }
      if (this.mode === "body") {
        if (this.remaining > 0) {
          if (this.buffer.length === 0) return;
          const take = Math.min(this.remaining, this.buffer.length);
          const data = this.buffer.subarray(0, take);
          this.buffer = this.buffer.subarray(take);
          this.remaining -= take;
          await this.body(data);
        }
        if (this.remaining === 0) {
          await this.endBody();
          this.mode = this.padding > 0 ? "padding" : "header";
        }
        continue;
      }
      // padding
      if (this.buffer.length === 0) return;
      const drop = Math.min(this.padding, this.buffer.length);
      this.buffer = this.buffer.subarray(drop);
      this.padding -= drop;
      if (this.padding === 0) this.mode = "header";
    }
  }

  private skip(name: string, why: string): void {
    this.report.skippedCount += 1;
    if (this.report.skipped.length < MAX_SKIPPED_LISTED) this.report.skipped.push({ path: name, why });
  }

  private async header(block: Buffer): Promise<void> {
    if (block.every((byte) => byte === 0)) {
      this.zeroBlocks += 1;
      if (this.zeroBlocks >= 2) this.mode = "done";
      return;
    }
    this.zeroBlocks = 0;
    if (!checksumOk(block)) throw new TarProtocolError("what came back is not a tar archive (bad checksum)");

    const typeflag = String.fromCharCode(block[156] || 0x30);
    let size = readNumber(block, 124, 12);
    const isUstar = block.subarray(257, 262).toString("latin1") === "ustar";
    let name = readString(block, 0, 100);
    if (isUstar) {
      const prefix = readString(block, 345, 155);
      if (prefix) name = `${prefix}/${name}`;
    }
    const mode = readNumber(block, 100, 8);
    const mtime = readNumber(block, 136, 12);

    if (typeflag === "x" || typeflag === "g" || typeflag === "L" || typeflag === "K") {
      if (size > MAX_META_BYTES) throw new TarProtocolError("the archive has an oversized header");
      this.metaType = typeflag;
      this.meta = [];
      this.metaSize = 0;
      this.startBody(size, typeflag === "x" ? "pax" : typeflag === "L" ? "longname" : "skip");
      return;
    }

    const overrides = this.overrides;
    this.overrides = {};
    if (overrides.name !== undefined) name = overrides.name;
    if (overrides.size !== undefined) size = overrides.size;
    const modified = overrides.mtime ?? mtime;

    if (typeflag === "0" || typeflag === "7") {
      await this.openFile(name, mode, modified, size);
      this.startBody(size, "file");
      return;
    }
    if (typeflag === "5") {
      const relative = this.admit(name);
      if (relative) await this.ensureDirectory(relative);
      this.report.directories += relative ? 1 : 0;
      this.startBody(0, "skip");
      return;
    }
    if (typeflag === "S") throw new TarProtocolError("sparse files in the results are not supported");
    const relative = this.admit(name) || name;
    this.skip(relative, typeflag === "1" ? "hard link" : typeflag === "2" ? "symbolic link" : "special file");
    this.startBody(typeflag === "1" || typeflag === "2" ? 0 : size, "skip");
  }

  private startBody(size: number, kind: BodyKind): void {
    this.bodyKind = kind;
    this.remaining = size;
    this.padding = size % BLOCK === 0 ? 0 : BLOCK - (size % BLOCK);
    this.mode = "body";
  }

  /** The member's place in the project, or an error if it is not one of the paths asked for. */
  private admit(name: string): string {
    const relative = checkMemberName(name);
    if (relative === "") return "";
    if (!this.allowed.some((allowed) => relative === allowed || relative.startsWith(`${allowed}/`))) {
      throw new TarProtocolError(`the worker sent ${relative}, which was not asked for`);
    }
    return relative;
  }

  private async realRoot(): Promise<string> {
    this.rootReal ??= await fs.promises.realpath(this.root);
    return this.rootReal;
  }

  /** Make `relative` a directory inside the project, creating what is missing; never through a link that leaves it. Returns its real path. */
  private async ensureDirectory(relative: string): Promise<string> {
    const rootReal = await this.realRoot();
    if (relative === "") return rootReal;
    let current = rootReal;
    let walked = "";
    for (const part of relative.split("/")) {
      walked = walked ? `${walked}/${part}` : part;
      const next = path.join(current, part);
      if (!this.checkedDirectories.has(walked)) {
        let stat: fs.Stats | null = null;
        try {
          stat = await fs.promises.lstat(next);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (!stat) {
          await fs.promises.mkdir(next);
        } else if (stat.isSymbolicLink()) {
          const real = await fs.promises.realpath(next);
          if (!isInside(rootReal, real) || !(await fs.promises.stat(real)).isDirectory()) {
            throw new TarProtocolError(`${walked} is a link in the project that leads outside it or is not a directory`);
          }
        } else if (!stat.isDirectory()) {
          throw new TarProtocolError(`${walked} is a file in the project but a directory in the results`);
        }
        this.checkedDirectories.add(walked);
      }
      current = next;
    }
    const real = await fs.promises.realpath(current);
    if (!isInside(rootReal, real)) throw new TarProtocolError(`${relative} leads outside the project`);
    return real;
  }

  private async openFile(name: string, mode: number, mtime: number | null, size: number): Promise<void> {
    const relative = this.admit(name);
    if (relative === "") throw new TarProtocolError("a result file has no name");
    if (this.report.files + 1 > this.limits.maxFiles) throw new TarProtocolError(`the results hold more than ${this.limits.maxFiles.toLocaleString("en-US")} files`);
    if (this.report.bytes + size > this.limits.maxBytes) {
      throw new TarProtocolError(`the results are bigger than ${Math.round(this.limits.maxBytes / (1024 * 1024)).toLocaleString("en-US")} MB`);
    }
    const parent = await this.ensureDirectory(path.posix.dirname(relative) === "." ? "" : path.posix.dirname(relative));
    const base = path.posix.basename(relative);
    const target = path.join(parent, base);
    try {
      if ((await fs.promises.lstat(target)).isDirectory()) {
        throw new TarProtocolError(`${relative} is a directory in the project but a file in the results`);
      }
    } catch (error) {
      if (error instanceof TarProtocolError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const temp = path.join(parent, `.${base}.cody-${randomBytes(4).toString("hex")}.tmp`);
    const handle = await fs.promises.open(temp, "wx", 0o600);
    // Owner can always read and write what came back; set-uid bits and the like are never restored.
    this.file = { handle, temp, target, mode: (mode & 0o777) | 0o600, mtime };
    this.report.files += 1;
  }

  private async body(data: Buffer): Promise<void> {
    if (this.bodyKind === "file") {
      const open = this.file;
      if (!open) throw new TarProtocolError("the archive's file data has no header");
      let offset = 0;
      while (offset < data.length) {
        const { bytesWritten } = await open.handle.write(data, offset, data.length - offset);
        offset += bytesWritten;
      }
      this.report.bytes += data.length;
    } else if (this.bodyKind === "pax" || this.bodyKind === "longname") {
      this.meta.push(Buffer.from(data));
      this.metaSize += data.length;
    }
  }

  private async endBody(): Promise<void> {
    if (this.bodyKind === "file") {
      const open = this.file;
      if (!open) return;
      this.file = null;
      try {
        await open.handle.chmod(open.mode);
        await open.handle.close();
        if (open.mtime !== null) {
          const when = new Date(open.mtime * 1000);
          await fs.promises.utimes(open.temp, when, when).catch(() => {});
        }
        await fs.promises.rename(open.temp, open.target);
      } catch (error) {
        await fs.promises.rm(open.temp, { force: true }).catch(() => {});
        throw error;
      }
    } else if (this.bodyKind === "pax") {
      parsePax(Buffer.concat(this.meta), this.overrides);
    } else if (this.bodyKind === "longname") {
      this.overrides.name = readString(Buffer.concat(this.meta), 0, this.metaSize);
    }
    this.meta = [];
    this.metaSize = 0;
    this.metaType = null;
  }
}

/**
 * Cuts the text a remote command prints before its binary payload off the
 * front of a stream: everything up to and including `marker` is collected in
 * `head`, everything after is passed on unchanged.
 */
export class HeadSplitter extends Transform {
  head = "";
  found = false;
  private pending: Buffer = EMPTY;
  private readonly marker: Buffer;

  constructor(marker: string, private readonly maxHead = 256 * 1024) {
    super();
    this.marker = Buffer.from(marker, "utf8");
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    if (this.found) {
      callback(null, chunk);
      return;
    }
    this.pending = Buffer.concat([this.pending, chunk]);
    const at = this.pending.indexOf(this.marker);
    if (at >= 0) {
      this.found = true;
      this.head += this.pending.subarray(0, at).toString("utf8");
      const rest = this.pending.subarray(at + this.marker.length);
      this.pending = EMPTY;
      callback(null, rest.length > 0 ? rest : undefined);
      return;
    }
    if (this.pending.length > this.maxHead) {
      callback(new TarProtocolError("the worker's answer has no results section"));
      return;
    }
    callback();
  }

  override _flush(callback: TransformCallback): void {
    if (!this.found) this.head += this.pending.toString("utf8");
    callback();
  }
}
