import { existsSync, promises as fs } from "fs";
import { homedir } from "os";
import * as path from "path";
import { parse as parseYaml } from "yaml";
import { getHarness } from "@/lib/harness";
import {
  canToggleHermesSkills,
  hermesPackageForIdentifier,
  hermesSkillMatchesPlatform,
  hermesSkillRoots,
  isExcludedHermesSkillDir,
  isHermesSkillSupportDir,
  readHermesDisabledSkills,
  readHermesSkillLock,
} from "@/lib/harness/hermes-skills";
import type { SkillInfo, SkillInstallScope } from "@/lib/api-types";
import { annotateSkillsWithInstallInfo } from "@/lib/skill-lock";

/**
 * Pure-Node skill discovery mirroring the active engine's providers.
 * omp (oh-my-pi/packages/coding-agent/src/discovery/{builtin,claude,agents,codex,github}.ts):
 * each provider contributes <root>/<name>/SKILL.md skills, higher-priority
 * providers win name collisions, and `enabled: false` frontmatter hides a
 * skill entirely. pi (pi-mono coding-agent package-manager.js
 * addAutoDiscoveredResources) reads a narrower set: <cwd>/.pi/skills,
 * .agents/skills walked up to the git root, <agent dir>/skills and
 * ~/.agents/skills — no .claude/.codex/.github compat dirs and no
 * managed-skills dir, so scanning those under pi would list skills the
 * engine never loads. Hermes reads a narrower set again but a DEEPER one —
 * see buildHermesScanRoots. Cody cannot import any of those SDKs, so the scan
 * rules are replicated per engine.
 */

export interface SkillDiagnostic {
  type: "error" | "warning" | "info";
  message: string;
  path?: string;
}

export interface SkillsWithDiagnostics {
  skills: SkillInfo[];
  diagnostics: SkillDiagnostic[];
}

interface SkillScanRoot {
  dir: string;
  /** Provider label surfaced as sourceInfo.source (".omp", ".claude", ...). */
  source: string;
  scope: "user" | "project";
  /** omp skips skills without a description for these providers. */
  requireDescription?: boolean;
  /**
   * Walk the whole tree instead of reading one level. Set ONLY for Hermes,
   * which nests skills under category folders. omp's and pi's providers are
   * deliberately one level deep: their roots sit inside repositories and user
   * config dirs, so a recursive walk there would surface every vendored,
   * checked-out or archived SKILL.md in the tree as a skill the engine loads,
   * which is not true. Recursion belongs to the engine whose discovery is
   * recursive, and nowhere else.
   */
  recursive?: boolean;
  /** Extra gate the engine applies to a skill's frontmatter before loading
   * it, beyond the `enabled: false` every engine honours. */
  accepts?: (frontmatter: Record<string, unknown>) => boolean;
  /** Engines that keep enable/disable outside the SKILL.md answer here
   * instead of through the frontmatter key omp honours. */
  isDisabled?: (name: string) => boolean;
}

export interface ParsedSkillFrontmatter {
  frontmatter: Record<string, unknown>;
  body: string;
}

/** Split YAML frontmatter from a markdown document. Returns an empty
 * frontmatter object when no `---` block is present or YAML is invalid. */
export function parseSkillFrontmatter(content: string): ParsedSkillFrontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (!match) return { frontmatter: {}, body: content };
  try {
    const parsed = parseYaml(match[1]) as unknown;
    const frontmatter =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    return { frontmatter, body: content.slice(match[0].length) };
  } catch {
    return { frontmatter: {}, body: content.slice(match[0].length) };
  }
}

function isTruthyFlag(value: unknown): boolean {
  return value === true || value === "true";
}

/** Ancestor directories from cwd up to the git repo root (or $HOME / fs root),
 * closest first — matches omp's project-level walk-up discovery. */
