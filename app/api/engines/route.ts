import { NextResponse } from "next/server";
import { isAbsolute, relative } from "path";
import { requireUser } from "@/lib/auth/http";
import { engineOwnVersion, getHarness, listHarnesses } from "@/lib/harness";
import { getToolsDir } from "@/lib/harness/engine-bin";
import { isEngineInstalling } from "@/lib/harness/install";
import { isEngineOnboarded, isSetupWizardDone } from "@/lib/harness/state";

/**
 * The engine roster: everything the onboarding picker and the Settings →
 * Agent engine card need in one signed-in round trip — which engines exist,
 * which are installed (and at what version), which Cody can install itself,
 * plus the active selection and whether this account may change it.
 */

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const resolved = requireUser(request);
  if ("response" in resolved) return resolved.response;

  const adapters = listHarnesses();
  const toolsDir = getToolsDir();
  // Version probes shell out to each binary; run them together so the picker
  // is not serialized behind three CLI startups.
  //
  // An engine Cody installs as an ACP adapter plus the CLI it drives has TWO
  // versions, and the one this payload calls `version` is the ENGINE's — the
  // number a user means by "Claude Code" (2.1.x), not the adapter's (0.70.x).
  // The adapter's rides alongside as `adapterVersion`, labelled, because the
  // alternative is a card reading "Installed · v0.70.0" for an engine whose
  // own `--version` says something else entirely.
  const [versions, engineVersions] = await Promise.all([
    Promise.all(adapters.map((adapter) => adapter.getVersion())),
    Promise.all(adapters.map((adapter) => engineOwnVersion(adapter))),
  ]);

  return NextResponse.json(
    {
      engines: adapters.map((adapter, index) => {
        const binPath = adapter.resolveBinary();
        const insideTools = binPath !== null && (() => {
          const rel = relative(toolsDir, binPath);
          return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
        })();
        return {
          id: adapter.id,
          name: adapter.displayName,
          shortName: adapter.shortName,
          tagline: adapter.tagline,
          experimental: adapter.experimental === true,
          installed: binPath !== null,
          // A truthful "still running" so a reloaded page can reattach to the
          // install (via the events route) instead of showing a dead button.
          installing: isEngineInstalling(adapter.id),
          version: engineVersions[index],
          // Present only for a two-package engine, so a UI can show both
          // numbers without guessing which package each belongs to.
          adapterVersion: adapter.engineCli ? versions[index] : null,
          adapterLabel: adapter.engineCli?.adapterLabel ?? null,
          engineCliLabel: adapter.engineCli?.label ?? null,
          // The audited-against marker, verbatim from the adapter: the
          // version of `installSpec`'s package this Cody build was built to.
          verifiedVersion: adapter.verifiedVersion ?? null,
          installable: Boolean(adapter.installSpec),
          // Cody npm-installed this binary into its own tools prefix, so Cody
          // can also uninstall it. A PATH or env-override install is the
          // operator's, not ours.
          managed: insideTools && Boolean(adapter.installSpec),
          authHint: adapter.authHint ?? null,
          binaryName: adapter.binaryName,
        };
      }),
      active: getHarness().id,
      onboarded: isEngineOnboarded(),
      setupDone: isSetupWizardDone(),
      canManage: resolved.user.role === "admin",
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
