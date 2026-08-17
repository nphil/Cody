import { NextResponse } from "next/server";
import { jsonError, requireAdmin } from "@/lib/auth/http";
import { parseJsonWithinLimit } from "@/lib/bounded-form-data";
import { getHarnessById } from "@/lib/harness";
import { EngineInstallError, installEngine } from "@/lib/harness/install";

/**
 * Install an engine on demand (admin only). npm runs against Cody's own
 * persistent prefix, so the engine survives container image updates; the call
 * is a single await (up to five minutes) rather than a stream — the UI shows a
 * spinner and gets either the installed version or an npm error to display.
 *
 * Installing does not switch engines: POST /api/engines/select does that, and
 * the picker calls it after a successful install.
 */

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const resolved = requireAdmin(request);
  if ("response" in resolved) return resolved.response;

  let body: { id?: unknown };
  try {
    body = await parseJsonWithinLimit(request, 1_024);
  } catch {
    return jsonError("Invalid request body", 400);
  }

  const id = typeof body.id === "string" ? body.id.trim() : "";
  const adapter = id ? getHarnessById(id) : undefined;
  if (!adapter) return jsonError(`Unknown engine "${id}"`, 400, "unknown_engine");

  const installSpec = adapter.installSpec;
  if (!installSpec) {
    return jsonError(`${adapter.displayName} cannot be installed by Cody.`, 400, "not_installable");
  }

  try {
    await installEngine({ id: adapter.id, installSpec, binaryName: adapter.binaryName });
  } catch (error) {
    const detail = error instanceof EngineInstallError ? error.detail : "";
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : String(error),
        code: "install_failed",
        ...(detail ? { detail } : {}),
      },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }

  // installEngine dropped the binary caches, so this probe sees the new install.
  return NextResponse.json(
    { id: adapter.id, installed: adapter.resolveBinary() !== null, version: await adapter.getVersion() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
