import * as path from "node:path";
import type { UsageAction, UsageKind } from "./usage-types";

/**
 * What a folder in the disk-usage tree IS, in words a person can act on.
 * Pure: names and paths in, a label out, no file system. The scan
 * (bin/cody-disk-usage.mjs) only reports facts (names, sizes, which marker
 * files sit in each folder); every decision lives here, so a rule can change
 * without rescanning, and `usage.ts` asks the SAME function again, against the
 * live disk, before it deletes anything (a cached label never authorises a
 * delete).
 *
 * Four kinds of answer:
 * - `rebuild`: build output the project's own tools make again (Cargo
 *   `target/`, `node_modules/`, ...). Only when the folder NEXT to it proves
 *   it (Cargo.toml beside `target/`), so a folder that merely shares the name
 *   is left alone.
 * - `cache`: a program's download or compile cache that is fetched again.
 * - `engine` / `engine-keep`: Cody's and the engine's own data. Never deleted
 *   by path here: chats go through the chat delete, the rest through the
 *   janitor or the engine's own gc. `engine-keep` has no action at all.
 * - `mine`: everything else. Review it yourself; there is no delete button.
 */

/** Files whose presence next to a folder says what kind of project it is. The scan reports which of these each folder holds. */
export const MARKER_FILES: readonly string[] = [
  ".git",
  "Cargo.toml",
  "package.json",
  "build.zig",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  "pyproject.toml",
  "requirements.txt",
  "setup.py",
  "Pipfile",
  "pyvenv.cfg",
];

/** A folder holding any of these is a project (or a repository) itself: never build output. */
const PROJECT_MARKERS: readonly string[] = [".git", "Cargo.toml", "package.json", "build.zig", "pyproject.toml", "setup.py"];

export interface RebuildRule {
  id: string;
  names: readonly string[];
  /** One of these must sit in the folder that CONTAINS the candidate. Empty: no condition. */
  parentHasAny: readonly string[];
  /** One of these must sit inside the candidate itself. Empty: no condition. */
  ownHasAny: readonly string[];
}

export const REBUILD_RULES: readonly RebuildRule[] = [
  { id: "cargo-target", names: ["target"], parentHasAny: ["Cargo.toml"], ownHasAny: [] },
  { id: "node-modules", names: ["node_modules"], parentHasAny: ["package.json"], ownHasAny: [] },
  { id: "web-build", names: [".next", ".nuxt", ".svelte-kit", ".turbo", ".parcel-cache", ".angular"], parentHasAny: ["package.json"], ownHasAny: [] },
  { id: "zig-cache", names: [".zig-cache", "zig-out", "zig-cache"], parentHasAny: ["build.zig"], ownHasAny: [] },
  { id: "gradle-project", names: [".gradle"], parentHasAny: ["build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"], ownHasAny: [] },
  { id: "python-cache", names: ["__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache"], parentHasAny: [], ownHasAny: [] },
  { id: "python-venv", names: [".venv", "venv"], parentHasAny: ["pyproject.toml", "requirements.txt", "setup.py", "Pipfile"], ownHasAny: ["pyvenv.cfg"] },
];

/** Every folder name any rebuild rule might match: what the scan lists as a candidate. */
export const CANDIDATE_NAMES: readonly string[] = [...new Set(REBUILD_RULES.flatMap((rule) => rule.names))];

/** Cache folders by their path below the home folder. Each is fetched or rebuilt by its own tool. */
const HOME_CACHES: ReadonlyArray<{ rel: string; id: string }> = [
  { rel: ".npm", id: "npm-cache" },
  { rel: ".cargo/registry", id: "cargo-registry" },
  { rel: ".cargo/git", id: "cargo-registry" },
  { rel: ".bun/install/cache", id: "bun-cache" },
  { rel: ".gradle/caches", id: "gradle-cache" },
  { rel: ".gradle/wrapper", id: "gradle-cache" },
  { rel: ".m2/repository", id: "maven-cache" },
  { rel: ".pnpm-store", id: "pnpm-store" },
  { rel: ".nuget/packages", id: "nuget-cache" },
  { rel: ".rustup/downloads", id: "cargo-registry" },
  { rel: "go/pkg/mod", id: "go-modules" },
];

/** Folders under `~/.cache` that hold installed programs, not downloads: deleting one breaks a tool. */
const INSTALLED_UNDER_CACHE: Readonly<Record<string, true>> = {
  toolchains: true, toolchain: true, sdk: true, sdks: true, venv: true, venvs: true, bin: true, nvm: true, rustup: true, pyenv: true, fnm: true, volta: true, "android-sdk": true,
};

