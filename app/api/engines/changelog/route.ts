import { NextResponse } from "next/server";
import { readFileSync } from "fs";
import { jsonError, requireUser } from "@/lib/auth/http";
import { getOmpChangelogPath } from "@/lib/omp/settings-schema";

/**
 * GET /api/engines/changelog?id=omp — recent entries from the installed
 * engine package's own CHANGELOG.md (Keep-a-Changelog sections). Engines
 * updated from inside Cody deserve visible release notes; today only omp
 * ships a changelog in its package, so other ids answer with a reason
 * instead of an error and the UI simply doesn't offer the affordance.
 */

export const dynamic = "force-dynamic";

const MAX_ENTRIES = 5;
const MAX_TOTAL_BYTES = 48_000;

export async function GET(request: Request) {
  const resolved = requireUser(request);
  if ("response" in resolved) return resolved.response;

  const id = new URL(request.url).searchParams.get("id")?.trim() ?? "";
  if (!id) return jsonError("Missing engine id", 400);
  if (id !== "omp") {
    return NextResponse.json(
      { entries: null, reason: "This engine's package does not ship a changelog." },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  const file = getOmpChangelogPath();
  if (!file) {
    return NextResponse.json(
      { entries: null, reason: "The installed omp package has no readable CHANGELOG.md." },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    return NextResponse.json(
      { entries: null, reason: String(error) },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  // Keep-a-Changelog: "## [17.3.5] - 2026-08-16" heads each release section.
  const entries: Array<{ heading: string; body: string }> = [];
  let total = 0;
  const sections = text.split(/^## (?=\[?\d)/m).slice(1);
  for (const section of sections) {
    if (entries.length >= MAX_ENTRIES || total >= MAX_TOTAL_BYTES) break;
    const newline = section.indexOf("\n");
    const heading = (newline === -1 ? section : section.slice(0, newline)).trim();
    const body = (newline === -1 ? "" : section.slice(newline + 1)).trim();
    const clipped = body.length > 12_000 ? `${body.slice(0, 12_000)}\n…` : body;
    entries.push({ heading, body: clipped });
    total += heading.length + clipped.length;
  }

  return NextResponse.json({ entries }, { headers: { "Cache-Control": "no-store" } });
}
