import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/api-utils";
import { existsSync } from "fs";
import { randomUUID } from "crypto";
import { allowFileRoot } from "@/lib/file-access";
import { invalidateSessionListCache } from "@/lib/session-reader";
import { WebRpcError, startRpcSession } from "@/lib/rpc-manager";
import { createCheckpoint } from "@/lib/checkpoints";
import { RpcCommandError } from "@/lib/omp/rpc-process";
import { getRequestUser } from "@/lib/auth/guard";
import { setSessionOwner } from "@/lib/auth/session-owners";
import { getHarness } from "@/lib/harness";
import { engineSessionTitle, getEngineSession, upsertEngineSession } from "@/lib/harness/engine-sessions";
import { EngineCommandError } from "@/lib/harness/errors";

function newSessionErrorResponse(error: unknown) {
  if (error instanceof SyntaxError) {
    return NextResponse.json({ error: "Invalid JSON request body", code: "invalid_json" }, { status: 400 });
  }
  if (error instanceof EngineCommandError) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: 400 });
  }
  if (error instanceof WebRpcError || error instanceof RpcCommandError) {
    return NextResponse.json(
      { error: error.message, code: error instanceof WebRpcError ? error.code : (error.code ?? "rpc_command_failed") },
      { status: 400 },
    );
  }
  return apiErrorResponse(error);
}
// POST /api/agent/new  body: { cwd: string; type: string; message?: string; ... }
// Spawns a brand-new omp session. Most calls immediately send the first command;
// type:"ensure_session" only creates the runtime so clients can query commands.
// Returns { sessionId, data } where sessionId is omp's real session id.
// Model/thinking presets are applied post-ready via RPC set_model /
// set_thinking_level (not CLI flags) so failures surface as command errors and
// the live model catalog (incl. background discovery) is consulted.
export async function POST(req: Request) {
  try {
    const body = await req.json() as { cwd?: string; [key: string]: unknown };
    const { cwd, ...command } = body;

    if (!cwd || typeof cwd !== "string") {
      return NextResponse.json({ error: "cwd is required", code: "cwd_required" }, { status: 400 });
    }
    if (!existsSync(cwd)) {
      return NextResponse.json({ error: `Directory does not exist: ${cwd}`, code: "directory_not_found" }, { status: 400 });
    }

    // Use a one-time key so startRpcSession's lock doesn't conflict with real session ids
    const { provider, modelId, toolNames, thinkingLevel, advisor, ...promptCommand } = command as { provider?: string; modelId?: string; toolNames?: string[]; thinkingLevel?: string; advisor?: boolean; [key: string]: unknown };
    if (typeof promptCommand.type !== "string" || !promptCommand.type.trim()) {
      return NextResponse.json({ error: "command type is required", code: "command_type_required" }, { status: 400 });
    }

    // Must be unique per request: startRpcSession coalesces concurrent callers
    // that share a key onto one session. Date.now() (ms resolution) collides for
    // requests in the same millisecond, merging two new sessions into one.
    const tempKey = `__new__${randomUUID()}`;
    // Snapshot before the very first prompt of a new session, same as the
    // per-message hook: failures are silent and never block the send.
    if (typeof command.message === "string" || command.type === "prompt") {
      await createCheckpoint(cwd, typeof command.message === "string" && command.message ? command.message : "New session");
    }
    // A non-omp engine has no session file: pass an empty engine session id so
    // the engine mints one, exactly as `sessionFile: ""` means "new" for omp.
    const harness = getHarness();
    const engineMode = typeof harness.createSession === "function";
    const { session, realSessionId } = await startRpcSession(
      tempKey,
      "",
      cwd,
      toolNames,
      advisor === true,
      engineMode ? "" : undefined,
    );

    // Keep the files-route allowed-roots cache (see app/api/files/[...path]/route.ts)
    // in sync so the new cwd is immediately readable via /api/files. Without this,
    // a file request under a brand-new cwd would 403 for up to the cache TTL.
    allowFileRoot(cwd);
    invalidateSessionListCache();

    // Stamp the creating account so the session lists (and opens) only for
    // them. Sessions created with auth off stay unowned — visible to all.
    const creator = getRequestUser(req);
    if (creator) setSessionOwner(realSessionId, creator.id);

    if (engineMode) {
      // The sidebar lists engine sessions from the index. An ACP session
      // writes its own row the moment `session/new` answers — engine id and
      // cwd only, no title, because the transport never sees the prompt as a
      // title — and that happens inside startRpcSession above, BEFORE this
      // line. So the row usually exists already, and seeding only a missing
      // row left every Claude, Codex and Hermes session labelled
      // "(no messages)" in the sidebar for good. Seed the title whenever the
      // row has none; an `ensure_session` (no prompt) still gets its row.
      const existingRow = getEngineSession(realSessionId);
      const title = engineSessionTitle(typeof command.message === "string" ? command.message : "");
      if (!existingRow || (!existingRow.title && title)) {
        try {
          upsertEngineSession(realSessionId, { engine: harness.id, cwd, title });
        } catch {
          // A sidecar write failure costs a sidebar row, never the session.
        }
      }
    } else {
      // Apply pre-selected model before sending the prompt. Both commands are
      // omp-only (chatExtras); a turn-based engine answers them "unsupported",
      // so never send them there.
      if (provider && modelId) {
        await session.send({ type: "set_model", provider, modelId });
      }

      // Apply pre-selected thinking level before sending the prompt
      if (thinkingLevel) {
        await session.send({ type: "set_thinking_level", level: thinkingLevel });
      }
    }

    if (promptCommand.type === "ensure_session") {
      return NextResponse.json({ success: true, sessionId: realSessionId, data: null });
    }

    const result = await session.send(promptCommand);

    return NextResponse.json({ success: true, sessionId: realSessionId, data: result });
  } catch (error) {
    return newSessionErrorResponse(error);
  }
}
