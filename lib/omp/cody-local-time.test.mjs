import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * The hidden line the agent reads before every prompt
 * (lib/omp/extensions/cody-local-time.ts). omp loads that file under Bun, with
 * no Cody imports, so it repeats a few helpers of lib/time-zone.ts; these tests
 * run both on the same inputs so the copies cannot drift, and drive the real
 * handler the way omp does.
 */
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const extension = await jiti.import("./extensions/cody-local-time.ts");
const shared = await jiti.import("../time-zone.ts");

function register() {
  const handlers = {};
  extension.default({ on: (event, handler) => { handlers[event] = handler; } });
  assert.deepEqual(Object.keys(handlers), ["before_agent_start"], "one hook, and no system-prompt rewrite");
  return handlers.before_agent_start;
}

/** What omp hands a handler. `answer` is what Cody's reply to the zone question looks like. */
function context({ answer, kind = "main", mode = "rpc", branch = [] } = {}) {
  const asked = [];
  return {
    asked,
    mode,
    agent: { kind },
    sessionManager: { getBranch: () => branch },
    ui: {
      input: async (title, _placeholder, options) => {
        asked.push({ title, options });
        if (answer instanceof Error) throw answer;
        return answer;
      },
    },
  };
}

const hiddenLine = (zone) => ({ type: "custom_message", id: "aa", customType: "cody-local-time", content: "Current local time: …", display: false, details: { zone } });
const answer = (zone, shell = zone) => JSON.stringify({ zone, shell });

test("the file's copy of the clock line is word for word the shared one, across zones and the shifts between them", () => {
  const instants = [
    "2026-10-02T18:58:00Z", // Friday evening in New York
    "2026-12-15T04:05:00Z", // standard time, and midnight-adjacent in New York
    "2026-03-08T07:30:00Z", // the hour before US clocks spring forward
    "2026-04-04T15:29:00Z", // Lord Howe's half-hour DST edge
    "2026-07-01T00:00:00Z",
  ];
  const zones = ["America/New_York", "Asia/Tokyo", "Asia/Kolkata", "Asia/Kathmandu", "Europe/London", "Australia/Lord_Howe", "Pacific/Auckland", "UTC"];
  for (const iso of instants) {
    for (const zone of zones) {
      assert.equal(extension.describeLocalNow(new Date(iso), zone), shared.describeLocalNow(iso, zone), `${zone} at ${iso}`);
    }
  }
  for (const value of ["America/New_York", "asia/tokyo", ":Europe/Paris", "Mars/Phobos", "+05:00", "", 3]) {
    assert.equal(extension.canonicalZone(value), shared.normalizeTimeZone(value), JSON.stringify(value));
  }
});

test("the agent is told the time in the zone of the message, as one short hidden line", async () => {
  const handler = register();
  const ctx = context({ answer: answer("America/New_York") });
  const result = await handler({ prompt: "what time is it?" }, ctx);

  assert.equal(result.message.customType, shared.LOCAL_TIME_CUSTOM_TYPE, "the type the transcript hides");
  assert.equal(result.message.display, false, "never a bubble");
  assert.equal(result.message.attribution, "agent", "an engine note, not something the user said");
  assert.deepEqual(result.message.details, { zone: "America/New_York" }, "remembered, so the next prompt can say the zone changed");

  const line = result.message.content;
  assert.match(line, /^Current local time: \w+day \d{1,2} \w+ \d{4}, \d{2}:\d{2} E[SD]T \(America\/New_York, UTC-0[45]:00\)\. Use this time zone for any times you state to the user\.$/);
  assert.ok(!line.includes("\n") && line.length < 220, `one short line, got ${line.length} chars`);
  assert.equal(ctx.asked.length, 1);
  assert.match(ctx.asked[0].title, /^CODY_TIME_ZONE /, "the question Cody intercepts");
  assert.ok(ctx.asked[0].options.timeout > 0, "bounded, so a host that never answers cannot hang a prompt");
});

test("the line says so when the device's zone changed since the last prompt, and only then", async () => {
  const handler = register();

  const moved = await handler({}, context({ answer: answer("Asia/Tokyo"), branch: [hiddenLine("America/New_York")] }));
  assert.match(moved.message.content, /^The user's device time zone changed: was America\/New_York, now Asia\/Tokyo\. Current local time: .*\(Asia\/Tokyo, UTC\+09:00\)/);

  const same = await handler({}, context({ answer: answer("Asia/Tokyo"), branch: [hiddenLine("Asia/Tokyo")] }));
  assert.doesNotMatch(same.message.content, /changed/);

  const first = await handler({}, context({ answer: answer("Asia/Tokyo"), branch: [] }));
  assert.doesNotMatch(first.message.content, /changed/, "a first prompt has nothing to have changed from");

  // The latest line wins, and other custom messages are not mistaken for it.
  const branch = [hiddenLine("Europe/Paris"), { type: "custom_message", customType: "xdev-mount-notice", details: { zone: "Mars/Phobos" } }, hiddenLine("America/New_York")];
  const latest = await handler({}, context({ answer: answer("Asia/Tokyo"), branch }));
  assert.match(latest.message.content, /was America\/New_York, now Asia\/Tokyo/);
});

test("a shell that still runs in the old zone is called out, so the agent never guesses which clock `date` reads", async () => {
  const handler = register();
  const result = await handler({}, context({ answer: answer("Asia/Tokyo", "America/New_York") }));
  assert.match(result.message.content, /Current local time: .*\(Asia\/Tokyo, UTC\+09:00\)\. Use this time zone for any times you state to the user\. Shell commands \(`date`\) still report America\/New_York until the next idle restart\.$/);

  const aligned = await handler({}, context({ answer: answer("Asia/Tokyo") }));
  assert.doesNotMatch(aligned.message.content, /Shell commands/);
});

test("with no usable answer the process's own zone is used for both, and the prompt still goes", async () => {
  const handler = register();
  const previous = process.env.TZ;
  process.env.TZ = "Asia/Kolkata";
  try {
    for (const reply of [undefined, new Error("the host went away"), "not json", JSON.stringify({ zone: "Mars/Phobos", shell: "Asia/Tokyo" }), JSON.stringify([1])]) {
      const result = await handler({}, context({ answer: reply }));
      assert.match(result.message.content, /\(Asia\/Calcutta, UTC\+05:30\)/, `reply: ${String(reply)}`);
      assert.doesNotMatch(result.message.content, /Shell commands|changed/);
    }
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test("subagents are left alone, and a terminal UI is never asked a question it cannot answer", async () => {
  const handler = register();
  const sub = context({ answer: answer("Asia/Tokyo"), kind: "sub" });
  assert.equal(await handler({}, sub), undefined);
  assert.equal(sub.asked.length, 0);

  const tui = context({ answer: answer("Asia/Tokyo"), mode: "tui" });
  const result = await handler({}, tui);
  assert.equal(tui.asked.length, 0, "a person at a terminal would see the question");
  assert.equal(result.message.display, false, "but the line is still given");
});
