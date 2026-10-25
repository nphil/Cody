import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { MessageView } = await jiti.import("./MessageView.tsx");
const { HomelabberApprovalProvider } = await jiti.import("./HomelabberApproval.tsx");

const ID = "3b1f6c1e-8d2a-4c57-9a0e-5f2d7a41b9c3";

/** HomeLabber's MCP answer as omp hands it to the transcript. */
function ompResult(toolCallId, outcome) {
  const lead = `${outcome.ok ? "" : "Error: "}${outcome.message}`;
  return {
    role: "toolResult",
    toolCallId,
    isError: !outcome.ok,
    content: [
      { type: "text", text: outcome.data === undefined ? lead : `${lead}\n\n${JSON.stringify(outcome.data, null, 2)}` },
      { type: "text", text: `\`\`\`json\n${JSON.stringify(outcome, null, 2)}\n\`\`\`` },
    ],
  };
}

function pending(expiresAt) {
  return {
    ok: false,
    message: `Waiting for Nitin to approve this on his phone (request ${ID}, expires 23:13). Call approval_wait with this id. Do not retry the call; a retry returns the same request.`,
    data: { approval: { id: ID, status: "pending", expiresAt } },
  };
}

function waited(status, items = []) {
  return {
    ok: ["pending", "approved", "executing", "executed"].includes(status),
    message: `Request ${ID} is ${status}.`,
    data: { id: ID, status, items },
  };
}

const call = (toolCallId, toolName, input) => ({ type: "toolCall", toolCallId, toolName, input });
const assistant = (...blocks) => ({ role: "assistant", content: blocks });

/** Render one assistant message the way the chat does: its own message, every
 *  result by call id, and the transcript-wide index around it. */
function render(messages, results, { mode = "compact", index = messages.length - 1 } = {}) {
  const toolResults = new Map(results.map((result) => [result.toolCallId, result]));
  return renderToStaticMarkup(
    React.createElement(
      HomelabberApprovalProvider,
      { messages, toolResults },
      React.createElement(MessageView, { message: messages[index], toolResults, activityDisplayMode: mode }),
    ),
  );
}

const firewall = call("c1", "mcp__homelabber_firewall_open", { host: "vps", port: 8443, proto: "tcp" });

test("a pending request shows the Face ID row, a live countdown and both ways to approve", () => {
  const expiresAt = Date.now() + 4 * 60_000 + 30_000;
  const message = assistant(firewall);
  const html = render([message], [ompResult("c1", pending(expiresAt))]);

  assert.match(html, /Waiting for your Face ID in HomeLabber/);
  assert.match(html, /role="timer"[^>]*>[34]:\d\d left</);
  assert.match(html, new RegExp(`href="homelabber://approve/${ID}"[^>]*>(?:<svg[^>]*>.*?</svg>)?Open HomeLabber`));
  assert.match(html, new RegExp(`href="https://homelabber\\.nateshome\\.net/approvals/${ID}"[^>]*target="_blank"[^>]*rel="noopener noreferrer"[^>]*>Details in HomeLabber<`));
  assert.match(html, />waiting</, "the header carries the state word where an ordinary call says error");
  assert.doesNotMatch(html, />error</);
  assert.doesNotMatch(html, /var\(--status-error\)/, "a request that is waiting is not an error");
  assert.match(html, /aria-expanded="false"/, "and it is not auto-expanded as one");
});

test("a pending request that reached the transcript only as prose still gets the row", () => {
  const message = assistant(firewall);
  const result = {
    role: "toolResult",
    toolCallId: "c1",
    isError: true,
    content: [{ type: "text", text: `Error: ${pending(0).message}` }],
  };
  const html = render([message], [result]);
  assert.match(html, /Waiting for your Face ID in HomeLabber/);
  assert.match(html, /expires 23:13/);
  assert.doesNotMatch(html, /role="timer"/, "no epoch, no countdown");
});

test("the same request, once an approval_wait reports it, reads approved and done", () => {
  const messages = [
    assistant(firewall),
    assistant(call("w1", "mcp__homelabber_approval_wait", { id: ID, waitSeconds: 25 })),
  ];
  const items = [{ seq: 0, tool: "firewall_open", status: "executed", message: "Opened 8443/tcp on vps", changeId: "chg-1" }];
  const html = render(messages, [ompResult("c1", pending(Date.now() + 60_000)), ompResult("w1", waited("executed", items))], { index: 0 });

  assert.match(html, /Approved and done/);
  assert.match(html, /Opened 8443\/tcp on vps/);
  assert.match(html, /firewall_open/);
  assert.match(html, />done</);
  assert.doesNotMatch(html, /Waiting for your Face ID/);
  assert.doesNotMatch(html, /homelabber:\/\/approve/, "nothing left to approve");
  assert.doesNotMatch(html, /var\(--status-error\)/);
  assert.match(html, /var\(--status-success\)/);
});

