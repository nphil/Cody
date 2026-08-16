import fs from "fs";
import { NextRequest, NextResponse } from "next/server";
import { createCheckpoint, listCheckpoints, restoreCheckpoint } from "@/lib/checkpoints";
import { getAllowedFileRoots, isExistingFilePathAllowed, isFilePathAllowed, isWindowsAbsolutePath } from "@/lib/file-access";

export const dynamic = "force-dynamic";

async function authorizeCwd(raw: unknown): Promise<{ cwd: string } | { response: NextResponse }> {
  const cwd = typeof raw === "string" ? raw.trim() : "";
  if (!cwd || (!cwd.startsWith("/") && !isWindowsAbsolutePath(cwd))) {
    return { response: NextResponse.json({ error: "cwd must be an absolute path", code: "cwd_must_be_absolute" }, { status: 400 }) };
  }
  const allowedRoots = await getAllowedFileRoots();
  if (!isFilePathAllowed(cwd, allowedRoots)) {
    return { response: NextResponse.json({ error: "Access denied", code: "access_denied" }, { status: 403 }) };
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(cwd);
  } catch {
    return { response: NextResponse.json({ error: "Directory not found", code: "directory_not_found" }, { status: 404 }) };
  }
  if (!stat.isDirectory()) {
    return { response: NextResponse.json({ error: "Not a directory", code: "not_a_directory" }, { status: 400 }) };
  }
  if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
    return { response: NextResponse.json({ error: "Access denied", code: "access_denied" }, { status: 403 }) };
  }
  return { cwd };
}

export async function GET(request: NextRequest) {
  try {
    const authorized = await authorizeCwd(request.nextUrl.searchParams.get("cwd"));
    if ("response" in authorized) return authorized.response;
    return NextResponse.json({ checkpoints: await listCheckpoints(authorized.cwd) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "JSON object required", code: "invalid_body" }, { status: 400 });
    }
    if (typeof body !== "object" || body === null) {
      return NextResponse.json({ error: "JSON object required", code: "invalid_body" }, { status: 400 });
    }
    const { cwd: rawCwd, action, hash, label } = body as { cwd?: unknown; action?: unknown; hash?: unknown; label?: unknown };
    const authorized = await authorizeCwd(rawCwd);
    if ("response" in authorized) return authorized.response;

    if (action === "create") {
      const checkpointLabel = typeof label === "string" && label.trim() ? label : "Manual checkpoint";
      const created = await createCheckpoint(authorized.cwd, checkpointLabel);
      if (!created) {
        return NextResponse.json({ error: "Could not create a checkpoint", code: "checkpoint_failed" }, { status: 409 });
      }
      return NextResponse.json({ ok: true, hash: created });
    }

    if (action === "restore") {
      if (typeof hash !== "string" || !hash.trim()) {
        return NextResponse.json({ error: "hash is required", code: "hash_required" }, { status: 400 });
      }
      const safetyLabel = typeof label === "string" && label.trim() ? label : "Before restore";
      const result = await restoreCheckpoint(authorized.cwd, hash.trim(), safetyLabel);
      if (!result.ok) {
        return NextResponse.json({ error: result.error ?? "Restore failed", code: "restore_failed" }, { status: 409 });
      }
      return NextResponse.json({ ok: true, safetyHash: result.safetyHash ?? null });
    }

    return NextResponse.json({ error: "action must be create or restore", code: "invalid_action" }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
