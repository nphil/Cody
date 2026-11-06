import { NextResponse } from "next/server";
import { jsonError, requireAdminOrOpenInstance, requireUserOrOpenInstance } from "@/lib/auth/http";
import { canAccessSession } from "@/lib/auth/session-owners";
import type { UserRecord } from "@/lib/auth/users";
import { parseJsonWithinLimit } from "@/lib/bounded-form-data";
import { isDiskJanitorRunning, readLastJanitorReport, runDiskJanitor } from "@/lib/disk/janitor";
import { DiskSettingsError, readDiskSettings, writeDiskSettings } from "@/lib/disk/settings";
import { readDiskAreas } from "@/lib/disk/status";
import type { DiskLastRun, DiskPayload, DiskScratchFolder } from "@/lib/disk/types";
import { listEngineSessions } from "@/lib/harness/engine-sessions";
import { listAllSessions } from "@/lib/session-reader";
import { isRecord } from "@/lib/type-guards";

/**
 * Settings › System › Disk: how full the temp and data disks are, which chats
 * hold the biggest scratch folders, and the janitor's last pass.
 *
 * GET answers any signed-in person (everyone shares the disk). POST (clean now)
 * and PUT (the janitor's settings) are admin-only, or open to anyone on an
 * instance with no accounts, like /api/machines: they change what is deleted
 * for everybody. A member sees only the titles of chats they may open; another
 * person's folder shows as "Unknown chat", and the list of removed paths is
 * left out for them.
 */

export const dynamic = "force-dynamic";

const NO_STORE = { headers: { "Cache-Control": "no-store" } };
const LARGEST_SCRATCH = 5;
const REMOVED_CAP = 50;
const TITLE_MAX_CHARS = 80;
const UNKNOWN_CHAT = "Unknown chat";
const DELETED_CHAT = "Deleted chat";

function shortTitle(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return UNKNOWN_CHAT;
  return flat.length <= TITLE_MAX_CHARS ? flat : `${flat.slice(0, TITLE_MAX_CHARS - 1).trimEnd()}…`;
}

/** Every chat the instance knows, by id, whatever engine wrote it. */
async function readChatTitles(): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  for (const row of listEngineSessions()) titles.set(row.sessionId, row.title);
  try {
    for (const session of await listAllSessions()) titles.set(session.id, session.name || session.firstMessage);
  } catch {
    // An unreadable session folder leaves the engine-indexed titles; the rest read as deleted.
  }
  return titles;
}

async function largestScratch(scratch: Array<{ sessionIds: string[]; bytes: number; lastUsedAt: number; live: boolean }>, user: UserRecord | null): Promise<DiskScratchFolder[]> {
  const top = [...scratch].sort((a, b) => b.bytes - a.bytes).slice(0, LARGEST_SCRATCH);
  if (top.length === 0) return [];
  const titles = await readChatTitles();
  return top.map((folder) => {
    const known = folder.sessionIds.find((id) => titles.has(id));
    let title = UNKNOWN_CHAT;
    if (known === undefined) {
      if (folder.sessionIds.length > 0) title = DELETED_CHAT;
    } else if (folder.sessionIds.every((id) => !titles.has(id) || canAccessSession(id, user))) {
      title = shortTitle(titles.get(known) ?? "");
    }
    return { title, bytes: folder.bytes, lastUsedAt: folder.lastUsedAt, live: folder.live };
  });
}

async function answer(canEdit: boolean, user: UserRecord | null, freedBytes?: number): Promise<NextResponse> {
  const report = readLastJanitorReport();
  const lastRun: DiskLastRun | null = report && {
    trigger: report.trigger,
    startedAt: report.startedAt,
    finishedAt: report.finishedAt,
    freedBytes: report.freedBytes,
    removedCount: report.removed.length,
    removed: canEdit ? report.removed.slice(0, REMOVED_CAP) : [],
    errorCount: report.errors.length,
  };
  const body: DiskPayload = {
    areas: readDiskAreas(),
    settings: readDiskSettings(),
    lastRun,
    largestScratch: report ? await largestScratch(report.scratch, user) : [],
    checkpointBytes: report?.checkpointBytes ?? 0,
    running: isDiskJanitorRunning(),
    canEdit,
    ...(freedBytes === undefined ? {} : { freedBytes }),
  };
  return NextResponse.json(body, NO_STORE);
}

export async function GET(request: Request) {
  const resolved = requireUserOrOpenInstance(request);
  if ("response" in resolved) return resolved.response;
  return answer(requireAdminOrOpenInstance(request) === null, resolved.user);
}

export async function POST(request: Request) {
  const resolved = requireUserOrOpenInstance(request);
  if ("response" in resolved) return resolved.response;
  const denied = requireAdminOrOpenInstance(request);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await parseJsonWithinLimit<unknown>(request, 1_024);
  } catch {
    return jsonError("Invalid request body", 400, "invalid_request");
  }
  if (!isRecord(body) || body.action !== "clean") return jsonError("Unknown action", 400, "invalid_request");

  const report = await runDiskJanitor({ trigger: "manual" });
  return answer(true, resolved.user, report.freedBytes);
}

export async function PUT(request: Request) {
  const resolved = requireUserOrOpenInstance(request);
  if ("response" in resolved) return resolved.response;
  const denied = requireAdminOrOpenInstance(request);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await parseJsonWithinLimit<unknown>(request, 4_096);
  } catch {
    return jsonError("Invalid request body", 400, "invalid_request");
  }
  if (!isRecord(body)) return jsonError("Invalid request body", 400, "invalid_request");

  try {
    writeDiskSettings(body);
  } catch (error) {
    if (error instanceof DiskSettingsError) {
      return NextResponse.json(
        { error: error.message, code: "invalid_disk_settings", field: error.field },
        { status: 400, headers: NO_STORE.headers },
      );
    }
    throw error;
  }
  return answer(true, resolved.user);
}
