import type { NextResponse } from "next/server";
import { jsonError } from "./auth/http";
import { getHarness } from "./harness";
import type { HarnessAdapter, HarnessCapabilities } from "./harness/types";

/**
 * Server-side gates for routes that only ONE engine — or only an engine with a
 * given capability — can honestly answer.
 *
 * Cody's rule is that a surface an engine cannot serve stays hidden; it never
 * renders another engine's data. The client half of that rule was already in
 * place (capability flags hide tabs and panels), but the routes underneath had
 * no gate at all: they read omp's files and spawned omp's binary whichever
 * engine was selected, and answered 200. Probed directly against a Hermes
 * instance they served omp's model catalog, omp's model roles, omp's
 * models.yml, omp's config.yml, omp's login providers and omp's plan quota —
 * every one of them presented as Hermes'. A client-side flag is a UI
 * convenience; it is not a boundary, and this is the boundary.
 *
 * A refused surface answers 400 `{error, code: "unsupported"}` — the same
 * shape GET /api/memory already uses and the one the client is built to
 * tolerate by hiding rather than rendering broken.
 */

/** Refuse unless `id` is the active engine. For surfaces that ARE one
 * engine's own files or protocol (omp's models.yml, `omp usage`, agent.db
 * credentials) and have no meaning under another. */
export function requireEngine(
  id: string,
  surface: string,
): { harness: HarnessAdapter } | { response: NextResponse } {
  const active = getHarness();
  if (active.id === id) return { harness: active };
  return {
    response: jsonError(
      `${surface} belongs to the ${id} engine, and ${active.displayName} is active. Cody will not answer it with another engine's data.`,
      400,
      "unsupported",
    ),
  };
}

/** Refuse unless the active engine declares `flag`. For surfaces several
 * engines could serve, where the adapter's own capability is the authority. */
export function requireCapability(
  flag: keyof HarnessCapabilities,
  surface: string,
): { harness: HarnessAdapter } | { response: NextResponse } {
  const active = getHarness();
  if (active.capabilities[flag]) return { harness: active };
  return {
    response: jsonError(`${active.displayName} does not support ${surface}.`, 400, "unsupported"),
  };
}
