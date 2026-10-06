import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

/**
 * The Devices panel's activity list and trust UI, rendered for real: a burst of routine agent commands is one compact
 * entry with every command still inside it; what waits for the person comes first; a command that waits for the
 * chat's trust question says so, one that is counting down shows its exact action and a Cancel; a device card shows how
 * far the person has trusted the device and offers Forget. Every string exists in all three languages.
 */

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { ActivityFeed } = await jiti.import("./devices/ActivityFeed.tsx");
const { OperationCard } = await jiti.import("./devices/OperationList.tsx");
const { DeviceCard } = await jiti.import("./devices/DeviceCard.tsx");
const { groupActivity } = await jiti.import("../lib/devices/activity-groups.ts");
const { setLocale } = await jiti.import("../lib/i18n/index.tsx");

const locales = Object.fromEntries(
  await Promise.all(["en", "ja", "zh-CN"].map(async (name) => [name, JSON.parse(await readFile(new URL(`../lib/i18n/locales/${name}.json`, import.meta.url), "utf8"))])),
);

const escape = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
const manager = { cancel() { throw new Error("rendering never cancels"); }, sendUser() {} };

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
const awaitingTrust = (over = {}) => operation({ state: "awaiting-trust", result: undefined, request: { command: "reboot-bootloader" }, ...over });
const counting = (releaseAt, over = {}) => operation({
  state: "countdown",
  result: undefined,
  riskDeclared: true,
  request: { command: "reboot-bootloader" },
  countdown: { startedAt: releaseAt - 30_000, releaseAt, binding },
  ...over,
});

const html = (element) => renderToStaticMarkup(element);
const feed = (operations) => html(React.createElement(ActivityFeed, { manager, entries: groupActivity(operations) }));
const card = (snapshot) => html(React.createElement(OperationCard, { manager, operation: snapshot }));

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
  const markup = feed([...history, mine, awaitingTrust()]);
  assert.ok(markup.indexOf("Waiting for your answer") < markup.indexOf("Agent ran 3"), "the waiting command comes first");
  assert.ok(markup.indexOf("Waiting for your answer") < markup.indexOf("getvar all"));
  assert.match(markup, /fastboot · exec/, "the person's own command is a normal card");
});

test("a command held for the trust question says the answer is in the chat and can still be cancelled", () => {
  const markup = card(awaitingTrust());
  assert.match(markup, /Waiting for your answer<\/span>/, "the state label");
  assert.match(markup, /The agent wants to control this device\. Answer the question in the chat to let it start\./);
  assert.match(markup, /Cancel operation/, "the generic cancel stays: it is not a countdown");
  assert.doesNotMatch(markup, /Starting in/, "no countdown card before the person answered");
  assert.doesNotMatch(markup, /Confirm exact action|asked to type/, "nothing here asks for a per-command confirmation or typed text");
});

