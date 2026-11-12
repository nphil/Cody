import { NextResponse } from "next/server";
import { jsonError, requireAdminOrOpenInstance } from "@/lib/auth/http";
import { parseJsonWithinLimit } from "@/lib/bounded-form-data";
import { isRecord } from "@/lib/type-guards";
import { checkWorkerMachine, WorkerCheckBusyError, WorkerCheckUnknownError } from "@/lib/workers/health";

/**
 * The "Check" button next to "Use as worker": read /etc/cody-worker.json of one
 * saved ssh machine over ssh, keep what it says about itself (arch, cores,
 * memory, tools, slots) and answer with the result.
 *
 * Admin-only (anyone, on an open instance), like the rest of the list: it makes
 * this server open an ssh connection. The machine is named by its id and must
 * be one of the saved ssh machines; the destination and the command both come
 * from the server, never from the request.
 *
 * A machine that cannot be reached, or that has no worker file, is an answer
 * (HTTP 200 with `ok:false`, a reason and ssh's own first line), not a fault.
 */

export const dynamic = "force-dynamic";

const MAX_ID_LENGTH = 64;

export async function POST(request: Request) {
  const denied = requireAdminOrOpenInstance(request);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await parseJsonWithinLimit<unknown>(request, 1_024);
  } catch {
    return jsonError("Invalid request body", 400, "invalid_request");
  }
  if (!isRecord(body) || typeof body.id !== "string" || !body.id || body.id.length > MAX_ID_LENGTH) {
    return jsonError("Invalid request body", 400, "invalid_request");
  }

  try {
    return NextResponse.json(await checkWorkerMachine(body.id), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof WorkerCheckUnknownError) return jsonError("That machine is not in the list.", 404, "machine_unknown");
    if (error instanceof WorkerCheckBusyError) return jsonError("Another worker check is still running. Try again in a moment.", 429, "worker_check_busy");
    throw error;
  }
}
