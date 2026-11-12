import { NextResponse } from "next/server";
import { jsonError, requireAdminOrOpenInstance } from "@/lib/auth/http";
import { requireEngine } from "@/lib/engine-guard";
import { presetOverlayEquals, sessionsOnPreset, unbindPreset } from "@/lib/model-presets/overlay";
import { presetRosterProblem } from "@/lib/model-presets/roster-check";
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
  const before = getPreset(id);
  // A selector omp cannot resolve is refused here, with its own suggestion,
  // rather than saved and then failing every chat on this preset.
  const unresolved = await presetRosterProblem(body);
  if (unresolved) return jsonError(unresolved, 400, "unknown_model");
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