export interface UsageContext {
  /** Real (symlink-resolved) paths. */
  home: string;
  agentDir: string;
  tmpDir: string;
}

export interface LabelInput {
  /** Absolute path of the folder. */
  path: string;
  /** Marker files (`MARKER_FILES`) in the folder that contains it. */
  parentMarks: readonly string[];
  /** Marker files inside it. */
  ownMarks: readonly string[];
}

export interface UsageLabel {
  kind: UsageKind;
  /** Which rule matched: the key under `diskUsage.rule.*` that says what it is. */
  rule: string;
  /** May be deleted by path through `clearUsageItem` (and only if the live checks pass). */
  deletable: boolean;
  action?: UsageAction;
}

/** `child` is `parent` or beneath it. Plain string work: both are absolute and already resolved. */
export function isWithin(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}

/** Path segments of `child` below `parent`; null when it is not beneath it. */
function below(child: string, parent: string): string[] | null {
  if (!isWithin(child, parent)) return null;
  return child === parent ? [] : child.slice(parent.length + (parent.endsWith(path.sep) ? 0 : 1)).split(path.sep);
}

/** The rebuild rule this folder satisfies, or null. A folder that is itself a project is never one. */
export function matchRebuildRule(name: string, parentMarks: readonly string[], ownMarks: readonly string[]): RebuildRule | null {
  if (ownMarks.some((mark) => PROJECT_MARKERS.includes(mark))) return null;
  for (const rule of REBUILD_RULES) {
    if (!rule.names.includes(name)) continue;
    if (rule.parentHasAny.length > 0 && !rule.parentHasAny.some((mark) => parentMarks.includes(mark))) continue;
    if (rule.ownHasAny.length > 0 && !rule.ownHasAny.some((mark) => ownMarks.includes(mark))) continue;
    return rule;
  }
  return null;
}

function engineAreaLabel(segments: string[]): UsageLabel | null {
  if (segments.length === 0) return { kind: "engine-keep", rule: "agent-root", deletable: false };
  if (segments.length > 1) return null;
  switch (segments[0]) {
    case "sessions": return { kind: "engine", rule: "sessions", deletable: false, action: "chats" };
    case "blobs": return { kind: "engine", rule: "blobs", deletable: false, action: "blobs" };
    case "cody-checkpoints": return { kind: "engine", rule: "checkpoints", deletable: false, action: "janitor" };
    case "cody-data-scratch": return { kind: "engine", rule: "data-scratch", deletable: false, action: "janitor" };
    case "tools": return { kind: "engine-keep", rule: "tools", deletable: false };
    default: return { kind: "engine-keep", rule: "agent-file", deletable: false };
  }
}

/**
 * The label of one folder by its own facts, or null when no rule names it
 * (the caller then lets it inherit from the folder it sits in, or call it
 * "mine"). Order matters: the engine's folder wins over a home folder that
 * contains it.
 */
export function labelFor(input: LabelInput, context: UsageContext): UsageLabel | null {
  const name = path.basename(input.path);

  const agent = below(input.path, context.agentDir);
  if (agent !== null) return engineAreaLabel(agent);

  const tmp = below(input.path, context.tmpDir);
  if (tmp !== null && tmp.length === 1) {
    return tmp[0] === "cs"
      ? { kind: "engine", rule: "chat-scratch", deletable: false, action: "janitor" }
      : { kind: "engine", rule: "tmp-entry", deletable: false, action: "janitor" };
  }

  const home = below(input.path, context.home);
  if (home !== null) {
    if (home.length === 2 && home[0] === "tmp") return { kind: "engine", rule: "home-tmp", deletable: false, action: "janitor" };
    if (home.length === 2 && home[0] === ".cache") {
      return Object.hasOwn(INSTALLED_UNDER_CACHE, home[1].toLowerCase())
        ? { kind: "mine", rule: "installed-tool", deletable: false }
        : { kind: "cache", rule: "xdg-cache", deletable: true };
    }
    const joined = home.join("/");
    const cache = HOME_CACHES.find((entry) => entry.rel === joined);
    if (cache) return { kind: "cache", rule: cache.id, deletable: true };
  }

  if (home !== null || tmp !== null) {
    const rule = matchRebuildRule(name, input.parentMarks, input.ownMarks);
    if (rule) return { kind: "rebuild", rule: rule.id, deletable: true };
  }
  return null;
}
