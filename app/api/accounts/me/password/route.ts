import { NextResponse } from "next/server";
import { parseJsonWithinLimit } from "@/lib/bounded-form-data";
import { jsonError, requireUser } from "@/lib/auth/http";
import { hashPassword, validatePasswordStrength, verifyPassword } from "@/lib/auth/password";
import { issueSessionToken, sessionCookie } from "@/lib/auth/session";
import { updateUser } from "@/lib/auth/users";

export const dynamic = "force-dynamic";

/**
 * Change the signed-in account's password. Requires the current password even
 * mid-session — a walked-away-from browser must not be enough to take the
 * account over. Bumps tokenVersion so every other device signs out, then
 * reissues this device's cookie.
 */
export async function POST(request: Request) {
  const resolved = requireUser(request);
  if ("response" in resolved) return resolved.response;
  const { user } = resolved;

  if (user.envManaged === true) {
    return jsonError("This account's password is the CODY_PASSWORD environment variable; change it in your container settings", 400, "env_managed");
  }

  let body: { currentPassword?: unknown; newPassword?: unknown };
  try {
    body = await parseJsonWithinLimit(request, 4_096);
  } catch {
    return jsonError("Invalid request body", 400);
  }
  const { currentPassword, newPassword } = body;
  if (typeof currentPassword !== "string" || typeof newPassword !== "string") {
    return jsonError("Current and new passwords are required", 400);
  }
  if (!user.passwordHash || !(await verifyPassword(currentPassword, user.passwordHash))) {
    return jsonError("Current password is incorrect", 403, "bad_password");
  }
  const strengthError = validatePasswordStrength(newPassword);
  if (strengthError) return jsonError(strengthError, 400);

  const passwordHash = await hashPassword(newPassword);
  const updated = updateUser(user.id, (record) => {
    record.passwordHash = passwordHash;
    record.tokenVersion += 1;
  });
  return NextResponse.json(
    { success: true },
    { headers: { "Set-Cookie": sessionCookie(issueSessionToken(updated)), "Cache-Control": "no-store" } },
  );
}
