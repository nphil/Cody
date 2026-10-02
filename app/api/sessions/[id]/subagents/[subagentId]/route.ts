import { NextResponse } from "next/server";
import { resolveSessionPathOr404 } from "@/lib/api-utils";
import { isSafeSubagentId, readCompletionArtifact, readSubagentTranscriptPage, resolveSubagentArtifact, subagentTranscriptPath } from "@/lib/subagent-history";

export const dynamic = "force-dynamic";

// OMP task names are explicit user input and may contain spaces/punctuation.
// The shared path-boundary validator permits those names while rejecting path
// separators, controls, traversal components, and overlong UTF-8 filenames.

/**
 * GET /api/sessions/[id]/subagents/[subagentId]
 *
 * Default: one page of a subagent's transcript, read by byte range from the
 * parent session's sibling artifacts dir (the whole file is never loaded).
 * Pages are whole JSONL lines, so every returned `fromByte` / `nextByte` is a
 * valid cursor. Three modes:
 *   ?tail=1            the newest page (ends at `endByte`)
 *   ?beforeByte=N      the page that ends at byte N (older history)
 *   ?fromByte=N        the page that starts at byte N (default 0)
 * Page shape: `SubagentTranscriptPage` in lib/subagent-types.ts.
 *
 * ?mode=completion: the subagent's final output (`<id>.md`), without loading
 * the transcript.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string; subagentId: string }> }
) {
  const { id, subagentId } = await params;
  try {
    if (!isSafeSubagentId(subagentId)) {
      return NextResponse.json({ error: "Invalid subagent id", code: "invalid_subagent_id" }, { status: 400 });
    }
    const sessionResolved = await resolveSessionPathOr404(id, req);
    if ("response" in sessionResolved) return sessionResolved.response;
    const filePath = sessionResolved.filePath;
    const searchParams = new URL(req.url).searchParams;
    if (searchParams.get("mode") === "completion") {
      const resolved = resolveSubagentArtifact(filePath, subagentId, ".md");
      if (!resolved) {
        return NextResponse.json({ error: "Subagent completion not found", code: "transcript_not_found" }, { status: 404 });
      }
      // Read the RESOLVED path: re-deriving from the raw session path here
      // would reopen whatever the symlink points at after the check.
      const completion = readCompletionArtifact(resolved);
      return NextResponse.json({
        sessionFile: subagentTranscriptPath(filePath, subagentId),
        completion: completion?.completion ?? null,
        truncated: completion?.truncated ?? false,
      });
    }
    const resolved = resolveSubagentArtifact(filePath, subagentId, ".jsonl");
    if (!resolved) {
      return NextResponse.json({ error: "Subagent transcript not found", code: "transcript_not_found" }, { status: 404 });
    }
    const byteParam = (raw: string | null) => {
      const n = Number(raw);
      return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
    };
    const beforeRaw = searchParams.get("beforeByte");
    const tailRaw = searchParams.get("tail");
    const page = tailRaw === "1" || tailRaw === "true"
      ? readSubagentTranscriptPage(resolved, 0, { tail: true })
      : beforeRaw !== null
        ? readSubagentTranscriptPage(resolved, byteParam(beforeRaw), { before: true })
        : readSubagentTranscriptPage(resolved, byteParam(searchParams.get("fromByte")));
    return NextResponse.json(page);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
