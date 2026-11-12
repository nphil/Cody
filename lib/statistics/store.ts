/**
 * The statistics index: daily aggregates per source file, kept in Cody's own
 * instance data dir.
 *
 * One JSON file, written atomically (temp + rename, 0600 in a 0700 dir). Rows
 * and per-file read offsets share that file on purpose: they can never disagree,
 * so a crash cannot leave rows from bytes the offsets say were never read (which
 * would count them twice on the next pass).
 *
 * A row is a day of one provider/model/worker inside one transcript file. Rows
 * are grouped by file so that a transcript that shrank or was rewritten can be
 * dropped and re-read as a unit. History older than `RETAIN_DAYS` is pruned, and
 * the file never outgrows `MAX_ROWS`.
 */

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isRecord } from "../type-guards";
import { billingKind } from "./billing";
import { addDays, dayToInt, intToDay, makeDayOf } from "./days";
import { cacheSaving, estimateCost, learnRates, rateKey, type RateBook } from "./rates";
import type { UsageRecord } from "./scan";
import type { BillingKind, FileEntry, RateEntry, SourceKind, StatRow, TopTurn } from "./types";

export const INDEX_FILE = "index.json";
export const INDEX_VERSION = 1;
/** Usage older than this many days is dropped from the index. */
export const RETAIN_DAYS = 400;
/** A hard ceiling so a pathological transcript set cannot grow the index forever. */
export const MAX_ROWS = 400_000;
/** Most-expensive-turn entries kept per transcript. */
export const TOP_TURNS_PER_FILE = 8;

type RowArray = [number, number, number, number, number, number, number, number, number, number, number, number, number];

/** What a file needs when it is first met; the rest starts empty. */
export interface FileSeed {
  kind: SourceKind;
  chat: string;
  cwd?: string;
  slug?: string;
  name?: string;
}

function emptyFile(id: number, filePath: string, seed: FileSeed): FileEntry {
  return {
    id,
    path: filePath,
    kind: seed.kind,
    chat: seed.chat,
    cwd: seed.cwd ?? "",
    agent: "",
    slug: seed.slug ?? "",
    name: seed.name ?? "",
    size: 0,
    mtimeMs: 0,
    ino: 0,
    offset: 0,
    headerTs: 0,
    forked: false,
    lastModel: {},
    first: 0,
    last: 0,
    top: [],
    gone: false,
  };
}

/** Ranks turns: priced ones by cost, unpriced ones by tokens (a billionth of a dollar each, so they sort below any priced turn). */
function turnScore(turn: TopTurn): number {
  return turn.cost > 0 ? turn.cost : (turn.input + turn.output + turn.cacheRead + turn.cacheWrite) / 1e9;
}

function pushTopTurn(file: FileEntry, turn: TopTurn): void {
  const score = turnScore(turn);
  const top = file.top;
  if (top.length >= TOP_TURNS_PER_FILE && score <= turnScore(top[top.length - 1])) return;
  let at = top.length;
  while (at > 0 && turnScore(top[at - 1]) < score) at -= 1;
  top.splice(at, 0, turn);
  if (top.length > TOP_TURNS_PER_FILE) top.length = TOP_TURNS_PER_FILE;
}

function asRate(value: unknown): RateEntry | null {
  if (!isRecord(value)) return null;
  const read = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  return { input: read(value.input), output: read(value.output), cacheRead: read(value.cacheRead), cacheWrite: read(value.cacheWrite) };
}

function asFile(value: unknown): FileEntry | null {
  if (!isRecord(value)) return null;
  const { id, path: filePath, kind } = value;
  if (typeof id !== "number" || typeof filePath !== "string" || typeof kind !== "string") return null;
  if (kind !== "main" && kind !== "sidebar" && kind !== "subagent" && kind !== "advisor" && kind !== "oneshot") return null;
  const file = emptyFile(id, filePath, { kind, chat: typeof value.chat === "string" ? value.chat : "" });
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  file.cwd = str(value.cwd);
  file.agent = str(value.agent);
  file.slug = str(value.slug);
  file.name = str(value.name);
  file.size = num(value.size);
  file.mtimeMs = num(value.mtimeMs);
  file.ino = num(value.ino);
  file.offset = num(value.offset);
  file.headerTs = num(value.headerTs);
  file.forked = value.forked === true;
  file.first = num(value.first);
  file.last = num(value.last);
  file.gone = value.gone === true;
  if (isRecord(value.lastModel)) {
    for (const [provider, model] of Object.entries(value.lastModel)) if (typeof model === "string") file.lastModel[provider] = model;
  }
  if (Array.isArray(value.top)) {
    for (const turn of value.top) {
      if (!isRecord(turn)) continue;
      file.top.push({
        ts: num(turn.ts),
        id: str(turn.id),
        provider: str(turn.provider),
        model: str(turn.model),
        worker: str(turn.worker),
        input: num(turn.input),
        output: num(turn.output),
        cacheRead: num(turn.cacheRead),
        cacheWrite: num(turn.cacheWrite),
        cost: num(turn.cost),
      });
    }
    file.top.length = Math.min(file.top.length, TOP_TURNS_PER_FILE);
  }
  return file;
}

