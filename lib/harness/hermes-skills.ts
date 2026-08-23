import { execFile, execFileSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { promisify } from "util";
import { parse as parseYaml } from "yaml";
import { hermesPythonPath } from "./hermes-settings";

const execFileAsync = promisify(execFile);

/**
 * Hermes' skills, on Hermes' terms.
 *
 * Cody's skills surface was built against omp's discovery: a flat
 * `<root>/<name>/SKILL.md` scan over a fixed provider list, an install that
 * shells `npx skills add`, and an enable/disable toggle that rewrites a
 * frontmatter key. Hermes agrees with none of that, so this module holds the
 * three facts that differ, verified against a real 0.19.0 install rather than
 * assumed:
 *
 * 1. **Layout is nested.** Hermes discovers skills with `rglob("SKILL.md")`
 *    under `$HERMES_HOME/skills` (agent/skill_utils.iter_skill_index_files),
 *    and `hermes skills install --category <c>` puts a skill at
 *    `skills/<c>/<name>/SKILL.md`. Categories nest further —
 *    prompt_builder._build_snapshot_entry reads the category as every path
 *    segment above the skill dir. A one-level readdir finds none of them.
 * 2. **Enable/disable is config, not frontmatter.** `skills.disabled` in
 *    `$HERMES_HOME/config.yaml` is a list of skill NAMES
 *    (agent/skill_utils.get_disabled_skill_names). Nothing in Hermes reads
 *    `disable-model-invocation`, so writing that key would toggle nothing.
 * 3. **Install is Hermes' own CLI.** `hermes skills install` fetches,
 *    quarantines, security-scans and then places the skill in Hermes' own
 *    root. `npx skills add --agent universal` writes to `.agents/skills`,
 *    which Hermes does not scan at all — a green toast over a skill the
 *    engine will never load.
 */

/** Directories Hermes' scanner prunes outright (agent/skill_utils
 * EXCLUDED_SKILL_DIRS). `.hub` is its own install bookkeeping. */
const EXCLUDED_SKILL_DIRS = new Set([
  ".git", ".github", ".hub", ".archive", ".venv", "venv", "node_modules",
  "site-packages", "__pycache__", ".tox", ".nox", ".pytest_cache",
  ".mypy_cache", ".ruff_cache",
]);

/** Progressive-disclosure subdirectories of a skill package. Hermes prunes
 * these only when the directory holding them is itself a skill, so a category
 * legitimately named `scripts` stays discoverable (skill_utils
 * SKILL_SUPPORT_DIRS / is_skill_support_path). */
const SKILL_SUPPORT_DIRS = new Set(["references", "templates", "assets", "scripts"]);

export function isExcludedHermesSkillDir(name: string): boolean {
  return EXCLUDED_SKILL_DIRS.has(name);
}

export function isHermesSkillSupportDir(name: string, parentHasSkillFile: boolean): boolean {
  return parentHasSkillFile && SKILL_SUPPORT_DIRS.has(name);
}

/** Hermes' config.yaml, parsed, or null when there is none yet (the normal
 * state of a fresh install — Hermes writes it on first `config set`). */
function readHermesConfig(hermesHome: string): Record<string, unknown> | null {
  try {
    const parsed = parseYaml(readFileSync(join(hermesHome, "config.yaml"), "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function skillsSection(hermesHome: string): Record<string, unknown> | null {
  const config = readHermesConfig(hermesHome);
  const skills = config?.skills;
  return skills && typeof skills === "object" && !Array.isArray(skills)
    ? (skills as Record<string, unknown>)
    : null;
}

/** Hermes normalizes a bare scalar into a one-element list rather than a set
 * of its characters (skill_utils._normalize_string_set). */
function asNameList(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (!Array.isArray(value)) return [];
  return value.map((entry) => String(entry).trim()).filter(Boolean);
}

/**
 * Extra roots from `skills.external_dirs`, expanded the way Hermes expands
 * them: `~` and `${VAR}`, relative entries resolved against HERMES_HOME, and
 * only directories that actually exist (skill_utils.get_external_skills_dirs).
 */
export function hermesExternalSkillDirs(hermesHome: string, home: string): string[] {
  const raw = asNameList(skillsSection(hermesHome)?.external_dirs);
  const local = join(hermesHome, "skills");
  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const entry of raw) {
    const expanded = entry
      .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => process.env[name] ?? "")
      .replace(/^~(?=$|[/\\])/, home);
    if (!expanded) continue;
    const resolved = expanded.startsWith("/") || /^[A-Za-z]:[/\\]/.test(expanded)
      ? expanded
      : join(hermesHome, expanded);
    if (resolved === local || seen.has(resolved)) continue;
    seen.add(resolved);
    if (existsSync(resolved)) dirs.push(resolved);
  }
  return dirs;
}

/** Every directory Hermes scans for skills: its own root first (which always
 * wins a name collision), then the configured external dirs in config order. */
export function hermesSkillRoots(hermesHome: string, home: string): string[] {
  return [join(hermesHome, "skills"), ...hermesExternalSkillDirs(hermesHome, home)];
}

/**
 * Skill names Hermes will not load, from `skills.disabled` in config.yaml.
 *
 * The per-platform list (`skills.platform_disabled.<platform>`) is
 * deliberately not unioned in: it keys off `HERMES_PLATFORM` /
 * `HERMES_SESSION_PLATFORM`, which the gateway sets for Telegram, Discord and
 * the rest. Cody drives the ACP coding agent, where neither is set, so the
 * global list is the whole answer for the sessions Cody actually runs.
 */
export function readHermesDisabledSkills(hermesHome: string): Set<string> {
  return new Set(asNameList(skillsSection(hermesHome)?.disabled));
}

/**
 * Hermes hides a skill whose `platforms:` list excludes the running OS
 * (skill_utils.skill_matches_platform), so Cody must too — listing it would
 * offer a skill the engine never loads.
 *
 * `environments:` (kanban/docker/s6) is NOT replicated: detecting it means
 * reading Hermes' own toolset config and container markers, and Hermes itself
 * fails open on a tag it does not recognize. Over-listing an s6-only skill is
 * a cosmetic miss; mis-detecting one and hiding a skill that IS loaded would
 * be a lie.
 */
export function hermesSkillMatchesPlatform(platforms: unknown, platform: string = process.platform): boolean {
  const list = Array.isArray(platforms) ? platforms : platforms ? [platforms] : [];
  if (list.length === 0) return true;
  const aliases: Record<string, string> = { macos: "darwin", linux: "linux", windows: "win32" };
  return list.some((entry) => {
    const normalized = String(entry).toLowerCase().trim();
    return platform.startsWith(aliases[normalized] ?? normalized);
  });
}

// ── install provenance (.hub/lock.json) ─────────────────────────────────────

export interface HermesLockEntry {
  /** Registry identifier `hermes skills install` was given. */
  identifier: string;
  /** Source adapter that answered ("skills-sh", "browse-sh", "clawhub", …). */
  source: string;
  /** Path under the skills root, e.g. "security/1password". */
  installPath: string;
  contentHash?: string;
  sourceUrl?: string;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Hermes' own install ledger, `<skills root>/.hub/lock.json`. Keyed by skill
 * name, the same key `skills.disabled` uses.
 */
export function readHermesSkillLock(skillsRoot: string): Map<string, HermesLockEntry> {
  const entries = new Map<string, HermesLockEntry>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(skillsRoot, ".hub", "lock.json"), "utf8"));
  } catch {
    return entries;
  }
  const installed = (parsed as { installed?: unknown } | null)?.installed;
  if (!installed || typeof installed !== "object") return entries;
  for (const [name, value] of Object.entries(installed as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const record = value as Record<string, unknown>;
    const identifier = asString(record.identifier);
    if (!identifier) continue;
    const metadata = (record.metadata && typeof record.metadata === "object" ? record.metadata : {}) as Record<string, unknown>;
    entries.set(name, {
      identifier,
      source: asString(record.source),
      installPath: asString(record.install_path),
      contentHash: asString(record.content_hash) || undefined,
      sourceUrl: asString(metadata.source_url) || undefined,
    });
  }
  return entries;
}

// ── identifier translation ──────────────────────────────────────────────────

/**
 * Cody's skill store browses skills.sh and produces `npx skills add` specs:
 * `owner/repo@slug` for a GitHub-backed skill, `https://<domain>` for a
 * well-known provider. Hermes addresses the same registry as
 * `skills-sh/owner/repo/slug` (tools/skills_hub.SkillsShSource, verified
 * against `hermes skills search --json`), and separately accepts a direct
 * HTTP(S) URL to a SKILL.md file.
 *
 * A bare `https://<domain>` is NOT a Hermes identifier: `npx skills` treats it
 * as "install this provider's whole set", and Hermes' UrlSource wants one
 * SKILL.md. Rather than guess a URL that would fetch a web page, this returns
 * null and the caller refuses the install with a reason.
 */
export function hermesSkillIdentifier(pkg: string): string | null {
  const spec = pkg.trim();
  if (!spec) return null;
  // A direct SKILL.md URL is already something Hermes' UrlSource handles.
  if (/^https?:\/\/\S+\/SKILL\.md$/i.test(spec)) return spec;
  if (/^https?:\/\//i.test(spec)) return null;
  const match = /^([^@\s]+)@([^@\s]+)$/.exec(spec);
  if (!match) return null;
  const [, source, slug] = match;
  if (source.split("/").length !== 2) return null;
  return `skills-sh/${source}/${slug}`;
}

/** The inverse, for annotating an installed skill with the package spec the
 * store compares against so an already-installed skill shows as installed. */
export function hermesPackageForIdentifier(identifier: string): string | null {
  const match = /^skills-sh\/([^/]+)\/([^/]+)\/(.+)$/.exec(identifier);
  return match ? `${match[1]}/${match[2]}@${match[3]}` : null;
}

// ── enable / disable ────────────────────────────────────────────────────────

/**
 * Why the toggle can be unavailable. `uv tool install` puts a venv beside the
 * `hermes` binary and that venv's interpreter is the only thing that can call
 * Hermes' own config writer; a bare `pip install` onto PATH leaves none.
 */
export const HERMES_TOGGLE_UNSUPPORTED_CODE = "hermes_no_runtime";

export function canToggleHermesSkills(binaryPath: string | null): boolean {
  return Boolean(binaryPath && hermesPythonPath(binaryPath));
}

/**
 * Add or remove a skill name from Hermes' `skills.disabled`, through Hermes'
 * own code.
 *
 * `hermes config set` cannot do this: it stores one scalar per key and has no
 * list form, so pointed at `skills.disabled` it would write a string where
 * Hermes expects a list (the same limit `hermes-settings.ts` reports as
 * LIST_WRITE_UNSUPPORTED). `hermes skills config` is a curses checklist, so it
 * is not scriptable either.
 *
 * What IS available is the function Hermes' own dashboard calls for exactly
 * this action — `hermes_cli.skills_config.save_disabled_skills`, which routes
 * through `hermes_cli.config.save_config` and therefore keeps atomic writes,
 * default stripping and the managed-scope guard. Reaching it means running the
 * venv interpreter, the same trick `hermes-settings.ts` uses to read
 * DEFAULT_CONFIG: ask the engine's own runtime rather than editing its YAML
 * behind its back.
 */
export function setHermesSkillDisabled(binaryPath: string, name: string, disabled: boolean): void {
  const python = hermesPythonPath(binaryPath);
  if (!python) {
    throw new Error(
      "Hermes' Python environment was not found beside its binary, so Cody cannot reach the config writer that owns the enabled/disabled list. Toggle it with `hermes skills config` in a Cody terminal.",
    );
  }
  const script = [
    "import json,sys",
    "from hermes_cli.config import load_config",
    "from hermes_cli.skills_config import get_disabled_skills, save_disabled_skills",
    "name, disable = sys.argv[1], sys.argv[2] == '1'",
    "config = load_config()",
    "disabled = get_disabled_skills(config)",
    "disabled.add(name) if disable else disabled.discard(name)",
    "save_disabled_skills(config, disabled)",
    "print(json.dumps(sorted(get_disabled_skills(load_config()))))",
  ].join("\n");
  try {
    execFileSync(python, ["-c", script, name, disabled ? "1" : "0"], {
      encoding: "utf8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    // execFileSync forwards stderr to Cody's own stderr unless it is piped,
    // which leaves `error.stderr` null and the caller with "Command failed".
    const stderr = (error as { stderr?: unknown }).stderr;
    const detail = typeof stderr === "string" ? stderr.trim() : "";
    throw new Error(detail || (error instanceof Error ? error.message : String(error)));
  }
}

// ── install ─────────────────────────────────────────────────────────────────

/** Fetch + scan + install can be slow: the first run builds a registry index
 * cache, and every install runs the security scanner. */
const INSTALL_TIMEOUT_MS = 180_000;

export interface HermesInstallResult {
  ok: boolean;
  /** Path under the skills root ("security/1password"), when it installed. */
  installed?: string;
  output: string;
}

const ANSI_RE = /\x1B\[[0-9;]*m/g;

/**
 * `hermes skills install`, with the one thing its exit code cannot tell you.
 *
 * Verified against 0.19.0: an install the security scanner BLOCKS still exits
 * 0 ("Installation blocked: Blocked (community source + caution verdict, 2
 * findings)"), and so does an identifier no source can resolve ("Error: Could
 * not fetch '…' from any source."). Only the literal `Installed: <path>` line
 * means a skill landed on disk, so that is what success is read from — the
 * same shape of check the npx path uses, against Hermes' real output rather
 * than the skills.sh CLI's.
 *
 * `--force` is deliberately never passed: it overrides a blocked security
 * verdict, and that is the user's call to make in a terminal, not Cody's.
 */
export async function installHermesSkill(
  binaryPath: string,
  identifier: string,
  category?: string,
): Promise<HermesInstallResult> {
  const args = ["skills", "install", identifier, "--yes"];
  if (category?.trim()) args.push("--category", category.trim());
  let stdout = "";
  let stderr = "";
  try {
    ({ stdout, stderr } = await execFileAsync(binaryPath, args, {
      timeout: INSTALL_TIMEOUT_MS,
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
      maxBuffer: 8 * 1024 * 1024,
    }));
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message?: string };
    stdout = failure.stdout ?? "";
    stderr = failure.stderr ?? "";
    if (!stdout && !stderr) throw error;
  }
  // Rich wraps its output at the terminal width, so the installed path can be
  // split across lines; join them before matching.
  const output = `${stdout}${stderr}`.replace(ANSI_RE, "");
  const installed = /^Installed:[ \t]*(\S+)/m.exec(output.replace(/\r/g, ""));
  return installed
    ? { ok: true, installed: installed[1], output }
    : { ok: false, output };
}
