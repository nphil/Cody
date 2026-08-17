import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/http";
import { writeEngineState } from "@/lib/harness/state";

// POST — mark the post-onboarding setup wizard finished (or skipped). One-way
// by design: the wizard offers everything Settings offers, so there is
// nothing to reopen; an admin who wants the flows again has Settings.
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const resolved = requireAdmin(request);
  if ("response" in resolved) return resolved.response;
  writeEngineState({ setupDone: true });
  return NextResponse.json({ setupDone: true }, { headers: { "Cache-Control": "no-store" } });
}
