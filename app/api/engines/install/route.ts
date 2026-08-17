import { NextResponse } from "next/server";
import { jsonError, requireAdmin } from "@/lib/auth/http";
import { parseJsonWithinLimit } from "@/lib/bounded-form-data";
import { getHarness, getHarnessById } from "@/lib/harness";
import { EngineInstallError, installEngine } from "@/lib/harness/install";
import { packageNameFromSpec } from "@/lib/harness/updates";
import { invalidateOmpCliCache } from "@/lib/omp/omp-cli";
import { restartAllRpcSessions } from "@/lib/rpc-manager";

/**
 * Install OR update an engine on demand (admin only) — the two are the same
 * npm run against Cody's persistent prefix (the specs pin @latest), so the
 * engine survives container image updates and "Update" in the engine card is
 * simply a re-install. The call is a single await (up to five minutes); live
 * npm output streams separately over GET ./events?id=, which the UI follows
 * for its progress readout while this response carries the outcome.
 *
 * Installing does not switch engines: POST /api/engines/select does that, and
 * the picker calls it after a successful install. Updating the ACTIVE engine
 * restarts its live sessions so nothing keeps running on the old binary.
 */

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const resolved = requireAdmin(request);
  if ("response" in resolved) return resolved.response;

  let body: { id?: unknown; version?: unknown };
  try {
    body = await parseJsonWithinLimit(request, 1_024);
  } catch {
    return jsonError("Invalid request body", 400);
  }

  const id = typeof body.id === "string" ? body.id.trim() : "";
  const adapter = id ? getHarnessById(id) : undefined;
  if (!adapter) return jsonError(`Unknown engine "${id}"`, 400, "unknown_engine");

  if (!adapter.installSpec) {
    return jsonError(`${adapter.displayName} cannot be installed by Cody.`, 400, "not_installable");
  }
  // Optional version pin — the revert path after a broken update. Anything
  // else keeps the adapter's own spec (@latest).
  let installSpec = adapter.installSpec;
  if (body.version !== undefined) {
    const version = typeof body.version === "string" ? body.version.trim() : "";
    if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
      return jsonError("version must be a plain semver string", 400);
    }
    installSpec = `${packageNameFromSpec(adapter.installSpec)}@${version}`;
  }

  try {
    // Probed before npm runs so a successful install records what it replaced.
    const currentVersion = await adapter.getVersion();
    await installEngine({ id: adapter.id, installSpec, binaryName: adapter.binaryName, currentVersion });
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

  // omp's own CLI probe caches independently of engine-bin's.
  if (adapter.id === "omp") invalidateOmpCliCache();
  // An update of the running engine must not leave live children on the old
  // binary; the browser reconnects sessions on demand with the fresh install.
  if (getHarness().id === adapter.id) {
    await restartAllRpcSessions().catch(() => {});
  }

  // installEngine dropped the binary caches, so this probe sees the new install.
  return NextResponse.json(
    { id: adapter.id, installed: adapter.resolveBinary() !== null, version: await adapter.getVersion() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
