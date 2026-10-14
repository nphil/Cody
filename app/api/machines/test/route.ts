import { NextResponse } from "next/server";
import { jsonError, requireAdminOrOpenInstance } from "@/lib/auth/http";
import { parseJsonWithinLimit } from "@/lib/bounded-form-data";
import { MachineTestBusyError, testSshMachine } from "@/lib/machines/sampler";
import { MACHINE_FIELD_MESSAGES } from "@/lib/machines/store";
import { checkMachineDestination } from "@/lib/machines/types";
import { isRecord } from "@/lib/type-guards";

/**
 * "Test": connect to an ssh destination and take one real reading.
 *
 * Admin-only (anyone, on an open instance): it makes this server open an ssh
 * connection to an address the caller chose, which is exactly the power adding
 * the machine would give. The destination goes through the same whitelist as a
 * saved one, and the command that runs there is the sampler's fixed loop, never
 * anything from the request.
 *
 * A failed connection is an answer, not a server fault: HTTP 200 with
 * `ok:false` and a reason, so the card can say why in plain words.
 */

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const denied = requireAdminOrOpenInstance(request);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await parseJsonWithinLimit<unknown>(request, 2_048);
  } catch {
    return jsonError("Invalid request body", 400, "invalid_request");
  }
  if (!isRecord(body)) return jsonError("Invalid request body", 400, "invalid_request");

  const destination = checkMachineDestination(body.destination);
  if (!destination.ok) return jsonError(MACHINE_FIELD_MESSAGES[destination.code], 400, destination.code);

  try {
    return NextResponse.json(await testSshMachine(destination.value), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof MachineTestBusyError) return jsonError("Another test is still running. Try again in a moment.", 429, "machine_test_busy");
    throw error;
  }
}
