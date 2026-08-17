import { NextResponse } from "next/server";
import { loadSessionFile } from "@/lib/omp/session-files";
import { isDeferrableToolResultImage } from "@/lib/session-reader";
import { apiErrorResponse, resolveSessionPathOr404 } from "@/lib/api-utils";

/**
 * GET /api/sessions/[id]/media?entryId=<id>&index=<n>
 *
 * Streams one tool-result image's bytes. The context routes defer tool-result
 * images out of the history payload and replace each with a url-source image
 * block pointing here, so the browser fetches (and caches) them lazily.
 * `index` counts image blocks within the entry with the SAME predicate the
 * deferral uses (session-reader isDeferrableToolResultImage) — the two sides
 * must stay aligned.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const url = new URL(req.url);
  const entryId = url.searchParams.get("entryId") ?? "";
  const index = Number.parseInt(url.searchParams.get("index") ?? "", 10);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(entryId) || !Number.isInteger(index) || index < 0 || index > 255) {
    return NextResponse.json({ error: "entryId and index are required", code: "bad_media_ref" }, { status: 400 });
  }

  try {
    const resolved = await resolveSessionPathOr404(id, req);
    if ("response" in resolved) return resolved.response;

    // Resolve blobs INCLUDING toolResult images — serving them is the point.
    const { entries, error: loadError } = loadSessionFile(resolved.filePath, { resolveBlobs: true });
    if (loadError === "too_large") {
      return NextResponse.json({ error: "Session file is too large", code: "session_file_too_large" }, { status: 413 });
    }
    const entry = entries.find((e) => e.id === entryId);
    const content = entry?.type === "message" && Array.isArray((entry.message as { content?: unknown }).content)
      ? (entry.message as { content: unknown[] }).content
      : [];
    const images = content.filter(isDeferrableToolResultImage);
    const block = images[index] as { data?: string; mimeType?: string; source?: { data?: string; media_type?: string } } | undefined;
    const data = typeof block?.data === "string" ? block.data : block?.source?.data;
    if (!data) {
      return NextResponse.json({ error: "Image not found", code: "media_not_found" }, { status: 404 });
    }
    const mime = block?.mimeType ?? block?.source?.media_type ?? "image/png";
    const bytes = Buffer.from(data, "base64");
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": /^image\//.test(mime) ? mime : "application/octet-stream",
        "Content-Length": String(bytes.length),
        // Entries are append-only and never rewritten, so a fetched image can
        // be cached for the session's practical lifetime — but privately.
        "Cache-Control": "private, max-age=86400",
      },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
