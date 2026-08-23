import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  readPermissionOptions,
  readPermissionRequest,
  readPermissionRequests,
  describeToolCall,
  isDurableChoice,
  isAllowChoice,
} = await jiti.import("./permission-request.ts");

/**
 * These shapes arrive from an ARBITRARY agent over a socket. The card that
 * renders them sits inline in the transcript, so a throw here takes the whole
 * conversation down — every reader is total by construction.
 */

const HERMES_OPTIONS = [
  { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
  { optionId: "allow_session", name: "Allow for session", kind: "allow_always" },
  { optionId: "allow_always", name: "Allow always", kind: "allow_always" },
  { optionId: "deny", name: "Deny", kind: "reject_once" },
  { optionId: "deny_always", name: "Deny always", kind: "reject_always" },
];

test("the agent's options survive in the order it sent them", () => {
  const options = readPermissionOptions(HERMES_OPTIONS);
  assert.deepEqual(options.map((o) => o.optionId), [
    "allow_once", "allow_session", "allow_always", "deny", "deny_always",
  ]);
});

test("two options sharing a kind are two options", () => {
  // Hermes maps its session-scoped grant onto allow_always because ACP has no
  // session kind. Collapsing or deduping by kind would delete a real choice —
  // and the one the user most likely wants.
  const options = readPermissionOptions(HERMES_OPTIONS);
  const always = options.filter((o) => o.kind === "allow_always");
  assert.equal(always.length, 2);
  assert.deepEqual(always.map((o) => o.name), ["Allow for session", "Allow always"]);
});

test("an option missing a field is dropped, never rendered as a mystery button", () => {
  const options = readPermissionOptions([
    { optionId: "ok", name: "Allow", kind: "allow_once" },
    { optionId: "no-name", kind: "reject_once" },
    { optionId: "bad-kind", name: "Maybe", kind: "shrug" },
    { name: "no id", kind: "allow_once" },
    "not an object",
    null,
  ]);
  assert.deepEqual(options.map((o) => o.optionId), ["ok"]);
});

test("a duplicate optionId is dropped — the id is what the answer is sent as", () => {
  const options = readPermissionOptions([
    { optionId: "yes", name: "Allow", kind: "allow_once" },
    { optionId: "yes", name: "Allow again", kind: "allow_always" },
  ]);
  assert.deepEqual(options.map((o) => o.name), ["Allow"]);
});

test("a request with nothing clickable is not a request", () => {
  // The server already declines these; if one ever reaches the browser it must
  // not render as a card that can never be answered.
  assert.equal(readPermissionRequest({ requestId: "perm-1", options: [] }), null);
  assert.equal(readPermissionRequest({ options: HERMES_OPTIONS }), null);
  assert.equal(readPermissionRequest(null), null);
  assert.equal(readPermissionRequest("perm-1"), null);
});

test("a well-formed request keeps its id, toolCall and options", () => {
  const request = readPermissionRequest({
    type: "permission_request",
    requestId: "perm-3",
    toolCall: { toolCallId: "call-1", title: "Write src/index.ts", kind: "edit" },
    options: HERMES_OPTIONS,
  });
  assert.equal(request.requestId, "perm-3");
  assert.equal(request.options.length, 5);
  assert.deepEqual(describeToolCall(request.toolCall), {
    title: "Write src/index.ts",
    kind: "edit",
    kindKnown: true,
  });
});

test("get_state hydration reads the same shapes and ignores junk", () => {
  const requests = readPermissionRequests([
    { requestId: "perm-1", toolCall: null, options: HERMES_OPTIONS },
    { requestId: "perm-1", toolCall: null, options: HERMES_OPTIONS }, // duplicate id
    { requestId: "perm-2", options: [] },                             // nothing to click
    42,
  ]);
  assert.deepEqual(requests.map((r) => r.requestId), ["perm-1"]);
  assert.deepEqual(readPermissionRequests(undefined), []);
  assert.deepEqual(readPermissionRequests({ requestId: "perm-1" }), []);
});

test("a toolCall with no title or kind still describes cleanly", () => {
  // One agent builds a different payload for a shell command than for a file
  // edit; neither field is guaranteed by the protocol.
  assert.deepEqual(describeToolCall({}), { title: null, kind: null, kindKnown: false });
  assert.deepEqual(describeToolCall(null), { title: null, kind: null, kindKnown: false });
  assert.deepEqual(describeToolCall({ title: "   " }), { title: null, kind: null, kindKnown: false });
  assert.deepEqual(describeToolCall({ title: "rm -rf /tmp/x", kind: "execute" }), {
    title: "rm -rf /tmp/x",
    kind: "execute",
    kindKnown: true,
  });
});

test("an unknown kind is carried through verbatim rather than translated", () => {
  const summary = describeToolCall({ title: "Do a thing", kind: "hermes_routine" });
  assert.equal(summary.kind, "hermes_routine");
  assert.equal(summary.kindKnown, false);
});

test("a title long enough to push the buttons off screen is truncated", () => {
  const long = `Run: ${"a".repeat(1000)}`;
  const { title } = describeToolCall({ title: long });
  assert.ok(title.length < 420, "a shell pipeline must not run the card off the page");
  assert.ok(title.endsWith("…"));
});

test("durable and allow are read off the kind, and only for styling", () => {
  assert.equal(isDurableChoice("allow_always"), true);
  assert.equal(isDurableChoice("reject_always"), true);
  assert.equal(isDurableChoice("allow_once"), false);
  assert.equal(isDurableChoice("reject_once"), false);
  assert.equal(isAllowChoice("allow_once"), true);
  assert.equal(isAllowChoice("allow_always"), true);
  assert.equal(isAllowChoice("reject_once"), false);
  assert.equal(isAllowChoice("reject_always"), false);
});