function getAncestorDirs(cwd: string): string[] {
  const home = homedir();
  const dirs: string[] = [];
  let current = path.resolve(cwd);
  while (true) {
    dirs.push(current);
    if (existsSync(path.join(current, ".git"))) break;
    if (current === home) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return dirs;
}

/** pi's discovery (see module doc): project .pi/skills + .agents/skills
 * walk-up, then user <agent dir>/skills + ~/.agents/skills. */
function buildPiScanRoots(cwd: string): SkillScanRoot[] {
  const home = homedir();
  const agentDir = getHarness().getAgentDir();
  const projectAncestors = getAncestorDirs(cwd).filter((dir) => dir !== home);
  const roots: SkillScanRoot[] = [];

  // Project scope: .pi/skills at the cwd only (pi does not walk .pi up), and
  // .agents/skills from the cwd up to the git root.
  roots.push({ dir: path.join(cwd, ".pi", "skills"), source: ".pi", scope: "project" });
  for (const dir of projectAncestors) {
    roots.push({ dir: path.join(dir, ".agents", "skills"), source: ".agents", scope: "project" });
  }

  // User scope: pi's own agent dir, then the ecosystem ~/.agents/skills —
  // also where Cody's global skill installs land, so installs stay loadable.
  roots.push({ dir: path.join(agentDir, "skills"), source: ".pi", scope: "user" });
  roots.push({ dir: path.join(home, ".agents", "skills"), source: ".agents", scope: "user" });

  return roots;
}

/**
 * Hermes' discovery (agent/skill_utils.get_all_skills_dirs +
 * iter_skill_index_files): its own `$HERMES_HOME/skills` first, then the
 * `skills.external_dirs` from its config.yaml, each walked RECURSIVELY.
 *
 * Two differences from every other engine, both load-bearing:
 *
 * - **There is no project scope.** Hermes has one skills root per home plus
 *   read-only external dirs; nothing is discovered from the workspace, so a
 *   `.hermes/skills` beside the code would be listed by Cody and loaded by
 *   nobody. Hence no `cwd` parameter here.
 * - **Skills nest under category folders.** `hermes skills install --category
 *   security 1password` writes `skills/security/1password/SKILL.md`, and
 *   categories can nest further. Hermes finds them with `rglob("SKILL.md")`;
 *   a flat readdir finds none of them.
 *
 * The bundled `optional-skills` shipped inside the installed package are NOT
 * a root: they are a catalog `hermes skills install` copies FROM, and Hermes
 * only loads a copy once it has been seeded into the skills root.
 */
function buildHermesScanRoots(): SkillScanRoot[] {
  const agentDir = getHarness().getAgentDir();
  const [own, ...external] = hermesSkillRoots(agentDir, homedir());
  // Read once per scan, not once per skill: both are file reads.
  const disabled = readHermesDisabledSkills(agentDir);
  const shared = {
    scope: "user",
    recursive: true,
    // Hermes hides a skill whose `platforms:` excludes this OS, so listing one
    // would offer a skill the engine never loads.
    accepts: (frontmatter: Record<string, unknown>) => hermesSkillMatchesPlatform(frontmatter.platforms),
    // Enable/disable lives in `skills.disabled` in config.yaml, keyed by skill
    // name. Nothing in Hermes reads the frontmatter key omp honours.
    isDisabled: (name: string) => disabled.has(name),
  } as const satisfies Omit<SkillScanRoot, "dir" | "source">;
  return [
    { dir: own, source: ".hermes", ...shared },
    // External dirs are Hermes-owned only for reading (skill_utils
    // is_external_skill_path): they are listed, never written to.
    ...external.map((dir): SkillScanRoot => ({ dir, source: "external", ...shared })),
  ];
}

/** Scan roots in omp's provider priority order (highest first): .omp (100),
 * .claude (80), .agent/.agents + .codex + .github (70), managed skills (5).
 * pi and Hermes each get their own narrower walk (above). */
function buildScanRoots(cwd: string): SkillScanRoot[] {
  if (getHarness().id === "pi") return buildPiScanRoots(cwd);
  if (getHarness().id === "hermes") return buildHermesScanRoots();
  const home = homedir();
  // The ACTIVE engine's dir, not omp's. Reading lib/omp/paths here meant
  // every engine scanned ~/.omp/agent for its skills — so a Claude Code or
  // Codex session offered omp's skills, which it cannot load. The pi branch
  // above already did this correctly; this one did not.
  const agentDir = getHarness().getAgentDir();
  const ancestors = getAncestorDirs(cwd);
  const projectAncestors = ancestors.filter((dir) => dir !== home);
  const roots: SkillScanRoot[] = [];

  // builtin (.omp): project walk-up first (closest first), then user dir.
  for (const dir of projectAncestors) {
    roots.push({ dir: path.join(dir, ".omp", "skills"), source: ".omp", scope: "project", requireDescription: true });
  }
  roots.push({ dir: path.join(agentDir, "skills"), source: ".omp", scope: "user", requireDescription: true });

  // claude compat: user ~/.claude/skills + project .claude/skills walk-up.
  const claudeHome = process.env.CLAUDE_CONFIG_DIR || path.join(home, ".claude");
  roots.push({ dir: path.join(claudeHome, "skills"), source: ".claude", scope: "user" });
  for (const dir of projectAncestors) {
    roots.push({ dir: path.join(dir, ".claude", "skills"), source: ".claude", scope: "project" });
  }

  // agent dirs compat (.agent/.agents): project walk-up + user home.
  for (const dir of projectAncestors) {
    roots.push({ dir: path.join(dir, ".agent", "skills"), source: ".agents", scope: "project" });
    roots.push({ dir: path.join(dir, ".agents", "skills"), source: ".agents", scope: "project" });
  }
  roots.push({ dir: path.join(home, ".agent", "skills"), source: ".agents", scope: "user" });
  roots.push({ dir: path.join(home, ".agents", "skills"), source: ".agents", scope: "user" });

  // codex compat: user ~/.codex/skills + project .codex/skills.
  roots.push({ dir: path.join(home, ".codex", "skills"), source: ".codex", scope: "user" });
  roots.push({ dir: path.join(cwd, ".codex", "skills"), source: ".codex", scope: "project" });

  // github compat: <repoRoot>/.github/skills.
  const repoRoot = ancestors[ancestors.length - 1];
  roots.push({ dir: path.join(repoRoot, ".github", "skills"), source: ".github", scope: "project", requireDescription: true });

  // managed auto-learn skills (lowest priority).
  roots.push({ dir: path.join(agentDir, "managed-skills"), source: "managed", scope: "user", requireDescription: true });

  return roots;
}

/** Directories the discovery walk reads, for callers that must authorize a
 * skill path (single source of truth with buildScanRoots — a narrower list
 * would reject skills the app itself discovered and installed). Without a cwd
 * only the cwd-independent user-scope roots are returned. */
export function getSkillScanRootDirs(cwd?: string): string[] {
  return buildScanRoots(cwd ?? homedir()).map((root) => root.dir);
}

const DISABLE_INVOCATION_KEYS = ["disable-model-invocation", "disableModelInvocation", "hide"] as const;
/** Agent Skills standard spelling — used when no variant is present yet. */
const CANONICAL_DISABLE_KEY = DISABLE_INVOCATION_KEYS[0];

/** True when any of the three spellings omp honors is set
 * (frontmatter.hide === true || frontmatter.disableModelInvocation === true,
 * with `disable-model-invocation` normalized into the latter). */
export function readDisableModelInvocation(frontmatter: Record<string, unknown>): boolean {
  return DISABLE_INVOCATION_KEYS.some((key) => isTruthyFlag(frontmatter[key]));
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/;
const DISABLE_KEY_LINE_RE = new RegExp(`^(?:${DISABLE_INVOCATION_KEYS.join("|")})[ \\t]*:.*$`);

/** Set/clear the disable-model-invocation flag in a SKILL.md, editing the key
 * line already present (in whichever of the three spellings) instead of
 * prepending a second copy, which would make the frontmatter invalid YAML. */
export function setDisableModelInvocation(content: string, disable: boolean): string {
  const match = FRONTMATTER_RE.exec(content);
  if (!match) {
    return disable ? `---\n${CANONICAL_DISABLE_KEY}: true\n---\n${content}` : content;
  }

  const eol = match[0].includes("\r\n") ? "\r\n" : "\n";
  const lines = match[1].split(/\r?\n/);
  const hits = lines.reduce<number[]>((acc, line, index) => {
    if (DISABLE_KEY_LINE_RE.test(line)) acc.push(index);
    return acc;
  }, []);

  let next: string[];
  if (disable) {
    if (hits.length === 0) {
      next = [`${CANONICAL_DISABLE_KEY}: true`, ...lines];
    } else {
      // Keep the spelling the file already uses; drop any duplicate variants so
      // a stale `hide: true` cannot re-enable hiding on the next toggle.
      const keep = hits[0];
      const keyName = /^([\w-]+)/.exec(lines[keep])?.[1] ?? CANONICAL_DISABLE_KEY;
      next = lines
        .map((line, index) => (index === keep ? `${keyName}: true` : line))
        .filter((_, index) => index === keep || !hits.includes(index));
    }
  } else {
    if (hits.length === 0) return content;
    next = lines.filter((_, index) => !hits.includes(index));
  }

  const block = `---${eol}${next.join(eol)}${eol}---${match[2]}`;
  return block + content.slice(match[0].length);
}

/** `root.dir` is user-controlled and can be outside the app. Keep runtime
 * discovery opaque to Next's NFT tracer so builds never glob the user's
 * profile (or protected Windows junctions). */
function readDirEntries(dir: string) {
  const readDirectory = Reflect.get(fs, "readdir") as typeof fs.readdir;
  return readDirectory(dir, { withFileTypes: true });
}

/** Directories one level under a root, each a candidate skill package. */
async function flatSkillDirs(root: string): Promise<string[]> {
  const entries = await readDirEntries(root);
  return entries
    .filter((entry) => !entry.name.startsWith(".") && (entry.isDirectory() || entry.isSymbolicLink()))
    .map((entry) => path.join(root, entry.name));
}

/**
 * Every directory under `root` holding a SKILL.md, mirroring Hermes'
 * `iter_skill_index_files`: dependency/VCS/cache dirs and Hermes' own `.hub`
 * are pruned, and a skill package's progressive-disclosure subdirectories
 * (references/templates/assets/scripts) are pruned only when the directory
 * containing them is itself a skill — so an archived SKILL.md under
 * `some-skill/references/` is documentation, while a category legitimately
 * named `scripts/` stays discoverable.
 */
async function nestedSkillDirs(root: string): Promise<string[]> {
  const found: string[] = [];
  const visit = async (dir: string): Promise<void> => {
    const entries = await readDirEntries(dir);
    const hasSkillFile = entries.some((entry) => entry.name === "SKILL.md" && !entry.isDirectory());
    if (hasSkillFile) found.push(dir);
    // Hermes follows symlinks (os.walk(followlinks=True)); Dirent.isDirectory
    // is false for one, so the child is visited and a bad link simply fails
    // its own readdir below.
    const children = entries.filter((entry) =>
      (entry.isDirectory() || entry.isSymbolicLink())
      && !isExcludedHermesSkillDir(entry.name)
      && !isHermesSkillSupportDir(entry.name, hasSkillFile));
    await Promise.all(children.map(async (entry) => {
      try {
        await visit(path.join(dir, entry.name));
      } catch {
        // An unreadable subtree hides its own skills, not the whole root.
      }
    }));
  };
  await visit(root);
  return found;
}

async function scanRoot(root: SkillScanRoot, diagnostics: SkillDiagnostic[]): Promise<SkillInfo[]> {
  let skillDirs: string[];
  try {
    skillDirs = root.recursive ? await nestedSkillDirs(root.dir) : await flatSkillDirs(root.dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      diagnostics.push({
        type: "warning",
        message: `Failed to read skills directory: ${String(error)}`,
        path: root.dir,
      });
    }
    return [];
  }

  const skills: SkillInfo[] = [];
  await Promise.all(skillDirs.map(async (baseDir) => {
    const skillPath = path.join(baseDir, "SKILL.md");
    let content: string;
    try {
      content = await fs.readFile(skillPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        diagnostics.push({ type: "warning", message: "Failed to read skill file", path: skillPath });
      }
      return;
    }
    const { frontmatter } = parseSkillFrontmatter(content);
    if (frontmatter.enabled === false) return;
    if (root.accepts && !root.accepts(frontmatter)) return;
    const description = typeof frontmatter.description === "string" ? frontmatter.description : "";
    if (root.requireDescription && !description) return;
    const rawName = frontmatter.name;
    const name = typeof rawName === "string" && rawName.trim() ? rawName.trim() : path.basename(baseDir);
    skills.push({
      name,
      description,
      filePath: skillPath,
      baseDir,
      disableModelInvocation: root.isDisabled
        ? root.isDisabled(name)
        : readDisableModelInvocation(frontmatter),
      sourceInfo: { source: root.source, scope: root.scope },
    });
  }));
  return skills;
}

/** Discover skills for a cwd the way the active engine does. Name collisions
 * resolve to the highest-priority provider (scan-root order); result is sorted
 * by name. */
export async function discoverSkills(cwd: string): Promise<SkillsWithDiagnostics> {
  const diagnostics: SkillDiagnostic[] = [];
  const byName = new Map<string, SkillInfo>();
  for (const root of buildScanRoots(cwd)) {
    for (const skill of await scanRoot(root, diagnostics)) {
      if (!byName.has(skill.name)) byName.set(skill.name, skill);
    }
  }
  const skills = [...byName.values()].sort((a, b) => {
    const cmp = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    return cmp !== 0 ? cmp : a.filePath.localeCompare(b.filePath);
  });
  return { skills, diagnostics };
}

/**
 * Provenance for skills `hermes skills install` put on disk, read from
 * Hermes' own ledger (`<skills root>/.hub/lock.json`) rather than the
 * skills.sh `.skill-lock.json` Cody's other engines share — Hermes never
 * writes that file, so the shared annotator would report every Hermes skill
 * as hand-placed.
 *
 * `canCheckForUpdates` is false throughout: Cody's update check diffs a
 * GitHub tree hash from the skills.sh lock, and Hermes tracks its own
 * `content_hash` with its own `hermes skills check`/`update` pair. Claiming a
 * check Cody cannot perform would be worse than not offering one.
 */
function annotateHermesInstalls(skills: SkillInfo[], skillsRoot: string): SkillInfo[] {
  const lock = readHermesSkillLock(skillsRoot);
  if (lock.size === 0) return skills;
  // Hermes keys the ledger by the name it resolved at INSTALL time, which is
  // not always the frontmatter `name` a later scan reads — a skill whose
  // SKILL.md says `name: PDF Generator` is locked under `pdf-generator`, and
  // Hermes' own `skills list` then reports it as source "local". The
  // `install_path` it also records is exact, so match on that first and fall
  // back to the name.
  const byPath = new Map([...lock.values()].map((entry) => [entry.installPath, entry]));
  return skills.map((skill) => {
    const relativePath = path.relative(skillsRoot, skill.baseDir).split(path.sep).join("/");
    const entry = byPath.get(relativePath) ?? lock.get(skill.name);
    if (!entry) return skill;
    const pkg = hermesPackageForIdentifier(entry.identifier);
    return {
      ...skill,
      install: {
        // The store compares this against its own `owner/repo@slug` specs, so
        // a skill installed through Cody shows as installed. Identifiers from
        // Hermes' other registries have no skills.sh equivalent and stay as
        // themselves — they match nothing in the store, which is correct.
        package: pkg ?? entry.identifier,
        scope: "global" as SkillInstallScope,
        source: entry.source || "hermes",
        sourceType: pkg ? "github" : entry.source,
        skillsShUrl: pkg ? `https://skills.sh/${entry.identifier.slice("skills-sh/".length)}` : undefined,
        versionHash: entry.contentHash?.replace(/^sha256:/, ""),
        canCheckForUpdates: false,
      },
    };
  });
}

export async function loadSkillsWithInstallInfo(cwd: string) {
  const harness = getHarness();
  const { skills, diagnostics } = await discoverSkills(cwd);
  const agentDir = harness.getAgentDir();
  return {
    skills: harness.id === "hermes"
      ? annotateHermesInstalls(skills, path.join(agentDir, "skills"))
      : annotateSkillsWithInstallInfo(skills, { cwd, agentDir }),
    diagnostics,
  };
}

/**
 * What the active engine's skills surface can actually do, so the UI disables
 * the controls that would not work instead of failing on click.
 *
 * `installScopes` is the honest shape of an engine's skill roots: omp and pi
 * both discover project-scoped dirs, so a skill can be installed beside the
 * code; Hermes has exactly one root per home (plus read-only external dirs)
 * and would silently install "into the project" globally.
 *
 * `canToggle` is false only when Hermes was installed without the adjacent
 * venv Cody needs to reach its config writer (see setHermesSkillDisabled).
 */
export interface SkillsSurface {
  installScopes: SkillInstallScope[];
  canToggle: boolean;
}

export function getSkillsSurface(): SkillsSurface {
  const harness = getHarness();
  if (harness.id !== "hermes") {
    return { installScopes: ["global", "project"], canToggle: true };
  }
  return {
    installScopes: ["global"],
    canToggle: canToggleHermesSkills(harness.resolveBinary()),
  };
}
