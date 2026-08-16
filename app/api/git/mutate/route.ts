import fs from "fs";
import { NextRequest, NextResponse } from "next/server";
import { getAllowedFileRoots, isExistingFilePathAllowed, isFilePathAllowed, isWindowsAbsolutePath } from "@/lib/file-access";
import { mutateGit, type GitMutationAction } from "@/lib/git-changes";

export const dynamic = "force-dynamic";

const ACTIONS = new Set<GitMutationAction>(["stage", "unstage", "discard", "commit"]);
const MAX_COMMIT_MESSAGE = 4_000;

export async function POST(request: NextRequest) {
  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "JSON object required", code: "invalid_body" }, { status: 400 });
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return NextResponse.json({ error: "JSON object required", code: "invalid_body" }, { status: 400 });
    }
    const { cwd: rawCwd, action, path: rawPath, message } = body as {
      cwd?: unknown; action?: unknown; path?: unknown; message?: unknown;
    };

    const cwd = typeof rawCwd === "string" ? rawCwd.trim() : "";
    if (!cwd || (!cwd.startsWith("/") && !isWindowsAbsolutePath(cwd))) {
      return NextResponse.json({ error: "cwd must be an absolute path", code: "cwd_must_be_absolute" }, { status: 400 });
    }
    if (typeof action !== "string" || !ACTIONS.has(action as GitMutationAction)) {
      return NextResponse.json({ error: "action must be stage, unstage, discard or commit", code: "invalid_action" }, { status: 400 });
    }
    // NOT trimmed: a filename may legitimately end in whitespace, and
    // trimming would silently retarget the operation at a different real file
    // — catastrophic for discard, which deletes.
    const filePath = typeof rawPath === "string" && rawPath !== "" ? rawPath : undefined;
    if (action !== "commit") {
      if (!filePath || (!filePath.startsWith("/") && !isWindowsAbsolutePath(filePath))) {
        return NextResponse.json({ error: "path must be an absolute path", code: "path_must_be_absolute" }, { status: 400 });
      }
    }
    const commitMessage = typeof message === "string" ? message : undefined;
    if (action === "commit" && (!commitMessage?.trim() || commitMessage.length > MAX_COMMIT_MESSAGE)) {
      return NextResponse.json({ error: "A commit message is required", code: "commit_message_required" }, { status: 400 });
    }

    const allowedRoots = await getAllowedFileRoots();
    if (!isFilePathAllowed(cwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied", code: "access_denied" }, { status: 403 });
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(cwd);
    } catch {
      return NextResponse.json({ error: "Directory not found", code: "directory_not_found" }, { status: 404 });
    }
    if (!stat.isDirectory()) {
      return NextResponse.json({ error: "Not a directory", code: "not_a_directory" }, { status: 400 });
    }
    if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied", code: "access_denied" }, { status: 403 });
    }
    // The target may be a deleted file (discard restores it), so only the
    // allow-list containment is checked here — not existence. mutateGit
    // additionally confines the path to inside the repository.
    if (filePath && !isFilePathAllowed(filePath, allowedRoots)) {
      return NextResponse.json({ error: "Access denied", code: "access_denied" }, { status: 403 });
    }

    const result = await mutateGit(cwd, action as GitMutationAction, filePath, commitMessage);
    if (!result.ok) {
      return NextResponse.json({ error: result.error ?? "Git operation failed", code: "git_mutation_failed" }, { status: 409 });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
