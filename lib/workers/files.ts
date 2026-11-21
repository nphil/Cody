import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * What goes to a worker and what may come back: which directory is the project,
 * which files of it are copied, and which paths a job may bring home. Everything
 * here is about NAMES being safe; the bytes move in tarball.ts.
 *
 * The project ("tree") is the git repository around the working directory (the
 * whole repository, so `../shared` and the lockfile at the top are there), or
 * the working directory itself when it is not in one. The working directory is
 * what the command runs in; `include` and `results` are written relative to it.
 */

/** A copy this big is almost certainly a mistake (an unignored build directory); the agent narrows it with `include`. */
export const MAX_COPY_FILES = 100_000;
export const MAX_COPY_BYTES = 1024 * 1024 * 1024;
/** A walk that visits this many directory entries has run away (a huge tree under a glob like `**`). */
const MAX_WALK_ENTRIES = 1_000_000;
const MAX_PATTERNS = 64;
const MAX_PATTERN_LENGTH = 512;
const MAX_RESULT_PATHS = 64;
const MAX_RESULT_LENGTH = 1024;
const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = 256 * 1024 * 1024;
/** How deep a submodule inside a submodule is followed. */
const MAX_SUBMODULE_DEPTH = 3;

/** Directories a glob copy leaves out unless a pattern names them. */
const HEAVY_DIRECTORIES: readonly string[] = [".git", "node_modules"];

export type Outcome<T> = { ok: true; value: T } | { ok: false; message: string };

/** `child` is `parent` or somewhere below it (both absolute, already resolved). */
export function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function toPosix(value: string): string {
  return path.sep === "/" ? value : value.split(path.sep).join("/");
}

/** The home directory's real path: a repository that holds it is never a project. */
function realHome(): string {
  const home = os.homedir();
  try {
    return fs.realpathSync(home);
  } catch {
    return home;
  }
}

// ── Where the project is ─────────────────────────────────────────────────────

export interface Tree {
  /** The project's top directory (real path). */
  root: string;
  /** The directory the command runs in (real path). */
  cwd: string;
  /** `cwd` relative to `root`, with `/`; empty when they are the same. */
  cwdRel: string;
  /** The tree is a git repository (its default copy follows `.gitignore`). */
  isGit: boolean;
}

function git(args: readonly string[], cwd: string, signal?: AbortSignal): Promise<{ ok: boolean; stdout: Buffer }> {
  const { promise, resolve } = Promise.withResolvers<{ ok: boolean; stdout: Buffer }>();
  try {
    const child = execFile(
      "git",
      ["-c", "core.quotepath=off", ...args],
      { cwd, encoding: "buffer", timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, windowsHide: true, signal, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } },
      (error, stdout) => resolve({ ok: !error, stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.alloc(0) }),
    );
    child.stdin?.end();
  } catch {
    resolve({ ok: false, stdout: Buffer.alloc(0) });
  }
  return promise;
}

async function gitToplevel(directory: string, signal?: AbortSignal): Promise<string | null> {
  const result = await git(["rev-parse", "--show-toplevel"], directory, signal);
  if (!result.ok) return null;
  const line = result.stdout.toString("utf8").split("\n")[0]?.trim();
  if (!line) return null;
  try {
    return await fs.promises.realpath(line);
  } catch {
    return null;
  }
}

/**
 * Find the tree for a call. `workspace` is the chat's directory; `requested` is
 * the agent's `cwd` (relative to the workspace, or absolute). The command may
 * run anywhere inside the workspace's repository (or inside the workspace when
 * it is not one), or inside another git repository: a chat that works on one
 * project often builds a neighbouring one, and a repository names its project
 * exactly (the tracked files). A plain directory elsewhere is refused, and so
 * is a repository that holds the home directory (its "project" would be the
 * whole home, secrets included).
 */
