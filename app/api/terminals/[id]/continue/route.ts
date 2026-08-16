import { NextRequest, NextResponse } from "next/server";
import { getTerminalManager } from "@/lib/terminal-manager";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const body: unknown = await request.json().catch(() => ({}));
    if (!body || typeof body !== "object") throw new Error("JSON object required");
    const value = body as Record<string, unknown>;
    if ((value.cols !== undefined && typeof value.cols !== "number") || (value.rows !== undefined && typeof value.rows !== "number")) throw new Error("Invalid terminal dimensions");
    return NextResponse.json(getTerminalManager().continue((await params).id, value.cols as number | undefined, value.rows as number | undefined));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid terminal request";
    return NextResponse.json({ error: message }, { status: /not found/i.test(message) ? 404 : 400 });
  }
}
