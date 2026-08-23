import { NextResponse } from "next/server";
import { runNpx } from "@/lib/npx";
import { getHarness } from "@/lib/harness";
import { hermesSkillIdentifier, installHermesSkill } from "@/lib/harness/hermes-skills";
import { getSkillsSurface } from "@/lib/skills-service";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";

export const dynamic = "force-dynamic";

const ANSI_RE = /\x1B\[[0-9;]*m/g;

/**
 * Install a skill for the ACTIVE engine, through that engine's own installer.
 *
 * For omp and pi that is the skills.sh CLI: `npx skills add --agent universal`
 * writes into the ecosystem-standard `.agents/skills` dirs both engines
 * discover. Hermes discovers neither — it reads only `$HERMES_HOME/skills`
 * and its configured external dirs — so the same command there would report a
 * successful install of a skill the engine never loads. `hermes skills
 * install` is the honest route for it, and it brings Hermes' own registry
 * resolution and security scan with it.
 */
// POST /api/skills/install  body: { package: string; scope: "global" | "project"; cwd?: string }
export async function POST(req: Request) {
  try {
    const { package: pkg, scope, cwd } = await req.json() as { package?: string; scope?: string; cwd?: string };
    if (!pkg?.trim()) return NextResponse.json({ error: "package required", code: "package_required" }, { status: 400 });

    const isGlobal = scope !== "project";
    if (!isGlobal) {
      if (!getSkillsSurface().installScopes.includes("project")) {
        return NextResponse.json(
          { error: "This engine has no project-scoped skills directory.", code: "skill_scope_unsupported" },
          { status: 400 },
        );
      }
      if (!cwd) return NextResponse.json({ error: "cwd required for project install", code: "cwd_required_for_project_install" }, { status: 400 });
      const allowedRoots = await getAllowedFileRoots();
      if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
        return NextResponse.json({ error: "Access denied", code: "access_denied" }, { status: 403 });
      }
    }

    const harness = getHarness();
    if (harness.id === "hermes") {
      const binaryPath = harness.resolveBinary();
      if (!binaryPath) {
        return NextResponse.json(
          { error: "Hermes is not installed, so skills cannot be installed for it.", code: "engine_not_installed" },
          { status: 409 },
        );
      }
      const identifier = hermesSkillIdentifier(pkg.trim());
      if (!identifier) {
        // A well-known provider spec is `https://<domain>`, which means "the
        // whole provider's set" to the skills.sh CLI and nothing to Hermes,
        // whose URL source wants one SKILL.md. Say so rather than sending an
        // identifier that would resolve to a web page.
        return NextResponse.json(
          { error: "Hermes installs one skill at a time by registry identifier, and this entry is a whole-provider bundle. Install it with `hermes skills install` in a Cody terminal.", code: "skill_source_unsupported" },
          { status: 400 },
        );
      }
      const result = await installHermesSkill(binaryPath, identifier);
      if (!result.ok) {
        // `hermes skills install` exits 0 whether it installed, was blocked by
        // its security scan, or could not resolve the identifier at all, so
        // the output IS the verdict. Hand the user Hermes' own words.
        const detail = result.output.trim().split(/\n{2,}/).pop()?.trim().slice(-400);
        return NextResponse.json(
          detail ? { error: detail } : { error: "Install failed", code: "skill_install_failed" },
          { status: 500 },
        );
      }
      return NextResponse.json({ success: true, output: result.output });
    }

    // The skills.sh CLI has no omp agent entry; "universal" installs into the
    // ecosystem-standard ~/.agents/skills (global) / <cwd>/.agents/skills
    // (project), both of which omp discovers via its agent-dirs provider.
    const args = ["skills", "add", pkg.trim(), "-y", "--agent", "universal"];
    if (isGlobal) args.push("-g");

    const { stdout, stderr } = await runNpx(args, {
      timeout: 60000,
      cwd: !isGlobal && cwd ? cwd : undefined,
      env: { ...process.env, FORCE_COLOR: "0" },
    });

    const output = (stdout + stderr).replace(ANSI_RE, "");
    const success = /Installation complete|Installed \d+ skill/.test(output);
    if (!success) {
      const detail = output.slice(-300);
      return NextResponse.json(
        detail ? { error: detail } : { error: "Install failed", code: "skill_install_failed" },
        { status: 500 },
      );
    }
    return NextResponse.json({ success: true, output });
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    const output = ((err.stdout ?? "") + (err.stderr ?? "")).replace(ANSI_RE, "");
    return NextResponse.json({ error: output || (err.message ?? String(e)) }, { status: 500 });
  }
}
