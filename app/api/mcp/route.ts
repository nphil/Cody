import { NextResponse } from "next/server";
import { jsonError, requireCredential } from "@/lib/auth/http";
import { requireCapability } from "@/lib/engine-guard";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { maskMcpSecrets } from "@/lib/mcp-secrets";
import { deleteMcpServer, parseMcpListOutput, readDiscoveredMcpServers, readMcpConfig, readUserMcpConfig, setUserServerDisabled, type McpLiveServer, type McpScope, validateMcpServer, writeMcpServer } from "@/lib/omp/mcp-config";
import { computerIsOnDemand } from "@/lib/omp/on-demand-chats";
import { deleteOnDemandServer, getOnDemandRegistryPath, readOnDemandServers, setServerOnDemand, writeOnDemandServer } from "@/lib/omp/on-demand-mcp";
import { getOmpSettingsSchema } from "@/lib/omp/settings-schema";
import { writeSchemaSettings } from "@/lib/omp/settings-values";
import { readSessionHeader, resolveSessionPath } from "@/lib/session-reader";
import { AgentSessionWrapper, getRpcSession, resolveSpawnCwd, startRpcSession } from "@/lib/rpc-manager";

export const dynamic = "force-dynamic";

function mergeMcpServers(primary: McpLiveServer[], secondary: McpLiveServer[]): McpLiveServer[] {
  const result = [...primary];
  const seen = new Set(primary.map((server) => `${server.source}:${server.name}`));
  for (const server of secondary) {
    const key = `${server.source}:${server.name}`;
    if (!seen.has(key)) result.push(server);
  }
  return result;
}

/** What a server definition is and whether it can run: the same reading for a
 * user-level row and a registry row. */
function serverKind(config: Record<string, unknown>): { type: string; valid: boolean } {
  const type = typeof config.type === "string" && config.type !== "stdio" ? config.type
    : typeof config.url === "string" ? "http" : "stdio";
  const command = typeof config.command === "string" ? config.command.trim() : "";
  const url = typeof config.url === "string" ? config.url.trim() : "";
  const hasCommand = command.length > 0;
  const hasUrl = url.length > 0;
  return { type, valid: (hasCommand || hasUrl) && !(hasCommand && hasUrl) && (type === "http" || type === "sse" ? hasUrl : hasCommand) };
}

async function allowedCwd(cwd: unknown): Promise<string> {
  if (typeof cwd !== "string" || !cwd.trim()) throw new Error("cwd is required");
  const allowedRoots = await getAllowedFileRoots();
  if (!isExistingFilePathAllowed(cwd, allowedRoots)) throw new Error("Workspace is not allowed");
  return cwd;
}

/** Which config a mutation targets. Absent means "project", so every caller
 * written before user-level editing existed keeps its meaning. */
function requestedScope(scope: unknown): McpScope {
  if (scope === undefined || scope === "project") return "project";
  if (scope === "user") return "user";
  throw new Error('scope must be "user" or "project"');
}

/** User-level servers belong to the INSTANCE: every session loads them, and a
 * stdio entry there is a command that runs in everyone's sessions — so
 * managing them is an administrator's job, not any signed-in member's. Their
 * `url` is not maskable either (an ha-mcp webhook URL IS the credential), so
 * the full config is served only to an admin; everyone else keeps the
 * name/status view this route has always shown. Project scope stays open: that
 * file lives in a workspace its user can already read and write.
 *
 * "No accounts exist yet" (`requireCredential` → 409) is the open-instance
 * case, not a missing permission — the same exception `/api/models/seen`
 * makes, since the viewer there IS the administrator.
 */
function userScopeDenied(request: Request): NextResponse | null {
  const resolved = requireCredential(request);
  if ("response" in resolved) return resolved.response.status === 409 ? null : resolved.response;
  if (resolved.credential.user.role !== "admin") return jsonError("Administrator access required", 403, "admin_required");
  return null;
}

