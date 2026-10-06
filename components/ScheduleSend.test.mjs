import assert from "node:assert/strict";
import test, { mock } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { SendPill } = await jiti.import("./SendPill.tsx");
const { ScheduleMenu, ScheduleMenuBody } = await jiti.import("./ScheduleMenu.tsx");
const { ScheduledRows } = await jiti.import("./ScheduledRows.tsx");
const { pickBounds } = await jiti.import("../lib/scheduled/ui.ts");

const render = (type, props) => renderToStaticMarkup(React.createElement(type, props));

/** The opening tag of the element carrying this test id. */
function tagOf(html, testId) {
  const match = html.match(new RegExp(`<[a-z]+[^>]*data-testid="${testId}"[^>]*>`));
  assert.ok(match, `no element with data-testid="${testId}"`);
  return match[0];
}

const has = (html, testId) => new RegExp(`data-testid="${testId}"`).test(html);
const isDisabled = (tag) => /\sdisabled(="")?(\s|>|\/)/.test(tag);
/** Intl may put a narrow no-break space before AM/PM; `\s` matches it. */
const spaced = (text) => text.replace(/ /g, "\\s");

/* ───────────────────────────────────── the Send pill ───────────────────────────────────── */

const pill = {
  isMobile: false,
  ready: true,
  sendDisabled: false,
  block: null,
  quota: null,
  onSend() {},
  onSchedule() {},
};

test("desktop: Send keeps its word and the menu zone joins the same pill, 22px wide", () => {
  const html = render(SendPill, pill);
  assert.equal((html.match(/data-testid="send-pill"/g) ?? []).length, 1, "one pill");
  const main = tagOf(html, "send-button");
  assert.doesNotMatch(main, /aria-label/, "the word is on the button");
  assert.match(html, /Send<\/button>/);
  const zone = tagOf(html, "send-menu-button");
  assert.match(zone, /aria-haspopup="menu"/);
  assert.match(zone, /aria-expanded="false"/);
  assert.match(zone, /aria-label="Send options"/);
  assert.match(zone, /width:22px/);
  assert.match(tagOf(html, "send-pill"), /height:28px/);
});

test("phone: Send stays icon-only at 38px and the menu zone adds 24px to the same pill", () => {
  const html = render(SendPill, { ...pill, isMobile: true });
  const main = tagOf(html, "send-button");
  assert.match(main, /aria-label="Send"/, "the word survives as the accessible name");
  assert.match(main, /width:38px/);
  assert.doesNotMatch(html, /Send<\/button>/, "no visible word");
  assert.match(tagOf(html, "send-menu-button"), /width:24px/);
  assert.match(tagOf(html, "send-pill"), /height:38px/);
});

test("an empty composer: Send is switched off and quiet, but the menu zone is still reachable to say why", () => {
  const html = render(SendPill, { ...pill, ready: false, sendDisabled: true, block: "empty" });
  assert.match(tagOf(html, "send-pill"), /data-ready="false"/);
  const main = tagOf(html, "send-button");
  assert.match(main, /aria-disabled="true"/);
  assert.match(main, /cursor:not-allowed/);
  assert.equal(isDisabled(tagOf(html, "send-menu-button")), false);
  // A really disabled button would swallow the pointer events the long press listens to.
  assert.equal(isDisabled(main), false);
});

test("a ready composer wears the accent and Send is live", () => {
  const html = render(SendPill, pill);
  assert.match(tagOf(html, "send-pill"), /data-ready="true"/);
  assert.match(tagOf(html, "send-button"), /aria-disabled="false"/);
});

test("the menu is not in the page until it is opened", () => {
  const html = render(SendPill, pill);
  assert.equal(has(html, "schedule-menu"), false);
  assert.equal(has(html, "schedule-sheet"), false);
});

/* ───────────────────────────────────── the menu's rows ───────────────────────────────────── */

