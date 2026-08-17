import { NextResponse } from "next/server";
import { authorizeDisplaySession } from "@/lib/display/access";
import { getLatestDisplayRequest, publishDisplayRequest } from "@/lib/display/bus";
import { parseDisplayRequestInput } from "@/lib/display/validation";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(await authorizeDisplaySession(request, id))) return NextResponse.json({ error: "Session not found" }, { status: 404 });
  return NextResponse.json({ request: getLatestDisplayRequest(id) }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(await authorizeDisplaySession(request, id))) return NextResponse.json({ error: "Session not found" }, { status: 404 });
  try {
    const input = parseDisplayRequestInput(await request.json());
    const display = await publishDisplayRequest(id, input);
    return NextResponse.json({ accepted: true, requestId: display.id, request: display }, { status: 202 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid display request" }, { status: 400 });
  }
}
