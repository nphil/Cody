import { NextResponse } from "next/server";
import { scanSessionInfo, setSessionTitle } from "@/lib/omp/session-files";
import { deriveSessionTitleFromFirstMessage, sanitizeSessionTitle } from "@/lib/session-title";
import { generateSessionName } from "@/lib/session-namer";
import { getRpcSession } from "@/lib/rpc-manager";
import { invalidateSessionListCache } from "@/lib/session-reader";
import { resolveSessionPathOr404 } from "@/lib/api-utils";

/**
 * POST /api/sessions/[id]/auto-name
 *
 * Best name first: the engine's own title (omp auto-titles sessions itself, and
 * an engine that has already named a session knows more about it than we do),
 * then a short model-written name, then a truncation of the first message.
 *
 * The model step is what keeps the sidebar readable: most sessions never get an
 * engine title, and the truncation fallback is a 60-character fragment of a
 * sentence rather than a name.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    // Running session: ask the live omp process (its in-memory title is newer
    // than the file's slot while a rewrite is pending). This runs before the
    // path check because omp does not create the session file until the history
    // holds an assistant message.
    const rpc = getRpcSession(id);
    const running = Boolean(rpc?.isAlive?.());
    if (running && typeof rpc?.send === "function") {
      try {
        const state = await rpc.send({ type: "get_state" }) as { sessionName?: string } | null;
        const liveTitle = sanitizeSessionTitle(state?.sessionName);
        if (liveTitle) {
          invalidateSessionListCache();
          return NextResponse.json({ title: liveTitle, usage: null });
        }
      } catch {
        // Fall through to the on-disk title.
      }
    }

    const resolved = await resolveSessionPathOr404(id, req);
    if ("response" in resolved) return resolved.response;
    const filePath = resolved.filePath;

    const info = scanSessionInfo(filePath, false);
    const storedTitle = sanitizeSessionTitle(info?.title);
    if (storedTitle) {
      return NextResponse.json({ title: storedTitle, usage: null });
    }

    // A model name is the one we actually want to stick, so unlike the
    // truncation below it is written even while a process owns the file —
    // through the live process, the same way PATCH routes a user rename, so its
    // in-memory title cannot clobber ours on the next flush.
    const generated = await generateSessionName(info?.firstMessage);
    if (generated) {
      let persisted = false;
      if (running && typeof rpc?.send === "function") {
        try {
          await rpc.send({ type: "set_session_name", name: generated });
          persisted = true;
        } catch {
          // Fall back to the on-disk title slot.
        }
      }
      if (!persisted) setSessionTitle(filePath, generated, "auto");
      invalidateSessionListCache();
      return NextResponse.json({ title: generated, usage: null });
    }

    const derived = deriveSessionTitleFromFirstMessage(info?.firstMessage);
    if (!derived) {
      return NextResponse.json(
        { error: "The session has no user messages to name", code: "session_no_messages_to_name" },
        { status: 409 },
      );
    }

    // Persist only when no live process owns the file; a running session will
    // title itself and would clobber our write on its next flush anyway — and a
    // sentence fragment is not worth racing the engine's own title for.
    if (!running) {
      setSessionTitle(filePath, derived, "auto");
    }
    invalidateSessionListCache();
    return NextResponse.json({ title: derived, usage: null });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
