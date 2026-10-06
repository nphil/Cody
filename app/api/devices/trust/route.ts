import { NextResponse } from "next/server";
import { jsonError, requireUserOrOpenInstance } from "@/lib/auth/http";
import { parseJsonWithinLimit } from "@/lib/bounded-form-data";
import {
  InvalidTrustedDeviceError,
  forgetTrustedDevice,
  listTrustedDevices,
  rememberTrustedDevice,
  trustOwnerKeyFor,
} from "@/lib/devices/trust-store";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 4 * 1024;
const MAX_KEY_CHARS = 512;
const noStore = { headers: { "Cache-Control": "no-store" } };

/**
 * `GET` - the devices the signed-in account (the open instance, when there are
 * no accounts) lets the agent control without asking again, newest first. Any
 * credential may read.
 */
export function GET(request: Request) {
  const actor = requireUserOrOpenInstance(request);
  if ("response" in actor) return actor.response;
  return NextResponse.json({ devices: listTrustedDevices(trustOwnerKeyFor(actor.user)) }, noStore);
}

/**
 * `PUT` - remember one device: `{label, vendorId, productId?, serialNumber}`. The
 * key and the time are set here, never taken from the body. An invalid body is a
 * 400 `invalid_trusted_device`. Answers `{devices}`, the list now stored.
 *
 * Trust is only ever given by a person pressing Allow on a page, and a page proves itself with its session
 * cookie. A request carrying an `Authorization` header of ANY scheme is refused before its credentials are even
 * looked at: not a personal access token, not an engine's capability token, and not HTTP Basic with the instance
 * password either - a script or an agent's shell can hold that one, and the person must never find a device
 * trusted that they did not allow.
 */
export async function PUT(request: Request) {
  if (request.headers.has("authorization")) {
    return jsonError("Only the Cody page can remember a device", 403, "page_required");
  }
  const actor = requireUserOrOpenInstance(request);
  if ("response" in actor) return actor.response;

  let body: unknown;
  try {
    body = await parseJsonWithinLimit(request, MAX_BODY_BYTES);
  } catch {
    return jsonError("Invalid request body", 400, "invalid_body");
  }
  try {
    return NextResponse.json({ devices: rememberTrustedDevice(trustOwnerKeyFor(actor.user), body) }, noStore);
  } catch (error) {
    if (error instanceof InvalidTrustedDeviceError) return jsonError(error.message, 400, error.code);
    throw error;
  }
}

/**
 * `DELETE ?key=<key>` - forget one device. Idempotent: a key that is not
 * remembered is not an error. Only the caller's own record is touched. Answers
 * `{devices}`. Removing trust is always allowed; it cannot grant anything.
 */
export function DELETE(request: Request) {
  const actor = requireUserOrOpenInstance(request);
  if ("response" in actor) return actor.response;
  const key = new URL(request.url).searchParams.get("key");
  if (!key || key.length > MAX_KEY_CHARS) return jsonError("A device key is required", 400, "invalid_trusted_device");
  return NextResponse.json({ devices: forgetTrustedDevice(trustOwnerKeyFor(actor.user), key) }, noStore);
}
