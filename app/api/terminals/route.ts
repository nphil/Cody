import { NextRequest, NextResponse } from "next/server";
import { authorizeTerminalCwd, getTerminalManager, type TerminalAttach } from "@/lib/terminal-manager";
import { resolveSessionPathOr404 } from "@/lib/api-utils";

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

const TERMINAL_LOCALES = ["en", "ja", "zh-CN"] as const;

/** Resolve the chat session the first terminal may attach to. Reuses the
 * session routes' ownership gate: a session that does not resolve or belongs
 * to another account yields a plain terminal, indistinguishable from passing
 * no session at all. */
async function resolveAttach(value: Record<string, unknown>, request: NextRequest): Promise<TerminalAttach | undefined> {
  if (value.sessionId === undefined || value.sessionId === null) return undefined;
  if (typeof value.sessionId !== "string") throw new Error("Invalid session id");
  const resolved = await resolveSessionPathOr404(value.sessionId, request);
  if ("response" in resolved) return undefined;
  const locale = TERMINAL_LOCALES.find((candidate) => candidate === value.locale) ?? "en";
  return { sessionFile: resolved.filePath, locale };
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
    const attach = await resolveAttach(value, request);
    return NextResponse.json(getTerminalManager().create(cwd, value.name as string | undefined, value.cols as number | undefined, value.rows as number | undefined, attach), { status: 201 });
  } catch (error) { return errorResponse(error); }
}
