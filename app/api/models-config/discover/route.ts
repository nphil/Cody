import { NextResponse } from "next/server";
import { jsonError, requireAdmin } from "@/lib/auth/http";
import { parseJsonWithinLimit } from "@/lib/bounded-form-data";

// POST { baseUrl } — probe an OpenAI-compatible endpoint's /models list
// (server-side: no CORS, honest timeout) so the setup wizard can seed a
// local provider (llama-swap, Ollama, llama.cpp, LM Studio) with its actual
// models instead of asking the user to type ids. Admin-only, like every
// other provider-mutation surface; connecting arbitrary endpoints is this
// screen's entire purpose, so the URL is only shape-checked.
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const resolved = requireAdmin(request);
  if ("response" in resolved) return resolved.response;

  let body: { baseUrl?: unknown };
  try {
    body = await parseJsonWithinLimit(request, 2_048);
  } catch {
    return jsonError("Invalid request body", 400);
  }
  const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim().replace(/\/+$/, "") : "";
  if (!/^https?:\/\//i.test(baseUrl)) return jsonError("baseUrl must be an http(s) URL", 400);

  try {
    const response = await fetch(`${baseUrl}/models`, {
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return jsonError(`Endpoint answered HTTP ${response.status}`, 502);
    const data = (await response.json()) as { data?: Array<{ id?: unknown }> };
    const models = Array.isArray(data?.data)
      ? data.data.map((entry) => entry?.id).filter((id): id is string => typeof id === "string" && id.length > 0).slice(0, 200)
      : [];
    return NextResponse.json({ models }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : String(error), 502);
  }
}
