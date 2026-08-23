import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

/**
 * Approval prompts, browser half.
 *
 * An ACP turn BLOCKS on this card: the agent's JSON-RPC request stays open
 * until someone clicks. So the failure modes are not cosmetic — a dropped
 * option is a grant the user was never offered, a card that never appears is a
 * session that looks hung forever, and a mis-styled "always" is a durable
 * grant handed over by accident.
 *
 * The rendering is exercised for real; the wiring inside the hook (which needs
 * a DOM to run) is pinned at the source, the house style of
 * hooks/useAgentSession.test.mjs.
 */

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { PermissionRequestCard } = await jiti.import("./PermissionRequestCard.tsx");

const hook = await readFile(new URL("../hooks/useAgentSession.ts", import.meta.url), "utf8");
const chatWindow = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
const card = await readFile(new URL("./PermissionRequestCard.tsx", import.meta.url), "utf8");

const locales = Object.fromEntries(
  await Promise.all(["en", "ja", "zh-CN"].map(async (name) => [
    name,
    JSON.parse(await readFile(new URL(`../lib/i18n/locales/${name}.json`, import.meta.url), "utf8")),
  ])),
);

/** The real option set Hermes offers — five options, two of which share a
 * kind. Anything that treats `kind` as an identity breaks on this exact list. */
