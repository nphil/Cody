import { NextRequest, NextResponse } from "next/server";
import { authorizeTerminalCwd, getTerminalManager } from "@/lib/terminal-manager";

export const dynamic = "force-dynamic";

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "Invalid terminal request";
  const status = /not found/i.test(message) ? 404 : /allowed|authorization/i.test(message) ? 403 : 400;
  return NextResponse.json({ error: message }, { status });
}

export async function GET(request: NextRequest) {
  try {
    const raw = request.nextUrl.searchParams.get("cwd");
    const cwd = await authorizeTerminalCwd(raw ?? "");
    return NextResponse.json({ terminals: getTerminalManager().list(cwd) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: NextRequest) {
  try {
    const body: unknown = await request.json();
    if (!body || typeof body !== "object") throw new Error("JSON object required");
    const value = body as Record<string, unknown>;
    const cwd = await authorizeTerminalCwd(value.cwd as string);
    if (value.name !== undefined && typeof value.name !== "string") throw new Error("Invalid terminal name");
    if (value.cols !== undefined && typeof value.cols !== "number") throw new Error("Invalid terminal dimensions");
    if (value.rows !== undefined && typeof value.rows !== "number") throw new Error("Invalid terminal dimensions");
    return NextResponse.json(getTerminalManager().create(cwd, value.name as string | undefined, value.cols as number | undefined, value.rows as number | undefined), { status: 201 });
  } catch (error) { return errorResponse(error); }
}
