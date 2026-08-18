import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
process.env.CODY_INTERNAL_DISPLAY_SECRET ??= "display-test-secret";
process.env.CODY_INTERNAL_DISPLAY_ORIGIN ??= "http://127.0.0.1:30178";

// The app-log ring (lib/logs/ring.ts) is what stands between a React render
// loop and the Node process's heap, so every bound it claims is tested here.

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  MAX_BYTES,
  MAX_ENTRIES,
  MAX_DIGEST_BYTES,
  MAX_LIMIT,
  appLogNotice,
  formatAppLogDigest,
  markAppLogsRead,
  parseSince,
  readAppLogs,
  recordAppLog,
  resetAppLogsForTests,
} = await jiti.import("./logs/ring.ts");
const { aliasDisplaySession, resetDisplayBusForTests } = await jiti.import("./display/bus.ts");

/** A console.error the app repeats, identical every time. */
function loopLine(session, at) {
  recordAppLog(session, {
    level: "error",
    source: "console",
    text: "Cannot read properties of undefined (reading 'map')\nat Row (http://127.0.0.1:3000/app.js:12:19)",
    url: "http://127.0.0.1:3000/app.js",
    at,
  });
}

test("identical repeats collapse into one counted entry", () => {
  resetAppLogsForTests();
  for (let i = 0; i < 5_000; i += 1) loopLine("s-loop", 1_000 + i);

  const digest = readAppLogs("s-loop");
  assert.equal(digest.held, 1, "5000 identical lines must be one entry");
  assert.equal(digest.events, 5_000);
  assert.equal(digest.entries.length, 1);
  assert.equal(digest.entries[0].count, 5_000);
  assert.equal(digest.entries[0].firstSeen, 1_000);
  assert.equal(digest.entries[0].lastSeen, 5_999);
  assert.match(formatAppLogDigest(digest), /x5000 since /);
});

test("distinct lines are bounded by the entry cap", () => {
  resetAppLogsForTests();
  for (let i = 0; i < 5_000; i += 1) {
    recordAppLog("s-distinct", { level: "warning", source: "console", text: `slow render #${i}`, at: 1_000 + i });
  }

  const digest = readAppLogs("s-distinct", { limit: 1_000 });
  assert.equal(digest.held, MAX_ENTRIES);
  assert.equal(digest.dropped, 5_000 - MAX_ENTRIES);
  assert.equal(digest.events, 5_000);
  assert.equal(digest.matched, MAX_ENTRIES);
  // A digest is a digest: the ring holds 300, one read hands back at most 200.
  assert.equal(digest.entries.length, MAX_LIMIT);
  // Newest-last, and the survivors are the newest ones.
  assert.equal(digest.entries.at(-1).text, "slow render #4999");
  assert.equal(digest.entries[0].text, `slow render #${5_000 - MAX_LIMIT}`);
});

test("fat lines are bounded by the byte cap before the entry cap", () => {
  resetAppLogsForTests();
  const fat = "x".repeat(1_100);
  for (let i = 0; i < 2_000; i += 1) {
    recordAppLog("s-fat", { level: "error", source: "console", text: `${i} ${fat}`, url: `http://127.0.0.1:3000/chunk-${i}.js`, at: 1_000 + i });
  }

  const digest = readAppLogs("s-fat");
  assert.ok(digest.bytes <= MAX_BYTES, `bytes ${digest.bytes} must stay under ${MAX_BYTES}`);
  assert.ok(digest.held < MAX_ENTRIES, "the byte cap must bind first for 1.1 KB lines");
  assert.ok(digest.held > 0, "the ring must never empty itself");
  assert.equal(digest.held + digest.dropped, 2_000);
});

test("a line that is still firing outlives stale one-offs", () => {
  resetAppLogsForTests();
  loopLine("s-lru", 1_000);
  for (let i = 0; i < MAX_ENTRIES - 1; i += 1) {
    recordAppLog("s-lru", { level: "info", source: "console", text: `one-off ${i}`, at: 2_000 + i });
  }
  // Ring is exactly full; the loop line is the oldest by insertion.
  assert.equal(readAppLogs("s-lru").held, MAX_ENTRIES);
  loopLine("s-lru", 9_000);
  for (let i = 0; i < 50; i += 1) {
    recordAppLog("s-lru", { level: "info", source: "console", text: `later ${i}`, at: 9_100 + i });
  }

  const digest = readAppLogs("s-lru", { level: "error", limit: MAX_ENTRIES });
  assert.equal(digest.matched, 1, "the repeating error must survive eviction");
  assert.equal(digest.entries[0].count, 2);
  assert.equal(readAppLogs("s-lru", { grep: "one-off 0$" }).matched, 0, "the stalest one-off must be gone");
});

