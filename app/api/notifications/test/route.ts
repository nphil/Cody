import { NextResponse } from "next/server";
import { requireUserOrOpenInstance } from "@/lib/auth/http";
import { publishNtfy } from "@/lib/notifications/ntfy";
import { readNotificationPrefs, recipientKeyFor } from "@/lib/notifications/store";

export const dynamic = "force-dynamic";

const noStore = { headers: { "Cache-Control": "no-store" } };

/**
 * `POST` — send "Test from Cody" to the caller's saved server and topic and say
 * how it went: `{ok:true}`, or `{ok:false, error, status?}` with ntfy's own
 * reason (a 403 means the topic wants an access token).
 *
 * It uses what is SAVED, not what the form currently holds, and ignores the
 * master switch: the point is to prove the address works before turning
 * notifications on. A failed test is a normal answer (HTTP 200 with
 * `ok:false`), not an HTTP error — the request itself worked.
 */
export async function POST(request: Request) {
  const actor = requireUserOrOpenInstance(request);
  if ("response" in actor) return actor.response;

  const prefs = readNotificationPrefs(recipientKeyFor(actor.user));
  if (!prefs.server || !prefs.topic) {
    return NextResponse.json({ ok: false, error: "Save an ntfy server and a topic first." }, noStore);
  }
  const result = await publishNtfy(
    { server: prefs.server, topic: prefs.topic, token: prefs.token },
    {
      title: "Test from Cody",
      message: "If you can read this, push notifications from Cody reach this device.",
      priority: 3,
      tags: ["bell"],
      ...(prefs.codyUrl
        ? { click: prefs.codyUrl, actions: [{ action: "view" as const, label: "Open Cody", url: prefs.codyUrl }] }
        : {}),
    },
  );
  return NextResponse.json(result.ok ? { ok: true } : { ok: false, error: result.error, ...(result.status ? { status: result.status } : {}) }, noStore);
}