const HERMES_REQUEST = {
  requestId: "perm-1",
  toolCall: { toolCallId: "call-1", title: "Run the tests: npm test", kind: "execute" },
  options: [
    { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
    { optionId: "allow_session", name: "Allow for session", kind: "allow_always" },
    { optionId: "allow_always", name: "Allow always", kind: "allow_always" },
    { optionId: "deny", name: "Deny", kind: "reject_once" },
    { optionId: "deny_always", name: "Deny always", kind: "reject_always" },
  ],
};

const noop = () => {};

function render(request) {
  return renderToStaticMarkup(React.createElement(PermissionRequestCard, { request, onRespond: noop }));
}

test("every option the agent offered is rendered, in the order it sent them", () => {
  const html = render(HERMES_REQUEST);
  const names = [...html.matchAll(/>([^<>]*(?:Allow|Deny)[^<>]*)</g)].map((m) => m[1]);
  assert.deepEqual(names, ["Allow once", "Allow for session", "Allow always", "Deny", "Deny always"]);
  assert.equal((html.match(/<button/g) ?? []).length, 5, "one button per option, no more and no fewer");
});

test("two options sharing a kind stay two distinguishable buttons", () => {
  // "Allow for session" and "Allow always" both arrive as allow_always. Their
  // NAME is the only thing separating them, so the name must be present and
  // prominent on each — grouping or deduping by kind deletes a real grant.
  const html = render(HERMES_REQUEST);
  assert.match(html, /Allow for session/);
  assert.match(html, /Allow always/);
  assert.equal((html.match(/font-weight:600/g) ?? []).length >= 5, true, "every option label is weighted, not just the primary");
});

test("an always option is visually distinct from its once sibling", () => {
  const html = render(HERMES_REQUEST);
  // The durable badge appears on every *_always option and on no other:
  // allow_session, allow_always and deny_always, but never allow_once or deny.
  assert.equal((html.match(/Remembered/g) ?? []).length, 3);
  // allow_once is the filled primary; allow_always is not filled the same way,
  // so a durable grant can never be picked up as the ordinary one at a glance.
  assert.match(html, /background:var\(--accent\)/, "allow_once is the filled primary button");
  assert.match(html, /color:var\(--accent\)/, "allow_always stays an approval, outlined rather than filled");
});

test("refusal reads as the safe secondary choice, never as the primary", () => {
  const html = render({
    requestId: "perm-2",
    toolCall: { title: "Delete build/", kind: "delete" },
    options: [
      { optionId: "no", name: "Deny", kind: "reject_once" },
      { optionId: "yes", name: "Allow", kind: "allow_once" },
    ],
  });
  // Exactly one filled accent button, and it is the allow.
  assert.equal((html.match(/background:var\(--accent\)/g) ?? []).length, 1);
  const denyIndex = html.indexOf("Deny");
  const allowIndex = html.indexOf(">Allow<");
  assert.ok(denyIndex < allowIndex, "the agent's order is preserved even when refusal comes first");
  assert.match(html, /color:var\(--text-muted\)/, "a plain refusal is the quiet control");
});

test("a tool call with no title still says something", () => {
  const html = render({ requestId: "perm-3", toolCall: null, options: HERMES_REQUEST.options });
  assert.match(html, /The agent is asking to use a tool\./);
  assert.equal((html.match(/<button/g) ?? []).length, 5, "an unreadable tool call must never hide the choices");
});

test("a known tool kind is translated; an agent-specific one is passed through", () => {
  assert.match(render(HERMES_REQUEST), /Run command/);
  const custom = render({
    requestId: "perm-4",
    toolCall: { title: "Do a thing", kind: "hermes_routine" },
    options: HERMES_REQUEST.options,
  });
  assert.match(custom, /hermes_routine/, "an unmapped kind renders verbatim, never as a missing key");
  assert.doesNotMatch(custom, /permissionRequest\.kind/, "no raw i18n key ever reaches the page");
});

test("the option name is the agent's own words, never translated", () => {
  // Passing an option name through the dictionary would rewrite the only thing
  // that distinguishes two options sharing a kind.
  assert.doesNotMatch(card, /t\(option\.name\)|translate\(option\.name\)/);
  assert.match(card, /\{option\.name\}/);
});

test("React keys off optionId, never the kind or the array index", () => {
  assert.match(card, /key=\{option\.optionId\}/);
  assert.doesNotMatch(card, /key=\{option\.kind\}/);
  assert.doesNotMatch(card, /key=\{index\}/);
});

test("one click is all a card ever sends", () => {
  // The answer settles a JSON-RPC request the agent is blocked on; a second
  // click at best does nothing and at worst answers a later request.
  assert.match(card, /const \[answeredWith, setAnsweredWith\]/);
  assert.match(card, /disabled=\{answeredWith !== null\}/);
  assert.match(card, /disabled=\{disabled\}/);
  // The latch is a REF, not the state: two clicks in one task both read the
  // pre-render state, and `disabled` only reaches the DOM after React commits.
  // A state-only guard was measured sending three answers for one card.
  assert.match(card, /const answeredRef = useRef<string \| null>\(null\)/);
  assert.match(card, /if \(answeredRef\.current !== null\) return;/);
  assert.match(card, /answeredRef\.current = option\.optionId;/);
});

test("the card is inline in the transcript, not a modal", () => {
  // ExtensionDialog is deliberately a modal; this is deliberately not one. An
  // approval arrives mid-stream and the answer depends on what the agent just
  // said, so the transcript must stay readable underneath it.
  assert.doesNotMatch(card, /aria-modal/);
  assert.doesNotMatch(card, /position: "absolute"|position: "fixed"/);
  assert.doesNotMatch(card, /overlay-backdrop/);
  // Rendered in the message column, at the live tail next to the running-tool
  // indicator — the sentinel that ends the transcript comes after it.
  const tail = chatWindow.slice(chatWindow.indexOf("chat-status-slot"), chatWindow.indexOf("ref={messagesEndRef}"));
  assert.match(tail, /<PermissionRequestCard/);
  assert.match(tail, /key=\{request\.requestId\}/);
});

test("the hook adds on request and removes on resolve", () => {
  assert.match(hook, /case "permission_request": \{/);
  assert.match(hook, /case "permission_resolved": \{/);
  const resolved = hook.slice(hook.indexOf('case "permission_resolved": {'), hook.indexOf('case "command_output": {'));
  assert.match(resolved, /existing\.requestId !== requestId/, "resolution removes by requestId");
});

test("a reloaded tab recovers the open approval from get_state", () => {
  // The permission_request event fired before the page existed, so state is
  // the only place the request can still be found. reconcileAgentState alone
  // is NOT enough: it early-returns unless a run is already believed to be in
  // flight, which is false immediately after a reload.
  const load = hook.slice(hook.indexOf("const loadSession = useCallback"), hook.indexOf("const loadContext = useCallback"));
  assert.match(load, /liveState\.pendingPermissions !== undefined/);
  assert.match(load, /adoptPermissionRequests\(liveState\.pendingPermissions\)/);
  // ...and a session with no live engine cannot have anything pending.
  assert.match(load, /adoptPermissionRequests\(undefined\)/);

  // The poll is the recovery net for an event lost to a dropped stream, and
  // must read the field BEFORE the busy early-return — a turn blocked on an
  // approval is exactly a busy turn.
  const reconcile = hook.slice(
    hook.indexOf("const reconcileAgentState = useCallback"),
    hook.indexOf("}, [finishPromptWithoutStream, refreshSubagentRoster, adoptPermissionRequests]);"),
  );
  const adoptAt = reconcile.indexOf("adoptPermissionRequests(state.pendingPermissions)");
  const busyAt = reconcile.indexOf("if (busy || !agentRunningRef.current) return;");
  assert.ok(adoptAt !== -1 && busyAt !== -1 && adoptAt < busyAt, "approvals must be mirrored before the busy return");
});

test("answering is optimistic, logged rather than thrown, and session-scoped", () => {
  const respondAt = hook.indexOf("const respondToPermission = useCallback");
  const respond = hook.slice(respondAt, hook.indexOf("}, [session?.id]);", respondAt));
  assert.match(respond, /setPermissionRequests\(\(prev\) => prev\.filter\(/, "the card goes on click");
  assert.match(respond, /type: "respond_permission", requestId, optionId/);
  assert.match(respond, /console\.error\("Failed to answer permission request:"/);
  assert.doesNotMatch(respond, /throw /);
  // Switching sessions drops the cards: answering one from another
  // conversation would grant something in a transcript nobody is reading.
  assert.match(respond, /setPermissionRequests\(\(prev\) => \(prev\.length === 0 \? prev : \[\]\)\);/);
});

test("the approval copy is real in all three locales", () => {
  const keys = [
    "permissionRequest.durable",
    "permissionRequest.heading",
    "permissionRequest.kindDelete",
    "permissionRequest.kindEdit",
    "permissionRequest.kindExecute",
    "permissionRequest.kindFetch",
    "permissionRequest.kindMove",
    "permissionRequest.kindOther",
    "permissionRequest.kindRead",
    "permissionRequest.kindSearch",
    "permissionRequest.kindSwitchMode",
    "permissionRequest.kindThink",
    "permissionRequest.sending",
    "permissionRequest.untitled",
  ];
  for (const key of keys) {
    for (const [name, dictionary] of Object.entries(locales)) {
      assert.equal(typeof dictionary[key], "string", `${name} is missing ${key}`);
      assert.ok(dictionary[key].trim().length > 0, `${name}:${key} is empty`);
    }
    assert.notEqual(locales.ja[key], locales.en[key], `ja:${key} was not translated`);
    assert.notEqual(locales["zh-CN"][key], locales.en[key], `zh-CN:${key} was not translated`);
  }
});
