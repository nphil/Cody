import { NextResponse } from "next/server";
import { clearedSessionCookie } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

/** Clearing the cookie is enough: tokens are stateless, and per-account
 * revocation (tokenVersion) exists for the cases that need more. */
export function POST() {
  return NextResponse.json(
    { success: true },
    { headers: { "Set-Cookie": clearedSessionCookie(), "Cache-Control": "no-store" } },
  );
}
