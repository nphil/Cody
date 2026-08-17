import { NextResponse } from "next/server";
import { publishDisplayRequest } from "@/lib/display/bus";
import { verifyDisplayCapability } from "@/lib/display/capability";
import { parseDisplayRequestInput } from "@/lib/display/validation";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const authorization = request.headers.get("authorization") ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  let capability = null;
  try { capability = verifyDisplayCapability(token); } catch { /* server not initialized */ }
  if (!capability) return NextResponse.json({ error: "Invalid display capability" }, { status: 401 });
  try {
    const input = parseDisplayRequestInput(await request.json());
    const display = await publishDisplayRequest(capability.sid, input);
    return NextResponse.json({ accepted: true, requestId: display.id }, { status: 202, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid display request" }, { status: 400 });
  }
}