/** An instant on the wall clock of whatever zone the test runs in (month is 0-based). */
const wall = (y, mo, d, h = 0, mi = 0) => new Date(y, mo, d, h, mi).getTime();
const MORNING = wall(2026, 9, 6, 10, 0);

const bodyProps = (overrides = {}) => ({
  presentation: "popover",
  now: MORNING,
  block: null,
  quota: null,
  picking: false,
  pickValue: "2026-10-06T11:00",
  pickProblem: null,
  onPickValueChange() {},
  onSendNow() {},
  onQuota() {},
  onChip() {},
  onTogglePick() {},
  onConfirmPick() {},
  ...overrides,
});

const quotaSource = (overrides = {}) => ({
  known: true,
  provider: "anthropic",
  resetsAt: new Date(MORNING + 3 * 3_600_000).toISOString(),
  accounts: [{ label: "Primary" }, { label: "Secondary" }],
  ...overrides,
});

test("the menu offers Send now, When quota resets and Send at… with its quick times, all on", () => {
  const html = render(ScheduleMenuBody, bodyProps({ quota: quotaSource() }));
  for (const id of ["schedule-send-now", "schedule-quota", "schedule-chip-in-1h", "schedule-chip-tonight", "schedule-chip-tomorrow", "schedule-chip-pick"]) {
    assert.equal(isDisabled(tagOf(html, id)), false, id);
  }
  assert.match(html, /Send now/);
  assert.match(html, /When quota resets/);
  assert.match(html, /Send at…/);
  assert.match(html, /In 1 hour/);
  assert.match(html, new RegExp(spaced("Tonight 11 PM")));
  assert.match(html, new RegExp(spaced("Tomorrow 9 AM")));
  assert.match(html, /Pick…/);
  assert.equal(has(html, "schedule-reason"), false, "nothing is wrong, so nothing is explained");
});

test("the quota row names whose quota and when it refills, and needs no email", () => {
  const html = render(ScheduleMenuBody, bodyProps({ quota: quotaSource() }));
  assert.match(html, /Claude · Primary refills at \d{1,2}:\d{2}/);
  assert.doesNotMatch(html, /@/);
});

