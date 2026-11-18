import { NextResponse } from "next/server";
import { isAgentName, writableAgentModelSelector } from "@/lib/agent-model-selector";
import { apiErrorResponse } from "@/lib/api-utils";
import { parseJsonWithinLimit } from "@/lib/bounded-form-data";
import { requireEngine } from "@/lib/engine-guard";
import { buildHelperRoster } from "@/lib/helper-agents";
import { readAgentModelOverrideEntries, setAgentModelOverride } from "@/lib/omp/agent-model-overrides";
import { discoverAgentDefinitions, SPAWN_HOOK_SINCE } from "@/lib/omp/agent-roster";
import { versionAtLeast } from "@/lib/omp/omp-cli";
import { loadProjectRegistry, mergeProjects } from "@/lib/project-registry";
import { DEFAULT_AGENT_ROLES } from "@/lib/routing/agent-roles";
import { listAllSessions } from "@/lib/session-reader";
import { isRecord } from "@/lib/type-guards";

export const dynamic = "force-dynamic";

/**
 * Helper agents are omp's own subagents: its agent files and the
 * `task.agentModelOverrides` setting in its config.yml. Another engine has
 * neither, so it gets `unsupported` rather than omp's list.
 */
const SURFACE = "Helper agents";

/** The folders chats start in: registered projects plus the ones sessions came from, like the project list. */
async function projectRoots(): Promise<string[]> {
  const discovered = (await listAllSessions())
    .map((session) => session.projectRoot ?? session.cwd)
    .filter((path): path is string => Boolean(path));
  return mergeProjects(loadProjectRegistry(), discovered).map((project) => project.path);
}

// GET /api/omp-agents → { agents, bundledError, engineVersion, canSwitchOnce }
// One row per agent name omp can start (its built-in agents, the user folder's,
// each project's), with the model setting Cody holds for it and what the agent
// files themselves choose. `canSwitchOnce`: this omp tells extensions before a
// helper starts, which is what lets one respawn use another model without a
// permanent setting.
export async function GET() {
  try {
    const gate = requireEngine("omp", SURFACE);
    if ("response" in gate) return gate.response;
    const { definitions, bundledError, engineVersion } = await discoverAgentDefinitions(await projectRoots());
    const agents = buildHelperRoster(definitions, readAgentModelOverrideEntries(), DEFAULT_AGENT_ROLES);
    return NextResponse.json({ agents, bundledError, engineVersion, canSwitchOnce: versionAtLeast(engineVersion, SPAWN_HOOK_SINCE) });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

// PUT /api/omp-agents  Body: { agent, model } → { ok: true }
// `model` is a role alias ("@slow"), one exact "provider/model", or null to
// remove the setting (the agent file's own `model:` applies again). Takes effect
// for helpers that start after the write: omp reads the setting on every spawn.
export async function PUT(request: Request) {
  try {
    const gate = requireEngine("omp", SURFACE);
    if ("response" in gate) return gate.response;
    const body = await parseJsonWithinLimit<unknown>(request, 4 * 1024);
    const agent = isRecord(body) && typeof body.agent === "string" ? body.agent.trim() : "";
    const model = isRecord(body) ? body.model : undefined;
    if (!isAgentName(agent)) {
      return NextResponse.json({ error: "agent is not a valid agent name", code: "agent_invalid" }, { status: 400 });
    }
    if (model !== null && (typeof model !== "string" || writableAgentModelSelector(model) === null)) {
      return NextResponse.json({ error: "model must be a role such as @slow, one provider/model, or null", code: "model_invalid" }, { status: 400 });
    }
    setAgentModelOverride(agent, model);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
