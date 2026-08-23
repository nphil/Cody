import { NextResponse } from "next/server";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "fs";
import { basename, dirname } from "path";
import { getHarness } from "@/lib/harness";
import { setHermesSkillDisabled } from "@/lib/harness/hermes-skills";
import {
  getSkillScanRootDirs,
  getSkillsSurface,
  loadSkillsWithInstallInfo,
  parseSkillFrontmatter,
  readDisableModelInvocation,
  setDisableModelInvocation,
} from "@/lib/skills-service";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";

export const dynamic = "force-dynamic";

// GET /api/skills?cwd=<path>
// Scans the roots the ACTIVE engine discovers — omp's provider list, pi's
// narrower one, or Hermes' recursive `$HERMES_HOME/skills` tree — and reports
// what the surface can do for that engine alongside them.
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const cwd = searchParams.get("cwd");
  if (!cwd) return NextResponse.json({ error: "cwd required", code: "cwd_required" }, { status: 400 });

  try {
    const allowedRoots = await getAllowedFileRoots();
    if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied", code: "access_denied" }, { status: 403 });
    }
    return NextResponse.json({ ...await loadSkillsWithInstallInfo(cwd), ...getSkillsSurface() });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

/** The name the engine keys a skill by: its frontmatter `name`, else the
 * directory it sits in. Both omp and Hermes resolve it this way. */
function skillNameFor(filePath: string, content: string): string {
  const raw = parseSkillFrontmatter(content).frontmatter.name;
  return typeof raw === "string" && raw.trim() ? raw.trim() : basename(dirname(filePath));
}

// PATCH /api/skills — enable or disable a skill for the active engine.
//
// Where that state LIVES is engine-specific and the two are not
// interchangeable: omp and pi read a `disable-model-invocation` key in the
// SKILL.md, while Hermes reads a list of skill names under `skills.disabled`
// in its own config.yaml and never looks at the frontmatter at all. Writing
// the frontmatter key for Hermes would report a successful toggle that
// changes nothing about what the engine loads.
export async function PATCH(req: Request) {
  try {
    const body = await req.json() as { filePath: string; disableModelInvocation: boolean; cwd?: string };
    const { filePath, disableModelInvocation, cwd } = body;
    if (!filePath) return NextResponse.json({ error: "filePath required", code: "file_path_required" }, { status: 400 });
    if (basename(filePath) !== "SKILL.md") {
      return NextResponse.json({ error: "not a SKILL.md file", code: "not_a_skill_file" }, { status: 400 });
    }
    if (!existsSync(filePath)) return NextResponse.json({ error: "file not found", code: "file_not_found" }, { status: 404 });
    // Every root the scanner reads must be writable here, or skills in the
    // compat dirs (~/.agents/skills — where the app's own global installs land,
    // ~/.claude/skills, ~/.codex/skills, managed-skills) could be listed but
    // never toggled. Session cwds cover the project-scope roots.
    const allowedRoots = new Set(await getAllowedFileRoots());
    // An optional cwd (already an allowed root) additionally covers the
    // project walk-up roots discovery visits above the session directory.
    const scanCwd = cwd && isExistingFilePathAllowed(cwd, allowedRoots) ? cwd : undefined;
    for (const dir of getSkillScanRootDirs(scanCwd)) allowedRoots.add(dir);
    // Resolve symlinks once up front and authorize the resolved path: the
    // read/write below then operate on the same resolved path, so a symlink
    // swapped between the authorization check and the write cannot redirect
    // it outside the checked roots.
    const resolvedFilePath = realpathSync(filePath);
    if (!isExistingFilePathAllowed(resolvedFilePath, allowedRoots)) {
      return NextResponse.json({ error: "Access denied", code: "access_denied" }, { status: 403 });
    }

    const content = readFileSync(resolvedFilePath, "utf8");

    const harness = getHarness();
    if (harness.id === "hermes") {
      const binaryPath = harness.resolveBinary();
      if (!binaryPath) {
        return NextResponse.json(
          { error: "Hermes is not installed, so its skill configuration cannot be changed.", code: "engine_not_installed" },
          { status: 409 },
        );
      }
      // The SKILL.md is read only to learn the name Hermes keys the skill by;
      // the file itself is never rewritten for this engine.
      try {
        setHermesSkillDisabled(binaryPath, skillNameFor(resolvedFilePath, content), disableModelInvocation);
      } catch (error) {
        // Hermes' own stderr says why (a managed config, an unreadable file);
        // String(e) below would prefix it with "Error:" and read as a crash.
        return NextResponse.json(
          { error: error instanceof Error ? error.message : String(error), code: "skill_toggle_failed" },
          { status: 500 },
        );
      }
      return NextResponse.json({ success: true, disableModelInvocation });
    }

    const updated = setDisableModelInvocation(content, disableModelInvocation);
    if (updated !== content) writeFileSync(resolvedFilePath, updated, "utf8");

    // Report what the file now says rather than what was asked for.
    const { frontmatter } = parseSkillFrontmatter(updated);
    return NextResponse.json({ success: true, disableModelInvocation: readDisableModelInvocation(frontmatter) });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
