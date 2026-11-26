import { NextResponse } from "next/server";
import { parseJsonWithinLimit } from "@/lib/bounded-form-data";
import { verifyDisplayCapability } from "@/lib/display/capability";
import { getDeviceBridge } from "@/lib/devices/bus";
import { DEVICE_OPERATION_TOOLS } from "@/lib/devices/operation-tools";
import { DEVICE_TOOLS, type DeviceToolContext } from "@/lib/devices/tools";
import { getRpcSession } from "@/lib/rpc-manager";
import { isRecord } from "@/lib/type-guards";

export const dynamic = "force-dynamic";

/**
 * A device write carries its payload as base64 in this body, so the cap is a
 * limit on how much an ACP engine can send per call. 16 KB was arbitrary and
 * too small to matter: bulk transfers move in 64 KB chunks (adb's own unit),
 * which base64 to ~87 KB, so every real push failed the cap before reaching
 * a device. 1 MiB matches the RPC frame budget the omp host-tool path gets,
 * so the two callers can send the same thing.
 */
const MAX_INTERNAL_DEVICES_BODY_BYTES = 1024 * 1024;
const NO_STORE = { "Cache-Control": "no-store" };

function invalidResponse(error: string, status = 400) {
  return NextResponse.json({ error }, { status, headers: NO_STORE });
}

export async function POST(request: Request) {
  const authorization = request.headers.get("authorization") ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  let capability = null;
  try {
    capability = verifyDisplayCapability(token);
  } catch {
    // The capability issuer is unavailable until Cody's internal secret exists.
  }
  if (!capability) {
    return NextResponse.json({ error: "Invalid session capability" }, { status: 401, headers: NO_STORE });
  }

  let body: unknown;
  try {
    body = await parseJsonWithinLimit(request, MAX_INTERNAL_DEVICES_BODY_BYTES);
  } catch {
    return invalidResponse("Invalid device request body");
  }
  if (!isRecord(body) || typeof body.sessionId !== "string" || !body.sessionId) {
    return invalidResponse("sessionId is required");
  }
  if (body.sessionId !== capability.sid) {
    return invalidResponse("Session does not match the session capability", 403);
  }
  if (typeof body.tool !== "string" || !body.tool) {
    return invalidResponse("tool is required");
  }
  const toolName = body.tool;
  const tool = [...DEVICE_TOOLS, ...DEVICE_OPERATION_TOOLS].find((candidate) => candidate.name === toolName);
  if (!tool) {
    return invalidResponse("Unknown device tool");
  }
  const toolArgs: Record<string, unknown> = isRecord(body.arguments) ? body.arguments : {};

  // The bridge is keyed by the verified capability's session id, never the
  // request body's — the body already had to match it above, so
  // capability.sid is the only session identity trusted past this point.
  // getDeviceBridge creates the bridge on first touch (bus.ts), so a session
  // whose browser has never attached still resolves to an empty, unattached
  // one rather than a lookup failure.
  const context: DeviceToolContext = {
    bridge: getDeviceBridge(capability.sid),
    cwd: getRpcSession(capability.sid)?.cwd,
    sessionId: capability.sid,
  };

  try {
    const text = await tool.handler(toolArgs, context);
    return NextResponse.json({ text }, { headers: NO_STORE });
  } catch (error) {
    // The handler contract promises plain text, never a throw, but the
    // catch stays anyway — the same defensive fallback the sessions/todo
    // routes keep for whatever the contract does not anticipate.
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500, headers: NO_STORE },
    );
  }
}
