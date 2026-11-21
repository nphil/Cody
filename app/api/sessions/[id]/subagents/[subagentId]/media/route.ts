import { NextResponse } from "next/server";
import { apiErrorResponse, resolveSessionPathOr404 } from "@/lib/api-utils";
import { isSafeSubagentId, readSubagentTranscriptImage, resolveSubagentArtifact } from "@/lib/subagent-history";

export const dynamic = "force-dynamic";

/**
 * GET /api/sessions/[id]/subagents/[subagentId]/media?offset=<byte>&entryId=<id>&index=<n>
 *
 * Streams one tool-result image of a subagent transcript. The transcript route
 * defers those images like the main chat does (`/api/sessions/[id]/media`) and
 * mints this url from the byte `offset` of the entry's line, so only that one
 * line is read — never the 14–21 MB file. `index` counts with the same
 * predicate the deferral used (`isDeferrableToolResultImage`).
 *
 * Same ownership check as the transcript route (`resolveSessionPathOr404`),
 * and the transcript is resolved with realpath confinement inside the parent
 * session's artifacts dir.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string; subagentId: string }> },
) {
  const { id, subagentId } = await params;
  try {
    if (!isSafeSubagentId(subagentId)) {
      return NextResponse.json({ error: "Invalid subagent id", code: "invalid_subagent_id" }, { status: 400 });
    }
    const url = new URL(req.url);
    const entryId = url.searchParams.get("entryId") ?? "";
    const offsetRaw = url.searchParams.get("offset") ?? "";
    const indexRaw = url.searchParams.get("index") ?? "";
    const offset = /^\d{1,15}$/.test(offsetRaw) ? Number(offsetRaw) : NaN;
    const index = /^\d{1,3}$/.test(indexRaw) ? Number(indexRaw) : NaN;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(entryId) || !Number.isSafeInteger(offset) || !Number.isInteger(index) || index > 255) {
      return NextResponse.json({ error: "offset, entryId and index are required", code: "bad_media_ref" }, { status: 400 });
    }
    const sessionResolved = await resolveSessionPathOr404(id, req);
    if ("response" in sessionResolved) return sessionResolved.response;
    const resolved = resolveSubagentArtifact(sessionResolved.filePath, subagentId, ".jsonl");
    if (!resolved) {
      return NextResponse.json({ error: "Subagent transcript not found", code: "transcript_not_found" }, { status: 404 });
    }
    const image = readSubagentTranscriptImage(resolved, offset, entryId, index);
    if (!image) {
      return NextResponse.json({ error: "Image not found", code: "media_not_found" }, { status: 404 });
    }
    return new Response(new Uint8Array(image.bytes), {
      headers: {
        "Content-Type": /^image\//.test(image.mime) ? image.mime : "application/octet-stream",
        "Content-Length": String(image.bytes.length),
        "X-Content-Type-Options": "nosniff",
        // Transcript lines are append-only, so the bytes at one offset never change.
        "Cache-Control": "private, max-age=86400",
      },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