test("approved but still running, then denied, expired and failed, each in its own words", () => {
  const gate = (status, items) => render(
    [assistant(firewall), assistant(call("w1", "mcp__homelabber_approval_wait", { id: ID }))],
    [ompResult("c1", pending(Date.now() + 60_000)), ompResult("w1", waited(status, items))],
    { index: 0 },
  );
  assert.match(gate("executing"), /Approved\. HomeLabber is carrying it out/);
  assert.match(gate("approved"), /lucide-loader-circle[^"]*icon-spin|icon-spin[^"]*lucide-loader-circle/, "the one phase still in motion turns");
  assert.doesNotMatch(gate("denied"), /icon-spin/);
  assert.match(gate("denied"), /Denied in HomeLabber/);
  assert.match(gate("expired"), /Expired before anyone approved it/);
  assert.match(gate("cancelled"), /Cancelled in HomeLabber/);
  const failed = gate("failed", [
    { seq: 0, tool: "dns_record_add", status: "executed", message: "Added a.nateshome.net", changeId: "chg-1" },
    { seq: 1, tool: "firewall_open", status: "failed", message: "Port 22 is protected", changeId: null },
    { seq: 2, tool: "expose_apply", status: "skipped", message: null, changeId: null },
  ]);
  assert.match(failed, /Approved, but it failed/);
  assert.match(failed, /Added a\.nateshome\.net/);
  assert.match(failed, /Port 22 is protected/);
  assert.match(failed, /aria-label="done"/);
  assert.match(failed, /aria-label="failed"/);
  assert.match(failed, /aria-label="skipped"/);
  assert.match(failed, /expose_apply/);
});

test("a request whose window closed with no answer says so, and never claims an outcome", () => {
  const html = render([assistant(firewall)], [ompResult("c1", pending(Date.now() - 1000))]);
  assert.match(html, /The approval window has closed/);
  assert.doesNotMatch(html, /Waiting for your Face ID/);
  assert.doesNotMatch(html, /homelabber:\/\/approve/);
  assert.match(html, />closed</);
});

test("a plan says how many steps it waits on", () => {
  const plan = call("p1", "mcp__homelabber_approval_request_plan", {
    reason: "publish the dashboard",
    steps: [{ tool: "dns_record_add", params: {} }, { tool: "firewall_open", params: {} }],
  });
  const html = render([assistant(plan)], [ompResult("p1", pending(Date.now() + 60_000))]);
  assert.match(html, /Waiting for your Face ID in HomeLabber/);
  assert.match(html, /2 steps/);
});

test("the device-call spelling draws the same card", () => {
  const device = call("d1", "write", { path: "xd://mcp__homelabber_firewall_open", content: JSON.stringify({ host: "vps", port: 8443 }) });
  const html = render([assistant(device)], [ompResult("d1", pending(Date.now() + 60_000))]);
  assert.match(html, /Waiting for your Face ID in HomeLabber/);
  assert.match(html, new RegExp(`homelabber://approve/${ID}`));
});

test("an approval_wait poll labels itself and does not repeat the card", () => {
  const poll = call("w1", "mcp__homelabber_approval_wait", { id: ID });
  const html = render([assistant(poll)], [ompResult("w1", waited("pending"))]);
  assert.match(html, />waiting</);
  assert.doesNotMatch(html, /Waiting for your Face ID/);
  assert.doesNotMatch(html, /Open HomeLabber/);
});

test("hidden activity still shows an approval that needs an answer, and still hides a quiet poll", () => {
  const html = render([assistant(firewall)], [ompResult("c1", pending(Date.now() + 60_000))], { mode: "hidden" });
  assert.match(html, /Waiting for your Face ID in HomeLabber/);

  const poll = call("w1", "mcp__homelabber_approval_wait", { id: ID });
  const quiet = render([assistant(poll)], [ompResult("w1", waited("pending"))], { mode: "hidden" });
  assert.equal(quiet, "");
});

test("tool calls that are not HomeLabber approvals keep the card they always had", () => {
  const ordinary = call("b1", "bash", { command: "false" });
  const failing = { role: "toolResult", toolCallId: "b1", isError: true, content: [{ type: "text", text: "exit 1" }] };
  const html = render([assistant(ordinary)], [failing]);
  assert.match(html, />error</);
  assert.match(html, /var\(--status-error\)/);
  assert.doesNotMatch(html, /HomeLabber/);

  const refusal = call("c9", "mcp__homelabber_firewall_open", { port: 22 });
  const refused = {
    role: "toolResult",
    toolCallId: "c9",
    isError: true,
    content: [{ type: "text", text: "Error: Approvals for this token are paused by Nitin; ask him to resume them in HomeLabber" }],
  };
  const refusedHtml = render([assistant(refusal)], [refused]);
  assert.match(refusedHtml, />error</, "a refusal is a real error and stays one");
  assert.doesNotMatch(refusedHtml, /Face ID/);
});
