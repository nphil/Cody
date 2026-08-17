import { NextRequest, NextResponse } from "next/server";
import { getTerminalManager } from "@/lib/terminal-manager";

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "Invalid terminal request";
  return NextResponse.json({ error: message }, { status: /not found/i.test(message) ? 404 : 400 });
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try { getTerminalManager().close((await params).id); return NextResponse.json({ closed: true }); }
  catch (error) { return errorResponse(error); }
}

// PATCH { name } — rename a terminal (the tab title is click-to-edit).
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const body = await request.json().catch(() => ({})) as { name?: unknown };
    if (typeof body.name !== "string") throw new Error("Invalid terminal name");
    return NextResponse.json(getTerminalManager().rename((await params).id, body.name));
  } catch (error) {
    return errorResponse(error);
  }
}
