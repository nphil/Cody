import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/http";
import { getHarness, listHarnesses } from "@/lib/harness";
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
  // Version probes shell out to each binary; run them together so the picker
  // is not serialized behind three CLI startups.
  const versions = await Promise.all(adapters.map((adapter) => adapter.getVersion()));

  return NextResponse.json(
    {
      engines: adapters.map((adapter, index) => ({
        id: adapter.id,
        name: adapter.displayName,
        shortName: adapter.shortName,
        tagline: adapter.tagline,
        experimental: adapter.experimental === true,
        installed: adapter.resolveBinary() !== null,
        // A truthful "still running" so a reloaded page can reattach to the
        // install (via the events route) instead of showing a dead button.
        installing: isEngineInstalling(adapter.id),
        version: versions[index],
        installable: Boolean(adapter.installSpec),
        authHint: adapter.authHint ?? null,
        binaryName: adapter.binaryName,
      })),
      active: getHarness().id,
      onboarded: isEngineOnboarded(),
      setupDone: isSetupWizardDone(),
      canManage: resolved.user.role === "admin",
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