export async function resolveTree(workspace: string, requested: string | undefined, signal?: AbortSignal): Promise<Outcome<Tree>> {
  let workspaceReal: string;
  try {
    workspaceReal = await fs.promises.realpath(workspace);
  } catch {
    return { ok: false, message: `The chat's workspace ${workspace} does not exist` };
  }
  const wanted = requested?.trim() ? requested : ".";
  if (wanted.includes("\0")) return { ok: false, message: "cwd contains a NUL character" };
  const candidate = path.resolve(workspaceReal, wanted);
  let cwd: string;
  try {
    cwd = await fs.promises.realpath(candidate);
    if (!(await fs.promises.stat(cwd)).isDirectory()) return { ok: false, message: `cwd ${wanted} is not a directory` };
  } catch {
    return { ok: false, message: `cwd ${wanted} does not exist in the workspace` };
  }

  const workspaceRoot = (await gitToplevel(workspaceReal, signal)) ?? workspaceReal;
  const own = await gitToplevel(cwd, signal);
  if (!isInside(workspaceRoot, cwd)) {
    if (own && !isInside(own, realHome())) {
      return { ok: true, value: { root: own, cwd, cwdRel: toPosix(path.relative(own, cwd)), isGit: true } };
    }
    return {
      ok: false,
      message: `cwd ${wanted} is outside the workspace${workspaceRoot === workspaceReal ? "" : "'s repository"}; the job's directory must be inside it or inside another git repository`,
    };
  }
  const root = own && isInside(workspaceRoot, own) ? own : cwd;
  return { ok: true, value: { root, cwd, cwdRel: toPosix(path.relative(root, cwd)), isGit: own !== null && root === own } };
}

// ── Glob matching ────────────────────────────────────────────────────────────

/** `{a,b}` alternatives, expanded (one level deep, at most this many results). */
const MAX_BRACE_EXPANSIONS = 64;

function expandBraces(pattern: string): string[] {
  const open = pattern.indexOf("{");
  if (open < 0) return [pattern];
  let depth = 0;
  let close = -1;
  const commas: number[] = [];
  for (let i = open; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        close = i;
        break;
      }
    } else if (char === "," && depth === 1) commas.push(i);
  }
  if (close < 0) return [pattern];
  const head = pattern.slice(0, open);
  const tail = pattern.slice(close + 1);
  const bounds = [open, ...commas, close];
  const results: string[] = [];
  for (let i = 0; i + 1 < bounds.length; i += 1) {
    const alternative = pattern.slice(bounds[i] + 1, bounds[i + 1]);
    for (const expanded of expandBraces(`${head}${alternative}${tail}`)) {
      results.push(expanded);
      if (results.length > MAX_BRACE_EXPANSIONS) throw new Error("too many {a,b} alternatives");
    }
  }
  return results;
}

function globToRegExp(pattern: string): RegExp {
  let source = "^";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        // `**/` is any number of directories (none included); a trailing `**` is anything below.
        if (pattern[i + 2] === "/") {
          source += "(?:.*/)?";
          i += 2;
        } else {
          source += ".*";
          i += 1;
        }
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else if (char === "[") {
      const end = pattern.indexOf("]", i + 2);
      if (end < 0) {
        source += "\\[";
      } else {
        let body = pattern.slice(i + 1, end);
        let negate = false;
        if (body.startsWith("!") || body.startsWith("^")) {
          negate = true;
          body = body.slice(1);
        }
        source += `[${negate ? "^" : ""}${body.replace(/[\\\]]/g, "\\$&")}]`;
        i = end;
      }
    } else {
      source += char.replace(/[.+^${}()|\\/]/g, "\\$&");
    }
  }
  return new RegExp(`${source}$`, "s");
}

interface CompiledInclude {
  /** The pattern names a directory (or a tree below it): everything under a match is included. */
  matchers: RegExp[];
  /** Heavy directories that a pattern spells out, so the walk goes into them. */
  named: ReadonlySet<string>;
}

/** A pattern is relative to the working directory and stays inside it. */
export function compileIncludes(raw: readonly string[]): Outcome<CompiledInclude> {
  if (raw.length > MAX_PATTERNS) return { ok: false, message: `include has more than ${MAX_PATTERNS} patterns` };
  const matchers: RegExp[] = [];
  const named = new Set<string>();
  for (const original of raw) {
    if (typeof original !== "string" || !original.trim()) return { ok: false, message: "include has an empty pattern" };
    if (original.length > MAX_PATTERN_LENGTH || original.includes("\0") || /[\n\r]/.test(original)) {
      return { ok: false, message: "include has a pattern that is too long or has control characters" };
    }
    let pattern = original.trim().replace(/^(?:\.\/)+/, "");
    if (pattern.startsWith("/") || /^[A-Za-z]:[\\/]/.test(pattern)) {
      return { ok: false, message: `include pattern ${original} is absolute: patterns are relative to cwd` };
    }
    pattern = pattern.replace(/\/+$/, "");
    if (!pattern || pattern === ".") return { ok: false, message: `include pattern ${original} names the whole working directory: leave include out to copy the project` };
    if (pattern.split("/").includes("..")) return { ok: false, message: `include pattern ${original} leaves cwd (it contains ..)` };
    let alternatives: string[];
    try {
      alternatives = expandBraces(pattern);
    } catch (error) {
      return { ok: false, message: `include pattern ${original}: ${error instanceof Error ? error.message : "cannot be read"}` };
    }
    for (const alternative of alternatives) {
      matchers.push(globToRegExp(alternative));
      for (const part of alternative.split("/")) {
        if (HEAVY_DIRECTORIES.includes(part)) named.add(part);
      }
    }
  }
  return { ok: true, value: { matchers, named } };
}

