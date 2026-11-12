import * as fs from "node:fs";
import * as path from "node:path";

/**
 * What a job printed, kept the way a person would want to read it: terminal
 * colours and cursor codes removed, a progress bar that rewrites its own line
 * (`\r`) shown as its last state, and two views of the same text: the last
 * lines in memory (for the status shown while it runs and the end of the
 * result) and the whole thing in a file whose path the agent is given.
 */

/** The result and the live status show this many lines from the end. */
export const TAIL_LINES = 200;
/** A line longer than this is shortened in the tail (the file keeps it all). */
const MAX_TAIL_LINE_CHARS = 4000;
/** The file stops growing here, so a command that prints forever cannot fill the disk. */
export const LOG_CAP_BYTES = 32 * 1024 * 1024;
/** A line that never ends (binary output) is cut into pieces of this size so it cannot grow in memory without bound. */
const MAX_LINE_BUFFER = 256 * 1024;

// An escape sequence: CSI (`ESC [ … final`), OSC (`ESC ] … BEL` or `ESC ] … ESC \`), or a two-byte one.
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
// Control characters that mean nothing in a log (tab, newline and carriage return are handled separately).
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
/** An escape sequence that may still be completed by the next chunk. */
// eslint-disable-next-line no-control-regex
const OPEN_ESCAPE = /\u001b(?:\[[0-?]*[ -/]*|\][^\u0007\u001b]*\u001b?)?$/;
const MAX_ESCAPE_CARRY = 128;

export interface OutputSinkOptions {
  /** Where the whole output goes; omitted: only the tail is kept. */
  logPath?: string | null;
  tailLines?: number;
}

export class OutputSink {
  private readonly lines: string[] = [];
  private readonly tailLines: number;
  private current = "";
  /** The last chunk ended in `\r`: it is a line ending if `\n` comes next, a rewrite otherwise. */
  private pendingReturn = false;
  private carry = "";
  private totalLines = 0;
  private fd: number | null = null;
  private opened = false;
  private logBytes = 0;
  private logFull = false;
  readonly logPath: string | null;

  constructor(options: OutputSinkOptions = {}) {
    this.tailLines = options.tailLines ?? TAIL_LINES;
    this.logPath = options.logPath ?? null;
    if (this.logPath) {
      try {
        fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
        this.fd = fs.openSync(this.logPath, "w", 0o600);
        this.opened = true;
      } catch {
        this.fd = null;
      }
    }
  }

  /** Lines seen so far (a half-written one counts once it has text). */
  get lineCount(): number {
    return this.totalLines + (this.current ? 1 : 0);
  }

  /** True when the file stopped growing at its size cap. */
  get logTruncated(): boolean {
    return this.logFull;
  }

  /** True when there is a file with the whole output in it. */
  get hasLog(): boolean {
    return this.opened;
  }

  write(text: string): void {
    if (!text) return;
    let input = this.carry + text;
    this.carry = "";
    const open = OPEN_ESCAPE.exec(input);
    if (open && open[0].length <= MAX_ESCAPE_CARRY) {
      this.carry = open[0];
      input = input.slice(0, open.index);
    }
    const clean = input.replace(ANSI, "").replace(CONTROL, "");
    if (!clean) return;

    if (this.pendingReturn) {
      this.pendingReturn = false;
      // `\r` then `\n` is a line ending; `\r` then anything else rewrote the line.
      if (!clean.startsWith("\n")) this.current = "";
    }
    const parts = clean.split("\n");
    for (let i = 0; i < parts.length; i += 1) {
      let part = parts[i];
      const last = i === parts.length - 1;
      if (part.includes("\r")) {
        const trailingReturn = part.endsWith("\r");
        if (trailingReturn) part = part.slice(0, -1);
        const segments = part.split("\r");
        this.current += segments[0];
        for (let s = 1; s < segments.length; s += 1) this.current = segments[s];
        if (trailingReturn) {
          if (last) this.pendingReturn = true;
          // before a "\n" (CRLF) the return changes nothing
        }
      } else {
        this.current += part;
      }
      if (!last) this.commit();
      else if (this.current.length > MAX_LINE_BUFFER) this.spill();
    }
  }

  private commit(): void {
    const line = this.current;
    this.current = "";
    this.pushLine(line);
  }

  private spill(): void {
    while (this.current.length > MAX_LINE_BUFFER) {
      const head = this.current.slice(0, MAX_LINE_BUFFER);
      this.current = this.current.slice(MAX_LINE_BUFFER);
      this.pushLine(head);
    }
  }

  private pushLine(line: string): void {
    this.totalLines += 1;
    this.lines.push(line.length > MAX_TAIL_LINE_CHARS ? `${line.slice(0, MAX_TAIL_LINE_CHARS)} … [+${line.length - MAX_TAIL_LINE_CHARS} characters]` : line);
    if (this.lines.length > this.tailLines) this.lines.shift();
    this.appendLog(`${line}\n`);
  }

  private appendLog(text: string): void {
    if (this.fd === null || this.logFull) return;
    try {
      const bytes = Buffer.from(text, "utf8");
      if (this.logBytes + bytes.length > LOG_CAP_BYTES) {
        const note = Buffer.from(`\n[Output file cut off at ${Math.round(LOG_CAP_BYTES / (1024 * 1024))} MB; the end of the output is in the tool result]\n`, "utf8");
        fs.writeSync(this.fd, note);
        this.logFull = true;
        return;
      }
      fs.writeSync(this.fd, bytes);
      this.logBytes += bytes.length;
    } catch {
      this.closeLog();
    }
  }

  /** The last `count` lines, with the line still being written as the final one. */
  tail(count: number = this.tailLines): string[] {
    const all = this.current ? [...this.lines, this.current.length > MAX_TAIL_LINE_CHARS ? `${this.current.slice(0, MAX_TAIL_LINE_CHARS)} …` : this.current] : [...this.lines];
    return all.slice(-count);
  }

  /** The output is over: the half-written last line counts, the file is closed. */
  end(): void {
    if (this.carry) {
      this.carry = "";
    }
    if (this.current) {
      const line = this.current;
      this.current = "";
      this.pushLine(line);
    }
    this.closeLog();
  }

  private closeLog(): void {
    if (this.fd === null) return;
    try {
      fs.closeSync(this.fd);
    } catch {
      // already gone
    }
    this.fd = null;
  }
}
