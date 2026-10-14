import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

/**
 * The composer's daily-limit circle, its popover and the "time's up" notice,
 * rendered statically: what each phase draws, in which colour, how full, and
 * what it says. `initial` stands in for the shared store's first answer (the
 * seam TimeZoneSetting and ModelPresets use), because a static render always
 * sees the store empty.
 */
const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { DailyLimitPopover, DailyLimitRing, LimitGlyph, RING_SIZE } = await jiti.import("./DailyLimitRing.tsx");
const { DailyLimitNotice, DailyLimitNoticeBar } = await jiti.import("./DailyLimitNotice.tsx");
const { deriveView } = await jiti.import("../lib/daily-limit/view.ts");

const state = (usedSeconds, overrides = {}) => ({
  enabled: true,
  limitMinutes: 120,
  day: "2026-10-13",
  zone: "UTC",
  dayStartsAt: 0,
  dayEndsAt: 86_400_000,
  serverNow: 1,
  usedSeconds,
  extraSeconds: 0,
  limitSeconds: 7200,
  remainingSeconds: 7200 - usedSeconds,
  noticeDue: false,
  ...overrides,
});

const ring = (initial, isMobile = false) => renderToStaticMarkup(React.createElement(DailyLimitRing, { isMobile, initial }));
const text = (html) => html.replace(/<[^>]*>/g, "");

test("nothing is drawn while the limit is off or unknown", () => {
  assert.equal(ring(null), "");
  assert.equal(ring(state(100, { enabled: false })), "");
  assert.equal(renderToStaticMarkup(React.createElement(DailyLimitNotice, { initial: state(7200, { enabled: false, noticeDue: true }) })), "");
});

test("the ring is one circle with no text beside it, named for a screen reader and the tooltip by the time left", () => {
  const html = ring(state(2880));
  assert.match(html, /data-testid="daily-limit-ring"/);
  assert.match(html, /aria-label="1h 12m left today"/);
  assert.match(html, /title="1h 12m left today"/);
  assert.equal(text(html), "", "no words in the row — the popover has them");
  assert.equal((html.match(/<button/g) ?? []).length, 1);
  assert.match(html, /aria-haspopup="dialog"/);
  assert.match(html, /aria-expanded="false"/);
});

test("the circle is as tall as the Send/Stop pill: 28px on a desktop, 38px on a phone", () => {
  assert.deepEqual(RING_SIZE, { desktop: 28, phone: 38 });
  // The pill is `height: isMobile ? 38 : 28` in both of its renderers.
  for (const file of ["./SendPill.tsx", "./ChatInput.tsx"]) {
    assert.match(fs.readFileSync(new URL(file, import.meta.url), "utf8"), /height: isMobile \? 38 : 28/, file);
  }
  const desktop = ring(state(100));
  assert.match(desktop, /<button[^>]*style="[^"]*width:28px;height:28px/);
  assert.match(desktop, /<svg width="28" height="28" viewBox="0 0 28 28"/);
  const phone = ring(state(100), true);
  assert.match(phone, /<button[^>]*style="[^"]*width:38px;height:38px/);
  assert.match(phone, /<svg width="38" height="38" viewBox="0 0 38 38"/);
});

