import { NextResponse } from "next/server";
import { parseJsonWithinLimit } from "@/lib/bounded-form-data";
import { jsonError, requireUser } from "@/lib/auth/http";
import { MAX_FULL_NAME_LENGTH, toPublicUser, updateUser } from "@/lib/auth/users";
import { isThemeId } from "@/lib/theme-catalog";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  const resolved = requireUser(request);
  if ("response" in resolved) return resolved.response;
  return NextResponse.json({ user: toPublicUser(resolved.user) }, { headers: { "Cache-Control": "no-store" } });
}

/** Profile fields the account edits about itself. Username is identity and
 * stays fixed; role changes go through the admin routes. Each field is
 * optional and applied only when sent, so the profile form and the theme
 * picker can each save their one field without knowing about the other. */
export async function PATCH(request: Request) {
  const resolved = requireUser(request);
  if ("response" in resolved) return resolved.response;

  let body: { fullName?: unknown; theme?: unknown };
  try {
    body = await parseJsonWithinLimit(request, 4_096);
  } catch {
    return jsonError("Invalid request body", 400);
  }
  const hasFullName = body.fullName !== undefined;
  const hasTheme = body.theme !== undefined;
  if (!hasFullName && !hasTheme) return jsonError("Nothing to update", 400);
  if (hasFullName && (typeof body.fullName !== "string" || !body.fullName.trim())) {
    return jsonError("Full name is required", 400);
  }
  // The id is checked against the catalog here so the store only ever holds
  // themes the app can render; the layout re-checks on the way out in case a
  // theme is retired later.
  if (hasTheme && !isThemeId(typeof body.theme === "string" ? body.theme : null)) {
    return jsonError("Unknown theme", 400, "unknown_theme");
  }
  const fullName = hasFullName ? (body.fullName as string).trim().slice(0, MAX_FULL_NAME_LENGTH) : null;
  const theme = hasTheme ? (body.theme as string) : null;
  const updated = updateUser(resolved.user.id, (record) => {
    if (fullName !== null) record.fullName = fullName;
    if (theme !== null) record.preferences = { ...record.preferences, theme };
  });
  return NextResponse.json({ user: toPublicUser(updated) }, { headers: { "Cache-Control": "no-store" } });
}
