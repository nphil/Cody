import { execFile, spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readEnv } from "../env";
import { getAgentDir } from "../omp/paths";
import { isRecord } from "../type-guards";
import { readLiveSessions, type LiveSessions } from "./janitor";
import { PathMentions, scanProcessUsage } from "./mentions";
import { CANDIDATE_NAMES, isWithin, labelFor, MARKER_FILES, type UsageContext, type UsageLabel } from "./usage-rules";
import type {
  ClearAnswer,
  ClearManyAnswer,
  ClearRefusal,
  UsageCandidate,
  UsageNode,
  UsagePayload,
  UsageResult,
  UsageRoot,
  UsageScanState,
  UsageVolume,
} from "./usage-types";
import { lowPriorityCommand, removeTree } from "./walk";

/**
 * "What is using space": runs the disk-usage scan (bin/cody-disk-usage.mjs) as
 * a low-priority process of its own, keeps the newest result on disk, labels
 * what it found, and clears the labelled build output and caches on request.
 *
 * - One scan at a time across both volumes. The scanner writes progress to
 *   `cody-disk-usage-<volume>.partial.json` every few seconds and the finished
 *   result to `cody-disk-usage-<volume>.json` (both 0600, atomic, in the agent
 *   dir). A scan a previous server started is still seen as running while its
 *   progress file keeps being rewritten.
 * - Nothing is deleted on the strength of the cached tree. `clearUsageItem`
 *   asks the live disk again: the path must be a real folder (never a link, no
 *   link in its path), inside the home or temp folder (never the engine's own
 *   folder, never one of those roots, never a folder that contains the engine
 *   or this server's working directory), recognised by the SAME rules as the
 *   display against marker files read now, not in use by a running process or
 *   a running chat's folder, and quiet for 15 minutes. Anything uncertain
 *   refuses with a reason.
 * - Deletion is `rm -rf` as its own low-priority process with the path as ONE
 *   argument (`removeTree`); no path is ever put into a shell string.
 */

const SCAN_DEADLINE_MS = 45 * 60_000;
/** A scan whose progress file was rewritten this recently is still running. */
const FRESH_PARTIAL_MS = 20_000;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_NODE_DEPTH = 8;
const RESULT_KEEP_MS = 30 * 24 * 3_600_000;
const PARTIAL_KEEP_MS = 24 * 3_600_000;
const MEASURE_TIMEOUT_MS = 30 * 60_000;
const LEVELS = [24, 14, 10, 8];
const MIN_NODE_BYTES = 4 * 1024 * 1024;
const MAX_CANDIDATES = 200;
/** A tree with anything changed this recently is in use, whatever the process table says. */
export const RECENT_CHANGE_MS = 15 * 60_000;
export const DEFAULT_OLDER_THAN_DAYS = 14;
const BATCH_BUDGET_MS = 8 * 60_000;
const BATCH_MAX_ITEMS = 100;
const DAY_MS = 86_400_000;

export const USAGE_VOLUMES: readonly UsageVolume[] = ["data", "tmp"];

export function isUsageVolume(value: unknown): value is UsageVolume {
  return value === "data" || value === "tmp";
}

export function usageFiles(volume: UsageVolume): { result: string; partial: string } {
  const dir = getAgentDir();
  return { result: path.join(dir, `cody-disk-usage-${volume}.json`), partial: path.join(dir, `cody-disk-usage-${volume}.partial.json`) };
}

function scannerPath(): string {
  const packageDir = readEnv("PACKAGE_DIR") ?? path.resolve(import.meta.dirname, "../..");
  return path.join(packageDir, "bin", "cody-disk-usage.mjs");
}

