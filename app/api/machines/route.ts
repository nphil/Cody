import { NextResponse } from "next/server";
import { jsonError, requireAdminOrOpenInstance, requireUserOrOpenInstance } from "@/lib/auth/http";
import { parseJsonWithinLimit } from "@/lib/bounded-form-data";
import { reconcileMachines } from "@/lib/machines/sampler";
import { findSshBinary } from "@/lib/machines/ssh";
import { listMachineConfigs, MachinesConfigError, updateMachinesConfig } from "@/lib/machines/store";
import type { MachinesPayload, MachinesUpdate } from "@/lib/machines/types";
import { isRecord } from "@/lib/type-guards";

/**
 * The machines the top bar shows meters for (Settings › System › Machines).
 *
 * GET answers the saved list to any signed-in person. An ssh machine's address
 * (`root@192.168.1.5`) is included only for someone who may change the list:
 * a member sees what is being watched, not how to reach it. PUT is admin-only
 * (anyone, on an open instance with no accounts): the list is instance-wide, and
 * every entry in it is a connection this server opens with its own ssh keys.
 */

export const dynamic = "force-dynamic";

const NO_STORE = { headers: { "Cache-Control": "no-store" } };

function answer(canEdit: boolean): NextResponse {
  const machines = listMachineConfigs().map((machine) =>
    canEdit || !machine.destination ? machine : { id: machine.id, kind: machine.kind, name: machine.name },
  );
  const body: MachinesPayload = { machines, canEdit, sshAvailable: findSshBinary() !== null };
  return NextResponse.json(body, NO_STORE);
}

export function GET(request: Request) {
  const resolved = requireUserOrOpenInstance(request);
  if ("response" in resolved) return resolved.response;
  return answer(requireAdminOrOpenInstance(request) === null);
}

export async function PUT(request: Request) {
  const denied = requireAdminOrOpenInstance(request);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await parseJsonWithinLimit<unknown>(request, 16_384);
  } catch {
    return jsonError("Invalid request body", 400, "invalid_request");
  }
  if (!isRecord(body)) return jsonError("Invalid request body", 400, "invalid_request");

  try {
    updateMachinesConfig(body as MachinesUpdate);
  } catch (error) {
    if (error instanceof MachinesConfigError) return jsonError(error.message, 400, error.code);
    throw error;
  }
  // Viewers already watching see the change at once, not at their next reload.
  reconcileMachines();
  return answer(true);
}
