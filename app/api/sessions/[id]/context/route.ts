import { NextResponse } from "next/server";
import { buildSessionContext, loadSessionFileCached, loadSessionForHistoryPage } from "@/lib/session-reader";
import { apiErrorResponse, historyCursorGone, resolveEngineSessionOr404, resolveSessionPathOr404 } from "@/lib/api-utils";
import { readEngineMessages, withCrashRows } from "@/lib/engine-transcript";
import { getHarness } from "@/lib/harness";
import { computeHistoryStats, pageSessionContext, parseHistoryPage } from "@/lib/session-history-page";
import type { SessionContext } from "@/lib/types";

/**
 * GET /api/sessions/[id]/context[?leafId=][&deferThinking][&deferMedia]
 *
 * The display context of one branch. With `?page=1` it is a window of that
 * branch (`before=<id>` / `after=<id>` walk it; see lib/session-history-page.ts)
 * and the response adds `historyStats`, the whole branch's totals. A non-omp
 * engine answers with its live turn log, cursored by message index.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const url = new URL(req.url);
  const leafId = url.searchParams.get("leafId") ?? undefined;
  const deferThinking = url.searchParams.has("deferThinking");
  const deferToolResultImages = url.searchParams.has("deferMedia");

  try {
    const parsedPage = parseHistoryPage(url.searchParams);
    if ("error" in parsedPage) {
      return NextResponse.json({ error: parsedPage.error.message, code: parsedPage.error.code }, { status: 400 });
    }
    const page = parsedPage.page;

    if (getHarness().createSession) {
      const engine = resolveEngineSessionOr404(id, req);
      if ("response" in engine) return engine.response;
      const { messages } = await readEngineMessages(id);
      const full: SessionContext = { messages, entryIds: [], thinkingLevel: "off", model: null, todoPhases: [] };
      if (!page) return NextResponse.json({ context: full });
      const paged = pageSessionContext(full, page, { engine: true });
      if ("error" in paged) return historyCursorGone();
      return NextResponse.json({ context: paged.context, historyStats: computeHistoryStats(messages) });
    }

    const resolved = await resolveSessionPathOr404(id, req);
    if ("response" in resolved) return resolved.response;
    const filePath = resolved.filePath;

    // With deferMedia a page reads the history-page parse (see lib/session-reader.ts
    // loadSessionForHistoryPage): the same entries minus engine-only fields.
    const { header, entries, error: loadError } = page && deferToolResultImages
      ? loadSessionForHistoryPage(filePath)
      : loadSessionFileCached(filePath, {
        resolveBlobs: true,
        skipToolResultImages: deferToolResultImages,
      });
    if (loadError === "too_large") {
      return NextResponse.json(
        { error: "Session file is too large to open in Cody", code: "session_file_too_large" },
        { status: 413 },
      );
    }
    if (!header) {
      return NextResponse.json({ error: "Session file is missing or malformed", code: "session_file_malformed" }, { status: 404 });
    }
    const context = buildSessionContext(entries, leafId, {
      deferThinking,
      deferToolResultImages,
      // Only a paged response may stub oversized blocks (fetched on demand from
      // /detail?entryId=...); a legacy consumer would show the stub as the text.
      ...(page ? { deferOversizedBlocks: true } : {}),
      toolResultImageUrl: (entryId, index) =>
        `/api/sessions/${encodeURIComponent(id)}/media?entryId=${encodeURIComponent(entryId)}&index=${index}`,
    });
    if (!page) return NextResponse.json({ context });

    // The same crash lines the main route lays in, so a cursor taken from either
    // route names the same message on the other.
    const full = withCrashRows(id, context);
    const paged = pageSessionContext(full, page);
    if ("error" in paged) return historyCursorGone();
    return NextResponse.json({ context: paged.context, historyStats: computeHistoryStats(full.messages) });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
