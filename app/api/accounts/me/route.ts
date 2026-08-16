import { NextResponse } from "next/server";
import { parseJsonWithinLimit } from "@/lib/bounded-form-data";
import { jsonError, requireUser } from "@/lib/auth/http";
import { MAX_FULL_NAME_LENGTH, toPublicUser, updateUser } from "@/lib/auth/users";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  const resolved = requireUser(request);
  if ("response" in resolved) return resolved.response;
  return NextResponse.json({ user: toPublicUser(resolved.user) }, { headers: { "Cache-Control": "no-store" } });
}

/** Profile fields the account edits about itself. Username is identity and
 * stays fixed; role changes go through the admin routes. */
export async function PATCH(request: Request) {
  const resolved = requireUser(request);
  if ("response" in resolved) return resolved.response;

  let body: { fullName?: unknown };
  try {
    body = await parseJsonWithinLimit(request, 4_096);
  } catch {
    return jsonError("Invalid request body", 400);
  }
  if (typeof body.fullName !== "string" || !body.fullName.trim()) {
    return jsonError("Full name is required", 400);
  }
  const fullName = body.fullName.trim().slice(0, MAX_FULL_NAME_LENGTH);
  const updated = updateUser(resolved.user.id, (record) => { record.fullName = fullName; });
  return NextResponse.json({ user: toPublicUser(updated) }, { headers: { "Cache-Control": "no-store" } });
}
