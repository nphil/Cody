import { NextRequest, NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/api-utils";
import { FileOpError, createDirectoryEntry, createFileEntry, deleteEntry, renameEntry } from "@/lib/file-ops";

export const dynamic = "force-dynamic";

// Sibling of app/api/files/[...path]/route.ts (browse/read/upload): this
// route is the mutating counterpart — create, rename, and delete — kept
// separate so the catch-all path segments there stay read/upload only.
//
// POST body: { action, path, ... } where action is one of:
//   "mkdir"       { path: <parent dir>, name: <new folder name> }
//   "create-file" { path: <parent dir>, name: <new file name> }
//   "rename"      { path: <source>, newName: <new base name, same directory> }
//   "delete"      { path: <target>, recursive?: boolean }  — recursive is
//                 required (and must be explicit) to remove a non-empty
//                 directory; the authorized root itself can never be removed.
const ACTIONS = new Set(["mkdir", "create-file", "rename", "delete"]);

interface OpsBody {
  action?: unknown;
  path?: unknown;
  name?: unknown;
  newName?: unknown;
  recursive?: unknown;
}

export async function POST(request: NextRequest) {
  let body: OpsBody;
  try {
    body = (await request.json()) as OpsBody;
  } catch {
    return NextResponse.json({ error: "JSON object required", code: "invalid_body" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: "JSON object required", code: "invalid_body" }, { status: 400 });
  }

  const { action, path: rawPath, name, newName, recursive } = body;
  if (typeof action !== "string" || !ACTIONS.has(action)) {
    return NextResponse.json(
      { error: "action must be mkdir, create-file, rename or delete", code: "invalid_action" },
      { status: 400 },
    );
  }
  if (typeof rawPath !== "string" || rawPath.length === 0) {
    return NextResponse.json({ error: "A path is required", code: "path_required" }, { status: 400 });
  }

  try {
    if (action === "mkdir") {
      const created = await createDirectoryEntry(rawPath, name);
      return NextResponse.json({ ok: true, path: created });
    }
    if (action === "create-file") {
      const created = await createFileEntry(rawPath, name);
      return NextResponse.json({ ok: true, path: created });
    }
    if (action === "rename") {
      const renamed = await renameEntry(rawPath, newName);
      return NextResponse.json({ ok: true, path: renamed });
    }
    // action === "delete"
    await deleteEntry(rawPath, recursive === true);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof FileOpError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    return apiErrorResponse(error);
  }
}
