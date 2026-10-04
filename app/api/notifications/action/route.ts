import { answerFromToken } from "@/lib/notifications/answer";
import { parseJsonWithinLimit } from "@/lib/bounded-form-data";
import { getRpcSession } from "@/lib/rpc-manager";
import { isRecord } from "@/lib/type-guards";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 8 * 1024;

/**
 * Where an answer button on a notification posts. PUBLIC (proxy.ts lists it):
 * the ntfy app calls it with no cookie and no Cody login, and the signed,
 * single-use, short-lived token in the body is the only authority — see
 * lib/notifications/answer.ts for everything it is checked against.
 *
 * CORS is open (`*`) because ntfy's WEB app calls it from its own origin and
 * preflights first. That is safe here for the same reason the route is public:
 * no cookie is ever read, so a page that makes this request has no ambient
 * credential to forge — it would need a token, which only the notification has.
 */
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "600",
  "Cache-Control": "no-store",
};

function reply(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: CORS_HEADERS });
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

/**
 * `POST {t: token}` — answer the pending request the token was made for:
 * `200 {ok:true}`; `401 invalid_token` (tampered, expired or already used);
 * `403 forbidden` (the person it was issued to no longer may); `410 gone` (the
 * request is no longer waiting); `503 session_restarting` (try again).
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await parseJsonWithinLimit(request, MAX_BODY_BYTES);
  } catch {
    return reply(400, { error: "Invalid request body", code: "invalid_body" });
  }
  const outcome = await answerFromToken(isRecord(body) ? body.t : undefined, { getSession: getRpcSession });
  return reply(outcome.status, outcome.body);
}
