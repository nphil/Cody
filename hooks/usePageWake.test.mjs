import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * Which surfaces listen for the shared "page woke up" signal, pinned at the
 * seam. The signal itself (debounce, clock jump, back/forward cache) is tested
 * with a fake clock in lib/page-wake.test.mjs, the sidebar's and the chat's own
 * reactions in components/SessionSidebar.test.mjs and hooks/useAgentSession.test.mjs.
 * What is pinned here is the rest: each surface that can show a figure the
 * sleep made old re-reads on the one signal, instead of growing listeners of
 * its own that would each send a request of their own.
 */

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const [hookSource, usage, scheduled, scheduledSync, statistics, display] = await Promise.all([
  read("./usePageWake.ts"),
  read("./useUsage.ts"),
  read("./useScheduledMessages.ts"),
  read("../lib/scheduled/sync.ts"),
  read("../components/statistics/useStatisticsData.ts"),
  read("./useDisplayRequests.ts"),
]);

test("the hook hands the latest callback to the shared subscription and unsubscribes when disabled", () => {
  assert.match(hookSource, /subscribePageWake\(\(event\) => latest\.current\(event\)\)/);
  assert.match(hookSource, /if \(!enabled\) return;/);
  assert.match(hookSource, /\}, \[enabled\]\);/);
});

test("the plan-quota read goes again on a wake, and lets go of a read the sleep left hanging", () => {
  assert.match(usage, /import \{ usePageWake \} from "@\/hooks\/usePageWake";/);
  const wake = usage.slice(usage.indexOf("usePageWake(() => {"), usage.indexOf("useEffect(() => {", usage.indexOf("usePageWake(() => {")));
  assert.match(wake, /inFlightRef\.current = false;/);
  assert.match(wake, /refresh\(\);/);
  assert.match(wake, /\}, enabled\);/);
});

test("banked reset credits re-read on a wake, with no listeners of their own left to double it", () => {
  const credits = usage.slice(usage.indexOf("export function useResetCredits"));
  assert.match(credits, /usePageWake\(\(\) => refresh\(\), enabled\);/);
  assert.doesNotMatch(credits, /addEventListener/);
  assert.doesNotMatch(credits, /refreshOnFocus/);
});

test("scheduled messages restart their read on a wake; the tab flip still re-arms the timer", () => {
  assert.match(scheduled, /usePageWake\(\(\) => syncRef\.current\?\.restart\(\)\);/);
  assert.match(scheduled, /document\.addEventListener\("visibilitychange", onVisibility\)/);
  assert.doesNotMatch(scheduled, /addEventListener\("(focus|online)"/);
  assert.match(scheduledSync, /^\s+restart\(\): void;/m);
  assert.match(scheduledSync, /^\s+restart,$/m);
});

test("Statistics reads again on a wake without forcing the server's re-scan", () => {
  assert.match(statistics, /usePageWake\(retry\);/);
  assert.doesNotMatch(statistics, /usePageWake\(refresh\)/);
});

test("the display stream is a self-healing stream that opens again on a wake, and a wake never replays the live handler", () => {
  assert.doesNotMatch(display, /new EventSource/);
  assert.match(display, /openLiveStream\(\{/);
  assert.match(display, /usePageWake\(\(\) => streamRef\.current\?\.reopen\(\)\);/);
  // The greeting of a new connection is a snapshot; only a live `request` event runs the handler.
  assert.match(display, /if \(event\.type === "request" && event\.request\) liveHandler\.current\(event\.request\);/);
  // The bus is quiet until the agent publishes something: no silence limit.
  assert.doesNotMatch(display, /silenceLimitMs/);
});