function realOrResolved(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

function deviceOf(target: string): number | null {
  try {
    return fs.statSync(target).dev;
  } catch {
    return null;
  }
}

/** The three folders the labels and the delete checks are judged against, symlinks resolved. */
export function currentUsageContext(): UsageContext {
  return { home: realOrResolved(os.homedir()), agentDir: realOrResolved(getAgentDir()), tmpDir: realOrResolved(os.tmpdir()) };
}

/**
 * What a volume's scan walks. The data volume is the file system holding the
 * agent dir: that dir, the home folder and the temp folder when they are on it.
 * A folder inside another walked folder is not walked twice.
 */
export function usageRoots(volume: UsageVolume, context: UsageContext = currentUsageContext()): Array<{ path: string; label: UsageRoot["label"] }> {
  const wanted: Array<{ path: string; label: UsageRoot["label"] }> = [];
  if (volume === "tmp") {
    wanted.push({ path: context.tmpDir, label: "tmp" });
  } else {
    const dev = deviceOf(context.agentDir);
    wanted.push({ path: context.agentDir, label: "agent" });
    if (deviceOf(context.home) === dev) wanted.push({ path: context.home, label: "home" });
    if (deviceOf(context.tmpDir) === dev) wanted.push({ path: context.tmpDir, label: "tmp" });
  }
  return wanted.filter((root) => !wanted.some((other) => other !== root && other.path !== root.path && isWithin(root.path, other.path)));
}

// ---------- reading ----------

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

interface AnnotateEnv {
  context: UsageContext;
  /** Folders the file viewer can open (project and chat folders). */
  fileRoots: ReadonlySet<string>;
}

/** What a node shows when a folder above it already says what it is. */
function inheritedFrom(label: UsageLabel): Pick<UsageNode, "kind" | "rule" | "inherited"> {
  return { kind: label.kind, rule: label.rule, inherited: true };
}

function annotateNode(raw: unknown, parentPath: string | null, parentMarks: readonly string[], above: UsageLabel | null, env: AnnotateEnv, depth: number): UsageNode | null {
  if (!isRecord(raw) || typeof raw.name !== "string" || raw.name === "" || depth > MAX_NODE_DEPTH) return null;
  let nodePath: string;
  if (parentPath === null) {
    if (!path.isAbsolute(raw.name)) return null;
    nodePath = raw.name;
  } else {
    if (raw.name.includes("/") || raw.name.includes("\0")) return null;
    nodePath = path.join(parentPath, raw.name);
  }
  const marks = strings(raw.marks);
  const isDir = raw.dir !== false;
  const node: UsageNode = { name: parentPath === null ? nodePath : path.basename(nodePath), path: nodePath, bytes: num(raw.bytes), changedMs: num(raw.changedMs), dir: isDir, kind: "mine" };

  // A build folder or a cache folder says what everything inside it is; Cody's own folders name their direct children themselves.
  const closed = above !== null && (above.kind === "rebuild" || above.kind === "cache");
  const own = closed ? null : labelFor({ path: nodePath, parentMarks, ownMarks: marks }, env.context);
  if (own) {
    node.kind = own.kind;
    node.rule = own.rule;
    if (own.deletable && parentPath !== null) node.deletable = true;
    if (own.action) node.action = own.action;
  } else if (above) {
    Object.assign(node, inheritedFrom(above));
  }
  if (isDir && env.fileRoots.has(nodePath)) node.inFiles = true;

  if (Array.isArray(raw.children)) {
    const nextAbove = own ?? above;
    const children = raw.children
      .map((child) => annotateNode(child, nodePath, marks, nextAbove, env, depth + 1))
      .filter((child): child is UsageNode => child !== null);
    if (children.length > 0) node.children = children;
  }
  const otherBytes = num(raw.otherBytes);
  if (otherBytes > 0) {
    node.otherBytes = otherBytes;
    node.otherCount = num(raw.otherCount);
  }
  return node;
}

function annotateResult(raw: unknown, env: AnnotateEnv, expected: UsageVolume): UsageResult | null {
  if (!isRecord(raw) || raw.version !== 1 || raw.volume !== expected || !Array.isArray(raw.roots)) return null;
  const roots: UsageRoot[] = [];
  for (const entry of raw.roots) {
    if (!isRecord(entry) || typeof entry.path !== "string" || !isRecord(entry.node)) continue;
    const label = entry.label === "agent" || entry.label === "home" || entry.label === "tmp" ? entry.label : "home";
    const node = annotateNode({ ...entry.node, name: entry.path }, null, [], null, env, 0);
    if (node) roots.push({ path: entry.path, label, node });
  }
  const rebuildable: UsageCandidate[] = [];
  if (Array.isArray(raw.rebuildable)) {
    for (const item of raw.rebuildable) {
      if (!isRecord(item) || typeof item.path !== "string" || !path.isAbsolute(item.path)) continue;
      const label = labelFor({ path: item.path, parentMarks: strings(item.parentMarks), ownMarks: strings(item.marks) }, env.context);
      if (label?.kind !== "rebuild" || !label.deletable) continue;
      rebuildable.push({ path: item.path, bytes: num(item.bytes), changedMs: num(item.mtimeMs), rule: label.rule, kind: label.kind });
    }
  }
  return {
    volume: expected,
    startedAt: num(raw.startedAt),
    finishedAt: typeof raw.finishedAt === "number" ? raw.finishedAt : null,
    complete: raw.complete === true,
    ...(typeof raw.reason === "string" ? { reason: raw.reason } : {}),
    scannedBytes: num(raw.scannedBytes),
    entries: num(raw.entries),
    roots,
    rebuildable,
  };
}

function readJsonFile(file: string): unknown {
  try {
    if (fs.statSync(file).size > MAX_FILE_BYTES) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function mtimeOf(file: string): number | null {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

// ---------- scan control ----------

interface RunningScan {
  volume: UsageVolume;
  child: ChildProcess;
  startedAt: number;
}

declare global {
  var __codyDiskUsageScan: RunningScan | undefined;
  var __codyDiskUsageClearing: boolean | undefined;
}

function ownScan(): RunningScan | null {
  const scan = globalThis.__codyDiskUsageScan;
  if (scan && scan.child.exitCode === null && scan.child.signalCode === null) return scan;
  return null;
}

/** The volume a scan is running on right now (ours, or one a previous server started), else null. */
export function runningScanVolume(now: number = Date.now()): UsageVolume | null {
  const own = ownScan();
  if (own) return own.volume;
  for (const volume of USAGE_VOLUMES) {
    const touched = mtimeOf(usageFiles(volume).partial);
    if (touched !== null && now - touched < FRESH_PARTIAL_MS) return volume;
  }
  return null;
}

export function readScanState(volume: UsageVolume, now: number = Date.now()): UsageScanState {
  const running = runningScanVolume(now);
  const base: UsageScanState = { running: running !== null, volume: running, startedAt: null, entries: 0, scannedBytes: 0 };
  if (running === null) return base;
  const partial = readJsonFile(usageFiles(running).partial);
  const own = ownScan();
  return {
    ...base,
    startedAt: own?.startedAt ?? (isRecord(partial) && typeof partial.startedAt === "number" ? partial.startedAt : null),
    entries: isRecord(partial) ? num(partial.entries) : 0,
    scannedBytes: isRecord(partial) ? num(partial.scannedBytes) : 0,
  };
}

/** Start a scan unless one is running. Never throws. */
export function startUsageScan(volume: UsageVolume, context: UsageContext = currentUsageContext()): "started" | "running" | "unavailable" {
  if (runningScanVolume() !== null) return "running";
  const script = scannerPath();
  if (!fs.existsSync(script)) return "unavailable";
  pruneUsageCache();
  const files = usageFiles(volume);
  try {
    fs.mkdirSync(path.dirname(files.result), { recursive: true });
    fs.rmSync(files.partial, { force: true });
  } catch {
    return "unavailable";
  }
  const spec = {
    volume,
    roots: usageRoots(volume, context),
    markers: MARKER_FILES,
    candidates: CANDIDATE_NAMES,
    levels: LEVELS,
    minBytes: MIN_NODE_BYTES,
    maxCandidates: MAX_CANDIDATES,
    deadlineMs: SCAN_DEADLINE_MS,
  };
  const command = lowPriorityCommand(process.execPath, [script, "scan", "--spec", JSON.stringify(spec), "--out", files.result, "--partial", files.partial]);
  const child = spawn(command.command, command.args, { stdio: "ignore" });
  const startedAt = Date.now();
  const timer = setTimeout(() => child.kill("SIGKILL"), SCAN_DEADLINE_MS + 120_000);
  timer.unref();
  child.once("error", () => clearTimeout(timer));
  child.once("exit", () => clearTimeout(timer));
  child.unref();
  globalThis.__codyDiskUsageScan = { volume, child, startedAt };
  return "started";
}

/** Delete scan files nobody will read: progress files of a dead scan, results older than 30 days. */
export function pruneUsageCache(now: number = Date.now()): void {
  try {
    const running = runningScanVolume(now);
    for (const volume of USAGE_VOLUMES) {
      const files = usageFiles(volume);
      const partialAt = mtimeOf(files.partial);
      if (partialAt !== null && volume !== running && now - partialAt > FRESH_PARTIAL_MS * 3) fs.rmSync(files.partial, { force: true });
      const resultAt = mtimeOf(files.result);
      if (resultAt !== null && now - resultAt > RESULT_KEEP_MS) fs.rmSync(files.result, { force: true });
    }
    const dir = getAgentDir();
    for (const name of fs.readdirSync(dir)) {
      if (!/^cody-disk-usage-.*\.tmp$/.test(name)) continue;
      const file = path.join(dir, name);
      if (now - (mtimeOf(file) ?? now) > PARTIAL_KEEP_MS) fs.rmSync(file, { force: true });
    }
  } catch {
    // No agent dir yet, or a file that would not go: the next hourly pass tries again.
  }
}

/** The newest finished scan of `volume`, or a running one's progress, labelled. */
export function readUsage(volume: UsageVolume, fileRoots: ReadonlySet<string>, canEdit: boolean, context: UsageContext = currentUsageContext(), now: number = Date.now()): UsagePayload {
  const env: AnnotateEnv = { context, fileRoots };
  const files = usageFiles(volume);
  const finished = annotateResult(readJsonFile(files.result), env, volume);
  const scan = readScanState(volume, now);
  let result = finished;
  let partial = false;
  if (scan.running && scan.volume === volume) {
    const progress = annotateResult(readJsonFile(files.partial), env, volume);
    // Progress beats an older finished result only until a finished one exists for this run.
    if (progress && (!finished || finished.startedAt < progress.startedAt)) {
      result = progress;
      partial = true;
    }
  }
  return {
    volume,
    result,
    partial,
    scan,
    canEdit,
    olderThanDays: DEFAULT_OLDER_THAN_DAYS,
    ...(fs.existsSync(scannerPath()) ? {} : { unavailable: true }),
  };
}

// ---------- clearing ----------

export interface Measured {
  bytes: number;
  entries: number;
  newestMs: number;
  changedMs: number;
  complete: boolean;
  crossedDevice: boolean;
  missing?: boolean;
}

export interface ClearDeps {
  context: UsageContext;
  liveSessions: () => LiveSessions | null;
  /** The process table's view of the paths under home and temp; null when it cannot be trusted. */
  processes: (context: UsageContext) => Promise<PathMentions | null>;
  measure: (target: string) => Promise<Measured | null>;
  remove: (target: string) => Promise<void>;
  now: () => number;
}

async function measureWithScanner(target: string): Promise<Measured | null> {
  const script = scannerPath();
  if (!fs.existsSync(script)) return null;
  const command = lowPriorityCommand(process.execPath, [script, "measure", target]);
  const { promise, resolve } = Promise.withResolvers<Measured | null>();
  execFile(command.command, command.args, { timeout: MEASURE_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: 1024 * 1024, encoding: "utf8" }, (error, stdout) => {
    if (error) return resolve(null);
    try {
      const parsed: unknown = JSON.parse(stdout.trim().split("\n").pop() ?? "");
      if (!isRecord(parsed)) return resolve(null);
      resolve({
        bytes: num(parsed.bytes),
        entries: num(parsed.entries),
        newestMs: num(parsed.newestMs),
        changedMs: num(parsed.changedMs),
        complete: parsed.complete === true,
        crossedDevice: parsed.crossedDevice === true,
        ...(parsed.missing === true ? { missing: true } : {}),
      });
    } catch {
      resolve(null);
    }
  });
  return promise;
}

async function processMentions(context: UsageContext): Promise<PathMentions | null> {
  const mentions = new PathMentions([{ path: context.home }, { path: context.tmpDir }]);
  return (await scanProcessUsage(mentions)) ? mentions : null;
}

export function defaultClearDeps(): ClearDeps {
  return {
    context: currentUsageContext(),
    liveSessions: readLiveSessions,
    processes: processMentions,
    measure: measureWithScanner,
    remove: removeTree,
    now: Date.now,
  };
}

/** Path segments of `child` below `parent`, null when it is not beneath it. */
function segmentsBelow(child: string, parent: string): string[] | null {
  if (!isWithin(child, parent)) return null;
  return child === parent ? [] : child.slice(parent.length + (parent.endsWith(path.sep) ? 0 : 1)).split(path.sep);
}

/** PathMentions keeps four segments per root; a deeper folder is judged by its four-segment ancestor, which can only err towards "in use". */
function isMentioned(mentions: PathMentions, context: UsageContext, target: string): boolean {
  for (const root of [context.home, context.tmpDir]) {
    const segments = segmentsBelow(target, root);
    if (segments === null || segments.length === 0) continue;
    if (mentions.has(`${root}/${segments.slice(0, 4).join("/")}`)) return true;
  }
  return false;
}

function marksIn(dir: string): string[] | null {
  try {
    return fs.readdirSync(dir).filter((name) => MARKER_FILES.includes(name));
  } catch {
    return null;
  }
}

type Checked = { real: string; plan: NonNullable<ClearAnswer["plan"]> } | { refused: ClearRefusal };

const refuse = (code: ClearRefusal["code"], detail?: ClearRefusal["detail"]): { refused: ClearRefusal } => ({ refused: detail === undefined ? { code } : { code, detail } });

/** Every live check, in the order that is cheapest first. Nothing is changed. */
async function checkClearable(target: unknown, deps: ClearDeps, mentionsOnce: () => Promise<PathMentions | null>): Promise<Checked> {
  const { context } = deps;
  if (typeof target !== "string" || target === "" || target.includes("\0") || !path.isAbsolute(target) || path.resolve(target) !== target) return refuse("outside");

  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(target);
  } catch {
    return refuse("missing");
  }
  if (stat.isSymbolicLink()) return refuse("symlink");
  if (!stat.isDirectory()) return refuse("not-recognised");

  let real: string;
  try {
    real = path.join(fs.realpathSync(path.dirname(target)), path.basename(target));
  } catch {
    return refuse("missing");
  }
  if (real !== target) return refuse("symlink");

  const inHome = isWithin(real, context.home) && real !== context.home;
  const inTmp = isWithin(real, context.tmpDir) && real !== context.tmpDir;
  if (!inHome && !inTmp) return refuse("outside");
  if (isWithin(real, context.agentDir) || isWithin(context.agentDir, real) || isWithin(context.home, real) || isWithin(context.tmpDir, real)) return refuse("outside");
  if (real.split(path.sep).includes(".git")) return refuse("not-recognised");
  if (isWithin(realOrResolved(process.cwd()), real)) return refuse("in-use", "server");

  const parentMarks = marksIn(path.dirname(real));
  const ownMarks = marksIn(real);
  if (parentMarks === null || ownMarks === null) return refuse("unmeasurable");
  const label = labelFor({ path: real, parentMarks, ownMarks }, context);
  if (!label || !label.deletable || (label.kind !== "rebuild" && label.kind !== "cache")) return refuse("not-recognised");

  const live = deps.liveSessions();
  if (live === null) return refuse("process-table");
  for (const cwd of live.cwds) {
    if (isWithin(cwd, real)) return refuse("chat-cwd");
  }
  const mentions = await mentionsOnce();
  if (mentions === null) return refuse("process-table");
  if (isMentioned(mentions, context, real)) return refuse("in-use");

  const measured = await deps.measure(real);
  if (!measured) return refuse("unmeasurable");
  if (measured.missing) return refuse("missing");
  if (!measured.complete) return refuse("unmeasurable");
  if (measured.crossedDevice) return refuse("mount");
  const age = deps.now() - measured.newestMs;
  if (age < RECENT_CHANGE_MS) return refuse("recent", Math.max(0, Math.floor(age / 60_000)));

  return { real, plan: { path: real, kind: label.kind, rule: label.rule, bytes: measured.bytes, entries: measured.entries, changedMs: measured.changedMs } };
}

function memoize<T>(call: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => (pending ??= call());
}

/** What clearing `target` would free and why it may be cleared, or why not. Nothing is deleted. */
export async function previewClear(target: unknown, deps: ClearDeps = defaultClearDeps()): Promise<ClearAnswer> {
  const checked = await checkClearable(target, deps, memoize(() => deps.processes(deps.context)));
  return "refused" in checked ? { refused: checked.refused } : { plan: checked.plan };
}

function remeasureRemaining(real: string, deps: ClearDeps): Promise<Measured | null> {
  try {
    fs.lstatSync(real);
  } catch {
    return Promise.resolve({ bytes: 0, entries: 0, newestMs: 0, changedMs: 0, complete: true, crossedDevice: false, missing: true });
  }
  return deps.measure(real);
}

async function clearChecked(checked: Checked, deps: ClearDeps): Promise<ClearAnswer> {
  if ("refused" in checked) return { refused: checked.refused };
  const { real, plan } = checked;
  // The last look before the delete: a link put here since the checks must not be followed.
  try {
    if (fs.lstatSync(real).isSymbolicLink()) return { refused: { code: "symlink" } };
  } catch {
    return { refused: { code: "missing" } };
  }
  try {
    await deps.remove(real);
  } catch {
    // Judged by what is left below.
  }
  const left = await remeasureRemaining(real, deps);
  const gone = left?.missing === true;
  const freedBytes = gone ? plan.bytes : Math.max(0, plan.bytes - (left?.bytes ?? plan.bytes));
  if (freedBytes > 0 || gone) forgetFromCache(real, freedBytes);
  return { plan, freedBytes, cleared: gone };
}

/** Check everything again, then delete one recognised folder. Never throws; one at a time. */
export async function clearUsageItem(target: unknown, deps: ClearDeps = defaultClearDeps()): Promise<ClearAnswer> {
  if (globalThis.__codyDiskUsageClearing) return { refused: { code: "busy" } };
  globalThis.__codyDiskUsageClearing = true;
  try {
    return await clearChecked(await checkClearable(target, deps, memoize(() => deps.processes(deps.context))), deps);
  } finally {
    globalThis.__codyDiskUsageClearing = false;
  }
}

/** Clear every listed build-output folder nobody touched for `days` days, biggest first, within a time budget. */
export async function clearOlderThan(
  volume: UsageVolume,
  days: number,
  fileRoots: ReadonlySet<string>,
  deps: ClearDeps = defaultClearDeps(),
): Promise<ClearManyAnswer | { refused: ClearRefusal }> {
  if (globalThis.__codyDiskUsageClearing) return { refused: { code: "busy" } };
  globalThis.__codyDiskUsageClearing = true;
  const summary: ClearManyAnswer = { cleared: 0, freedBytes: 0, refused: 0, stoppedEarly: false };
  try {
    const result = readUsage(volume, fileRoots, true, deps.context, deps.now()).result;
    const cutoff = deps.now() - days * DAY_MS;
    const items = (result?.rebuildable ?? []).filter((item) => item.changedMs > 0 && item.changedMs < cutoff).slice(0, BATCH_MAX_ITEMS);
    const mentionsOnce = memoize(() => deps.processes(deps.context));
    const started = deps.now();
    for (const item of items) {
      if (deps.now() - started > BATCH_BUDGET_MS) {
        summary.stoppedEarly = true;
        break;
      }
      const answer = await clearChecked(await checkClearable(item.path, deps, mentionsOnce), deps);
      if (answer.cleared) {
        summary.cleared += 1;
        summary.freedBytes += answer.freedBytes ?? 0;
      } else {
        summary.refused += 1;
        summary.freedBytes += answer.freedBytes ?? 0;
      }
    }
    return summary;
  } finally {
    globalThis.__codyDiskUsageClearing = false;
  }
}

// ---------- keeping the cache honest after a delete ----------

interface RawNode {
  name: string;
  bytes: number;
  children?: RawNode[];
  otherBytes?: number;
}

/** The nodes of `names` that exist in the cached tree, from the top: shorter than `names` when the folder (or one above it) was too small to be listed. */
function matchedChain(nodes: RawNode[], names: string[]): RawNode[] {
  const chain: RawNode[] = [];
  let level = nodes;
  for (const name of names) {
    const match = level.find((node) => node.name === name);
    if (!match) break;
    chain.push(match);
    level = match.children ?? [];
  }
  return chain;
}

/**
 * The cached tree after `removed` was deleted: the node is dropped, every folder
 * above it shrinks by what was freed, and the build-output list loses it. The
 * rest of the tree is untouched (a rescan refreshes it). Edits the finished
 * result of every volume that holds the path; a missing or unreadable file is skipped.
 */
export function forgetFromCache(removed: string, freedBytes: number): void {
  for (const volume of USAGE_VOLUMES) {
    const file = usageFiles(volume).result;
    const raw = readJsonFile(file);
    if (!isRecord(raw) || !Array.isArray(raw.roots)) continue;
    let changed = false;
    for (const entry of raw.roots) {
      if (!isRecord(entry) || typeof entry.path !== "string" || !isRecord(entry.node)) continue;
      const names = segmentsBelow(removed, entry.path);
      if (names === null || names.length === 0) continue;
      const top = entry.node as unknown as RawNode;
      const chain = matchedChain(top.children ?? [], names);
      const listed = chain.length === names.length;
      // A folder too small to be listed only shrinks the totals above it.
      const ancestors = listed ? chain.slice(0, -1) : chain;
      top.bytes = Math.max(0, num(top.bytes) - freedBytes);
      for (const node of ancestors) node.bytes = Math.max(0, num(node.bytes) - freedBytes);
      if (listed) {
        const parent = ancestors.length > 0 ? ancestors[ancestors.length - 1] : top;
        parent.children = (parent.children ?? []).filter((child) => child !== chain[chain.length - 1]);
      }
      changed = true;
    }
    if (Array.isArray(raw.rebuildable)) {
      const kept = raw.rebuildable.filter((item) => !(isRecord(item) && typeof item.path === "string" && isWithin(item.path, removed)));
      if (kept.length !== raw.rebuildable.length) {
        raw.rebuildable = kept;
        changed = true;
      }
    }
    if (!changed) continue;
    try {
      const temp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(raw), { mode: 0o600 });
      fs.renameSync(temp, file);
    } catch {
      // The next scan replaces it anyway.
    }
  }
}
