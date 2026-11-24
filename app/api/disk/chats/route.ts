import { NextResponse } from "next/server";
import { jsonError, requireAdminOrOpenInstance, requireUserOrOpenInstance } from "@/lib/auth/http";
import { isChatSort, listChatSizes } from "@/lib/disk/usage-chats";

/**
 * Settings › System › Disk space › Chats: the biggest (or longest untouched)
 * chat transcripts and their sizes. Admin-only: it is part of the "what is
 * using space" view. Deleting is the sidebar's own DELETE /api/sessions/<id>.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const resolved = requireUserOrOpenInstance(request);
  if ("response" in resolved) return resolved.response;
  const denied = requireAdminOrOpenInstance(request);
  if (denied) return denied;
  const sort = new URL(request.url).searchParams.get("sort") ?? "size";
  if (!isChatSort(sort)) return jsonError("Unknown sort", 400, "invalid_request");
  try {
    return NextResponse.json(await listChatSizes(sort, resolved.user), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : String(error), 500, "chats_failed");
  }
}
