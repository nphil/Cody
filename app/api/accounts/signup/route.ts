import { NextResponse } from "next/server";
import { parseJsonWithinLimit } from "@/lib/bounded-form-data";
import { jsonError } from "@/lib/auth/http";
import { hashPassword, validatePasswordStrength } from "@/lib/auth/password";
import { issueSessionToken, sessionCookie } from "@/lib/auth/session";
import { createUser, hasAnyUser, isSignupAllowed, toPublicUser } from "@/lib/auth/users";

export const dynamic = "force-dynamic";

/**
 * Self-service account creation from the login screen. The first account ever
 * created becomes the administrator (the fresh-install flow); afterwards the
 * route obeys CODY_ALLOW_SIGNUP and new accounts join as members.
 */
export async function POST(request: Request) {
  let body: { username?: unknown; fullName?: unknown; password?: unknown };
  try {
    body = await parseJsonWithinLimit(request, 4_096);
  } catch {
    return jsonError("Invalid request body", 400);
  }
  const { username, fullName, password } = body;
  if (typeof username !== "string" || typeof password !== "string") {
    return jsonError("Username and password are required", 400);
  }

  const firstRun = !hasAnyUser();
  if (!firstRun && !isSignupAllowed()) {
    return jsonError("Account creation is disabled on this server", 403, "signup_disabled");
  }
  const passwordError = validatePasswordStrength(password);
  if (passwordError) return jsonError(passwordError, 400);

  let user;
  try {
    user = createUser({
      username,
      fullName: typeof fullName === "string" ? fullName : username,
      passwordHash: await hashPassword(password),
      role: firstRun ? "admin" : "member",
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : String(error), 400);
  }

  const token = issueSessionToken(user);
  return NextResponse.json(
    { user: toPublicUser(user) },
    { status: 201, headers: { "Set-Cookie": sessionCookie(token), "Cache-Control": "no-store" } },
  );
}
