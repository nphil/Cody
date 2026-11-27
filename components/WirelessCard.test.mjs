process.env.TZ = "UTC";
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";
import { rootRequests, shellResult, states } from "./devices/wireless-fixtures.mjs";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { WirelessCard, ForgetGuide, RemoveConfirm } = await jiti.import("./devices/WirelessCard.tsx");
const { WirelessRootRequests } = await jiti.import("./devices/WirelessRootRequests.tsx");
const { WirelessShellOutput, WirelessShellReview } = await jiti.import("./devices/WirelessShell.tsx");

const card = (name) => renderToStaticMarkup(React.createElement(WirelessCard, { wireless: states[name] }));
const inputs = (html) => [...html.matchAll(/<input\b[^>]*>/g)].map((match) => match[0]);

test("an unpaired chat gets the pair form, with the connection port and the pairing port as two separate, labelled fields", () => {
  const html = card("unpaired");
  assert.match(html, /Pair once with the code Android shows/);
  assert.match(html, /<legend[^>]*>1 · Connection \(main screen\)<\/legend>/);
  assert.match(html, /<legend[^>]*>2 · Pairing \(one time only\)<\/legend>/);
  assert.match(html, /Connection port/);
  assert.match(html, /Pairing port/);
  assert.match(html, /is not the connection port/);
  assert.match(html, /Where do I find these\?/);
  assert.match(html, /<button[^>]*type="submit"[^>]*disabled=""[^>]*>[\s\S]*Pair and connect/, "nothing can be sent until every field is valid");
  assert.doesNotMatch(html, /Reconnect|Disconnect|Remove tablet/);
});

test("the pairing code is masked and not a named form field; it starts empty", () => {
  const field = inputs(card("unpaired")).find((input) => input.includes("data-wireless-pairing-code"));
  assert.ok(field, "the code field exists");
  assert.match(field, /type="password"/);
  assert.match(field, /inputMode="numeric"|inputmode="numeric"/i);
  assert.match(field, /autoComplete="off"|autocomplete="off"/i);
  assert.match(field, /data-1p-ignore/);
  assert.match(field, /data-lpignore/);
  assert.match(field, /maxLength="6"|maxlength="6"/i);
  assert.doesNotMatch(field, /\bname=/);
  assert.doesNotMatch(field, /\bvalue=/);
});

test("a connected tablet has Disconnect and a tucked-away manual command form, with no pairing fields", () => {
  const html = card("connected");
  assert.match(html, /Samsung Galaxy Tab S9 Ultra/);
  assert.match(html, /192\.168\.100\.123:37099/);
  assert.match(html, /Connected/);
  assert.match(html, /Last connected/);
  assert.match(html, /Disconnect/);
  assert.match(html, /belongs to this chat only/);
  assert.match(html, /Remove this tablet/);
  assert.match(html, /Run a command yourself/);
  assert.match(html, /Review command/);
  assert.doesNotMatch(html, /Run this exact command/);
  assert.equal(inputs(html).length, 1, "only the human's command input");
  assert.doesNotMatch(html, /Pairing code/);
});

test("an unreachable tablet offers Reconnect without a code, and the address form for a changed port has no code field", () => {
  const html = card("offline");
  assert.match(html, /Not reachable/);
  assert.match(html, /Reconnect/);
  assert.match(html, /Nothing answered at 192\.168\.100\.123:37099\./, "the server's reason is shown");
  assert.match(html, /Address or port changed\?/);
  assert.match(html, /Save and reconnect/);
  assert.equal(inputs(html).length, 2, "address and connection port only");
  assert.doesNotMatch(html, /Pairing code|Pairing port/);
});

test("a deliberate disconnect keeps the pairing and does not imply that Cody will retry on its own", () => {
  const html = card("disconnected");
  assert.match(html, /Disconnected/);
  assert.match(html, /Still paired/);
  assert.match(html, /Reconnect/);
  assert.doesNotMatch(html, /Not reachable|Pairing code|Run a command yourself/);
});

test("a command result shows its exit code and both output streams as text", () => {
  const html = renderToStaticMarkup(React.createElement(WirelessShellOutput, { result: shellResult }));
  assert.match(html, /Exit code: 1/);
  assert.match(html, /model=SM-X916B/);
  assert.match(html, /Error output/);
  assert.match(html, /&lt;not an html element&gt;/);
});

test("a rejected pairing must be removed before Cody offers another pairing code form", () => {
  const html = card("needsPairing");
  assert.match(html, /Pair again/);
  assert.match(html, /The tablet refused that pairing code\./);
  assert.match(html, /role="alert"/);
  assert.match(html, /Remove the old pairing below/);
  assert.match(html, /Remove tablet/);
  assert.doesNotMatch(html, /data-wireless-pairing-code|Pair and connect/);
});