test("a command counting down shows its exact action, a live countdown and one Cancel that stops it", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_700_000_000_000 }); // the countdown is read off the clock: a frozen one cannot tick past a boundary mid-render
  const markup = card(counting(Date.now() + 30_000));
  assert.match(markup, /Starting in 30 s/);
  assert.match(markup, /<code>fastboot command - reboot-bootloader<\/code>/);
  assert.match(markup, /Nothing has been sent yet\./);
  assert.equal((markup.match(/Cancel, don&#x27;t send/g) ?? []).length, 1, "one Cancel, on the countdown card");
  assert.doesNotMatch(markup, /Cancel operation/, "no second cancel beneath it");
  assert.match(markup, /Starting soon<\/span>/, "the state label");
  assert.match(markup, /min-height:44px/, "the Cancel is a full-size touch target");
});

test("a command that finished no longer shows the waiting notice or the countdown, only its result", () => {
  const markup = card(operation({ request: { command: "reboot-bootloader" }, result: { summary: "device is rebooting" } }));
  assert.match(markup, /device is rebooting/);
  assert.match(markup, /Succeeded/);
  assert.doesNotMatch(markup, /Answer the question in the chat|Nothing has been sent yet|Cancel operation/);
});

test("a cancel the system made shows its reason as a warning, not as a failure", () => {
  const reason = "The device left the USB bus before this started, so it was cancelled. Nothing was changed on the device.";
  const markup = card(operation({ state: "cancelled", result: undefined, error: reason, request: { command: "reboot-bootloader" } }));
  assert.ok(markup.includes(escape(reason)));
  assert.match(markup, /Cancelled/);
  assert.match(markup, /var\(--status-warning\)/);
  assert.doesNotMatch(markup, /color:var\(--status-error\)[^>]*>[^<]*left the USB bus/);
});

// A device card needs a manager that can say how far the device is trusted; nothing else of it runs while rendering.
function trustManager(levels, operations = []) {
  return {
    trustLevel: (deviceId) => levels[deviceId] ?? "none",
    subscribeTrust: () => () => {},
    withdrawTrust: async () => { throw new Error("rendering never forgets"); },
    snapshots: () => operations,
    subscribe: () => () => {},
    cancel() { throw new Error("rendering never cancels"); },
    sendUser() {},
    status() { return undefined; },
  };
}
const device = (over = {}) => ({
  id: "usb-1",
  kind: "usb",
  label: "Lenovo Smart Display",
  vendorId: 0x17ef,
  productId: 0x7435,
  serialNumber: "UNIT1",
  open: false,
  protocolCandidates: [{ protocol: "adb", interfaceNumber: 0, alternateSetting: 0 }],
  ...over,
});
const deviceCard = (level, over = {}, operations = []) => html(React.createElement(DeviceCard, {
  sessionId: "panel-session",
  manager: trustManager({ "usb-1": level, ...over.levels }, operations),
  device: device(over.device),
  activity: undefined,
  operations,
  selectedInputId: null,
  input: undefined,
  onChooseFile() {},
  onDisconnect() {},
}));

test("a remembered device shows the Trusted chip and a Forget button that names the device", () => {
  const markup = deviceCard("remembered");
  assert.match(markup, />Trusted<\/span>/);
  assert.ok(markup.includes(`title="${escape(locales.en["deviceTrust.chipRememberedHint"])}"`), "the hint explains what it means");
  assert.ok(markup.includes(`aria-label="${escape(locales.en["deviceTrust.forgetLabel"].replace("{device}", "Lenovo Smart Display"))}"`));
  assert.match(markup, /<button[^>]*aria-label="Forget Lenovo Smart Display[^"]*"[^>]*>(?:(?!<\/button>).)*>Forget<\/span>/s);
  assert.doesNotMatch(markup, /Agent blocked/);
});

test("a device trusted only until it is unplugged says so and can still be forgotten", () => {
  const markup = deviceCard("session");
  assert.match(markup, />Trusted for now<\/span>/);
  assert.ok(markup.includes(`title="${escape(locales.en["deviceTrust.chipSessionHint"])}"`));
  assert.match(markup, />Forget<\/span>/);
  assert.doesNotMatch(markup, />Trusted<\/span>/);
});

test("a device the person said no to shows the blocked chip and why, with nothing to forget", () => {
  const markup = deviceCard("declined");
  assert.match(markup, />Agent blocked<\/span>/);
  assert.ok(markup.includes(escape(locales.en["deviceTrust.chipDeclinedHint"])));
  assert.doesNotMatch(markup, />Forget<\/span>/);
});

test("a device the agent has not asked about shows no trust UI at all", () => {
  const markup = deviceCard("none");
  assert.doesNotMatch(markup, /Trusted|Agent blocked|Forget|deviceTrust\./);
});

test("a Bluetooth device is never an operation target, so it shows no trust UI even if a stale level is reported", () => {
  const markup = deviceCard("remembered", { device: { kind: "ble", protocolCandidates: undefined, services: [] } });
  assert.doesNotMatch(markup, />Trusted<\/span>|Forget/);
});

test("without a manager the card shows no trust UI", () => {
  const markup = html(React.createElement(DeviceCard, { sessionId: "panel-session", manager: null, device: device(), activity: undefined, operations: [], selectedInputId: null, input: undefined, onChooseFile() {}, onDisconnect() {} }));
  assert.doesNotMatch(markup, />Trusted<\/span>|Forget/);
});

test("the title chips follow the operations: waiting for the answer, then starting soon, then running", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_700_000_000_000 });
  const chipRow = (operations) => deviceCard("none", {}, operations);
  assert.match(chipRow([awaitingTrust()]), />Waiting for your answer<\/span><\/span>/);
  assert.match(chipRow([counting(Date.now() + 10_000)]), />Starting soon<\/span><\/span>/);
  assert.match(chipRow([operation({ state: "running", result: undefined })]), />Running<\/span><\/span>/);
});

