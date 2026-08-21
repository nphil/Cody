import { NextResponse } from "next/server";
import {
  browseSkills,
  getSkillDescriptions,
  getSkillDetail,
  isValidSkillId,
  searchSkills,
  MAX_DESCRIPTION_BATCH,
  MAX_STORE_LIMIT,
  SKILL_CATEGORIES,
} from "@/lib/skills-registry";

export const dynamic = "force-dynamic";

// GET /api/skills/store?q=<query>            search (fuzzy/semantic upstream)
// GET /api/skills/store?category=<id>        browse one category
// GET /api/skills/store                      browse merged "popular" view
// GET /api/skills/store?detail=<skill id>    one skill's description/readme/files
export async function GET(req: Request) {
  const url = new URL(req.url);
  const detailId = url.searchParams.get("detail");
  const query = url.searchParams.get("q")?.trim() ?? "";
  const category = url.searchParams.get("category") ?? "";
  const limitRaw = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0
    ? Math.min(MAX_STORE_LIMIT, Math.floor(limitRaw))
    : MAX_STORE_LIMIT;

  try {
    if (detailId !== null) {
      if (!isValidSkillId(detailId)) {
        return NextResponse.json({ error: "invalid skill id", code: "invalid_skill_id" }, { status: 400 });
      }
      const detail = await getSkillDetail(detailId);
      return NextResponse.json({ detail });
    }

    if (query) {
      const { items, searchType } = await searchSkills(query, limit);
      return NextResponse.json({ items, searchType });
    }

    const items = await browseSkills(category, limit);
    return NextResponse.json({
      items,
      categories: SKILL_CATEGORIES.map((entry) => entry.id),
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { error: message, code: "skill_store_unreachable" },
      { status: 502 },
    );
  }
}

// POST /api/skills/store  body: { ids: string[] } → { descriptions }
// Description enrichment for the visible page of results; bounded server-side.
export async function POST(req: Request) {
  let ids: unknown;
  try {
    ({ ids } = (await req.json()) as { ids?: unknown });
  } catch {
    return NextResponse.json({ error: "invalid body", code: "invalid_body" }, { status: 400 });
  }
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
    return NextResponse.json({ error: "ids must be a string array", code: "invalid_body" }, { status: 400 });
  }
  if (ids.length > MAX_DESCRIPTION_BATCH) ids = (ids as string[]).slice(0, MAX_DESCRIPTION_BATCH);

  const descriptions = await getSkillDescriptions(ids as string[]);
  return NextResponse.json({ descriptions });
}
