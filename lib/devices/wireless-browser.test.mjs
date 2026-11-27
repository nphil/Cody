import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { WirelessRequestError, endpointProblem, isPrivateIpv4, isPairingCode, pairingProblem, parsePort, pollDelay, readWireless, scrub, sendWireless, sendWirelessShell, splitHostPort } = await jiti.import("./wireless-browser.ts");

const httpsPage = { isSecureContext: true, location: new URL("https://cody.example.test") };
const selectionId = "selection-A";
const pairing = { action: "pair", sessionId: "s1", host: "192.168.1.50", pairingPort: 41234, connectPort: 37099, code: "493021" };
const approval = { action: "root", sessionId: "s1", selectionId, requestId: "r1", decision: "approve" };
const reviewedCommand = { sessionId: "s1", selectionId, command: " printf 'hello' ", rootCapableConfirmed: true };
const snapshot = (over = {}) => ({ sessionId: "s1", supported: true, status: "unpaired", device: null, rootRequests: [], ...over });
const reply = (body, status = 200) => async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const device = { selectionId, label: "Tab S9", host: "192.168.1.50", connectPort: 37099, pairedAt: 1 };

test("a read asks for this chat only, without caching, and never carries a credential", async () => {
  const seen = [];
  const answer = await readWireless("s 1/x", undefined, async (url, init) => { seen.push([url, init]); return new Response(JSON.stringify(snapshot({ sessionId: "s 1/x" }))); });
  assert.equal(answer.status, "unpaired");
  assert.equal(seen[0][0], "/api/devices/wireless?sessionId=s%201%2Fx");
  assert.equal(seen[0][1].cache, "no-store");
  assert.equal(seen[0][1].headers, undefined, "no Authorization or any other header");
});

test("an answer about another chat is refused, so a late reply after a session switch never paints the new chat", async () => {
  await assert.rejects(readWireless("s2", undefined, reply(snapshot({ sessionId: "s1" }))), /not about this chat/);
  await assert.rejects(sendWireless({ action: "disconnect", sessionId: "s2", selectionId }, reply(snapshot({ sessionId: "s1" })), httpsPage), /not about this chat/);
  await assert.rejects(readWireless("s1", undefined, reply({ nonsense: true })), /not about this chat/);
});

test("a refusal keeps the server's words and code; a body that is not JSON still gives a plain error", async () => {
  await assert.rejects(sendWireless({ action: "forget", sessionId: "s1", selectionId }, reply({ error: "Wrong pairing code", code: "wrong_code" }, 400), httpsPage), (error) => {
    assert.ok(error instanceof WirelessRequestError);
    assert.equal(error.message, "Wrong pairing code");
    assert.equal(error.code, "wrong_code");
    assert.equal(error.status, 400);
    return true;
  });
  await assert.rejects(readWireless("s1", undefined, async () => new Response("<html>", { status: 502 })), /answered 502/);
});

test("the pairing code goes in the POST body only: not the URL, not a header, not cached, no referrer", async () => {
  let call;
  await sendWireless(pairing, async (url, init) => {
    call = { url, init };
    return new Response(JSON.stringify(snapshot({ status: "connected", device })));
  }, httpsPage);
  assert.equal(call.url, "/api/devices/wireless");
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.cache, "no-store");
  assert.equal(call.init.referrerPolicy, "no-referrer");
  assert.equal(call.init.redirect, "error");
  assert.deepEqual(Object.keys(call.init.headers), ["Content-Type"]);
  assert.equal(JSON.parse(call.init.body).code, "493021");
  assert.ok(!call.url.includes("493021"));
});

test("the reviewed command and selection are sent once to the page-only shell route; a nonzero exit still returns output", async () => {
  const signal = new AbortController().signal;
  const output = { exitCode: 1, stdout: "partial", stderr: "command failed" };
  let calls = 0;
  assert.deepEqual(await sendWirelessShell(reviewedCommand, signal, async (url, init) => {
    calls += 1;
    assert.equal(url, "/api/devices/wireless/shell");
    assert.equal(init.method, "POST");
    assert.equal(init.signal, signal);
    assert.equal(init.cache, "no-store");
    assert.deepEqual(Object.keys(init.headers), ["Content-Type"]);
    assert.deepEqual(JSON.parse(init.body), reviewedCommand);
    return new Response(JSON.stringify(output));
  }, httpsPage), output);
  assert.equal(calls, 1);
  await assert.rejects(sendWirelessShell(reviewedCommand, signal, reply({ exitCode: 0 }), httpsPage), /did not return a command result/);
});

