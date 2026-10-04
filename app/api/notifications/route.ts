import { NextResponse } from "next/server";
import { jsonError, requireUserOrOpenInstance } from "@/lib/auth/http";
import { parseJsonWithinLimit } from "@/lib/bounded-form-data";
import { defaultNotificationPrefs } from "@/lib/notifications/catalog";
import {
  InvalidNotificationSettingsError,
  readNotificationPrefs,
  recipientKeyFor,
  toPublicPrefs,
  updateNotificationPrefs,
} from "@/lib/notifications/store";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 8 * 1024;
const noStore = { headers: { "Cache-Control": "no-store" } };

/**
 * `GET` — the signed-in account's own push-notification settings (the open
 * instance's, when there are no accounts), with the ntfy access token reduced
 * to `hasToken`: it is write-only, and nothing here ever sends it back.
 * `defaults` is what "Reset" would restore.
 */
export function GET(request: Request) {
  const actor = requireUserOrOpenInstance(request);
  if ("response" in actor) return actor.response;
  return NextResponse.json(
    {
      prefs: toPublicPrefs(readNotificationPrefs(recipientKeyFor(actor.user))),
      defaults: toPublicPrefs(defaultNotificationPrefs()),
    },
    noStore,
  );
}

/**
 * `PUT` — change any subset of the settings (lib/notifications/catalog.ts
 * `NotificationPrefsPatch`). `token`: a string stores it, `null` clears it,
 * absent keeps it. Anything invalid is a 400 `invalid_notification_settings`
 * and nothing is saved. Answers `{prefs}`, the saved record.
 */
export async function PUT(request: Request) {
  const actor = requireUserOrOpenInstance(request);
  if ("response" in actor) return actor.response;

  let body: unknown;
  try {
    body = await parseJsonWithinLimit(request, MAX_BODY_BYTES);
  } catch {
    return jsonError("Invalid request body", 400, "invalid_body");
  }
  try {
    const saved = updateNotificationPrefs(recipientKeyFor(actor.user), body);
    return NextResponse.json({ prefs: toPublicPrefs(saved) }, noStore);
  } catch (error) {
    if (error instanceof InvalidNotificationSettingsError) return jsonError(error.message, 400, error.code);
    throw error;
  }
}