test("with no reset time to wait for, the quota row is switched off and says why", () => {
  for (const quota of [null, { known: false }, quotaSource({ resetsAt: null }), quotaSource({ resetsAt: new Date(MORNING - 1000).toISOString() })]) {
    const html = render(ScheduleMenuBody, bodyProps({ quota }));
    assert.equal(isDisabled(tagOf(html, "schedule-quota")), true, JSON.stringify(quota));
    assert.match(html, /Cody can&#x27;t see when this model&#x27;s quota resets\./);
    // The rest of the menu is unaffected.
    assert.equal(isDisabled(tagOf(html, "schedule-chip-in-1h")), false);
  }
});

test("'Tonight 11 PM' is not offered once 11 PM has passed", () => {
  const html = render(ScheduleMenuBody, bodyProps({ now: wall(2026, 9, 6, 23, 30) }));
  assert.equal(has(html, "schedule-chip-tonight"), false);
  assert.equal(has(html, "schedule-chip-tomorrow"), true);
});

test("an empty composer switches off every row and says to write something", () => {
  const html = render(ScheduleMenuBody, bodyProps({ block: "empty", quota: quotaSource() }));
  for (const id of ["schedule-send-now", "schedule-quota", "schedule-chip-in-1h", "schedule-chip-tomorrow", "schedule-chip-pick"]) {
    assert.equal(isDisabled(tagOf(html, id)), true, id);
  }
  assert.match(html, /Write a message first\./);
});

test("while attachments are still being prepared nothing can go, now or later", () => {
  const html = render(ScheduleMenuBody, bodyProps({ block: "preparing", quota: quotaSource() }));
  assert.equal(isDisabled(tagOf(html, "schedule-send-now")), true);
  assert.equal(isDisabled(tagOf(html, "schedule-quota")), true);
  assert.match(html, /Finishing the attachments…/);
});

test("a message that cannot be scheduled can still be sent now, and the menu says which and why", () => {
  const reasons = {
    "no-session": /Send the first message before scheduling\./,
    images: /Images can only be sent now\./,
    shell: /Shell commands can only be sent now\./,
  };
  for (const [block, reason] of Object.entries(reasons)) {
    const html = render(ScheduleMenuBody, bodyProps({ block, quota: quotaSource() }));
    assert.equal(isDisabled(tagOf(html, "schedule-send-now")), false, `${block}: Send now`);
    assert.equal(isDisabled(tagOf(html, "schedule-quota")), true, `${block}: quota`);
    assert.equal(isDisabled(tagOf(html, "schedule-chip-in-1h")), true, `${block}: chip`);
    assert.match(html, reason, block);
  }
});

test("Pick… opens a native date-time field bounded to the next minute and 30 days out", () => {
  const bounds = pickBounds(MORNING);
  const html = render(ScheduleMenuBody, bodyProps({ picking: true, pickValue: bounds.initial }));
  const input = tagOf(html, "schedule-pick-input");
  assert.match(input, /type="datetime-local"/);
  assert.match(input, new RegExp(`min="${bounds.min}"`));
  assert.match(input, new RegExp(`max="${bounds.max}"`));
  assert.match(input, new RegExp(`value="${bounds.initial}"`));
  assert.equal(isDisabled(tagOf(html, "schedule-pick-confirm")), false);
  assert.match(tagOf(html, "schedule-chip-pick"), /aria-expanded="true"/);
  assert.equal(has(html, "schedule-pick-problem"), false);
});

test("a time that cannot be scheduled is explained under the field", () => {
  const words = {
    empty: /Pick a date and time\./,
    past: /That time has already passed\. Pick a later one\./,
    far: /Pick a time within 30 days\./,
  };
  for (const [problem, text] of Object.entries(words)) {
    const html = render(ScheduleMenuBody, bodyProps({ picking: true, pickProblem: problem }));
    assert.match(html, text, problem);
    assert.match(tagOf(html, "schedule-pick-input"), /aria-invalid="true"/);
  }
});

test("the field is not offered while scheduling is off", () => {
  const html = render(ScheduleMenuBody, bodyProps({ picking: true, block: "images" }));
  assert.equal(has(html, "schedule-pick-input"), false);
});

const anchor = { top: 700, left: 880, right: 960, bottom: 728 };
const menu = (presentation, extra = {}) => ({
  presentation,
  anchor,
  block: null,
  quota: null,
  onSendNow() {},
  onSchedule() {},
  onClose() {},
  ...extra,
});

test("on a mouse the menu is a popover with 40px rows and the Enter hint on Send now", () => {
  const html = render(ScheduleMenu, menu("popover"));
  const root = tagOf(html, "schedule-menu");
  assert.match(root, /role="menu"/);
  assert.match(root, /data-presentation="popover"/);
  assert.match(root, /aria-label="Send options"/);
  assert.match(root, /class="dropdown-surface"/);
  assert.equal(has(html, "schedule-sheet"), false);
  assert.match(tagOf(html, "schedule-send-now"), /min-height:40px/);
  assert.match(tagOf(html, "schedule-quota"), /min-height:40px/);
  assert.match(html, /<kbd[^>]*>Enter<\/kbd>/);
});

test("on a touch screen the menu is a bottom sheet with 48px rows and bigger chips", () => {
  const html = render(ScheduleMenu, menu("sheet"));
  assert.match(tagOf(html, "schedule-sheet"), /position:fixed/);
  const root = tagOf(html, "schedule-menu");
  assert.match(root, /role="menu"/);
  assert.match(root, /data-presentation="sheet"/);
  assert.match(root, /class="schedule-sheet"/);
  assert.match(tagOf(html, "schedule-send-now"), /min-height:48px/);
  assert.match(tagOf(html, "schedule-quota"), /min-height:48px/);
  assert.match(tagOf(html, "schedule-chip-in-1h"), /min-height:44px/);
  assert.doesNotMatch(html, /<kbd/, "no key hints on a screen with no keyboard");
  assert.match(root, /padding:[^;"]*var\(--safe-bottom\)/, "clear of the home indicator");
});

/* ───────────────────────────────────── the scheduled rows ───────────────────────────────────── */

const NOON = wall(2026, 9, 6, 12, 0);
const iso = (ms) => new Date(ms).toISOString();
const entry = (id, overrides = {}) => ({
  id,
  sessionId: "chat-1",
  message: `message ${id}`,
  mode: "at",
  at: iso(NOON + 3_600_000),
  source: "user",
  status: "pending",
  createdAt: iso(NOON - 60_000),
  ...overrides,
});

function rows(items, overrides = {}) {
  const clock = mock.method(Date, "now", () => NOON);
  try {
    return render(ScheduledRows, {
      items,
      busy: new Set(),
      roundTop: true,
      isMobile: false,
      onEdit() {},
      onSendNow() {},
      onCancel() {},
      ...overrides,
    });
  } finally {
    clock.mock.restore();
  }
}

/** The rows' opening tags, in order. */
const rowTags = (html) => html.match(/<div[^>]*data-testid="scheduled-row"[^>]*>/g) ?? [];
/** The action buttons' titles, which name what each does. */
const actionTitles = (html) => [...html.matchAll(/<button[^>]*class="scheduled-row__action"[^>]*title="([^"]*)"/g)].map((match) => match[1]);

test("no scheduled messages, no rows", () => {
  assert.equal(rows([]), "");
});

test("a timed message reads its time, its text, and offers Edit, Send now and Cancel", () => {
  const html = rows([entry("a", { message: "run the full suite and report" })]);
  assert.equal(rowTags(html).length, 1);
  assert.match(rowTags(html)[0], /data-scheduled-status="pending"/);
  assert.match(rowTags(html)[0], /data-scheduled-mode="at"/);
  assert.match(html, new RegExp(`data-testid="scheduled-row-when"[^>]*>${spaced("at 1:00 PM")}<`));
  assert.match(html, /run the full suite and report/);
  assert.deepEqual(actionTitles(html), [
    "Cancel this scheduled message and put its text back in the box",
    "Send this message now instead of waiting",
    "Cancel this scheduled message",
  ]);
  assert.match(html, />Edit</);
  assert.match(html, />Send now</);
  assert.match(html, />Cancel</);
});

test("a message waiting for the quota to refill says so, and 'checking quota' once the reset has passed", () => {
  const waiting = rows([entry("q", { mode: "quota", at: iso(NOON + 3_600_000), quota: { label: "Claude · Secondary", giveUpAt: iso(NOON + 90_000_000) } })]);
  assert.match(rowTags(waiting)[0], /data-scheduled-mode="quota"/);
  assert.match(waiting, new RegExp(`when quota resets \\(${spaced("1:00 PM")}\\)`));
  const checking = rows([entry("q", { mode: "quota", at: iso(NOON - 60_000), quota: { label: "Claude · Secondary", giveUpAt: iso(NOON + 90_000_000) } })]);
  assert.match(checking, /checking quota…/);
  assert.match(rowTags(checking)[0], /data-scheduled-status="checking"/);
});

test("a message the agent scheduled says so, on a desktop and on a phone alike; one the person scheduled does not", () => {
  for (const isMobile of [false, true]) {
    const html = rows([entry("g", { source: "agent" })], { isMobile });
    assert.match(html, /data-scheduled-source="agent"/);
    assert.match(html, /data-testid="scheduled-row-agent"[^>]*>.*by the agent/s);
  }
  assert.doesNotMatch(rows([entry("u")]), /by the agent/);
});

test("a phone row keeps the width for the text and puts the time under it; a desktop row puts the time first", () => {
  const order = (html) => [html.indexOf('data-testid="scheduled-row-when"'), html.indexOf('data-testid="scheduled-row-text"')];
  const [phoneWhen, phoneText] = order(rows([entry("p")], { isMobile: true }));
  assert.ok(phoneText > 0 && phoneWhen > phoneText, "text, then time");
  const [deskWhen, deskText] = order(rows([entry("d")]));
  assert.ok(deskWhen > 0 && deskText > deskWhen, "time, then text");
});

test("a failed message stays as a red row with the reason, Retry, Edit and Cancel — and no Send now", () => {
  const html = rows([entry("f", { status: "failed", error: "The chat no longer exists." })]);
  assert.match(rowTags(html)[0], /data-scheduled-status="failed"/);
  assert.match(rowTags(html)[0], /role="status"/);
  assert.match(html, /Failed to send/);
  assert.match(html, /data-testid="scheduled-row-note"[^>]*>The chat no longer exists\.</);
  assert.deepEqual(actionTitles(html), [
    "Try sending this message again now",
    "Cancel this scheduled message and put its text back in the box",
    "Cancel this scheduled message",
  ]);
  assert.match(html, />Retry</);
  assert.doesNotMatch(html, />Send now</);
});

test("a message on its way has nothing to press", () => {
  const html = rows([entry("s", { status: "sending" })]);
  assert.match(html, /sending…/);
  assert.deepEqual(actionTitles(html), []);
});

test("on a phone Send now and Cancel are icons with their names, and Edit keeps its word", () => {
  const html = rows([entry("p")], { isMobile: true });
  assert.match(html, /aria-label="Send now"/);
  assert.match(html, /aria-label="Cancel"/);
  assert.match(html, />Edit</);
  assert.doesNotMatch(html, />Send now</);
  assert.doesNotMatch(html, />Cancel</);
  assert.equal(actionTitles(html).length, 3);
});

test("a row whose own request is in flight waits; its neighbours do not", () => {
  const html = rows([entry("a"), entry("b", { at: iso(NOON + 7_200_000) })], { busy: new Set(["a"]) });
  const buttons = html.split('data-testid="scheduled-row"').slice(1).map((chunk) => (chunk.match(/<button[^>]*>/g) ?? []));
  assert.equal(buttons[0].length, 3);
  assert.ok(buttons[0].every((tag) => isDisabled(tag)), "row a is busy");
  assert.ok(buttons[1].every((tag) => !isDisabled(tag)), "row b is free");
});

test("the stack's top corners are rounded by its first row only", () => {
  const top = rowTags(rows([entry("a"), entry("b")], { roundTop: true }));
  assert.match(top[0], /border-radius:var\(--radius-card\) var\(--radius-card\) 0 0/);
  assert.match(top[1], /border-radius:0/);
  const under = rowTags(rows([entry("a"), entry("b")], { roundTop: false }));
  assert.match(under[0], /border-radius:0/);
});

test("a long list folds behind '<n> more scheduled' and a short one shows in full", () => {
  const many = Array.from({ length: 6 }, (_, index) => entry(`m${index}`, { at: iso(NOON + (index + 1) * 3_600_000) }));
  const folded = rows(many);
  assert.equal(rowTags(folded).length, 3);
  assert.match(tagOf(folded, "scheduled-rows-toggle"), /aria-expanded="false"/);
  assert.match(folded, /3 more scheduled/);
  const four = rows(many.slice(0, 4));
  assert.equal(rowTags(four).length, 4, "a fold that hides one row saves nothing");
  assert.equal(has(four, "scheduled-rows-toggle"), false);
});

test("a row's text is cut for the line but whole in its tooltip, and a huge one is never copied whole", () => {
  const html = rows([entry("h", { message: `start ${"x".repeat(5000)}` })]);
  const title = html.match(/data-testid="scheduled-row-text"[^>]*title="([^"]*)"/)?.[1] ?? "";
  assert.ok(title.startsWith("start xxx"));
  assert.ok(title.length <= 600, `title is ${title.length} characters`);
  assert.ok(html.length < 12_000, "the page does not carry the whole message twice");
});
