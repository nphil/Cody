import { NextResponse } from "next/server";
import { jsonError, requireAdminOrOpenInstance, requireUserOrOpenInstance } from "@/lib/auth/http";
import { parseJsonWithinLimit } from "@/lib/bounded-form-data";
import { getAllowedFileRoots } from "@/lib/file-access";
import { clearOlderThan, clearUsageItem, DEFAULT_OLDER_THAN_DAYS, isUsageVolume, previewClear, readUsage, startUsageScan } from "@/lib/disk/usage";
import { isRecord } from "@/lib/type-guards";

/**
 * Settings › System › Disk space › What is using space.
 *
 * GET `?volume=data|tmp`: the newest finished scan (or a running one's
 * progress) with every folder labelled. POST `{action}`: `scan` (start one, one
 * at a time), `preview` (what clearing a path would free and whether it may be),
 * `clear` (delete it), `clearOlder` (every listed build-output folder idle for
 * `days` days). All admin-only, or open on an instance with no accounts: the
 * tree names everybody's project folders and the deletes are for everybody.
 * Nothing here deletes by the cached tree: `clear` re-checks the live disk
 * (lib/disk/usage.ts).
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { headers: { "Cache-Control": "no-store" } };
const MAX_DAYS = 365;

/** Folders the file viewer can open, in the same spelling the scan uses. */
async function viewerRoots(): Promise<ReadonlySet<string>> {
  try {
    return await getAllowedFileRoots();
  } catch {
    return new Set();
  }
}

export async function GET(request: Request) {
  const resolved = requireUserOrOpenInstance(request);
  if ("response" in resolved) return resolved.response;
  const denied = requireAdminOrOpenInstance(request);
  if (denied) return denied;
  const volume = new URL(request.url).searchParams.get("volume") ?? "data";
  if (!isUsageVolume(volume)) return jsonError("Unknown volume", 400, "invalid_request");
  return NextResponse.json(readUsage(volume, await viewerRoots(), true), NO_STORE);
}

export async function POST(request: Request) {
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

  switch (body.action) {
    case "scan": {
      if (!isUsageVolume(body.volume)) return jsonError("Unknown volume", 400, "invalid_request");
      const started = startUsageScan(body.volume);
      if (started === "unavailable") return jsonError("This server cannot scan disk usage.", 503, "unavailable");
      return NextResponse.json({ started: started === "started", ...readUsage(body.volume, await viewerRoots(), true) }, NO_STORE);
    }
    case "preview":
      return NextResponse.json(await previewClear(body.path), NO_STORE);
    case "clear":
      return NextResponse.json(await clearUsageItem(body.path), NO_STORE);
    case "clearOlder": {
      if (!isUsageVolume(body.volume)) return jsonError("Unknown volume", 400, "invalid_request");
      const days = typeof body.days === "number" && Number.isInteger(body.days) && body.days >= 1 && body.days <= MAX_DAYS ? body.days : DEFAULT_OLDER_THAN_DAYS;
      return NextResponse.json(await clearOlderThan(body.volume, days, await viewerRoots()), NO_STORE);
    }
    default:
      return jsonError("Unknown action", 400, "invalid_request");
  }
}
