import { getRequestCredential } from "../auth/guard";
import { jsonError } from "../auth/http";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "../bounded-form-data";
import { isRecord } from "../type-guards";
import { verifiedWirelessOrigin } from "./wireless-origin";
import { wirelessService, WirelessServiceError, type WirelessService } from "./wireless-service";
import type { WirelessAction, WirelessShellAction } from "./wireless-types";

const noStore = { headers: { "Cache-Control": "no-store" } };
const MAX_BODY_BYTES = 8 * 1024;
type PageService = Pick<WirelessService, "pageAction" | "pageSnapshot" | "pageShell">;

function pageOwner(request: Request): string | Response {
  // Do not fall back to API, engine capability, Basic, or anonymous/open-instance credentials.
  if (request.headers.has("authorization")) return jsonError("Use the signed-in Cody page to control wireless ADB.", 403, "page_required");
  const expected = verifiedWirelessOrigin(request);
  if (!expected) {
    return jsonError("Wireless ADB needs direct loopback or verified HTTPS. Behind a reverse proxy, set CODY_PUBLIC_ORIGIN and CODY_TRUSTED_PROXY_IP on Cody (see the README’s Security notes).", 403, "secure_origin_required");
  }
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  // Next's URL and forwarded headers are not proof of HTTPS. Compare the browser Origin with the launcher's proof.
  if ((fetchSite !== null && fetchSite !== "same-origin")
    || (origin === null ? request.method !== "GET" || fetchSite !== "same-origin" : origin !== expected)) {
    return jsonError("Open the Devices panel on the same Cody page to control wireless ADB.", 403, "page_required");
  }
  const credential = getRequestCredential(request);
  return credential?.kind === "cookie" ? credential.user.id : jsonError("Sign in to Cody to use wireless ADB.", 401, "auth_required");
}

function session(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 160) throw new WirelessServiceError("invalid_body", "Choose a chat for wireless ADB.", 400);
  return value;
}

function invalid(): never {
  throw new WirelessServiceError("invalid_body", "The wireless ADB request was not recognized.", 400);
}

function version(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value)) invalid();
  return value;
}

async function body(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") invalid();
  let raw: unknown;
  try { raw = await parseJsonWithinLimit(request, MAX_BODY_BYTES); }
  catch (error) {
    if (error instanceof RequestBodyTooLargeError) throw new WirelessServiceError("request_too_large", "The wireless ADB request is too large.", 413);
    invalid();
  }
  if (!isRecord(raw)) invalid();
  return raw;
}

function action(raw: Record<string, unknown>): WirelessAction {
  const sessionId = session(raw.sessionId);
  if (raw.action === "pair") {
    const { host, pairingPort, connectPort, code } = raw;
    if (typeof host !== "string" || typeof pairingPort !== "number" || typeof connectPort !== "number" || typeof code !== "string") invalid();
    return { action: "pair", sessionId, host, pairingPort, connectPort, code };
  }
  const selection = { sessionId, selectionId: version(raw.selectionId) };
  switch (raw.action) {
    case "connect": {
      const { host, connectPort } = raw;
      if ((host !== undefined && typeof host !== "string") || (connectPort !== undefined && typeof connectPort !== "number")) invalid();
      return { action: "connect", ...selection, host, connectPort };
    }
    case "disconnect": return { action: "disconnect", ...selection };
    case "forget": return { action: "forget", ...selection };
    case "root": {
      const { requestId, decision } = raw;
      if (decision !== "approve" && decision !== "deny") invalid();
      return { action: "root", ...selection, requestId: version(requestId), decision };
    }
    default: return invalid();
  }
}

function failure(error: unknown): Response {
  return error instanceof WirelessServiceError
    ? jsonError(error.message, error.status, error.code)
    : jsonError("Cody could not complete the wireless ADB request.", 500, "server_error");
}

export function handleWirelessGet(request: Request, service?: PageService): Response {
  const owner = pageOwner(request);
  if (typeof owner !== "string") return owner;
  try {
    const sessionId = session(new URL(request.url).searchParams.get("sessionId"));
    return Response.json((service ?? wirelessService()).pageSnapshot(owner, sessionId), noStore);
  } catch (error) { return failure(error); }
}

export async function handleWirelessPost(request: Request, service?: PageService): Promise<Response> {
  const owner = pageOwner(request);
  if (typeof owner !== "string") return owner;
  try {
    const input = action(await body(request));
    // This is the only path carrying an Android pairing code. It never enters a URL or an engine/tool frame.
    return Response.json(await (service ?? wirelessService()).pageAction(owner, input, request.signal), noStore);
  } catch (error) { return failure(error); }
}

export async function handleWirelessShell(request: Request, service?: PageService): Promise<Response> {
  const owner = pageOwner(request);
  if (typeof owner !== "string") return owner;
  try {
    const raw = await body(request);
    if (typeof raw.command !== "string" || Object.keys(raw).some((key) => !["command", "sessionId", "selectionId", "rootCapableConfirmed"].includes(key))) invalid();
    if (raw.rootCapableConfirmed !== true) {
      throw new WirelessServiceError("command_confirmation_required", "Review and confirm the exact command; it can request root.", 400);
    }
    const input: WirelessShellAction = { sessionId: session(raw.sessionId), selectionId: version(raw.selectionId), command: raw.command, rootCapableConfirmed: true };
    const { stdout, stderr, exitCode } = await (service ?? wirelessService()).pageShell(owner, input, request.signal);
    return Response.json({ exitCode, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8") }, noStore);
  } catch (error) { return failure(error); }
}
