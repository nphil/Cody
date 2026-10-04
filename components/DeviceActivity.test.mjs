import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

/**
 * The Devices panel's activity list and approval cards, rendered for real: a burst of routine agent commands is one
 * compact entry with every command still inside it; what waits for the person comes first and shows the exact device,
 * action and a choice of when to send; an approved command shows its countdown and a Cancel; a cancel the system made
 * says why. Every string exists in all three languages.
 */

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { ActivityFeed } = await jiti.import("./devices/ActivityFeed.tsx");
const { OperationCard } = await jiti.import("./devices/OperationList.tsx");
const { groupActivity } = await jiti.import("../lib/devices/activity-groups.ts");
const { setLocale } = await jiti.import("../lib/i18n/index.tsx");

const locales = Object.fromEntries(
  await Promise.all(["en", "ja", "zh-CN"].map(async (name) => [name, JSON.parse(await readFile(new URL(`../lib/i18n/locales/${name}.json`, import.meta.url), "utf8"))])),
);

const escape = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
const manager = { cancel() { throw new Error("rendering never cancels"); }, confirm() { throw new Error("rendering never confirms"); }, sendUser() {} };

let counter = 0;
let clock = 10_000_000;
function operation(over = {}) {
  counter += 1;
  const { request, ...rest } = over;
  clock += 1_000;
  return {
    id: `op-${counter}`,
    sessionId: "session-a",
    origin: "agent",
    state: "succeeded",
    createdAt: clock,
    updatedAt: clock + 400,
    output: [],
    events: [],
    result: { summary: "msm8x53" },
    request: { protocol: "fastboot", action: "exec", deviceId: "usb-1", command: `getvar var${counter}`, ...request },
    ...rest,
  };
}

const binding = { action: "fastboot command", target: "reboot-bootloader", backup: "Not applicable: reboot changes mode.", details: "Switch device mode; reconnect after USB re-enumerates." };
const waiting = (over = {}) => operation({
  state: "awaiting-confirmation",
  result: undefined,
  approvalAsked: true,
  request: { command: "reboot-bootloader" },
  confirmation: { id: "device-confirmation-1", requestedAt: clock, binding, device: { id: "usb-1", identity: "usb:18d1:4ee0:UNIT1" }, ...over },
});

const html = (element) => renderToStaticMarkup(element);
const feed = (operations, deviceLabel = "Lenovo Smart Display") => html(React.createElement(ActivityFeed, { manager, entries: groupActivity(operations), deviceLabel }));
const card = (snapshot, deviceLabel = "Lenovo Smart Display") => html(React.createElement(OperationCard, { manager, operation: snapshot, deviceLabel }));

test("seven routine agent commands are one compact entry that is closed by default, with every command one tap inside it", () => {
  const reads = ["product", "serialno", "secure", "unlocked", "version-bootloader", "current-slot", "slot-count"].map((name) => operation({ request: { command: `getvar ${name}` }, result: { summary: `${name} value` } }));
  const markup = feed(reads);
  assert.match(markup, /Agent ran 7 fastboot commands/);
  assert.match(markup, /7 ok/);
  assert.equal((markup.match(/<details/g) ?? []).length, 1 + 7, "one entry plus one row per command");
  assert.doesNotMatch(markup, /<details[^>]*\sopen/, "nothing is expanded until asked");
  for (const name of ["product", "serialno", "secure", "unlocked", "version-bootloader", "current-slot", "slot-count"]) {
    assert.ok(markup.includes(`getvar ${name}`), `${name}: the command is reachable`);
    assert.ok(markup.includes(`${name} value`), `${name}: so is what came of it`);
  }
  // The full card of each command (its state and result section) is inside the row, not a separate card beside it.
  assert.equal((markup.match(/<article/g) ?? []).length, 7);
  assert.ok(markup.indexOf("<article") > markup.indexOf("Agent ran 7"), "the cards live inside the entry");
});

test("a burst that had a failure says so on its face", () => {
  const markup = feed([operation(), operation({ state: "failed", error: "No such variable", result: undefined }), operation()]);
  assert.match(markup, /Agent ran 3 fastboot commands/);
  assert.match(markup, /2 ok · 1 failed|2 ok.*1 failed/);
  assert.match(markup, /No such variable/);
});

test("one routine command reads as that command, not as 'a burst of 1'", () => {
  const markup = feed([operation({ request: { command: "getvar product" } })]);
  assert.match(markup, /Agent ran fastboot getvar product/);
  assert.doesNotMatch(markup, /Agent ran 1 /);
});

test("what waits for the person is listed before the history, and a command the person ran keeps its own card", () => {
  const history = [operation(), operation(), operation()];
  const mine = operation({ origin: "user", request: { command: "getvar all" } });
  const markup = feed([...history, mine, waiting()]);
  assert.ok(markup.indexOf("Hardware action needs your confirmation") < markup.indexOf("Agent ran 3"), "the approval comes first");
  assert.ok(markup.indexOf("Hardware action needs your confirmation") < markup.indexOf("getvar all"));
  assert.match(markup, /fastboot · exec/, "the person's own command is a normal card");
});

test("the approval card names the device, the exact action, and lets the person pick when to send", () => {
  const markup = card(waiting(), "Lenovo Smart Display");
  assert.match(markup, /Hardware action needs your confirmation/);
  assert.match(markup, /Device<\/dt>.*Lenovo Smart Display \(usb:18d1:4ee0:UNIT1\)/s, "the device it is for, with its USB identity");
  assert.match(markup, /reboot-bootloader/);
  assert.match(markup, /Switch device mode; reconnect after USB re-enumerates\./, "the details are shown in full");
  assert.match(markup, /role="radiogroup"[^>]*aria-label="When to send"/);
  for (const label of ["Right away", "In 10 s", "In 30 s", "In 60 s"]) assert.ok(markup.includes(label), label);
  assert.match(markup, /aria-checked="true"[^>]*>Right away/, "with no request, sending right away is what is selected");
  assert.match(markup, /Confirm exact action/);
  assert.doesNotMatch(markup, /The agent asked for/);
});

