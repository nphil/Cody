import { NextResponse } from "next/server";
import { requireEngine } from "@/lib/engine-guard";
import { archiveSessionFileWithArtifacts } from "@/lib/omp/session-files";
import {
  collapseContinuedSessions,
  invalidateSessionListCache,
  invalidateSessionPathCache,
  listAllSessions,
  listSupersededCopies,
} from "@/lib/session-reader";
import { resolveSessionPathOr404 } from "@/lib/api-utils";
import { getRpcSession } from "@/lib/rpc-manager";

/** POST /api/sessions/[id]/archive — stop the live child, then archive the
 * native OMP JSONL and its sibling artifacts using OMP's gc layout. */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    // Archiving moves an OMP .jsonl and its sibling artifacts using omp's own
    // gc layout. An engine that owns its storage has no such file — Delete,
    // next door, already dispatches for exactly this reason — so this says
    // `unsupported` instead of the bare 404 a missing path produced.
    const gate = requireEngine("omp", "Session archiving");
    if ("response" in gate) return gate.response;
    const resolved = await resolveSessionPathOr404(id, req);
    if ("response" in resolved) return resolved.response;
    const filePath = resolved.filePath;
    // Parent-session paths are native branch metadata. Moving only a parent
    // would leave active children pointing at a path that no longer exists,
    // flattening their tree in the sidebar. Archive leaves first instead.
    // The list is the sidebar's: forks of an earlier copy of this chat hang
    // from it, and the earlier copies themselves are not children.
    const hasChildren = collapseContinuedSessions(await listAllSessions()).some((session) => session.parentSessionId === id);
    if (hasChildren) {
      return NextResponse.json(
        { error: "Archive child sessions before archiving this session", code: "session_has_children" },
        { status: 409 },
      );
    }

    // OMP owns writes while a child is live; wait for its final flush before
    // moving the file so the archive contains the complete native transcript.
    await getRpcSession(id)?.destroyAndWait?.("the chat was archived");
    // A chat omp moved to a new file (18.13.2+) is one row standing in for its
    // earlier copies; they go with it, or the list would show the chat again.
    // They first, so a failure leaves the row in place to try again.
    for (const copy of await listSupersededCopies(id)) {
      archiveSessionFileWithArtifacts(copy.path);
      invalidateSessionPathCache(copy.id);
    }
    const archivedPath = archiveSessionFileWithArtifacts(filePath);
    invalidateSessionPathCache(id);
    invalidateSessionListCache();
    return NextResponse.json({ ok: true, archived: true, archivedPath });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message, code: "session_archive_failed" }, { status: 500 });
  }
}
