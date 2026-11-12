import { NextResponse } from "next/server";
import { jsonError, requireUserOrOpenInstance } from "@/lib/auth/http";
import { visibleChats } from "@/lib/statistics/access";
import { todayIn } from "@/lib/statistics/days";
import { labelsWithin } from "@/lib/statistics/labels";
import { buildDeepDive, buildStatistics } from "@/lib/statistics/query";
import { parseGroupBy, parseOptionalPeriod, parsePeriod, parseSession } from "@/lib/statistics/request";
import { freshStore } from "@/lib/statistics/service";

/**
 * What the Statistics page reads.
 *
 * `GET ?preset=today|7d|30d|90d` or `?from=YYYY-MM-DD&to=YYYY-MM-DD`, with
 * `&groupBy=provider|project|model|worker`, answers the totals of the period
 * and of the one before it, the ring tree, the daily timeline and a few plain
 * findings. `&refresh=1` asks for a fresh pass over the transcripts (at most
 * once every 20 seconds).
 *
 * `GET ?session=<chat id>` (optionally with the same period) answers one
 * chat's deep dive: its priciest turns, what each kind of work did and its
 * subagents.
 *
 * Only the viewer's own chats are counted (lib/auth/session-owners.ts); a chat
 * somebody else owns answers 404 exactly like one that does not exist.
 *
 * The index is built from the transcripts in the background. A request waits a
 * moment for a running pass and otherwise answers with what is on file and
 * `updating: true`, so the page asks again.
 */

export const dynamic = "force-dynamic";

const NO_STORE = { headers: { "Cache-Control": "no-store" } };
/** How long a request waits for the indexer, then for the chat titles, before answering with what it has. */
const INDEX_WAIT_MS = 300;
const LABEL_WAIT_MS = 400;

export async function GET(request: Request) {
  const resolved = requireUserOrOpenInstance(request);
  if ("response" in resolved) return resolved.response;
  const params = new URL(request.url).searchParams;

  const groupBy = parseGroupBy(params);
  if (!groupBy.ok) return jsonError(groupBy.error, 400, groupBy.code);
  const session = parseSession(params);
  if (!session.ok) return jsonError(session.error, 400, session.code);

  const now = Date.now();
  const { store, status } = await freshStore({ refresh: params.get("refresh") === "1", waitMs: INDEX_WAIT_MS, now });
  const today = todayIn(store.zone, now);
  const { labels, ready } = await labelsWithin(store, LABEL_WAIT_MS, now);
  // Plain names are a reason to ask again, the same as a half-built index.
  const settled = { ...status, updating: status.updating || !ready };
  const visible = visibleChats(store, resolved.user);

  if (session.value !== null) {
    const period = parseOptionalPeriod(params, today);
    if (!period.ok) return jsonError(period.error, 400, period.code);
    const dive = visible(session.value) ? buildDeepDive({ store, chat: session.value, period: period.value, labels, status: settled }) : null;
    return dive ? NextResponse.json(dive, NO_STORE) : jsonError("No usage is recorded for that chat", 404, "not_found");
  }

  const period = parsePeriod(params, today);
  if (!period.ok) return jsonError(period.error, 400, period.code);
  return NextResponse.json(buildStatistics({ store, now, period: period.value, groupBy: groupBy.value, visible, labels, status: settled }), NO_STORE);
}
