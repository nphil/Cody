import { NextResponse } from "next/server";
import { isAgentName, writableAgentModelSelector } from "@/lib/agent-model-selector";
import { agentCommandErrorResponse, resolveSessionPathOr404 } from "@/lib/api-utils";
import { parseJsonWithinLimit } from "@/lib/bounded-form-data";
import { recordEngineCrash } from "@/lib/engine-crash-log";
import { requireEngine } from "@/lib/engine-guard";
import { setAgentModelOverride } from "@/lib/omp/agent-model-overrides";
import { SPAWN_HOOK_SINCE } from "@/lib/omp/agent-roster";
import { switchHelper, type SwitchOutcome } from "@/lib/omp/agent-switch";
import { getOmpVersion, versionAtLeast } from "@/lib/omp/omp-cli";
import { readModelRoles } from "@/lib/omp/model-roles";
import { RpcCommandError } from "@/lib/omp/rpc-process";
import { getRpcSession } from "@/lib/rpc-manager";
import { ownerTimeZone } from "@/lib/time-zone-prefs";
import { isRecord } from "@/lib/type-guards";

export const dynamic = "force-dynamic";

const SURFACE = "Changing a helper's model";
const MAX_BODY_BYTES = 8 * 1024;
/** How long to wait for the engine to answer one command of the switch. */
const SEND_BOUND_MS = 20_000;
const MAX_ID_CHARS = 200;
const MAX_PATH_CHARS = 600;

const FAILURE_TEXT: Record<Extract<SwitchOutcome, { ok: false }>["code"], string> = {
  already_finished: "That helper had already finished, so nothing was stopped.",
  needs_setting: "This omp cannot move a single helper on its own; save the choice as the setting for this kind of helper instead.",
  no_scratch: "This chat has no scratch folder to keep the one-time choice in.",
};

/** One short line of text from the page, or null when it is empty, too long or spans lines. */
function plainText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text !== "" && text.length <= max && !/\p{Cc}/u.test(text) ? text : null;
}

// POST /api/agent/[id]/switch-helper
// Body: { subagentId, agent, model, alsoFuture, transcriptPath? }
// Moves one RUNNING helper of this chat to another model by restarting it: the
// helper is stopped, the main agent is told to start it again, and the new one
// starts on `model` (a role such as "@slow" or one "provider/model"). With
// `alsoFuture` the choice is also saved as the setting for every later helper
// of that kind; without it, it applies to the next one only (lib/omp/agent-switch.ts).
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const gate = requireEngine("omp", SURFACE);
    if ("response" in gate) return gate.response;
    const resolved = await resolveSessionPathOr404(id, request);
    if ("response" in resolved) return resolved.response;
    const session = getRpcSession(id);
    if (!session?.isAlive()) {
      return NextResponse.json({ error: "This chat is not running, so there is no helper to move.", code: "session_not_running" }, { status: 409 });
    }

    const body = await parseJsonWithinLimit<unknown>(request, MAX_BODY_BYTES);
    const fields = isRecord(body) ? body : {};
    const subagentId = plainText(fields.subagentId, MAX_ID_CHARS);
    const agent = typeof fields.agent === "string" ? fields.agent.trim() : "";
    const selector = writableAgentModelSelector(fields.model);
    if (subagentId === null || !isAgentName(agent) || selector === null || typeof fields.alsoFuture !== "boolean") {
      return NextResponse.json({ error: "subagentId, agent, model (a role or provider/model) and alsoFuture are required", code: "invalid_request" }, { status: 400 });
    }
    const transcriptPath = plainText(fields.transcriptPath, MAX_PATH_CHARS);

    const roles = readModelRoles().roles;
    const outcome = await switchHelper(
      session,
      { subagentId, agent, selector, alsoFuture: fields.alsoFuture, ...(transcriptPath ? { transcriptPath } : {}) },
      {
        now: Date.now,
        zoneFor: ownerTimeZone,
        roleModel: (role) => roles[role],
        setOverride: setAgentModelOverride,
        record: recordEngineCrash,
        sendBoundMs: SEND_BOUND_MS,
        canSwitchOnce: versionAtLeast(await getOmpVersion(), SPAWN_HOOK_SINCE),
      },
    );
    if (!outcome.ok) {
      return NextResponse.json({ error: FAILURE_TEXT[outcome.code], code: outcome.code, settingSaved: outcome.settingSaved }, { status: 409 });
    }
    return NextResponse.json(outcome);
  } catch (error) {
    // omp too old to know `cancel_subagent` answers "Unknown command": the page hides the control for it, and says so here as well.
    if (error instanceof RpcCommandError) {
      return NextResponse.json({ error: error.message, code: error.code ?? "rpc_command_failed" }, { status: 400 });
    }
    return agentCommandErrorResponse(error);
  }
}
