import { NextResponse } from "next/server";
import { isAbsolute, relative } from "path";
import { jsonError, requireAdmin } from "@/lib/auth/http";
import { parseJsonWithinLimit } from "@/lib/bounded-form-data";
import { getHarness, getHarnessById } from "@/lib/harness";
import { getToolsDir, probeEngineVersion } from "@/lib/harness/engine-bin";
import { EngineInstallError, installEngine, isEngineInstalling, readInstallHistory, uninstallEngine } from "@/lib/harness/install";
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
 * the picker calls it after a successful install. npm exiting 0 does not prove
 * the engine works, so the new binary is run once before any of that: only a
 * verified install reports success, and only a verified install of the ACTIVE
 * engine restarts its live sessions.
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
    // An unreadable version is passed as undefined rather than null: a retry
    // against an already-broken engine would otherwise overwrite the recorded
    // revert target with "nothing", losing the last known-good version.
    const currentVersion = (await adapter.getVersion()) ?? undefined;
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

  // omp's own CLI probe caches independently of engine-bin's. Dropped even
  // when verification is about to fail: npm has already replaced whatever the
  // cached probe described.
  if (adapter.id === "omp") invalidateOmpCliCache();

  // installEngine dropped the binary caches, so this probe sees what npm just
  // wrote. npm resolves a platform-native optional dependency on a best-effort
  // basis and exits 0 when it cannot, which leaves a CLI that fails on every
  // invocation — running it once is the only way to tell the two apart.
  const binary = adapter.resolveBinary();
  const probe = binary
    ? await probeEngineVersion(binary)
    : { version: null, error: `npm finished but no ${adapter.binaryName} binary is installed.` };

  if (!probe.version) {
    const previousVersion = readInstallHistory()[adapter.id]?.previousVersion ?? null;
    const recovery = previousVersion
      ? ` Reverting to ${previousVersion}, the version this install replaced, should restore a working engine.`
      : "";
    // Live sessions are deliberately left alone here: restarting them onto an
    // engine that just failed its own version probe would take working chats
    // down with the update, and they still have the old binary.
    return NextResponse.json(
      {
        error: `${adapter.displayName} was installed but its binary does not run, so the install could not be verified.${recovery}`,
        code: "install_unverified",
        detail: probe.error ?? "",
        previousVersion,
      },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }

  // An update of the running engine must not leave live children on the old
  // binary; the browser reconnects sessions on demand with the fresh install.
  if (getHarness().id === adapter.id) {
    await restartAllRpcSessions().catch(() => {});
  }

  return NextResponse.json(
    { id: adapter.id, installed: true, version: probe.version },
    { headers: { "Cache-Control": "no-store" } },
  );
}

// DELETE /api/engines/install  body: { id } — remove an engine from Cody's
// tools prefix (admin only). Only engines Cody itself npm-installed there are
// removable: a PATH or env-override binary belongs to the operator, and the
// ACTIVE engine is never uninstalled out from under its sessions — switching
// first is the explicit, honest order of operations.
export async function DELETE(request: Request) {
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
  if (!adapter.installSpec) {
    return jsonError(`${adapter.displayName} cannot be managed by Cody.`, 400, "not_installable");
  }
  if (getHarness().id === adapter.id) {
    return jsonError(
      `${adapter.displayName} is the active engine. Switch to another engine before uninstalling it.`,
      409,
      "engine_active",
    );
  }
  if (isEngineInstalling(adapter.id)) {
    return jsonError(`${adapter.displayName} is installing right now; wait for it to finish.`, 409, "install_running");
  }

  const binPath = adapter.resolveBinary();
  if (!binPath) return jsonError(`${adapter.displayName} is not installed.`, 400, "not_installed");
  const rel = relative(getToolsDir(), binPath);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    return jsonError(
      `${adapter.displayName} runs from ${binPath}, which Cody did not install. Remove it on the host instead.`,
      400,
      "not_managed",
    );
  }

  try {
    await uninstallEngine({
      id: adapter.id,
      packageName: packageNameFromSpec(adapter.installSpec),
      binaryName: adapter.binaryName,
    });
  } catch (error) {
    const detail = error instanceof EngineInstallError ? error.detail : "";
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : String(error),
        code: "uninstall_failed",
        ...(detail ? { detail } : {}),
      },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }

  if (adapter.id === "omp") invalidateOmpCliCache();

  // A copy on PATH (or behind a CODY_<NAME>_BIN override) survives removal
  // from the tools prefix. Report it so the UI says what actually happened
  // instead of pretending the engine vanished.
  const remainingBinary = adapter.resolveBinary();
  return NextResponse.json(
    { id: adapter.id, uninstalled: true, remainingBinary },
    { headers: { "Cache-Control": "no-store" } },
  );
}