/** The path matches, or one of the directories above it does (a pattern naming a directory takes everything in it). */
function included(compiled: CompiledInclude, relative: string): boolean {
  const parts = relative.split("/");
  for (let length = parts.length; length >= 1; length -= 1) {
    const prefix = parts.slice(0, length).join("/");
    if (compiled.matchers.some((matcher) => matcher.test(prefix))) return true;
  }
  return false;
}

// ── The files to copy ────────────────────────────────────────────────────────

export interface FileList {
  /** Paths relative to the tree's root, with `/`. Regular files and symlinks only. */
  files: string[];
  bytes: number;
  /** Entries left out because their names are not valid UTF-8 or they are neither files nor links. */
  skipped: number;
}

function tooBig(count: number, bytes: number): string {
  const mb = Math.round(bytes / (1024 * 1024));
  return `The copy would be ${count.toLocaleString("en-US")} files and ${mb.toLocaleString("en-US")} MB, over the limit of ${MAX_COPY_FILES.toLocaleString("en-US")} files / ${Math.round(MAX_COPY_BYTES / (1024 * 1024)).toLocaleString("en-US")} MB. Pass include with the paths the command needs (for example ["src/**", "package.json"]) or add the big directories to .gitignore.`;
}

class Collector {
  readonly files: string[] = [];
  bytes = 0;
  skipped = 0;
  overLimit = false;

  /** Returns false once a limit is crossed. */
  add(relative: string, size: number): boolean {
    this.files.push(relative);
    this.bytes += size;
    if (this.files.length > MAX_COPY_FILES || this.bytes > MAX_COPY_BYTES) this.overLimit = true;
    return !this.overLimit;
  }
}

/** Bytes that decode as UTF-8 and encode back to the same bytes: the only names a text file list carries safely. */
function utf8Name(bytes: Buffer): string | null {
  const text = bytes.toString("utf8");
  return Buffer.from(text, "utf8").equals(bytes) ? text : null;
}

async function statEntry(root: string, relative: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.lstat(path.join(root, relative));
  } catch {
    return null;
  }
}

/** Tracked and untracked-not-ignored files under `directory`, with submodules followed. */
async function listGit(root: string, directory: string, depth: number, collector: Collector, signal?: AbortSignal): Promise<boolean> {
  const result = await git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"], path.join(root, directory), signal);
  if (!result.ok) return false;
  const seen = new Set<string>();
  const entries: string[] = [];
  for (const raw of result.stdout.toString("latin1").split("\0")) {
    if (!raw) continue;
    const bytes = Buffer.from(raw, "latin1");
    const name = utf8Name(bytes);
    if (name === null) {
      collector.skipped += 1;
      continue;
    }
    if (seen.has(name)) continue;
    seen.add(name);
    entries.push(directory ? `${directory}/${name}` : name);
  }
  for (let start = 0; start < entries.length; start += 64) {
    if (signal?.aborted) return true;
    const batch = entries.slice(start, start + 64);
    const stats = await Promise.all(batch.map((relative) => statEntry(root, relative)));
    for (let i = 0; i < batch.length; i += 1) {
      const stat = stats[i];
      const relative = batch[i];
      if (!stat) continue; // tracked but deleted in the working tree
      if (stat.isDirectory()) {
        // A submodule: the repository's own listing, one level down.
        if (depth < MAX_SUBMODULE_DEPTH && fs.existsSync(path.join(root, relative, ".git"))) {
          await listGit(root, relative.replace(/\/+$/, ""), depth + 1, collector, signal);
          if (collector.overLimit) return true;
        } else {
          collector.skipped += 1;
        }
        continue;
      }
      if (!stat.isFile() && !stat.isSymbolicLink()) {
        collector.skipped += 1;
        continue;
      }
      if (!collector.add(relative, stat.isFile() ? stat.size : 0)) return true;
    }
  }
  return true;
}

