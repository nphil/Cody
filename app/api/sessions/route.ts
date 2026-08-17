import { NextResponse } from "next/server";
import { createHash } from "crypto";
import { listAllSessions } from "@/lib/session-reader";
import { getRunningRpcSessionIds } from "@/lib/rpc-manager";
import { getRequestUser } from "@/lib/auth/guard";
import { filterSessionsForUser } from "@/lib/auth/session-owners";
import { getHarness } from "@/lib/harness";
import { listEngineSessions } from "@/lib/harness/engine-sessions";
import type { SessionInfo } from "@/lib/types";

// The session list mixes on-disk sessions with the live runningSessionIds set,
// which changes on every agent turn, so it must never be cached by proxies or
// the browser. An ETag is still computed so conditional GETs short-circuit to
// a 304 when nothing changed (cheap client-side polling, server-side response
// body skipped).
const SESSION_LIST_HEADERS = {
  "Cache-Control": "no-store",
  Vary: "Cookie",
} as const;

/**
 * Sessions of a non-omp engine, in the shape the sidebar consumes. They are
 * listed strictly for the ACTIVE engine: rows written by another engine (or by
 * omp's own on-disk sessions) never mix into one list, because nothing but the
 * active engine could open them.
 *
 * Fields Cody cannot know without the engine's private transcript — message
 * count, branch parentage, the exact first message — degrade to zero/undefined
 * rather than being guessed; the index title stands in as the label.
 */
function listActiveEngineSessions(engineId: string): SessionInfo[] {
  return listEngineSessions(engineId).map((row) => ({
    path: "",
    id: row.sessionId,
    cwd: row.cwd,
    name: row.title || undefined,
    created: row.createdAt,
    modified: row.updatedAt || row.createdAt,
    messageCount: 0,
    firstMessage: row.title || "(no messages)",
    projectRoot: row.cwd,
  }));
}

export async function GET(req: Request) {
  try {
    // Ownership filter: each account sees its own sessions plus unowned ones
    // (pre-account history and terminal-created sessions stay visible to all).
    const harness = getHarness();
    const sessions = filterSessionsForUser(
      harness.createSession ? listActiveEngineSessions(harness.id) : await listAllSessions(),
      getRequestUser(req),
    );
    const visible = new Set(sessions.map((session) => session.id));
    const runningSessionIds = getRunningRpcSessionIds().filter((id) => visible.has(id));
    const body = { sessions, runningSessionIds };

    const etag = `"${createHash("sha1").update(JSON.stringify(body)).digest("hex").slice(0, 16)}"`;
    if (req.headers.get("if-none-match") === etag) {
      return new NextResponse(null, { status: 304, headers: { ETag: etag, ...SESSION_LIST_HEADERS } });
    }
    return NextResponse.json(body, { headers: { ETag: etag, ...SESSION_LIST_HEADERS } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error), code: "internal_error" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
