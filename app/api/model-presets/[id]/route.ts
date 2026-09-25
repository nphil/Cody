import { NextResponse } from "next/server";
import { jsonError, requireAdminOrOpenInstance } from "@/lib/auth/http";
import { requireEngine } from "@/lib/engine-guard";
import { loadRoster } from "@/lib/model-plan/roster";
import { unavailablePresetSelection } from "@/lib/model-presets/availability";
import { presetOverlayEquals, sessionsOnPreset, unbindPreset } from "@/lib/model-presets/overlay";
import { deletePreset, getPreset, PresetValidationError, updatePreset } from "@/lib/model-presets/store";
import type { ModelPresetUpdate } from "@/lib/model-presets/types";
import { restartSessionForRoutingWhenIdle } from "@/lib/rpc-manager";
import { isRecord } from "@/lib/type-guards";

export const dynamic = "force-dynamic";

const SURFACE = "Model presets";

function validationResponse(error: unknown): NextResponse {
  if (error instanceof PresetValidationError) return jsonError(error.message, error.code === "not_found" ? 404 : 400, error.code);
  return jsonError(error instanceof Error ? error.message : String(error), 500);
}

/** Move the chats bound to a changed preset onto it: idle ones restart now;
 *  one mid-turn restarts the moment that turn ends, so nothing is killed
 *  mid-run and nothing stays on stale settings. `active` counts the latter. */
async function restartBoundSessions(sessionIds: string[]): Promise<{ restarted: number; active: number }> {
  let restarted = 0;
  let active = 0;
  for (const sessionId of sessionIds) {
    try {
      const result = await restartSessionForRoutingWhenIdle(sessionId);
      if (result.restarted) restarted += 1;
      if (result.active) active += 1;
    } catch {
      // One chat failing to restart must not fail the save that caused it.
    }
  }
  return { restarted, active };
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = requireEngine("omp", SURFACE);
  if ("response" in gate) return gate.response;
  const denied = requireAdminOrOpenInstance(request);
  if (denied) return denied;
  const { id } = await params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON body", 400, "invalid_json");
  }
  if (!isRecord(body)) return jsonError("Body must be an object", 400, "invalid_preset");
  if (body.roles !== undefined || body.chains !== undefined) {
    let roster;
    try {
      roster = await loadRoster();
    } catch {
      return jsonError("The current model roster is unavailable; retry after the provider catalog loads.", 503, "roster_unavailable");
    }
    const unavailable = unavailablePresetSelection({ roles: body.roles, chains: body.chains }, roster.models);
    if (unavailable) return jsonError(unavailable, 400, "model_unavailable");
  }
  const before = getPreset(id);
  let preset;
  try {
    preset = updatePreset(id, body as ModelPresetUpdate);
  } catch (error) {
    return validationResponse(error);
  }
  // A name/intent/research-stamp-only edit changes none of what the overlay
  // actually materializes: restarting every bound chat for that would be
  // exactly the queued-restart-with-no-reason this compare exists to skip.
  const { restarted, active } = presetOverlayEquals(before, preset)
    ? { restarted: 0, active: 0 }
    : await restartBoundSessions(sessionsOnPreset(id));
  return NextResponse.json({ preset, restarted, active });
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = requireEngine("omp", SURFACE);
  if ("response" in gate) return gate.response;
  const denied = requireAdminOrOpenInstance(request);
  if (denied) return denied;
  const { id } = await params;
  const bound = sessionsOnPreset(id);
  try {
    deletePreset(id);
  } catch (error) {
    return validationResponse(error);
  }
  // Its chats go back to base settings, and the idle ones restart onto base.
  const reassigned = unbindPreset(id);
  await restartBoundSessions(bound);
  return NextResponse.json({ ok: true, reassigned });
}
