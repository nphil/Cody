import { NextResponse } from "next/server";
import { readFileSync } from "fs";
import { jsonError, requireUser } from "@/lib/auth/http";
import { listHarnesses } from "@/lib/harness";
import { buildChangelogPayload } from "@/lib/harness/package-changelog";
import { fetchLatestPackageVersion, packageNameFromSpec } from "@/lib/harness/updates";
import { getOmpChangelogPath } from "@/lib/omp/settings-schema";

/**
 * GET /api/engines/changelog?id=omp — release notes for an installed engine.
 * While the registry knows a newer version than the installed binary, the
 * entries come from the LATEST published package (that is what the Update
 * button installs — the installed file can only describe the past); otherwise,
 * or when the registry fetch fails, from the installed package's own
 * CHANGELOG.md. Today only omp ships a changelog in its package, so other
 * ids answer with a reason instead of an error and the UI simply doesn't
 * offer the affordance.
 */

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const resolved = requireUser(request);
  if ("response" in resolved) return resolved.response;

  const id = new URL(request.url).searchParams.get("id")?.trim() ?? "";
  if (!id) return jsonError("Missing engine id", 400);
  const adapter = listHarnesses().find((candidate) => candidate.id === id);
  if (id !== "omp" || !adapter) {
    return NextResponse.json(
      {
        entries: null,
        reason: "This engine's package does not ship a changelog.",
        source: null,
        installedVersion: null,
        latestVersion: null,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  const packageName = adapter.installSpec ? packageNameFromSpec(adapter.installSpec) : null;
  const [installedVersion, latestVersion] = await Promise.all([
    adapter.getVersion(),
    packageName ? fetchLatestPackageVersion(packageName) : Promise.resolve(null),
  ]);

  const payload = await buildChangelogPayload({
    packageName,
    installedVersion,
    latestVersion,
    readInstalledChangelog: () => {
      const file = getOmpChangelogPath();
      return file ? readFileSync(file, "utf8") : null;
    },
  });

  return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
}