test("accent normally, warning for the last 15 minutes, error once the limit is spent", () => {
  const colour = (html) => html.match(/<button[^>]*style="[^"]*color:([^;"]+)/)?.[1];
  assert.equal(colour(ring(state(1800))), "var(--accent)");
  assert.equal(colour(ring(state(6300))), "var(--status-warning)");
  assert.equal(colour(ring(state(7200))), "var(--status-error)");
  assert.equal(colour(ring(state(7920))), "var(--status-error)");
  assert.match(ring(state(1800)), /data-phase="normal"/);
  assert.match(ring(state(6300)), /data-phase="warning"/);
  assert.match(ring(state(7200)), /data-phase="reached"/);
  assert.match(ring(state(7920)), /data-phase="over"/);
  assert.match(ring(state(7920)), /aria-label="12m over today&#x27;s limit"/);
});

test("the inside fills like liquid from the bottom: a clipped block slid up as the day is used, with a thin outline and no dot", () => {
  const glyph = (level, size = 28) => renderToStaticMarkup(React.createElement(LimitGlyph, { size, level }));
  const offsetOf = (html) => Number(html.match(/translateY\(([\d.]+)px\)/)[1]);
  const empty = glyph(0);
  const half = glyph(0.5);
  const full = glyph(1);

  // 0% = the block sits a full inner diameter down (hidden by the clip), 100% = it covers the circle.
  assert.ok(offsetOf(empty) > offsetOf(half) && offsetOf(half) > offsetOf(full));
  assert.equal(offsetOf(full), 0);
  assert.ok(Math.abs(offsetOf(half) - offsetOf(empty) / 2) < 1e-6, "halfway is half the travel");
  assert.equal(offsetOf(glyph(-3)), offsetOf(empty), "a level below 0 is empty");
  assert.equal(offsetOf(glyph(7)), 0, "a level above 1 is full");

  // The block is a rect clipped to the INNER circle; the outline is a separate thin ring.
  assert.match(full, /<clipPath id="daily-limit-clip-[A-Za-z0-9_-]+"><circle/);
  assert.match(full, /clip-path="url\(#daily-limit-clip-/);
  assert.match(full, /<rect[^>]*data-testid="daily-limit-liquid"/);
  const circles = [...full.matchAll(/<circle[^>]*\sr="([\d.]+)"/g)].map((m) => Number(m[1]));
  assert.equal(circles.length, 3, "outline, tint and clip: nothing else");
  assert.ok(Math.min(...circles) > 8, "no centre dot");
  const stroke = Number(full.match(/stroke-width="([\d.]+)"/)[1]);
  assert.ok(stroke <= 2, "the outline is thin");
  // The level change is a transform transition, which the global prefers-reduced-motion rule turns instant.
  assert.match(full, /transition:transform var\(--dur-slow\) var\(--ease-out-warm\)/);
  const css = fs.readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\*,\s*\*::before,\s*\*::after \{[^}]*transition-duration: 0\.001ms !important/);
});

test("two circles on a page never share a clip id", () => {
  const two = renderToStaticMarkup(React.createElement("div", null,
    React.createElement(LimitGlyph, { size: 28, level: 0.3 }),
    React.createElement(LimitGlyph, { size: 28, level: 0.6 })));
  const ids = [...two.matchAll(/<clipPath id="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(ids.length, 2);
  assert.notEqual(ids[0], ids[1]);
});

const popover = (used, overrides = {}) => renderToStaticMarkup(React.createElement(DailyLimitPopover, {
  view: deriveView(state(used, overrides)), onAdd() {}, onOpenSettings() {},
}));

test("the popover shows the time left in big numbers, what was used, the limit, and the way to Settings", () => {
  const html = popover(2880);
  assert.match(html, /role="dialog"/);
  assert.match(html, /data-testid="daily-limit-big"[^>]*>1h 12m</);
  assert.match(html, />left today</);
  assert.match(html, /Used today<\/dt><dd[^>]*>48m</);
  assert.match(html, /Daily limit<\/dt><dd[^>]*>2h</);
  assert.match(html, /Counts only while you&#x27;re actively using Cody\./);
  assert.match(html, /data-testid="daily-limit-settings-link"[^>]*>Time limit settings/);
  assert.doesNotMatch(html, /daily-limit-add/, "no Add button while there is time left");
});

test("the popover offers Add 15 minutes once the limit is spent, and says how far over", () => {
  for (const used of [6300, 6900]) assert.doesNotMatch(popover(used), /daily-limit-add/, `${used}s: still some left`);

  const reached = popover(7200);
  assert.match(reached, /daily-limit-add/);
  assert.match(reached, />Add 15 minutes</);
  assert.match(reached, /data-testid="daily-limit-big"[^>]*>0m</);
  assert.match(reached, />Limit reached</);

  const over = popover(7920);
  assert.match(over, /data-testid="daily-limit-big"[^>]*color:var\(--status-error\)[^>]*>12m</);
  assert.match(over, />over today&#x27;s limit</);
  assert.match(over, /daily-limit-add/);

  const added = popover(7920, { extraSeconds: 900, limitSeconds: 8100, remainingSeconds: 180 });
  assert.match(added, /Daily limit<\/dt><dd[^>]*>2h 15m</);
  assert.match(added, /includes 15m added today/);
  assert.match(added, /data-testid="daily-limit-big"[^>]*>3m</);
});

test("the time's-up notice says it once, calmly, with the two answers", () => {
  const due = state(7200, { noticeDue: true });
  const html = renderToStaticMarkup(React.createElement(DailyLimitNotice, { initial: due }));
  assert.match(html, /role="status"/);
  assert.match(html, /You&#x27;ve reached today&#x27;s 2h limit/);
  assert.match(html, /Nothing is blocked\. Your chats keep running\./);
  assert.match(html, /data-testid="daily-limit-notice-add"[^>]*>Add 15 minutes</);
  assert.match(html, /data-testid="daily-limit-notice-done"[^>]*>Done for today</);
  // Not due (dismissed, or time left): no bar.
  assert.equal(renderToStaticMarkup(React.createElement(DailyLimitNotice, { initial: state(7200, { noticeDue: false }) })), "");
  assert.equal(renderToStaticMarkup(React.createElement(DailyLimitNotice, { initial: state(100) })), "");
  // The limit named is today's own, extra time included.
  const extended = renderToStaticMarkup(React.createElement(DailyLimitNotice, { initial: state(8100, { noticeDue: true, extraSeconds: 900, limitSeconds: 8100, remainingSeconds: 0 }) }));
  assert.match(extended, /today&#x27;s 2h 15m limit/);
});

test("while an answer is being saved, both buttons wait; a finger gets taller buttons", () => {
  const view = deriveView(state(7200, { noticeDue: true }));
  const bar = (props) => renderToStaticMarkup(React.createElement(DailyLimitNoticeBar, { view, onAdd() {}, onDone() {}, ...props }));
  assert.equal((bar({ busy: "add" }).match(/disabled=""/g) ?? []).length, 2);
  assert.equal((bar({}).match(/disabled=""/g) ?? []).length, 0);
  assert.match(bar({ touch: true }), /min-height:44px/);
  assert.match(bar({}), /min-height:32px/);
});

test("the composer and the app shell carry the new pieces", () => {
  const input = fs.readFileSync(new URL("./ChatInput.tsx", import.meta.url), "utf8");
  assert.match(input, /<DailyLimitRing isMobile=\{isMobile\} \/>/);
  assert.match(input, /<DailyLimitNotice \/>/);
  // The ring sits before the quota gauge, and the notice above the Scheduled bar.
  assert.ok(input.indexOf("<DailyLimitRing") < input.indexOf("ref={contextPopoverRef}"));
  assert.ok(input.indexOf("<DailyLimitNotice") < input.indexOf("<ScheduledBar"));
  const shell = fs.readFileSync(new URL("./AppShell.tsx", import.meta.url), "utf8");
  assert.match(shell, /useDailyLimitTracker\(\);/);
});