test("a wait the agent asked for is pre-selected and said, and added to the choices when it is not one of them", () => {
  const asked = card(waiting({ sendDelaySeconds: 20 }));
  assert.match(asked, /aria-checked="true"[^>]*>In 20 s/);
  assert.match(asked, /Confirm, send in 20 s/);
  assert.match(asked, /The agent asked for 20 s\./);
  const standard = card(waiting({ sendDelaySeconds: 30 }));
  assert.equal((standard.match(/In 30 s/g) ?? []).length, 1, "30 s is not offered twice");
  assert.match(standard, /aria-checked="true"[^>]*>In 30 s/);
});

test("an approved command shows its exact action, a live countdown and a Cancel that stops it; its other buttons are gone", () => {
  const releaseAt = Date.now() + 30_000;
  const armed = operation({
    state: "armed",
    result: undefined,
    approvalAsked: true,
    request: { command: "reboot-bootloader" },
    armed: { approvedAt: releaseAt - 30_000, releaseAt, expiresAt: releaseAt + 10_000, binding, device: { id: "usb-1", identity: "usb:18d1:4ee0:UNIT1" } },
  });
  const markup = card(armed);
  assert.match(markup, /Approved\. Sending in 30 s/);
  assert.match(markup, /fastboot command · reboot-bootloader/);
  assert.match(markup, /Nothing has been sent yet/);
  assert.match(markup, /void if the command cannot be sent by/);
  assert.equal((markup.match(/Cancel, don&#x27;t send/g) ?? []).length, 1, "one Cancel, on the countdown card");
  assert.doesNotMatch(markup, /Cancel operation/, "no second cancel beneath it");
  assert.doesNotMatch(markup, /Confirm exact action/, "an approval already given cannot be given again");
  assert.match(markup, /Approved, waiting to send/);
});

test("a cancel the system made shows its reason as a warning, not as a failure", () => {
  const reason = "The device left the USB bus before this was approved, so it was cancelled. Nothing was changed on the device.";
  const markup = card(operation({ state: "cancelled", result: undefined, error: reason, approvalAsked: true, request: { command: "reboot-bootloader" } }));
  assert.ok(markup.includes(escape(reason)));
  assert.match(markup, /Cancelled/);
  assert.match(markup, /var\(--status-warning\)/);
  assert.doesNotMatch(markup, /color:var\(--status-error\)[^>]*>[^<]*left the USB bus/);
});

test("every new card and entry reads in English, Japanese and Chinese with real words: no key left bare, no placeholder unfilled", () => {
  const reads = [operation(), operation(), operation({ state: "failed", error: "No such variable", result: undefined })];
  const releaseAt = Date.now() + 45_000;
  const armed = operation({ state: "armed", result: undefined, approvalAsked: true, request: { command: "reboot-bootloader" }, armed: { approvedAt: releaseAt - 45_000, releaseAt, expiresAt: releaseAt + 10_000, binding, device: { id: "usb-1" } } });
  // The language only follows a switch where there is a document; on the server it is always English.
  globalThis.document = { documentElement: {} };
  try {
    for (const locale of Object.keys(locales)) {
      setLocale(locale);
      const say = (key, vars = {}) => escape(locales[locale][key].replace(/\{(\w+)\}/g, (_, variable) => String(vars[variable])));
      const rendered = {
        burst: feed(reads),
        single: feed([operation({ request: { command: "getvar product" } })]),
        approval: card(waiting({ sendDelaySeconds: 20 })),
        armed: card(armed),
      };
      for (const [name, markup] of Object.entries(rendered)) {
        assert.doesNotMatch(markup, /devices\.[a-zA-Z]+/, `${locale}/${name}: a translation key shows`);
        assert.doesNotMatch(markup, /\{[a-zA-Z]+\}/, `${locale}/${name}: a placeholder was not filled`);
      }
      assert.ok(rendered.burst.includes(say("devices.burstTitle.other", { count: 3, protocol: "fastboot" })), `${locale}: burst title`);
      assert.ok(rendered.burst.includes(say("devices.burstFailed", { count: 1 })), `${locale}: burst failure count`);
      assert.ok(rendered.single.includes(say("devices.burstOne", { protocol: "fastboot", command: "getvar product" })), `${locale}: single command`);
      assert.ok(rendered.approval.includes(say("devices.confirmDevice")), `${locale}: device row`);
      assert.ok(rendered.approval.includes(say("devices.sendTimingLabel")), `${locale}: timing label`);
      assert.ok(rendered.approval.includes(say("devices.sendNow")) && rendered.approval.includes(say("devices.sendInSeconds", { seconds: 30 })), `${locale}: timing choices`);
      assert.ok(rendered.approval.includes(say("devices.sendTimingRequested", { seconds: 20 })), `${locale}: the agent's request`);
      assert.ok(rendered.approval.includes(say("devices.confirmOperationIn", { seconds: 20 })), `${locale}: confirm button`);
      assert.ok(rendered.armed.includes(say("devices.armedTitle", { seconds: 45 })), `${locale}: countdown title`);
      assert.ok(rendered.armed.includes(say("devices.armedBody")) && rendered.armed.includes(say("devices.armedCancel")), `${locale}: countdown body and cancel`);
      assert.ok(rendered.armed.includes(say("devices.operationStateArmed")), `${locale}: state label`);
    }
  } finally {
    setLocale("en");
    delete globalThis.document;
  }
});