/** Every file below `start` (relative to the root) that the patterns pick, or all of them when there are none. */
async function walk(
  root: string,
  start: string,
  compiled: CompiledInclude | null,
  collector: Collector,
  signal?: AbortSignal,
): Promise<Outcome<true>> {
  const named = compiled?.named ?? new Set<string>();
  const stack: string[] = [start];
  let visited = 0;
  while (stack.length > 0) {
    if (signal?.aborted) return { ok: true, value: true };
    const directory = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(path.join(root, directory), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      visited += 1;
      if (visited > MAX_WALK_ENTRIES) return { ok: false, message: "The include patterns walk through too many files: make them more specific" };
      const relative = directory ? `${directory}/${entry.name}` : entry.name;
      const relativeToStart = start && relative.startsWith(`${start}/`) ? relative.slice(start.length + 1) : relative;
      if (entry.isDirectory()) {
        if (HEAVY_DIRECTORIES.includes(entry.name) && !named.has(entry.name)) continue;
        stack.push(relative);
        continue;
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) {
        collector.skipped += 1;
        continue;
      }
      if (compiled && !included(compiled, relativeToStart)) continue;
      const stat = entry.isFile() ? await statEntry(root, relative) : null;
      if (entry.isFile() && !stat) continue;
      if (!collector.add(relative, stat?.size ?? 0)) return { ok: true, value: true };
    }
  }
  return { ok: true, value: true };
}

/**
 * The files a job gets. Without `include`: a git repository's tracked and
 * untracked-not-ignored files (so `node_modules` and build output stay home),
 * or, outside git, everything except `.git` and `node_modules`. With `include`:
 * the files below the working directory that match the patterns.
 */
export async function listTreeFiles(tree: Tree, include: readonly string[] | undefined, signal?: AbortSignal): Promise<Outcome<FileList>> {
  const collector = new Collector();
  if (include && include.length > 0) {
    const compiled = compileIncludes(include);
    if (!compiled.ok) return compiled;
    const walked = await walk(tree.root, tree.cwdRel, compiled.value, collector, signal);
    if (!walked.ok) return walked;
  } else if (tree.isGit) {
    const listed = await listGit(tree.root, "", 0, collector, signal);
    if (!listed) return { ok: false, message: "git could not list the project's files (is it a damaged repository?)" };
  } else {
    const walked = await walk(tree.root, "", null, collector, signal);
    if (!walked.ok) return walked;
  }
  if (collector.overLimit) return { ok: false, message: tooBig(collector.files.length, collector.bytes) };
  collector.files.sort();
  return { ok: true, value: { files: collector.files, bytes: collector.bytes, skipped: collector.skipped } };
}

// ── What the project builds from outside itself ──────────────────────────────

/** At most this many crates outside the project are followed (dependencies of dependencies included). */
const MAX_OUTSIDE_CRATES = 256;
/** At most this many of the project's own manifests are read. */
const MAX_MANIFESTS = 512;
/** A manifest bigger than this is not read. */
const MAX_MANIFEST_BYTES = 1024 * 1024;
/** How many directories up from an outside crate the top of its workspace is looked for. */
const MAX_WORKSPACE_DEPTH = 8;
/** Never part of a crate's own files: build output, and what never goes to a worker anyway. */
const CRATE_SKIPPED: readonly string[] = [...HEAVY_DIRECTORIES, "target"];

