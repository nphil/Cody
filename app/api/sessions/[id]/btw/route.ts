import { NextResponse } from "next/server";
import { jsonError } from "@/lib/auth/http";
import { canAccessSession } from "@/lib/auth/session-owners";
import { getRequestUser } from "@/lib/auth/guard";
import { requireEngine } from "@/lib/engine-guard";
import { agentCommandErrorResponse, resolveSessionPathOr404 } from "@/lib/api-utils";
import { parseBtwRecords } from "@/lib/btw";
import { readBtwHistoryFromDisk } from "@/lib/btw-history";
import { getRpcSession } from "@/lib/rpc-manager";
import { resolveSessionPath } from "@/lib/session-reader";
import { isUnsupportedCommandError } from "@/lib/subagent-types";

export const dynamic = "force-dynamic";

const SURFACE = "Side questions";
/** Same bound as getStateBounded: omp answers `get_btw_history` from its SERIAL
 * queue, so a long `compact` ahead of it can delay the ack indefinitely. */
const LIVE_HISTORY_TIMEOUT_MS = 3_000;
const NO_STORE = { "Cache-Control": "no-store" };

type Source = "live" | "disk";

function answer(records: unknown[], source: Source, supported: boolean | null) {
  return NextResponse.json({ records, source, supported }, { headers: NO_STORE });
}

/**
 * GET /api/sessions/[id]/btw — the chat's side questions, newest first.
 *
 * `{ records, source, supported }`:
 *  - live engine: asked through `get_btw_history` (`source:"live"`,
 *    `supported:true`); an omp that predates /btw answers `supported:false`
 *    with no records. A slow engine (3 s) falls back to the sidecar on disk
 *    WITHOUT marking a running topic interrupted — it may still be writing —
 *    and answers `source:"disk"`, `supported:null` (unknown).
 *  - no live engine: the sidecar, with a topic left `running` reported as
 *    `interrupted` (its writer is gone). Never spawns an engine.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = requireEngine("omp", SURFACE);
  if ("response" in gate) return gate.response;
  const { id } = await params;
  if (!canAccessSession(id, getRequestUser(request))) return jsonError("Session not found", 404, "session_not_found");

  const live = getRpcSession(id);
  if (!live?.isAlive()) {
    const resolved = await resolveSessionPathOr404(id, request);
    if ("response" in resolved) return resolved.response;
    return answer(await readBtwHistoryFromDisk(resolved.filePath, { recoverRunning: true }), "disk", null);
  }

  const TIMED_OUT = Symbol("get_btw_history_timeout");
  const deadline: { timer?: NodeJS.Timeout } = {};
  try {
    const reply = Promise.resolve(live.send({ type: "get_btw_history" }));
    // If the timeout wins, nobody awaits this again; keep its late settlement
    // from becoming an unhandled rejection.
    reply.catch(() => {});
    const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
      deadline.timer = setTimeout(() => resolve(TIMED_OUT), LIVE_HISTORY_TIMEOUT_MS);
      deadline.timer.unref?.();
    });
    const outcome = await Promise.race([reply, timeout]);
    if (outcome === TIMED_OUT) {
      // A live session may not have created its jsonl yet: nothing to read.
      const file = live.sessionFile || (await resolveSessionPath(id)) || "";
      return answer(await readBtwHistoryFromDisk(file, { recoverRunning: false }), "disk", null);
    }
    const records = (outcome as { records?: unknown } | null | undefined)?.records;
    return answer(parseBtwRecords(records), "live", true);
  } catch (error) {
    if (isUnsupportedCommandError(error)) return answer([], "live", false);
    return agentCommandErrorResponse(error);
  } finally {
    clearTimeout(deadline.timer);
  }
}
