import { NextResponse } from "next/server";
import { entryToUiMessage, loadSessionForHistoryPage } from "@/lib/session-reader";
import { LAZY_PAGE_CHARS, lazyDetailText, sliceLazyPage, type LazyDetailKind } from "@/lib/lazy-blocks";
import { apiErrorResponse, resolveSessionPathOr404 } from "@/lib/api-utils";

const KINDS: readonly LazyDetailKind[] = ["thinking", "result", "arg"];

function nonNegativeInt(raw: string | null, fallback: number): number | null {
  if (raw === null) return fallback;
  if (!/^\d{1,12}$/.test(raw)) return null;
  return Number(raw);
}

/**
 * GET /api/sessions/[id]/detail
 *   ?entryId=<id> &kind=thinking|result|arg &blockIndex=<n> [&pointer=<RFC 6901>] [&page=<n>] [&limit=<n>]
 *
 * One page of an oversized block the transcript payload replaced with a stub
 * (lib/lazy-blocks.ts projectLazyBlocks). Same session ownership gate as every
 * other session route. The text is read from the entry's UI message, the very
 * shape the transcript route sends (hidden entries, engine-only roles and
 * every field the transcript drops are not there to read), and only the three
 * displayed fields can be asked for: assistant thinking, toolResult text, a
 * string inside a tool call's arguments. Nothing else of the entry, no path
 * and no tree data is ever returned. Pages are numbered from 0 and tile the
 * text exactly (at most LAZY_PAGE_CHARS + 1 UTF-16 units each, never cut
 * inside a character), so any page — first, last, or one back — can be asked
 * for on its own; `pages` says how many there are.
 *
 * The route is shallow on purpose (the entry id is a query parameter, like the
 * media route): a deeper nested dynamic route was not served by Next dev.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const query = new URL(req.url).searchParams;
  const entryId = query.get("entryId") ?? "";
  const kind = query.get("kind") as LazyDetailKind | null;
  const blockIndex = nonNegativeInt(query.get("blockIndex"), Number.NaN);
  const page = nonNegativeInt(query.get("page"), 0);
  const limit = nonNegativeInt(query.get("limit"), LAZY_PAGE_CHARS);
  const pointer = query.get("pointer") ?? undefined;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(entryId) || !kind || !KINDS.includes(kind) || blockIndex === null || !Number.isSafeInteger(blockIndex) || page === null || limit === null || limit < 1) {
    return NextResponse.json({ error: "Valid entryId, kind, blockIndex, page and limit are required", code: "invalid_detail_request" }, { status: 400 });
  }
  if ((kind === "arg") !== (pointer !== undefined)) {
    return NextResponse.json({ error: "pointer is required for kind=arg and only for it", code: "invalid_detail_request" }, { status: 400 });
  }

  try {
    const resolved = await resolveSessionPathOr404(id, req);
    if ("response" in resolved) return resolved.response;

    // The history-page parse the transcript was built from (a cache hit when it
    // was just read): it keeps every displayed field whole and holds no blob
    // bytes for the text read here.
    const entry = loadSessionForHistoryPage(resolved.filePath).entries.find((candidate) => candidate.id === entryId);
    const message = entry ? entryToUiMessage(entry, {}) : null;
    const text = message ? lazyDetailText(message, kind, blockIndex, pointer) : null;
    if (text === null) {
      return NextResponse.json({ error: "Block not found", code: entry ? "detail_block_not_found" : "detail_entry_not_found" }, { status: 404 });
    }
    const slice = sliceLazyPage(text, page, limit);
    if (!slice) {
      return NextResponse.json({ error: "Page not found", code: "detail_page_not_found" }, { status: 404 });
    }
    return NextResponse.json(slice, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