/** `path = "…"` values in a Cargo manifest: path dependencies and patches (target paths name files, and are dropped). */
const PATH_VALUE = /(?:^|[\s{,])path\s*=\s*(?:"([^"\n]*)"|'([^'\n]*)')/g;
/** The manifest takes fields from its workspace (`edition.workspace = true`, `{ workspace = true }`) or names it (`workspace = "../.."`). */
const USES_WORKSPACE = /\bworkspace\s*=\s*(?:true\b|["'])/;
const NAMES_WORKSPACE = /^\s*workspace\s*=\s*(?:"([^"\n]+)"|'([^'\n]+)')/m;
const WORKSPACE_TABLE = /^\s*\[workspace\]/m;

export interface OutsideDir {
  /** Where it is on this server (real path); the job sees its copy at the same path. */
  path: string;
  /** Paths relative to `path`, with `/`. */
  files: string[];
  bytes: number;
}

export interface OutsideDirs {
  dirs: OutsideDir[];
  /** Why directories the project uses from outside itself were left out; null when none were. */
  note: string | null;
}

async function readManifest(file: string): Promise<string> {
  try {
    const stat = await fs.promises.stat(file);
    return stat.isFile() && stat.size <= MAX_MANIFEST_BYTES ? await fs.promises.readFile(file, "utf8") : "";
  } catch {
    return "";
  }
}

function pathValues(manifest: string): string[] {
  const values: string[] = [];
  for (const line of manifest.split("\n")) {
    if (/^\s*#/.test(line)) continue;
    for (const match of line.matchAll(PATH_VALUE)) {
      const value = match[1] ?? match[2];
      if (value) values.push(value);
    }
  }
  return values;
}

/** The real path of a directory that holds a Cargo manifest, or null. */
async function crateDirectory(candidate: string): Promise<string | null> {
  try {
    const real = await fs.promises.realpath(candidate);
    return (await fs.promises.stat(path.join(real, "Cargo.toml"))).isFile() ? real : null;
  } catch {
    return null;
  }
}

/** The top of the workspace an outside crate takes fields from, found the way Cargo finds it; null when it takes none. */
async function workspaceTop(crate: string, manifest: string): Promise<string | null> {
  if (!USES_WORKSPACE.test(manifest) || WORKSPACE_TABLE.test(manifest)) return null;
  const named = NAMES_WORKSPACE.exec(manifest);
  if (named) {
    const dir = await crateDirectory(path.resolve(crate, named[1] ?? named[2] ?? ""));
    return dir && WORKSPACE_TABLE.test(await readManifest(path.join(dir, "Cargo.toml"))) ? dir : null;
  }
  let dir = crate;
  for (let depth = 0; depth < MAX_WORKSPACE_DEPTH; depth += 1) {
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
    if (WORKSPACE_TABLE.test(await readManifest(path.join(dir, "Cargo.toml")))) return dir;
  }
  return null;
}

/** Every file below `dir` (relative to it), without the skipped directories; null when there are too many to walk. */
async function walkCrate(dir: string): Promise<string[] | null> {
  const names: string[] = [];
  const stack = [""];
  let visited = 0;
  while (stack.length > 0) {
    const relative = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(path.join(dir, relative), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      visited += 1;
      if (visited > MAX_WALK_ENTRIES) return null;
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!CRATE_SKIPPED.includes(entry.name)) stack.push(name);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        names.push(name);
      }
    }
  }
  return names;
}

/** What git lists in a directory (tracked, and new files it does not ignore), relative to it; null outside git. */
async function gitListed(dir: string, signal?: AbortSignal): Promise<string[] | null> {
  const listed = await git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"], dir, signal);
  if (!listed.ok) return null;
  const names: string[] = [];
  for (const raw of listed.stdout.toString("latin1").split("\0")) {
    const name = raw ? utf8Name(Buffer.from(raw, "latin1")) : null;
    if (name) names.push(name);
  }
  return names;
}

/**
 * A crate's own files, relative to its directory: what git lists there (every
 * file, outside git), without build output or the packages nested inside it
 * (those are crates of their own, followed only when something uses them).
 * Null when there are too many to walk.
 */
async function crateFiles(dir: string, signal?: AbortSignal): Promise<string[] | null> {
  let names = await gitListed(dir, signal);
  // Outside git, or in a repository that ignores the crate (vendored code): its files as they are.
  if (!names?.includes("Cargo.toml")) names = await walkCrate(dir);
  if (names === null) return null;
  const nested = names.filter((name) => name.endsWith("/Cargo.toml")).map((name) => name.slice(0, -"/Cargo.toml".length));
  return names.filter((name) => !name.split("/").some((step) => CRATE_SKIPPED.includes(step)) && !nested.some((inner) => name.startsWith(`${inner}/`)));
}

/** Every file of a directory outside the project, relative to it, the way the project's own are listed: what git lists there (every file, outside git), without build output. Null when there are too many to walk. */
async function unitFiles(dir: string, signal?: AbortSignal): Promise<string[] | null> {
  let names = await gitListed(dir, signal);
  if (!names?.length) names = await walkCrate(dir);
  return names && names.filter((name) => !name.split("/").some((step) => CRATE_SKIPPED.includes(step)));
}

