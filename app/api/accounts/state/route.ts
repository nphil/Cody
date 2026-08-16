import { NextResponse } from "next/server";
import { getRequestUser, isAuthRequired } from "@/lib/auth/guard";
import { hasAnyUser, isSignupAllowed, toPublicUser } from "@/lib/auth/users";

/**
 * Everything the login screen (and the signed-in shell) needs to know about
 * the account system, in one public round trip. Public by design: it reveals
 * only which flows are available, never who exists.
 */

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  const user = getRequestUser(request);
  const firstRun = !hasAnyUser();
  return NextResponse.json(
    {
      authRequired: isAuthRequired(),
      firstRun,
      // First-run setup is always allowed; a fresh install that cannot create
      // its first account would be a brick.
      signupAllowed: firstRun || isSignupAllowed(),
      user: user ? toPublicUser(user) : null,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
