import { NextResponse } from "next/server";
import { resolveSessionPathOr404 } from "@/lib/api-utils";
import { getRequestUser } from "@/lib/auth/guard";
import { jsonError } from "@/lib/auth/http";
import { canAccessSession } from "@/lib/auth/session-owners";
import { requireEngine } from "@/lib/engine-guard";
import { loadRoster } from "@/lib/model-plan/roster";
import { unavailablePresetSelection } from "@/lib/model-presets/availability";
import { readSessionPresetId, setSessionPreset } from "@/lib/model-presets/overlay";
import { getPreset, resolveSmartDefault, setLastUsedPreset } from "@/lib/model-presets/store";
import type { SessionPresetResponse } from "@/lib/model-presets/types";
import { getRpcSession, restartSessionForRouting, WebRpcError } from "@/lib/rpc-manager";
import { isRecord } from "@/lib/type-guards";

export const dynamic = "force-dynamic";

const SURFACE = "Model presets";

/** Same gate as Local-only: a live chat may not have its file yet; a dormant
 *  one must resolve through the ownership-checked path lookup. */
async function assertSessionAccess(id: string, request: Request): Promise<NextResponse | null> {
  if (!canAccessSession(id, getRequestUser(request))) return jsonError("Session not found", 404, "session_not_found");
  if (!getRpcSession(id)?.isAlive()) {
    const resolved = await resolveSessionPathOr404(id, request);
    if ("response" in resolved) return resolved.response;
  }
  return null;
}

async function describe(id: string): Promise<SessionPresetResponse> {
  const presetId = readSessionPresetId(id);
  let smartDefault = null;
  try {
    const roster = await loadRoster();
    smartDefault = resolveSmartDefault(presetId ? getPreset(presetId) : null, roster.models);
  } catch {
    // An unreadable config or unavailable roster leaves Smart unresolved.
  }
  return { presetId, smartDefault };
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = requireEngine("omp", SURFACE);
  if ("response" in gate) return gate.response;
  const { id } = await params;
  const access = await assertSessionAccess(id, request);
  if (access) return access;
  return NextResponse.json(await describe(id), { headers: { "Cache-Control": "no-store" } });
}

/**
 * Switch one chat's preset. The chat's engine restarts on the new overlay
 * before its next turn, so the switch is refused while a turn runs — the
 * client holds the pick and sends it again once the run ends. Only this chat
 * changes; the pick also becomes the preset new chats start on.
 */
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = requireEngine("omp", SURFACE);
  if ("response" in gate) return gate.response;
  const { id } = await params;
  const access = await assertSessionAccess(id, request);
  if (access) return access;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON body", 400, "invalid_json");
  }
  if (!isRecord(body) || !(body.presetId === null || typeof body.presetId === "string")) {
    return jsonError("presetId must be a preset id or null", 400, "invalid_preset");
  }
  const presetId = body.presetId as string | null;
  const preset = presetId === null ? null : getPreset(presetId);
  if (presetId !== null && !preset) return jsonError("That preset no longer exists.", 404, "not_found");
  if (preset) {
    let roster;
    try {
      roster = await loadRoster();
    } catch {
      return jsonError("The current model roster is unavailable; retry after the provider catalog loads.", 503, "roster_unavailable");
    }
    const unavailable = unavailablePresetSelection(preset, roster.models);
    if (unavailable) return jsonError(unavailable, 400, "model_unavailable");
  }
  if (getRpcSession(id)?.isRunning()) {
    return jsonError("Finish the current turn before switching presets.", 409, "session_busy");
  }

  const previous = readSessionPresetId(id);
  setSessionPreset(id, presetId);
  let restarted = false;
  try {
    const result = await restartSessionForRouting(id);
    if (result.active && !result.restarted) {
      // A turn started between the check and the restart.
      setSessionPreset(id, previous);
      return jsonError("Finish the current turn before switching presets.", 409, "session_busy");
    }
    restarted = result.restarted;
  } catch (error) {
    if (error instanceof WebRpcError && error.code === "session_restarting") {
      // A routing restart from elsewhere (a concurrent pick, or the deferred
      // turn-end restart) is already in flight. The binding stays: every
      // restart reads it fresh at launch, so that one — or the pending one
      // it re-arms — applies this pick without losing it, same as the
      // busy-turn 409 above.
      return jsonError("A routing restart is already in progress. Retry in a moment.", 409, "session_busy");
    }
    // The chat keeps exactly the settings it had: a switch that did not take
    // effect must not be reported, or silently deferred, as one that did.
    setSessionPreset(id, previous);
    return jsonError(error instanceof Error ? error.message : String(error), 500, "restart_failed");
  }
  setLastUsedPreset(presetId);
  return NextResponse.json({ ...(await describe(id)), restarted } satisfies SessionPresetResponse);
}