/** The directories that are not inside another one of them. */
function outermost(dirs: readonly string[]): string[] {
  const kept: string[] = [];
  for (const dir of [...new Set(dirs)].sort((a, b) => a.length - b.length)) if (!kept.some((unit) => isInside(unit, dir))) kept.push(dir);
  return kept;
}

/** The files (absolute) under the directory each is in, with their sizes, when they fit in one copy with the project's own; otherwise which limit they pass. */
async function sizeUnits(units: readonly string[], absolute: readonly string[], list: FileList): Promise<{ ok: true; dirs: OutsideDir[] } | { ok: false; over: "files" | "bytes" }> {
  const grouped = new Map(units.map((unit) => [unit, new Set<string>()]));
  for (const file of absolute) {
    const unit = units.find((candidate) => isInside(candidate, file));
    if (unit) grouped.get(unit)?.add(toPosix(path.relative(unit, file)));
  }
  let count = list.files.length;
  let bytes = list.bytes;
  const dirs: OutsideDir[] = [];
  for (const unit of units) {
    const listed = [...(grouped.get(unit) ?? [])].sort();
    if (count + listed.length > MAX_COPY_FILES) return { ok: false, over: "files" };
    const sized = await sizeFiles(unit, listed);
    count += sized.files.length;
    bytes += sized.bytes;
    dirs.push({ path: unit, files: sized.files, bytes: sized.bytes });
  }
  return bytes > MAX_COPY_BYTES ? { ok: false, over: "bytes" } : { ok: true, dirs };
}

/** The ones that are files or links, with their size. */
async function sizeFiles(root: string, relatives: readonly string[]): Promise<{ files: string[]; bytes: number }> {
  const files: string[] = [];
  let bytes = 0;
  for (let start = 0; start < relatives.length; start += 64) {
    const batch = relatives.slice(start, start + 64);
    const stats = await Promise.all(batch.map((relative) => statEntry(root, relative)));
    batch.forEach((relative, index) => {
      const stat = stats[index];
      if (!stat || !(stat.isFile() || stat.isSymbolicLink())) return;
      files.push(relative);
      bytes += stat.isFile() ? stat.size : 0;
    });
  }
  return { files, bytes };
}

/**
 * Directories outside the project that its Cargo manifests build from: path
 * dependencies in a sibling repository (and theirs). Each sibling repository
 * goes whole, the way the project does (outside git: the workspace, or the lone
 * crate), because a build may read any of its files: a build script's assets,
 * an `include_str!`. Each one that would break the copy limits sends only what
 * the build needs at the least: its crates' own files and the top manifest of
 * the workspace they take fields from (`edition.workspace = true`). A job
 * sees each copy at the same path when the worker shows the project at its own
 * path. Nothing that holds the project or the home directory is ever one.
 * Whatever would still break the limits is left out with a note, and the job
 * runs as it would have without it.
 */