test("the Terminal tab holds the terminal only: no shell grant button stands above it", () => {
  const markup = deviceCard("session");
  const start = markup.search(/id="[^"]*-panel-terminal"/);
  assert.ok(start >= 0, "the device offers a Terminal tab");
  const rest = markup.slice(start + 4);
  const next = rest.search(/id="[^"]*-panel-/);
  const panel = next < 0 ? rest : rest.slice(0, next);
  assert.match(panel, /Start terminal|Start/i, "the terminal itself is there");
  assert.doesNotMatch(panel, /aria-pressed|shell access|Allow shell|Revoke/i);
});

test("every new card and entry reads in English, Japanese and Chinese with real words: no key left bare, no placeholder unfilled", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_700_000_000_000 });
  const reads = [operation(), operation(), operation({ state: "failed", error: "No such variable", result: undefined })];
  const releaseAt = Date.now() + 45_000;
  // The language only follows a switch where there is a document; on the server it is always English.
  globalThis.document = { documentElement: {} };
  try {
    for (const locale of Object.keys(locales)) {
      setLocale(locale);
      const say = (key, vars = {}) => escape(locales[locale][key].replace(/\{(\w+)\}/g, (_, variable) => String(vars[variable])));
      const rendered = {
        burst: feed(reads),
        single: feed([operation({ request: { command: "getvar product" } })]),
        awaiting: card(awaitingTrust()),
        countdown: card(counting(releaseAt)),
        remembered: deviceCard("remembered", {}, [awaitingTrust()]),
        session: deviceCard("session", {}, [counting(releaseAt)]),
        declined: deviceCard("declined"),
      };
      for (const [name, markup] of Object.entries(rendered)) {
        assert.doesNotMatch(markup, /devices\.[a-zA-Z]+|deviceTrust\.[a-zA-Z]+/, `${locale}/${name}: a translation key shows`);
        assert.doesNotMatch(markup, /\{[a-zA-Z]+\}/, `${locale}/${name}: a placeholder was not filled`);
      }
      assert.ok(rendered.burst.includes(say("devices.burstTitle.other", { count: 3, protocol: "fastboot" })), `${locale}: burst title`);
      assert.ok(rendered.burst.includes(say("devices.burstFailed", { count: 1 })), `${locale}: burst failure count`);
      assert.ok(rendered.single.includes(say("devices.burstOne", { protocol: "fastboot", command: "getvar product" })), `${locale}: single command`);
      assert.ok(rendered.awaiting.includes(say("deviceTrust.stateAwaiting")) && rendered.awaiting.includes(say("deviceTrust.awaitingBody")), `${locale}: waiting state and notice`);
      assert.ok(rendered.countdown.includes(say("deviceTrust.countdownTitle", { seconds: 45 })), `${locale}: countdown title`);
      assert.ok(rendered.countdown.includes(say("deviceTrust.countdownBody")) && rendered.countdown.includes(say("deviceTrust.countdownCancel")), `${locale}: countdown body and cancel`);
      assert.ok(rendered.countdown.includes(say("deviceTrust.stateCountdown")), `${locale}: countdown state label`);
      assert.ok(rendered.remembered.includes(say("deviceTrust.chipRemembered")) && rendered.remembered.includes(say("deviceTrust.forget")), `${locale}: remembered chip and Forget`);
      assert.ok(rendered.remembered.includes(say("deviceTrust.forgetLabel", { device: "Lenovo Smart Display" })), `${locale}: Forget's accessible name`);
      assert.ok(rendered.remembered.includes(say("deviceTrust.stateAwaiting")), `${locale}: the device's waiting chip`);
      assert.ok(rendered.session.includes(say("deviceTrust.chipSession")) && rendered.session.includes(say("deviceTrust.stateCountdown")), `${locale}: session chip and countdown chip`);
      assert.ok(rendered.declined.includes(say("deviceTrust.chipDeclined")) && rendered.declined.includes(say("deviceTrust.chipDeclinedHint")), `${locale}: declined chip and hint`);
    }
  } finally {
    setLocale("en");
    delete globalThis.document;
  }
});