export async function GET(request: Request) {
  try {
    // omp's mcp.json conventions (project + user level). The MCP editor is
    // hidden client-side on engines that report `capabilities.mcp` false; the
    // route says the same thing, so a direct call cannot read or write omp's
    // config behind another engine.
    const gate = requireCapability("mcp", "MCP server management");
    if ("response" in gate) return gate.response;
    const params = new URL(request.url).searchParams;
    const requestedCwd = params.get("cwd");
    const cwd = requestedCwd ? await allowedCwd(requestedCwd) : null;
    const file = cwd ? readMcpConfig(cwd) : null;
    const user = readUserMcpConfig();
    const denied = new Set(user.disabledServers);
    const userNames = new Set(user.servers.map(({ name }) => name));
    const inventory: McpLiveServer[] = [
      ...user.servers.map(({ name, config }) => ({ name, source: "User level", status: denied.has(name) || config.enabled === false ? "disabled" as const : "configured" as const, type: typeof config.type === "string" ? config.type : typeof config.url === "string" ? "http" : "stdio" })),
      // A denied name that is NOT one of the user's own servers is a
      // suppressed project or discovered server; the user's own already
      // carries its state on its row above.
      ...user.disabledServers.filter((name) => !userNames.has(name)).map((name) => ({ name, source: "Disabled", status: "disabled" as const })),
      ...Object.entries(file?.config.mcpServers ?? {}).map(([name, config]) => ({ name, source: "Project level", status: denied.has(name) || config.enabled === false ? "disabled" as const : "configured" as const, type: typeof config.type === "string" ? config.type : typeof config.url === "string" ? "http" : "stdio" })),
      ...readDiscoveredMcpServers(cwd ?? undefined, user.disabledServers),
    ];
    // The user-level config may carry bearer tokens/API keys in `headers` and
    // credentials in `env`. Those values never reach the browser: the config
    // travels with every `headers`/`env` value replaced by a sentinel, which a
    // save merges back from disk (lib/mcp-secrets.ts). The project file is
    // sent raw — it lives in the repository the user can already read.
    //
    // The rest of a user-level entry is admin-only (`userScopeDenied`): a
    // `url` cannot be masked and can itself be the credential, and only an
    // admin may edit these anyway, so a member gets the name/status view.
    const canManageUser = userScopeDenied(request) === null;
    const safeUser = {
      path: user.path,
      disabledServers: user.disabledServers,
      error: user.error,
      servers: user.servers.map(({ name, config }) => {
        const { type, valid } = serverKind(config);
        const disabled = denied.has(name);
        return {
          name,
          status: disabled || config.enabled === false ? ("disabled" as const) : ("configured" as const),
          type,
          enabled: !disabled && config.enabled !== false,
          disabled,
          valid,
          ...(canManageUser ? { config: maskMcpSecrets(config) } : {}),
        };
      }),
    };
    // The "Load on demand" registry follows the same masking rule as the user
    // file above: names, type and purpose for everyone, the (masked) config
    // only for an admin. A registry entry the extension cannot use is reported
    // in `problems` and stays in the file.
    const registry = readOnDemandServers();
    const onDemand = {
      path: registry.path,
      servers: registry.servers.map(({ name, config, purpose }) => ({
        name,
        ...serverKind(config),
        purpose,
        ...(canManageUser ? { config: maskMcpSecrets(config) } : {}),
      })),
      problems: registry.problems,
      // Desktop control is an omp setting (`computer.enabled`), not a server: only an engine whose settings schema declares it can switch it.
      computer: { onDemand: computerIsOnDemand(), supported: getOmpSettingsSchema()?.settings.some((setting) => setting.key === "computer.enabled") ?? false },
    };
    const sessionId = params.get("sessionId");
    let liveServers: ReturnType<typeof parseMcpListOutput> | undefined;
    let liveError: string | undefined;
    if (sessionId) {
      try {
        let session = getRpcSession(sessionId);
        if (!session?.isAlive()) {
          const sessionFile = await resolveSessionPath(sessionId);
          if (!sessionFile) throw new Error("Session not found");
          ({ session } = await startRpcSession(sessionId, sessionFile, resolveSpawnCwd(readSessionHeader(sessionFile)?.cwd)));
        }
        // `/mcp list` is an omp-protocol command; a session driven by another
        // engine has no equivalent (its adapter reports capabilities.mcp
        // false, so the UI hides this surface anyway).
        if (!(session instanceof AgentSessionWrapper)) {
          throw new Error("Live MCP inventory is not supported by the active engine");
        }
        liveServers = mergeMcpServers(parseMcpListOutput(await session.getMcpList()), inventory);
      } catch (error) {
        liveError = error instanceof Error ? error.message : String(error);
      }
    }
    return NextResponse.json({ root: file?.root ?? null, path: file?.path ?? null, exists: file?.exists ?? false, servers: Object.entries(file?.config.mcpServers ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([name, config]) => ({ name, config })), user: safeUser, onDemand, canManageUser, inventory, liveServers, liveError });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}

export async function POST(request: Request) {
  try {
    // omp's mcp.json conventions (project + user level). The MCP editor is
    // hidden client-side on engines that report `capabilities.mcp` false; the
    // route says the same thing, so a direct call cannot read or write omp's
    // config behind another engine.
    const gate = requireCapability("mcp", "MCP server management");
    if ("response" in gate) return gate.response;
    const body = await request.json() as { cwd?: unknown; scope?: unknown; name?: unknown; previousName?: unknown; server?: unknown; onDemand?: unknown; purpose?: unknown };
    const scope = requestedScope(body.scope);
    if (body.onDemand !== undefined && typeof body.onDemand !== "boolean") throw new Error("onDemand must be true or false");
    if (body.onDemand === true && scope !== "user") throw new Error("Load on demand applies to user-level servers");
    if (scope === "user") {
      const denied = userScopeDenied(request);
      if (denied) return denied;
    }
    // A user-level server belongs to no project, so it is written with no
    // workspace at all; only a project write is checked against the roots.
    const cwd = scope === "project" ? await allowedCwd(body.cwd) : undefined;
    validateMcpServer(body.name, body.server);
    if (body.previousName !== undefined && typeof body.previousName !== "string") throw new Error("previousName must be a string");
    if (body.onDemand === true) {
      if (body.purpose !== undefined && typeof body.purpose !== "string") throw new Error("purpose must be a string");
      writeOnDemandServer(body.name as string, body.server, body.purpose, body.previousName);
      return NextResponse.json({ success: true, scope, onDemand: true, path: getOnDemandRegistryPath() });
    }
    return NextResponse.json({ success: true, ...writeMcpServer({ scope, cwd }, body.name as string, body.server, body.previousName) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}

export async function PUT(request: Request) {
  try {
    // omp's mcp.json conventions (project + user level). The MCP editor is
    // hidden client-side on engines that report `capabilities.mcp` false; the
    // route says the same thing, so a direct call cannot read or write omp's
    // config behind another engine.
    const gate = requireCapability("mcp", "MCP server management");
    if ("response" in gate) return gate.response;
    const body = await request.json() as { action?: unknown; scope?: unknown; name?: unknown; server?: unknown; onDemand?: unknown; purpose?: unknown };
    // With an action this changes how a server (or desktop control) loads;
    // without one it stays the validate-only check the editor's "Check"
    // button calls.
    if (body.action !== undefined) {
      if (body.action === "computer") {
        // An instance setting (config.yml), so an administrator's call.
        const denied = userScopeDenied(request);
        if (denied) return denied;
        if (typeof body.onDemand !== "boolean") throw new Error("onDemand must be true or false");
        if (!getOmpSettingsSchema()?.settings.some((setting) => setting.key === "computer.enabled")) throw new Error("This engine has no desktop control, so there is nothing to load on demand");
        // On demand means "not on for every chat": `computer.enabled` false.
        writeSchemaSettings({ "computer.enabled": !body.onDemand });
        return NextResponse.json({ success: true, computer: { onDemand: computerIsOnDemand() } });
      }
      if (body.action !== "enable" && body.action !== "disable" && body.action !== "ondemand") throw new Error('action must be "enable", "disable", "ondemand" or "computer"');
      if (requestedScope(body.scope) !== "user") throw new Error("Enabling, disabling and loading on demand apply to user-level servers");
      const denied = userScopeDenied(request);
      if (denied) return denied;
      if (typeof body.name !== "string") throw new Error("name is required");
      if (body.action === "ondemand") {
        if (typeof body.onDemand !== "boolean") throw new Error("onDemand must be true or false");
        if (body.purpose !== undefined && typeof body.purpose !== "string") throw new Error("purpose must be a string");
        setServerOnDemand(body.name, body.onDemand, body.purpose);
        return NextResponse.json({ success: true, onDemand: body.onDemand, path: getOnDemandRegistryPath() });
      }
      return NextResponse.json({ success: true, ...setUserServerDisabled(body.name, body.action === "disable") });
    }
    validateMcpServer(body.name, body.server);
    return NextResponse.json({ success: true, message: "MCP server configuration is valid" });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}

export async function DELETE(request: Request) {
  try {
    // omp's mcp.json conventions (project + user level). The MCP editor is
    // hidden client-side on engines that report `capabilities.mcp` false; the
    // route says the same thing, so a direct call cannot read or write omp's
    // config behind another engine.
    const gate = requireCapability("mcp", "MCP server management");
    if ("response" in gate) return gate.response;
    const body = await request.json() as { cwd?: unknown; scope?: unknown; name?: unknown; onDemand?: unknown };
    const scope = requestedScope(body.scope);
    if (body.onDemand !== undefined && typeof body.onDemand !== "boolean") throw new Error("onDemand must be true or false");
    if (body.onDemand === true && scope !== "user") throw new Error("Load on demand applies to user-level servers");
    if (scope === "user") {
      const denied = userScopeDenied(request);
      if (denied) return denied;
    }
    const cwd = scope === "project" ? await allowedCwd(body.cwd) : undefined;
    if (typeof body.name !== "string") throw new Error("name is required");
    if (body.onDemand === true) {
      deleteOnDemandServer(body.name);
      return NextResponse.json({ success: true, scope, onDemand: true, path: getOnDemandRegistryPath() });
    }
    return NextResponse.json({ success: true, ...deleteMcpServer({ scope, cwd }, body.name) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