test("the digest filters by level, age and pattern", () => {
  resetAppLogsForTests();
  const now = Date.now();
  recordAppLog("s-filter", { level: "debug", source: "console", text: "hydrating", at: now - 600_000 });
  recordAppLog("s-filter", { level: "warning", source: "network", text: "HTTP 404 Not Found (Script)", url: "http://127.0.0.1:3000/missing.js", at: now - 300_000 });
  recordAppLog("s-filter", { level: "error", source: "exception", text: "Uncaught TypeError: boom", at: now - 1_000 });

  assert.equal(readAppLogs("s-filter").matched, 3);
  assert.equal(readAppLogs("s-filter", { level: "warning" }).matched, 2);
  assert.equal(readAppLogs("s-filter", { level: "error" }).matched, 1);
  assert.equal(readAppLogs("s-filter", { since: now - 60_000 }).matched, 1);
  assert.equal(readAppLogs("s-filter", { grep: "missing\\.js" }).matched, 1, "grep must see the URL too");
  assert.equal(readAppLogs("s-filter", { grep: "[unclosed" }).matched, 0, "an uncompilable pattern degrades to substring, not an error");
  assert.equal(readAppLogs("s-filter", { limit: 2 }).entries.length, 2);
  // Newest-last regardless of the limit.
  assert.equal(readAppLogs("s-filter", { limit: 2 }).entries.at(-1).text, "Uncaught TypeError: boom");
});

test("the notice reports unread errors once and stays quiet after a read", () => {
  resetAppLogsForTests();
  assert.equal(appLogNotice("s-notice"), null, "a session with no logs says nothing");
  recordAppLog("s-notice", { level: "warning", source: "console", text: "deprecated prop", at: 1_000 });
  assert.equal(appLogNotice("s-notice"), null, "warnings alone must not interrupt");

  for (let i = 0; i < 1_200; i += 1) loopLine("s-notice", 2_000 + i);
  recordAppLog("s-notice", { level: "error", source: "network", text: "Request failed: net::ERR_CONNECTION_REFUSED (Fetch)", url: "http://127.0.0.1:9/api", at: 4_000 });
  const first = appLogNotice("s-notice");
  assert.equal(first, "2 new app errors (1201 occurrences) in the previewed page since your last action — call read_app_logs to see them.");

  readAppLogs("s-notice");
  markAppLogsRead("s-notice");
  assert.equal(appLogNotice("s-notice"), null, "reading clears it");

  loopLine("s-notice", 5_000);
  assert.equal(appLogNotice("s-notice"), "1 new app error in the previewed page since your last action — call read_app_logs to see them.");
});

test("since accepts relative ages, ISO stamps and nothing else", () => {
  const now = 1_700_000_000_000;
  assert.equal(parseSince("90s", now), now - 90_000);
  assert.equal(parseSince("5m", now), now - 300_000);
  assert.equal(parseSince("2h", now), now - 7_200_000);
  assert.equal(parseSince("2026-08-18T00:00:00Z", now), Date.parse("2026-08-18T00:00:00Z"));
  assert.equal(parseSince(now - 1_000, now), now - 1_000);
  assert.equal(parseSince("yesterday", now), null);
  assert.equal(parseSince(undefined, now), null);
});

test("an empty ring explains itself and names the direct-rung blind spot", () => {
  resetAppLogsForTests();
  const text = formatAppLogDigest(readAppLogs("s-empty"));
  assert.match(text, /No app logs captured/);
  assert.match(text, /open_preview/);
  assert.match(text, /direct rung/);
});

test("one digest cannot flood the model's context", () => {
  resetAppLogsForTests();
  const fat = "z".repeat(900);
  for (let i = 0; i < 400; i += 1) {
    recordAppLog("s-budget", { level: "error", source: "console", text: `failure #${i} ${fat}`, at: 1_000 + i });
  }

  const digest = readAppLogs("s-budget", { limit: MAX_LIMIT });
  const text = formatAppLogDigest(digest);
  const [header, ...body] = text.split("\n");
  assert.ok(Buffer.byteLength(body.join("\n")) <= MAX_DIGEST_BYTES, `digest body ${Buffer.byteLength(body.join("\n"))} exceeds ${MAX_DIGEST_BYTES}`);
  assert.ok(body.every((line) => line.length <= 400), "every rendered line is clipped");
  // The newest match is never the one sacrificed, and the header says so.
  assert.ok(text.includes("failure #399"), "the newest entry must always be rendered");
  assert.match(header, /showing the newest \d+/);
  assert.ok(body.length < digest.entries.length, "the budget must have dropped the oldest matches");
});

test("an engine rekey keeps the model's logs reachable", () => {
  resetAppLogsForTests();
  resetDisplayBusForTests();
  recordAppLog("engine-old", { level: "error", source: "console", text: "before the rekey", at: 1_000 });
  aliasDisplaySession("engine-old", "engine-new");
  // The provider still holds the pre-rekey id; the ring resolves it forward.
  recordAppLog("engine-old", { level: "error", source: "console", text: "after the rekey", at: 2_000 });

  const digest = readAppLogs("engine-new");
  assert.equal(digest.matched, 1);
  assert.equal(digest.entries[0].text, "after the rekey");
  // Both ids now name the same bucket — the old one cannot read a stale ring.
  assert.deepEqual(readAppLogs("engine-old").entries.map((entry) => entry.text), ["after the rekey"]);
});