export async function findOutsideDirs(tree: Tree, list: FileList, signal?: AbortSignal): Promise<OutsideDirs> {
  const none: OutsideDirs = { dirs: [], note: null };
  const queue = list.files
    .filter((file) => file === "Cargo.toml" || file.endsWith("/Cargo.toml"))
    .slice(0, MAX_MANIFESTS)
    .map((file) => path.join(tree.root, file));
  if (queue.length === 0) return none;
  const home = realHome();
  /** Each outside crate, with the top of the workspace it takes fields from. */
  const crates = new Map<string, string | null>();
  const read = new Set<string>();
  while (queue.length > 0) {
    if (signal?.aborted) return none;
    const manifest = queue.shift() as string;
    if (read.has(manifest)) continue;
    read.add(manifest);
    for (const value of pathValues(await readManifest(manifest))) {
      const crate = await crateDirectory(path.resolve(path.dirname(manifest), value));
      if (!crate || crates.has(crate) || isInside(tree.root, crate) || isInside(crate, tree.root) || isInside(crate, home)) continue;
      if (crates.size >= MAX_OUTSIDE_CRATES) {
        return { dirs: [], note: `The project's Cargo manifests use more than ${MAX_OUTSIDE_CRATES} crates from outside it, so none of them were copied` };
      }
      const own = path.join(crate, "Cargo.toml");
      const top = await workspaceTop(crate, await readManifest(own));
      const usable = top && !isInside(top, tree.root) && !isInside(top, home) ? top : null;
      crates.set(crate, usable);
      queue.push(own);
      if (usable) queue.push(path.join(usable, "Cargo.toml"));
    }
  }
  if (crates.size === 0) return none;

  // What the build needs at the least: each crate's own files and its workspace's top manifest.
  const needed: string[] = [];
  for (const [crate, top] of crates) {
    if (signal?.aborted) return none;
    const own = await crateFiles(crate, signal);
    if (own === null) return { dirs: [], note: `${crate}, which the project builds from, has too many files to list, so nothing outside the project was copied` };
    for (const file of own) needed.push(path.join(crate, file));
    if (top) needed.push(path.join(top, "Cargo.toml"));
  }
  let units = outermost([...crates].map(([crate, top]) => top ?? crate));
  const least = await sizeUnits(units, needed, list);
  if (!least.ok) {
    const shown = [...crates.keys()];
    const names = shown.length > 3 ? `${shown.slice(0, 3).join(", ")} and ${shown.length - 3} more crates` : shown.join(", ");
    const limit = least.over === "files" ? `${MAX_COPY_FILES.toLocaleString("en-US")} files` : `${Math.round(MAX_COPY_BYTES / (1024 * 1024)).toLocaleString("en-US")} MB`;
    return { dirs: [], note: `${names}, which the project builds from, would take the copy past ${limit}, so none of it was copied` };
  }

  // Better: each sibling repository whole (outside git, the workspace or lone crate), every one that still fits.
  const wholes: string[] = [];
  for (const [crate, top] of crates) {
    if (signal?.aborted) return none;
    if (wholes.some((unit) => isInside(unit, crate))) continue;
    const repository = await gitToplevel(crate, signal);
    wholes.push(repository && !isInside(repository, tree.root) && !isInside(repository, home) ? repository : (top ?? crate));
  }
  let files = needed;
  let dirs = least.dirs;
  for (const unit of outermost(wholes)) {
    if (signal?.aborted) return none;
    const listed = await unitFiles(unit, signal);
    if (listed === null) continue;
    const grown = outermost([...units, unit]);
    const more = [...files, ...listed.map((file) => path.join(unit, file))];
    const sized = await sizeUnits(grown, more, list);
    if (!sized.ok) continue;
    units = grown;
    files = more;
    dirs = sized.dirs;
  }
  return { dirs, note: null };
}

// ── Paths that come back ─────────────────────────────────────────────────────

/**
 * Turn the agent's `results` into paths relative to the tree's root, refusing
 * anything that could write outside it: absolute paths, `..`, the whole tree,
 * `.git`, control characters. Nested paths are folded into the directory that
 * already covers them.
 */
export function checkResultPaths(raw: readonly string[], cwdRel: string): Outcome<string[]> {
  if (raw.length > MAX_RESULT_PATHS) return { ok: false, message: `results has more than ${MAX_RESULT_PATHS} paths` };
  const found = new Set<string>();
  for (const original of raw) {
    if (typeof original !== "string" || !original.trim()) return { ok: false, message: "results has an empty path" };
    if (original.length > MAX_RESULT_LENGTH) return { ok: false, message: "results has a path that is too long" };
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(original)) return { ok: false, message: `results path ${JSON.stringify(original)} has control characters` };
    if (original.startsWith("/") || original.startsWith("\\") || /^[A-Za-z]:/.test(original)) {
      return { ok: false, message: `results path ${original} is absolute: paths are relative to cwd` };
    }
    const joined = path.posix.normalize(path.posix.join(cwdRel || ".", original));
    const clean = joined.replace(/\/+$/, "") || (joined.startsWith("/") ? "/" : ".");
    if (clean === ".." || clean.startsWith("../") || clean.startsWith("/")) {
      return { ok: false, message: `results path ${original} leaves the project` };
    }
    if (clean === ".") return { ok: false, message: `results path ${original} is the whole project: name the files or directories to bring back` };
    if (clean.split("/").includes(".git")) return { ok: false, message: `results path ${original} points into .git` };
    found.add(clean);
  }
  const sorted = [...found].sort();
  const kept = sorted.filter((candidate) => !sorted.some((other) => other !== candidate && candidate.startsWith(`${other}/`)));
  return { ok: true, value: kept };
}

/** A result path as the agent wrote it (relative to cwd), for messages. */
export function relativeToCwd(rootRelative: string, cwdRel: string): string {
  if (!cwdRel) return rootRelative;
  return toPosix(path.posix.relative(cwdRel, rootRelative)) || ".";
}
