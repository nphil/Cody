import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/api-utils";
import { existsSync } from "fs";
import { randomUUID } from "crypto";
import { allowFileRoot } from "@/lib/file-access";
import { invalidateSessionListCache } from "@/lib/session-reader";
import { WebRpcError, startRpcSession } from "@/lib/rpc-manager";
import { createCheckpoint } from "@/lib/checkpoints";
import { RpcCommandError } from "@/lib/omp/rpc-process";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";

import { getRequestUser } from "@/lib/auth/guard";
import { zoneForMessage } from "@/lib/time-zone-prefs";
import { setSessionOwner } from "@/lib/auth/session-owners";
import { getHarness } from "@/lib/harness";
import { engineSessionTitle, getEngineSession, upsertEngineSession } from "@/lib/harness/engine-sessions";
import { EngineCommandError } from "@/lib/harness/errors";
import { configuredLocalRoutingModels, renameSessionLocalRouting, setSessionLocalOnly } from "@/lib/local-model-routing";
import { forgetSessionPreset, setSessionPreset } from "@/lib/model-presets/overlay";
import { getPreset, setLastUsedPreset } from "@/lib/model-presets/store";

/** Same bound as /api/agent/[id]: the browser's prompt frame is capped at
 * PROMPT_FRAME_BUDGET_BYTES (900 KiB, lib/image-compress.ts), so 4 MiB is
 * headroom, not a working size. */
const MAX_NEW_AGENT_REQUEST_BYTES = 4 * 1024 * 1024;

function newSessionErrorResponse(error: unknown) {
  if (error instanceof RequestBodyTooLargeError) {
    return NextResponse.json({ error: "New session request is too large", code: "request_too_large" }, { status: 413 });
  }
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
    const body = await parseJsonWithinLimit<{ cwd?: string; [key: string]: unknown }>(req, MAX_NEW_AGENT_REQUEST_BYTES);
    const { cwd, ...command } = body;

    if (!cwd || typeof cwd !== "string") {
      return NextResponse.json({ error: "cwd is required", code: "cwd_required" }, { status: 400 });
    }
    if (!existsSync(cwd)) {
      return NextResponse.json({ error: `Directory does not exist: ${cwd}`, code: "directory_not_found" }, { status: 400 });
    }

    // Use a one-time key so startRpcSession's lock doesn't conflict with real session ids
    const { provider, modelId, toolNames, thinkingLevel, advisor, localOnly, kind, contextSessionId, presetId, ...promptCommand } = command as { provider?: string; modelId?: string; toolNames?: string[]; thinkingLevel?: string; advisor?: boolean; localOnly?: boolean; kind?: "sidebar"; contextSessionId?: string | null; presetId?: string | null; [key: string]: unknown };
    // A stale or forged sessionId must never reach the child RPC.
    delete promptCommand.sessionId;
    if (typeof promptCommand.type !== "string" || !promptCommand.type.trim()) {
      return NextResponse.json({ error: "command type is required", code: "command_type_required" }, { status: 400 });
    }

    if (localOnly !== undefined && typeof localOnly !== "boolean") {
      return NextResponse.json({ error: "localOnly must be a boolean", code: "invalid_local_routing" }, { status: 400 });
    }
    if (presetId !== undefined && presetId !== null && typeof presetId !== "string") {
      return NextResponse.json({ error: "presetId must be a preset id or null", code: "invalid_preset" }, { status: 400 });
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
    if (localOnly === true && harness.id !== "omp") {
      return NextResponse.json({ error: "Local-only routing is available only for omp sessions.", code: "local_routing_unsupported" }, { status: 400 });
    }
    const localIntent = localOnly === true ? setSessionLocalOnly(tempKey, true) : null;
    // A model preset is an omp role overlay. A sidebar chat is isolated from
    // role configuration by design and never takes one.
    const presetForLaunch = typeof presetId === "string" && harness.id === "omp" && kind !== "sidebar" ? presetId : null;
    if (presetForLaunch !== null) {
      if (!getPreset(presetForLaunch)) {
        return NextResponse.json({ error: "That preset no longer exists.", code: "not_found" }, { status: 404 });
      }
      // Bound under the temporary key; startRpcSession moves it onto omp's
      // real id once the child announces it.
      setSessionPreset(tempKey, presetForLaunch);
    }
    if (presetId !== undefined && kind !== "sidebar" && harness.id === "omp") setLastUsedPreset(presetForLaunch);
    const localEnvelope = localIntent?.envelope;
    if (localIntent && !localEnvelope) throw new Error("Local-only routing did not produce a safe context envelope.");
    const selectedForLaunch = localIntent?.primary ?? (provider && modelId ? { provider, modelId } : undefined);
    const configuredTarget = selectedForLaunch
      ? configuredLocalRoutingModels().models.find((model) => model.provider === selectedForLaunch.provider && model.modelId === selectedForLaunch.modelId)
      : undefined;
    const profileTarget = selectedForLaunch
      ? {
        ...selectedForLaunch,
        ...(localEnvelope
          ? { contextWindow: localEnvelope.contextWindow, maxTokens: localEnvelope.maxTokens }
          : configuredTarget ? { contextWindow: configuredTarget.contextWindow, maxTokens: configuredTarget.maxTokens } : {}),
      }
      : undefined;
    // Resolved before the spawn: the sidebar's context tools are handed this
    // account, and every session they read is gated by its ownership.
    const actor = getRequestUser(req);
    // The new chat starts in the zone of the browser that opened it (or the
    // person's own choice), and its first message carries that same zone.
    const timeZone = zoneForMessage(actor, command.timeZone);
    promptCommand.timeZone = timeZone;
    let started: Awaited<ReturnType<typeof startRpcSession>>;
    try {
      started = await startRpcSession(
        tempKey,
        "",
        cwd,
        toolNames,
        advisor === true,
        engineMode ? "" : undefined,
        profileTarget,
        kind,
        // Sidebar only: its context tools read this account's sessions, and
        // default `read_session` to whichever main chat the panel is pointed at.
        kind === "sidebar" ? { contextSessionId: typeof contextSessionId === "string" ? contextSessionId : null, user: actor } : undefined,
        { timeZone },
      );
    } catch (error) {
      // No session came of it, so its pre-spawn binding must not linger.
      if (presetForLaunch !== null) forgetSessionPreset(tempKey);
      throw error;
    }
    const { session, realSessionId } = started;
    if (localIntent) renameSessionLocalRouting(tempKey, realSessionId);

    // Keep the files-route allowed-roots cache (see app/api/files/[...path]/route.ts)
    // in sync so the new cwd is immediately readable via /api/files. Without this,
    // a file request under a brand-new cwd would 403 for up to the cache TTL.
    allowFileRoot(cwd);
    invalidateSessionListCache();

    // Stamp the creating account so the session lists (and opens) only for
    // them. Sessions created with auth off stay unowned — visible to all.
    if (actor) setSessionOwner(realSessionId, actor.id);

    if (engineMode) {
      // The sidebar lists engine sessions from the index. An ACP session
      // writes its own row the moment `session/new` answers — engine id and
      // cwd only, no title, because the transport never sees the prompt as a
      // title — and that happens inside startRpcSession above, BEFORE this
      // line. So the row usually exists already, and seeding only a missing
      // row left every Claude Code and Codex session labelled
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
      if (selectedForLaunch) {
        await session.send({ type: "set_model", provider: selectedForLaunch.provider, modelId: selectedForLaunch.modelId });
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