test("every sensitive post is blocked before fetch on remote HTTP and non-secure HTTPS", async () => {
  const neverFetch = () => assert.fail("no request should leave the page");
  for (const page of [
    { isSecureContext: false, location: new URL("http://192.168.1.2:30178") },
    { isSecureContext: true, location: new URL("http://192.168.1.2:30178") },
    { isSecureContext: true, location: new URL("http://localhost.example.test:30178") },
    { isSecureContext: false, location: new URL("https://cody.example.test") },
  ]) {
    await assert.rejects(sendWireless(pairing, neverFetch, page), { code: "secure_context_required" });
    await assert.rejects(sendWireless(approval, neverFetch, page), { code: "secure_context_required" });
    await assert.rejects(sendWirelessShell(reviewedCommand, undefined, neverFetch, page), { code: "secure_context_required" });
  }
});

test("local development allows loopback and sends selection-bound actions unchanged", async () => {
  const actions = [
    { action: "connect", sessionId: "s1", selectionId, host: "192.168.1.50", connectPort: 39008 },
    { action: "disconnect", sessionId: "s1", selectionId },
    { action: "forget", sessionId: "s1", selectionId },
    approval,
  ];
  for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
    const page = { isSecureContext: true, location: new URL(`http://${host}:30178`) };
    for (const action of actions) {
      await sendWireless(action, async (_, init) => {
        assert.deepEqual(JSON.parse(init.body), action);
        return new Response(JSON.stringify(snapshot()));
      }, page);
    }
  }
});

test("scrub removes a secret an error message echoed, everywhere it appears", () => {
  assert.equal(scrub("code 493021 was wrong (493021)", "493021"), "code •••••• was wrong (••••••)");
  assert.equal(scrub("nothing to hide", "493021"), "nothing to hide");
  assert.equal(scrub("unchanged", undefined), "unchanged");
});

test("polling: quick while changing, steady while paired, slow while nothing is paired, silent when hidden or unsupported", () => {
  assert.equal(pollDelay(null, true), null);
  assert.equal(pollDelay(snapshot({ status: "connected", device }), true), null, "a hidden tab does not poll");
  assert.equal(pollDelay(null, false), 8_000, "the first read is retried");
  assert.equal(pollDelay(snapshot({ supported: false }), false), null);
  assert.equal(pollDelay(snapshot({ status: "pairing" }), false), 1_500);
  assert.equal(pollDelay(snapshot({ status: "connecting", device }), false), 1_500);
  assert.equal(pollDelay(snapshot({ status: "connected", device, rootRequests: [{ id: "r", command: "id", elevated: false, requestedAt: 1, expiresAt: 2, state: "pending" }] }), false), 2_000);
  assert.equal(pollDelay(snapshot({ status: "offline", device }), false), 5_000);
  assert.equal(pollDelay(snapshot(), false), 15_000);
});

test("what a person types: the address, the two different ports and the code are each checked on their own", () => {
  for (const host of ["192.168.1.50", " 10.0.0.2 ", "172.16.0.1", "172.31.255.254"]) assert.ok(isPrivateIpv4(host), host);
  for (const bad of ["", "192.168.1", "192.168.1.256", "0192.168.1.50", "tablet.local", "192.168.1.50:5555", "172.15.1.2", "172.32.1.2", "127.0.0.1", "8.8.8.8", "169.254.1.2"]) assert.ok(!isPrivateIpv4(bad), bad);
  assert.equal(parsePort("37099"), 37099);
  assert.equal(parsePort("1024"), 1024);
  assert.equal(parsePort("65535"), 65535);
  for (const bad of ["", "80", "5", "5037", "5555", "65536", "12x", "-1", "123456"]) assert.equal(parsePort(bad), null, bad);
  assert.ok(isPairingCode("012345"));
  for (const bad of ["12345", "1234567", "12345a", ""]) assert.ok(!isPairingCode(bad), bad);
  assert.deepEqual(splitHostPort("192.168.1.50:37099"), { host: "192.168.1.50", port: "37099" });
  assert.deepEqual(splitHostPort(" 10.0.0.2:41234 "), { host: "10.0.0.2", port: "41234" });
  assert.equal(splitHostPort("192.168.1.50"), null);
  assert.equal(splitHostPort("tablet:37099"), null);

  const good = { host: "192.168.1.50", connectPort: "37099", pairingPort: "41234", code: "493021" };
  assert.equal(pairingProblem(good), null);
  assert.equal(pairingProblem({ ...good, host: "x" }), "address");
  assert.equal(pairingProblem({ ...good, connectPort: "" }), "connectPort");
  assert.equal(pairingProblem({ ...good, pairingPort: "9" }), "pairingPort");
  assert.equal(pairingProblem({ ...good, pairingPort: good.connectPort }), "samePort");
  assert.equal(pairingProblem({ ...good, code: "49302" }), "code");
  assert.equal(endpointProblem({ host: "192.168.1.50", connectPort: "37099" }), null, "the address form needs no code");
  assert.equal(endpointProblem({ host: "192.168.1.50", connectPort: "0" }), "connectPort");
});
