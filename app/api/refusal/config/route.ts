import { NextResponse } from "next/server";
import { jsonError, requireAdminOrOpenInstance } from "@/lib/auth/http";
import { parseJsonWithinLimit } from "@/lib/bounded-form-data";
import { getHarness } from "@/lib/harness";
import { isRecord } from "@/lib/type-guards";
import { isRefusalPolicy, readRefusalPolicyConfig, writeRefusalPolicyConfig } from "@/lib/refusal/config";

export const dynamic = "force-dynamic";
const MAX_BODY_BYTES = 256;

/** The refusal guard is an omp extension whose hooks exist from omp 18.3. */
function supportsPolicy(version: string | null): boolean {
  const parsed = version?.match(/^(\d+)\.(\d+)(?:\.|$)/);
  if (getHarness().id !== "omp" || !parsed) return false;
  const major = Number(parsed[1]);
  const minor = Number(parsed[2]);
  return major > 18 || (major === 18 && minor >= 3);
}

async function answer(request: Request, policy: "ask" | "rewind" | "fallback"): Promise<NextResponse> {
  const version = await getHarness().getVersion();
  const supported = supportsPolicy(version);
  return NextResponse.json(
    {
      policy,
      supported,
      version,
      ...(supported ? {} : { reason: "Requires OMP 18.3 or newer." }),
      canManage: requireAdminOrOpenInstance(request) === null,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function GET(request: Request): Promise<NextResponse> {
  return answer(request, readRefusalPolicyConfig().policy);
}

export async function PUT(request: Request): Promise<NextResponse> {
  const version = await getHarness().getVersion();
  if (!supportsPolicy(version)) return jsonError("Requires OMP 18.3 or newer.", 400, "unsupported");

  const denied = requireAdminOrOpenInstance(request);
  if (denied) return denied;

  let parsed: unknown;
  try {
    parsed = await parseJsonWithinLimit(request, MAX_BODY_BYTES);
  } catch {
    return jsonError("Invalid request body", 400, "invalid_body");
  }
  const policy = isRecord(parsed) && isRefusalPolicy(parsed.policy) ? parsed.policy : null;
  if (!policy) return jsonError("policy must be ask, rewind, or fallback", 400, "invalid_body");

  return answer(request, writeRefusalPolicyConfig({ policy }).policy);
}
