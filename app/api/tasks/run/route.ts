import fs from "fs";
import { NextRequest, NextResponse } from "next/server";
import { getAllowedFileRoots, isExistingFilePathAllowed, isFilePathAllowed, isWindowsAbsolutePath } from "@/lib/file-access";
import { authorizeTerminalCwd, getTerminalManager } from "@/lib/terminal-manager";
import { readTasksConfig } from "@/lib/workspace-tasks-file";

export const dynamic = "force-dynamic";

/** TerminalManager.create() rejects anything outside this charset. */
const TERMINAL_NAME_CHARSET = /[^\w .:+-]/gu;
const TERMINAL_NAME_MAX = 80;

/**
 * Fold a task title into a legal terminal name (`/^[\w .:+-]{1,80}$/`).
 * Illegal characters become spaces, runs of whitespace collapse, and a title
 * that survives as nothing (e.g. fully non-ASCII) falls back to "Task".
 */
function terminalNameForTask(title: string): string {
  const cleaned = title
    .replace(TERMINAL_NAME_CHARSET, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, TERMINAL_NAME_MAX)
    .trim();
  return cleaned || "Task";
}

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
    const { cwd: rawCwd, taskId } = body as { cwd?: unknown; taskId?: unknown };

    const cwd = typeof rawCwd === "string" ? rawCwd.trim() : "";
    if (!cwd || (!cwd.startsWith("/") && !isWindowsAbsolutePath(cwd))) {
      return NextResponse.json({ error: "cwd must be an absolute path", code: "cwd_must_be_absolute" }, { status: 400 });
    }
    if (typeof taskId !== "string" || taskId.trim() === "") {
      return NextResponse.json({ error: "taskId is required", code: "task_id_required" }, { status: 400 });
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

    // Terminals re-check the allowed roots against the resolved real path.
    let authorizedCwd: string;
    try {
      authorizedCwd = await authorizeTerminalCwd(cwd);
    } catch {
      return NextResponse.json({ error: "Access denied", code: "access_denied" }, { status: 403 });
    }

    // The command is never taken from the request: the config is re-read here
    // and the task is looked up by id, so the browser can only name a task the
    // workspace already declares.
    const config = await readTasksConfig(authorizedCwd);
    if (config.state !== "loaded") {
      const error = config.state === "missing"
        ? "No workspace tasks are configured"
        : config.error;
      return NextResponse.json({ error, code: "tasks_config_unavailable" }, { status: 409 });
    }

    const task = config.tasks.find((candidate) => candidate.id === taskId);
    if (!task) {
      return NextResponse.json({ error: "Task not found", code: "task_not_found" }, { status: 404 });
    }

    const manager = getTerminalManager();
    const info = manager.create(authorizedCwd, terminalNameForTask(task.title));
    try {
      manager.write(info.id, `${task.command}\n`);
    } catch (error) {
      // Never leave an orphaned shell behind when the write fails.
      try {
        manager.close(info.id);
      } catch {
        // The terminal is already gone; nothing left to clean up.
      }
      return NextResponse.json(
        { error: error instanceof Error ? error.message : String(error), code: "task_dispatch_failed" },
        { status: 500 },
      );
    }

    return NextResponse.json({ terminalId: info.id }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
