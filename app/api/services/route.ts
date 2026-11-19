import { NextResponse } from "next/server";
import { jsonError, requireAdminOrOpenInstance } from "@/lib/auth/http";
import { parseJsonWithinLimit } from "@/lib/bounded-form-data";
import { getHarness } from "@/lib/harness";
import { listServices, readServiceBoard, stopLegacyBrokers, stopService, type ServiceRow } from "@/lib/omp/services";
import { isRecord } from "@/lib/type-guards";

/**
 * Settings › System › Services: the background processes the agent started
 * (dev servers, watchers) that keep running after a chat's engine exits.
 *
 * Admin-only (or open on an instance with no accounts), for both reading and
 * stopping: the list shows command lines and folders of every project on the
 * host, and stopping affects everybody. A stop request must name a service that
 * is in the live listing (omp 19: by the daemon's unit id; omp ≤ 18: by name and
 * folder), so the route never passes a caller-chosen folder to the engine.
 * `stopOld` asks the per-project service managers an older engine left running
 * after an in-place engine update to shut down (the new engine cannot list them).
 */

export const dynamic = "force-dynamic";

const NO_STORE = { headers: { "Cache-Control": "no-store" } };

function unsupported(): NextResponse {
  return jsonError("This engine does not list background services.", 404, "unsupported");
}

export async function GET(request: Request) {
  const denied = requireAdminOrOpenInstance(request);
  if (denied) return denied;
  if (getHarness().id !== "omp") return unsupported();
  try {
    return NextResponse.json(await readServiceBoard(), NO_STORE);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : String(error), 502, "services_unavailable");
  }
}

export async function POST(request: Request) {
  const denied = requireAdminOrOpenInstance(request);
  if (denied) return denied;
  if (getHarness().id !== "omp") return unsupported();

  let body: unknown;
  try {
    body = await parseJsonWithinLimit<unknown>(request, 4_096);
  } catch {
    return jsonError("Invalid request body", 400, "invalid_request");
  }
  if (!isRecord(body)) return jsonError("Unknown action", 400, "invalid_request");
  if (body.action === "stopOld") {
    try {
      await stopLegacyBrokers();
      return NextResponse.json(await readServiceBoard(), NO_STORE);
    } catch (error) {
      return jsonError(error instanceof Error ? error.message : String(error), 502, "services_unavailable");
    }
  }
  if ((body.action !== "stop" && body.action !== "kill") || typeof body.name !== "string") {
    return jsonError("Unknown action", 400, "invalid_request");
  }
  const id = typeof body.id === "string" ? body.id : null;
  const projectDir = typeof body.projectDir === "string" ? body.projectDir : null;
  const scope = typeof body.scope === "string" ? body.scope : null;

  try {
    const known = (await listServices()).find((row: ServiceRow) =>
      id !== null
        ? row.id === id
        : row.id === null && row.name === body.name && row.projectDir === projectDir && row.scope === scope,
    );
    if (!known) return jsonError("That service is not running any more.", 404, "service_not_found");
    await stopService(known, body.action);
    return NextResponse.json(await readServiceBoard(), NO_STORE);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : String(error), 502, "services_unavailable");
  }
}
