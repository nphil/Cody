import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/api-utils";
import { comparableProjectPath } from "@/lib/comparable-path";
import { allowFileRoot } from "@/lib/file-access";
import { getHarness } from "@/lib/harness";
import { listEngineSessions } from "@/lib/harness/engine-sessions";
import {
  hideProject,
  loadProjectRegistry,
  mergeProjects,
  ProjectPathError,
  saveProjectRegistry,
  upsertProject,
  validateProjectPath,
} from "@/lib/project-registry";
import { listAllSessions } from "@/lib/session-reader";
import { resolveProject } from "@/lib/worktree";
import type { ManagedProject } from "@/lib/types";

// GET /api/projects  →  { projects: ManagedProject[] }
// Registered (non-hidden) projects plus session-discovered projects, excluding
// hidden entries. Session-discovered paths get no addedAt; the client orders
// the merged list by most-recently-added (registration order), then by path —
// deliberately not by session activity, which would reorder rows on refresh.
export async function GET() {
  try {
    const registry = loadProjectRegistry();
    const sessions = await listAllSessions();
    const discovered = sessions
      .map((s) => s.projectRoot ?? s.cwd)
      .filter((path): path is string => Boolean(path));
    // A non-omp engine keeps its transcripts in its own private store, so its
    // sessions never appear in listAllSessions(). Their cwds come from Cody's
    // sidecar index instead — without this the sidebar loses every project
    // group that only has engine sessions.
    const harness = getHarness();
    if (harness.createSession) {
      for (const entry of listEngineSessions(harness.id)) {
        if (entry.cwd) discovered.push(entry.cwd);
      }
    }
    const projects = mergeProjects(registry, discovered);
    // Keep the in-memory browse allowlist warm for registered projects that
    // have no sessions (the in-memory list does not survive restarts, and an
    // empty managed project derives no root from sessions).
    for (const project of projects) allowFileRoot(project.path);
    return NextResponse.json({ projects });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

// POST /api/projects  body: { cwd }  →  { project: ManagedProject }
// Validates the directory, resolves Git worktrees to their main projectRoot,
// registers and authorizes it, and unhides it if it was previously hidden.
export async function POST(req: Request) {
  try {
    const body = await req.json() as { cwd?: unknown };
    const cwd = typeof body.cwd === "string" ? body.cwd : "";
    const normalized = validateProjectPath(cwd);
    const { projectRoot } = await resolveProject(normalized);

    const registry = loadProjectRegistry();
    const next = upsertProject(registry, projectRoot);
    saveProjectRegistry(next);
    allowFileRoot(projectRoot);

    const entry = next.projects.find((p) => comparableProjectPath(p.path) === comparableProjectPath(projectRoot))!;
    return NextResponse.json({ project: { path: entry.path, addedAt: entry.addedAt } satisfies ManagedProject });
  } catch (error) {
    if (error instanceof ProjectPathError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 400 });
    }
    return apiErrorResponse(error);
  }
}

// DELETE /api/projects  body: { cwd }  →  { success: true }
// Hides the project from the sidebar without touching its directory or
// sessions. Re-adding the directory (POST) restores it.
export async function DELETE(req: Request) {
  try {
    const body = await req.json() as { cwd?: unknown };
    const cwd = typeof body.cwd === "string" ? body.cwd.trim() : "";
    if (!cwd) {
      return NextResponse.json({ error: "Path is required", code: "path_required" }, { status: 400 });
    }
    // Canonicalize worktree paths so hiding a worktree hides its whole project.
    const { projectRoot } = await resolveProject(cwd);
    const registry = loadProjectRegistry();
    saveProjectRegistry(hideProject(registry, projectRoot));
    return NextResponse.json({ success: true });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
