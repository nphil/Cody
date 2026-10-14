import { NextResponse } from "next/server";
import { jsonError, requireAdmin, requireUser } from "@/lib/auth/http";
import { parseJsonWithinLimit } from "@/lib/bounded-form-data";
import { CLAUDE_CREDITS_PROVIDERS } from "@/lib/claude-credits";
import { requireEngine } from "@/lib/engine-guard";
import { getHarness } from "@/lib/harness";
import { describeClaudeCreditsError, readClaudeCreditsRouting, readClaudeCreditsStatus, removeClaudeApiKey, saveClaudeApiKey } from "@/lib/omp/claude-credits";
import { disposeUtilityRpc } from "@/lib/omp/rpc-utility";
import { settleProviderChange } from "@/lib/provider-state";

/**
 * Claude API credits: the backup behind the Claude plans (lib/claude-credits.ts
 * explains the mechanism). One API key per plan account, stored in omp's own
 * credential store; omp serves them only after the plans' limits have come back.
 *
 * GET tells the Providers panel which plan accounts have a key (masked to the
 * last four characters — a key's value never leaves the server, and nothing
 * here logs one). PUT saves or replaces an account's key; DELETE forgets one.
 * Both writes are admin-only because the credits are spent by everyone's chats,
 * and omp-only because they are omp's credential store and fallback chains.
 */
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

async function answer(canEdit: boolean) {
  try {
    return NextResponse.json(await readClaudeCreditsStatus(canEdit), { headers: NO_STORE });
  } catch {
    return jsonError("The Claude API credits could not be read.", 500);
  }
}

/** A saved or removed key changes what the next chat spawn carries (the models.yml blocks and the
 * fallback overlay), so the catalog child and every idle engine are refreshed. A credits provider
 * left without a key is gone: whatever was remembered about it (a blackout) goes with it. */
async function settleAfterChange(removedProviders: readonly string[]) {
  disposeUtilityRpc();
  await settleProviderChange({
    engineId: getHarness().id,
    restart: true,
    ...(removedProviders.length > 0 ? { removedProviders } : {}),
  });
}

export async function GET(request: Request) {
  const resolved = requireUser(request);
  if ("response" in resolved) return resolved.response;
  const gate = requireEngine("omp", "Claude API credits");
  if ("response" in gate) return gate.response;
  return answer(resolved.user.role === "admin");
}

export async function PUT(request: Request) {
  const resolved = requireAdmin(request);
  if ("response" in resolved) return resolved.response;
  const gate = requireEngine("omp", "Claude API credits");
  if ("response" in gate) return gate.response;

  let body: { accountId?: unknown; key?: unknown };
  try {
    body = await parseJsonWithinLimit(request, 8_192);
  } catch {
    return jsonError("Invalid request body", 400);
  }
  const accountId = typeof body.accountId === "string" ? body.accountId.trim() : "";
  const key = typeof body.key === "string" ? body.key : "";
  if (!accountId) return jsonError("Choose which Claude account this key belongs to.", 400, "claude_credits_unknown_account");
  try {
    await saveClaudeApiKey(accountId, key);
  } catch (error) {
    const described = describeClaudeCreditsError(error);
    return jsonError(described.message, described.status, described.code);
  }
  await settleAfterChange([]);
  return answer(true);
}

export async function DELETE(request: Request) {
  const resolved = requireAdmin(request);
  if ("response" in resolved) return resolved.response;
  const gate = requireEngine("omp", "Claude API credits");
  if ("response" in gate) return gate.response;

  let body: { keyId?: unknown };
  try {
    body = await parseJsonWithinLimit(request, 1_024);
  } catch {
    return jsonError("Invalid request body", 400);
  }
  const keyId = typeof body.keyId === "string" ? body.keyId.trim() : "";
  if (!keyId) return jsonError("Choose which key to remove.", 400, "claude_credits_unknown_account");
  try {
    await removeClaudeApiKey(keyId);
  } catch (error) {
    const described = describeClaudeCreditsError(error);
    return jsonError(described.message, described.status, described.code);
  }
  const status = await readClaudeCreditsStatus(true).catch(() => null);
  const withKey = new Set(readClaudeCreditsRouting().providers);
  await settleAfterChange(CLAUDE_CREDITS_PROVIDERS.filter((name) => !withKey.has(name)));
  return status ? NextResponse.json(status, { headers: NO_STORE }) : jsonError("The Claude API credits could not be read.", 500);
}
