import { NextResponse } from "next/server";
import { setTimeout as sleep } from "node:timers/promises";
import { parseJsonWithinLimit } from "@/lib/bounded-form-data";
import { jsonError } from "@/lib/auth/http";
import { hashPassword, needsRehash, verifyPassword } from "@/lib/auth/password";
import { issueSessionToken, sessionCookie } from "@/lib/auth/session";
import { findUserByUsername, toPublicUser, updateUser } from "@/lib/auth/users";
import { isValidBasicAuthorization } from "@/lib/web-auth";

export const dynamic = "force-dynamic";

/** One uniform failure: same message, same ~300ms floor, whether the username
 * exists or not — nothing to enumerate accounts with. */
const FAILURE_DELAY_MS = 300;

export async function POST(request: Request) {
  let body: { username?: unknown; password?: unknown };
  try {
    body = await parseJsonWithinLimit(request, 4_096);
  } catch {
    return jsonError("Invalid request body", 400);
  }
  const { username, password } = body;
  if (typeof username !== "string" || typeof password !== "string" || !username || !password) {
    return jsonError("Username and password are required", 400);
  }

  const started = Date.now();
  const fail = async () => {
    await sleep(Math.max(0, FAILURE_DELAY_MS - (Date.now() - started)));
    return jsonError("Incorrect username or password", 401, "bad_credentials");
  };

  const user = findUserByUsername(username);
  if (!user) return fail();

  if (user.envManaged === true) {
    // The bootstrap account authenticates against CODY_PASSWORD, reusing the
    // same constant-time check the Basic Auth path uses.
    const header = `Basic ${Buffer.from(`${user.username}:${password}`).toString("base64")}`;
    if (!isValidBasicAuthorization(header)) return fail();
  } else {
    if (!user.passwordHash || !(await verifyPassword(password, user.passwordHash))) return fail();
    if (needsRehash(user.passwordHash)) {
      // Parameters changed since this hash was written; refresh it while the
      // cleartext is in hand.
      const rehashed = await hashPassword(password);
      updateUser(user.id, (record) => { record.passwordHash = rehashed; });
    }
  }

  const token = issueSessionToken(user);
  return NextResponse.json(
    { user: toPublicUser(user) },
    { headers: { "Set-Cookie": sessionCookie(token), "Cache-Control": "no-store" } },
  );
}
