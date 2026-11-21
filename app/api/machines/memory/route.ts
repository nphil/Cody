import { NextResponse } from "next/server";
import { requireUserOrOpenInstance } from "@/lib/auth/http";
import { memoryOverview } from "@/lib/machines/memory-store";
import type { MemoryOverview } from "@/lib/machines/memory";

/**
 * What the Machines panel lists under each machine: the memory events of the
 * last week (newest first) and how many jobs started where in the last 24
 * hours. Any signed-in person may read it, as with the meters: it names
 * machines by their ids and says nothing about how to reach one.
 */

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  const resolved = requireUserOrOpenInstance(request);
  if ("response" in resolved) return resolved.response;
  const body: MemoryOverview = memoryOverview();
  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}
