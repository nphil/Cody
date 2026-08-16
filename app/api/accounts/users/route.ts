import { NextResponse } from "next/server";
import { parseJsonWithinLimit } from "@/lib/bounded-form-data";
import { jsonError, requireAdmin } from "@/lib/auth/http";
import { hashPassword, validatePasswordStrength } from "@/lib/auth/password";
import { createUser, listUsers, toPublicUser } from "@/lib/auth/users";

export const dynamic = "force-dynamic";

/** Admin: the account roster. */
export function GET(request: Request) {
  const resolved = requireAdmin(request);
  if ("response" in resolved) return resolved.response;
  return NextResponse.json(
    { users: listUsers().map(toPublicUser) },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/** Admin: create an account directly (as opposed to self-service signup). */
export async function POST(request: Request) {
  const resolved = requireAdmin(request);
  if ("response" in resolved) return resolved.response;

  let body: { username?: unknown; fullName?: unknown; password?: unknown; role?: unknown };
  try {
    body = await parseJsonWithinLimit(request, 4_096);
  } catch {
    return jsonError("Invalid request body", 400);
  }
  const { username, fullName, password, role } = body;
  if (typeof username !== "string" || typeof password !== "string") {
    return jsonError("Username and password are required", 400);
  }
  const passwordError = validatePasswordStrength(password);
  if (passwordError) return jsonError(passwordError, 400);

  try {
    const user = createUser({
      username,
      fullName: typeof fullName === "string" ? fullName : username,
      passwordHash: await hashPassword(password),
      role: role === "admin" ? "admin" : "member",
    });
    return NextResponse.json({ user: toPublicUser(user) }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : String(error), 400);
  }
}