test("the in-between and failure states say what is going on and offer the right next step", () => {
  assert.match(card("checking"), /Checking wireless status/);
  assert.match(card("loadFailed"), /Could not read the wireless status: The server answered 502\./);
  assert.match(card("loadFailed"), /Try again/);
  assert.match(card("unsupported"), /adb is not installed on this server\./);
  assert.equal(inputs(card("unsupported")).length, 0);
  assert.match(card("connecting"), /Connecting…/);
  assert.match(card("connecting"), /Disconnect/, "a stuck attempt can be stopped");
  assert.match(card("stale"), /last state it knew/);
  const busy = card("pairingBusy");
  assert.match(busy, /Pairing…/);
  assert.ok(inputs(busy).every((input) => /disabled=""/.test(input)), "nothing can be edited or sent twice while pairing");
});

test("removing a tablet asks twice, keeps the safe answer first, and then tells the person what to forget on Android", () => {
  const confirm = renderToStaticMarkup(React.createElement(RemoveConfirm, { locked: false, onKeep() {}, onRemove() {} }));
  assert.ok(confirm.indexOf("Keep") < confirm.indexOf("Yes, remove"));
  const guide = renderToStaticMarkup(React.createElement(ForgetGuide, { name: "Cody on a rather long server name", onDone() {} }));
  assert.match(guide, /Wireless debugging, Paired devices, tap Cody on a rather long server name, then Forget/);
  assert.match(renderToStaticMarkup(React.createElement(ForgetGuide, { name: undefined, onDone() {} })), /the entry for this Cody server/);
});

test("a root request shows the exact command; only a pending one can be approved or denied, and none is a standing grant", () => {
  const html = renderToStaticMarkup(React.createElement(WirelessRootRequests, { requests: rootRequests, busy: false, onAnswer() {} }));
  assert.ok(html.includes("getprop ro.product.model &amp;&amp; printf &#x27;%s\\n&#x27; &#x27;a-long-marker-to-check-command-wrapping-in-the-narrow-devices-panel&#x27;"), "the whole command, escaped, not shortened");
  assert.equal([...html.matchAll(/Approve this command/g)].length, 1, "the approved request has no button");
  assert.equal([...html.matchAll(/>Deny</g)].length, 1);
  assert.match(html, /only this exact command, once/);
  assert.match(html, /never permanent access/);
  assert.match(html, /Approved\. Cody may be waiting for Magisk/);
  assert.doesNotMatch(html, /always allow|remember|for this session/i);
  assert.equal(renderToStaticMarkup(React.createElement(WirelessRootRequests, { requests: [], busy: false, onAnswer() {} })), "", "nothing renders with no request");
});

test("an ordinary approval still warns that the command can elevate", () => {
  const html = renderToStaticMarkup(React.createElement(WirelessRootRequests, {
    requests: [{ ...rootRequests[0], elevated: false, reason: "Inspect this tablet's Android version." }], busy: false, onAnswer() {},
  }));
  assert.match(html, /The agent asks to run a command/);
  assert.match(html, /Inspect this tablet/);
  assert.match(html, /exact command, once/);
  assert.match(html, /can request root/);
  assert.doesNotMatch(html, /Magisk|without root/);
});

test("manual command review shows the full command and its risks with a separate run button", () => {
  const command = "  printf '<private>'  ";
  const html = renderToStaticMarkup(React.createElement(WirelessShellReview, { command, locked: false, onBack() {}, onRun() {} }));
  assert.match(html, /> {2}printf &#x27;&lt;private&gt;&#x27; {2}<\/pre>/);
  assert.match(html, /can request root .* and change files or settings/);
  assert.match(html, />Back</);
  assert.match(html, />Run this exact command</);
  assert.doesNotMatch(html, /type="submit"/);
});

test("every wireless string the card and the approvals use exists in all three languages", async () => {
  const keys = new Set();
  for (const file of ["devices/WirelessCard.tsx", "devices/WirelessRootRequests.tsx", "devices/WirelessShell.tsx"]) {
    const source = await readFile(new URL(`./${file}`, import.meta.url), "utf8");
    for (const match of source.matchAll(/"(devices\.wireless[A-Za-z]+)"/g)) keys.add(match[1]);
  }
  assert.ok(keys.size > 40);
  for (const locale of ["en", "ja", "zh-CN"]) {
    const messages = JSON.parse(await readFile(new URL(`../lib/i18n/locales/${locale}.json`, import.meta.url), "utf8"));
    const missing = [...keys].filter((key) => typeof messages[key] !== "string" || messages[key] === "");
    assert.deepEqual(missing, [], `${locale} is missing wireless strings`);
  }
});