export class StatsStore {
  readonly dir: string;
  /** The zone days are bucketed in; fixed when the index was created. */
  zone: string;
  created: number;
  /** When a pass last finished (ms), or null. */
  indexedAt: number | null = null;
  nextFileId = 1;
  readonly files = new Map<number, FileEntry>();
  readonly byPath = new Map<string, FileEntry>();
  readonly rows = new Map<number, Map<string, StatRow>>();
  rates: RateBook = {};
  /** Byte offset reached in each append-only job log. */
  logs: Record<string, number> = {};
  dirty = false;
  lastSaveError: string | null = null;

  private readonly dayOf: (ts: number) => number;
  private readonly kinds = new Map<string, BillingKind>();

  private constructor(dir: string, zone: string, created: number) {
    this.dir = dir;
    this.zone = zone;
    this.created = created;
    this.dayOf = makeDayOf(zone);
  }

  /**
   * Opens the index in `dir`, or starts an empty one in `zone`. An existing
   * index keeps ITS zone: its days were bucketed there, so changing zones
   * later must not silently relabel history.
   */
  static open(dir: string, zone: string, now: number = Date.now()): StatsStore {
    const loaded = StatsStore.read(dir);
    return loaded ?? new StatsStore(dir, zone, now);
  }

  private static read(dir: string): StatsStore | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(dir, INDEX_FILE), "utf8"));
    } catch {
      return null;
    }
    if (!isRecord(parsed) || parsed.v !== INDEX_VERSION || typeof parsed.zone !== "string") return null;
    try {
      const store = new StatsStore(dir, parsed.zone, typeof parsed.created === "number" ? parsed.created : Date.now());
      store.indexedAt = typeof parsed.indexedAt === "number" ? parsed.indexedAt : null;
      store.nextFileId = typeof parsed.nextFileId === "number" ? parsed.nextFileId : 1;
      if (isRecord(parsed.rates)) {
        for (const [key, value] of Object.entries(parsed.rates)) {
          const rate = asRate(value);
          if (rate) store.rates[key] = rate;
        }
      }
      if (isRecord(parsed.logs)) {
        for (const [key, value] of Object.entries(parsed.logs)) if (typeof value === "number") store.logs[key] = value;
      }
      if (Array.isArray(parsed.files)) {
        for (const raw of parsed.files) {
          const file = asFile(raw);
          if (!file) continue;
          store.files.set(file.id, file);
          store.byPath.set(file.path, file);
          if (file.id >= store.nextFileId) store.nextFileId = file.id + 1;
        }
      }
      const strings = Array.isArray(parsed.strings) ? (parsed.strings as unknown[]) : [];
      const text = (index: number): string => (typeof strings[index] === "string" ? (strings[index] as string) : "");
      if (Array.isArray(parsed.rows)) {
        for (const raw of parsed.rows) {
          if (!Array.isArray(raw) || raw.length < 13) continue;
          const [day, file, provider, model, worker, n, input, output, cacheRead, cacheWrite, cost, unpriced, save] = raw as number[];
          if (!store.files.has(file)) continue;
          const row: StatRow = {
            day, file, provider: text(provider), model: text(model), worker: text(worker),
            n, input, output, cacheRead, cacheWrite, cost, unpriced, save,
          };
          store.rowsOf(file).set(rowKey(row.day, row.provider, row.model, row.worker), row);
        }
      }
      return store;
    } catch {
      return null;
    }
  }

  rowsOf(fileId: number): Map<string, StatRow> {
    let rows = this.rows.get(fileId);
    if (!rows) {
      rows = new Map();
      this.rows.set(fileId, rows);
    }
    return rows;
  }

  /** The entry for a transcript path, created empty on first sight. */
  fileFor(filePath: string, seed: FileSeed): FileEntry {
    const known = this.byPath.get(filePath);
    if (known) return known;
    const file = emptyFile(this.nextFileId, filePath, seed);
    this.nextFileId += 1;
    this.files.set(file.id, file);
    this.byPath.set(filePath, file);
    this.dirty = true;
    return file;
  }

  /** Forgets everything read from a file so it can be read again from byte 0. */
  resetFile(file: FileEntry): void {
    this.rows.delete(file.id);
    file.offset = 0;
    file.headerTs = 0;
    file.forked = false;
    file.agent = "";
    file.lastModel = {};
    file.first = 0;
    file.last = 0;
    file.top = [];
    this.dirty = true;
  }

  billingOf(provider: string): BillingKind {
    let kind = this.kinds.get(provider);
    if (!kind) {
      kind = billingKind(provider);
      this.kinds.set(provider, kind);
    }
    return kind;
  }

  /**
   * Files one call's usage under its day/provider/model/worker row.
   *
   * A call is PRICED when omp recorded a cost for it. One that did not goes to
   * `unpriced` as tokens: never a $0 cost, because "no price on file" is not
   * "free". The exception is a local runtime, where there is genuinely no
   * per-token price to be missing.
   */
  addRecord(file: FileEntry, record: UsageRecord): void {
    const usage = record.usage;
    const tokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
    const day = this.dayOf(record.ts);
    const key = rowKey(day, record.provider, record.model, record.worker);
    const rows = this.rowsOf(file.id);
    let row = rows.get(key);
    if (!row) {
      row = {
        day, file: file.id, provider: record.provider, model: record.model, worker: record.worker,
        n: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, unpriced: 0, save: 0,
      };
      rows.set(key, row);
    }
    const rates = learnRates(this.rates, rateKey(record.provider, record.model), usage);
    let cost = usage.costTotal;
    if (cost <= 0 && record.estimate && this.billingOf(record.provider) === "subscription") cost = estimateCost(usage, rates) ?? 0;
    row.n += 1;
    row.input += usage.input;
    row.output += usage.output;
    row.cacheRead += usage.cacheRead;
    row.cacheWrite += usage.cacheWrite;
    if (cost > 0) {
      row.cost += cost;
      row.save += cacheSaving(usage, rates);
    } else if (tokens > 0 && this.billingOf(record.provider) !== "local") {
      row.unpriced += tokens;
    }
    if (file.first === 0 || record.ts < file.first) file.first = record.ts;
    if (record.ts > file.last) file.last = record.ts;
    if (record.turn) {
      pushTopTurn(file, {
        ts: record.ts,
        id: record.id,
        provider: record.provider,
        model: record.model,
        worker: record.worker,
        input: usage.input,
        output: usage.output,
        cacheRead: usage.cacheRead,
        cacheWrite: usage.cacheWrite,
        cost: cost > 0 ? cost : 0,
      });
    }
    this.dirty = true;
  }

  /** Marks every transcript not in `seen` as deleted from disk. Its rows stay. */
  markGone(seen: ReadonlySet<string>): void {
    for (const file of this.files.values()) {
      if (file.kind === "oneshot") continue;
      const gone = !seen.has(file.path);
      if (file.gone !== gone) {
        file.gone = gone;
        this.dirty = true;
      }
    }
  }

  rowCount(): number {
    let count = 0;
    for (const rows of this.rows.values()) count += rows.size;
    return count;
  }

  /**
   * Drops usage older than the retention window (and, past the row ceiling,
   * the oldest days first), then forgets deleted transcripts that no longer own
   * any row. `todayInt` is today's yyyymmdd in the index zone.
   */
  prune(todayInt: number): void {
    const cutoff = dayToInt(addDays(intToDay(todayInt), -RETAIN_DAYS));
    let hardCutoff = cutoff;
    const count = this.rowCount();
    if (count > MAX_ROWS) {
      const days: number[] = [];
      for (const rows of this.rows.values()) for (const row of rows.values()) days.push(row.day);
      days.sort((a, b) => a - b);
      hardCutoff = Math.max(cutoff, days[count - MAX_ROWS] + 1);
    }
    for (const [fileId, rows] of this.rows) {
      for (const [key, row] of rows) {
        if (row.day < hardCutoff) {
          rows.delete(key);
          this.dirty = true;
        }
      }
      if (rows.size === 0) this.rows.delete(fileId);
    }
    for (const file of [...this.files.values()]) {
      if ((file.gone || file.kind === "oneshot") && !this.rows.has(file.id)) {
        this.files.delete(file.id);
        this.byPath.delete(file.path);
        this.dirty = true;
      }
    }
  }

  /** Writes the index. Never throws; a failure is kept in `lastSaveError` and retried next time. */
  save(): boolean {
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const strings: string[] = [];
      const seen = new Map<string, number>();
      const intern = (value: string): number => {
        let index = seen.get(value);
        if (index === undefined) {
          index = strings.length;
          strings.push(value);
          seen.set(value, index);
        }
        return index;
      };
      const rows: RowArray[] = [];
      for (const fileRows of this.rows.values()) {
        for (const r of fileRows.values()) {
          rows.push([r.day, r.file, intern(r.provider), intern(r.model), intern(r.worker), r.n, r.input, r.output, r.cacheRead, r.cacheWrite, r.cost, r.unpriced, r.save]);
        }
      }
      const body = JSON.stringify({
        v: INDEX_VERSION,
        zone: this.zone,
        created: this.created,
        indexedAt: this.indexedAt,
        nextFileId: this.nextFileId,
        rates: this.rates,
        logs: this.logs,
        files: [...this.files.values()],
        strings,
        rows,
      });
      const target = path.join(this.dir, INDEX_FILE);
      const temp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
      try {
        fs.writeFileSync(temp, body, { mode: 0o600 });
        fs.renameSync(temp, target);
      } catch (error) {
        fs.rmSync(temp, { force: true });
        throw error;
      }
      this.dirty = false;
      this.lastSaveError = null;
      return true;
    } catch (error) {
      this.lastSaveError = error instanceof Error ? error.message : String(error);
      return false;
    }
  }
}

function rowKey(day: number, provider: string, model: string, worker: string): string {
  return `${day}|${provider}|${model}|${worker}`;
}
