import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * What a notification can safely let a phone answer, and how its text is cut.
 * The button rules are the heart of this file: a tap on a lock screen must only
 * ever give one narrow answer to one question.
 */
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const compose = await jiti.import("./compose.ts");
const catalog = await jiti.import("./catalog.ts");

const ui = (fields) => ({ id: "req-1", ...fields });
const labelsOf = (offer) => offer?.choices.map((choice) => choice.label);
const answersOf = (offer) => offer?.choices.map((choice) => choice.answer);

// ---------------------------------------------------------------------------
// omp dialogs
// ---------------------------------------------------------------------------

test("a tool approval gets Allow and Deny, answering confirmed true and false", () => {
  const offer = compose.answerOfferForUiRequest(ui({ method: "confirm", title: "Allow tool: bash", message: "ls" }));
  assert.equal(offer.kind, "ui");
  assert.equal(offer.requestId, "req-1");
  assert.deepEqual(labelsOf(offer), ["Allow", "Deny"]);
  assert.deepEqual(answersOf(offer), [{ confirmed: true }, { confirmed: false }]);
  assert.deepEqual(labelsOf(compose.answerOfferForUiRequest(ui({ method: "confirm", title: "ALLOW TOOL : edit" }))), ["Allow", "Deny"], "the title match is case-insensitive");
});

// omp sends its tool approval as a `select` (18.8.3: just "Approve" and "Deny"; since 18.11.3 with more rows),
// never as a confirm. The options are, in order: grants for this session, grants across sessions, "Approve"
// ("Approve Once" once any grant is offered), "Approve <subject> for this session", "Deny". A lock-screen tap
// must only ever allow ONE call or deny it.
const approvalSelect = (options, title = "Allow tool: bash\nOrigin: built-in\nnpm test") => ui({ method: "select", title, options });
const SESSION_LABEL = "Approve bash for this session";

test("a tool approval select gets 'Allow once' and 'Deny' only, never the session-wide approval beside them", () => {
  const old = compose.answerOfferForUiRequest(approvalSelect(["Approve", "Deny"]));
  assert.deepEqual(labelsOf(old), ["Allow once", "Deny"]);
  assert.deepEqual(answersOf(old), [{ value: "Approve" }, { value: "Deny" }]);

  // Three options used to make three buttons: the middle one approved the tool for the rest of the session.
  const session = compose.answerOfferForUiRequest(approvalSelect(["Approve", SESSION_LABEL, "Deny"]));
  assert.deepEqual(labelsOf(session), ["Allow once", "Deny"]);
  assert.deepEqual(answersOf(session), [{ value: "Approve" }, { value: "Deny" }]);
});

test("a tool approval that also offers grants answers 'Approve Once', never the grant labelled 'Approve'", () => {
  const files = approvalSelect(["Approve Directory: /repo", "Always Approve Directory: /repo", "Approve Once", SESSION_LABEL, "Deny"]);
  const offer = compose.answerOfferForUiRequest(files);
  assert.deepEqual(answersOf(offer), [{ value: "Approve Once" }, { value: "Deny" }]);
  // A non-file target's grants are labelled plainly "Approve" and "Always Approve".
  const plain = compose.answerOfferForUiRequest(approvalSelect(["Approve", "Always Approve", "Approve Once", "Deny"]));
  assert.deepEqual(answersOf(plain), [{ value: "Approve Once" }, { value: "Deny" }]);
  for (const value of ["Approve", "Always Approve", "Approve Directory: /repo"]) {
    for (const choice of [...offer.choices, ...plain.choices]) assert.notEqual(choice.answer.value, value);
  }
});

test("a tool approval whose narrow option cannot be told apart gets no buttons at all", () => {
  for (const options of [
    ["Approve", "Always Approve", "Deny"], // "Approve" would be a grant, and there is no one-call option
    ["Approve", "Remember for an hour", "Deny"], // a row this code does not know
    ["Approve", "Approve"],
    ["Approve", "Deny", "Deny"],
    ["Approve Once", "Approve Once", "Deny"],
    ["Approve", SESSION_LABEL],
    ["Deny"],
    ["Approve", 2, "Deny"],
    [],
  ]) {
    assert.equal(compose.answerOfferForUiRequest(approvalSelect(options)), null, JSON.stringify(options));
  }
  assert.equal(compose.answerOfferForUiRequest(ui({ method: "select", title: "Allow tool: bash" })), null);
});

test("toolApprovalSelect reads the tool and its details, and says whether more than 'once' was on offer", () => {
  const plain = compose.toolApprovalSelect(approvalSelect(["Approve", "Deny"]));
  assert.deepEqual(plain, { tool: "bash", details: "Origin: built-in\nnpm test", once: "Approve", deny: "Deny", broader: false });
  assert.equal(compose.toolApprovalSelect(approvalSelect(["Approve", SESSION_LABEL, "Deny"])).broader, true);
  assert.equal(compose.toolApprovalSelect(approvalSelect(["Approve Once", "Approve", "Deny"])).once, "Approve Once");
  assert.equal(compose.toolApprovalSelect(ui({ method: "select", title: "Pick one", options: ["Approve", "Deny"] })), null, "only a tool approval");
  assert.equal(compose.toolApprovalSelect(ui({ method: "confirm", title: "Allow tool: bash" })), null, "only the select form");
});

test("any other confirm gets Yes and No", () => {
  const offer = compose.answerOfferForUiRequest(ui({ method: "confirm", title: "Overwrite the file?" }));
  assert.deepEqual(labelsOf(offer), ["Yes", "No"]);
  assert.deepEqual(answersOf(offer), [{ confirmed: true }, { confirmed: false }]);
});

test("a select gets one button per option when there are at most three, answering the option itself", () => {
  for (const options of [["Only"], ["Yes", "No"], ["red", "green", "blue"]]) {
    const offer = compose.answerOfferForUiRequest(ui({ method: "select", title: "Pick", options }));
    assert.deepEqual(labelsOf(offer), options);
    assert.deepEqual(answersOf(offer), options.map((value) => ({ value })));
  }
});

test("a select with more than three options, none, or one it cannot read gets no buttons", () => {
  assert.equal(compose.answerOfferForUiRequest(ui({ method: "select", title: "Pick", options: ["a", "b", "c", "d"] })), null);
  assert.equal(compose.answerOfferForUiRequest(ui({ method: "select", title: "Pick", options: [] })), null);
  assert.equal(compose.answerOfferForUiRequest(ui({ method: "select", title: "Pick" })), null);
  assert.equal(compose.answerOfferForUiRequest(ui({ method: "select", title: "Pick", options: ["a", 2, "c"] })), null, "never a subset of what was asked");
  assert.equal(compose.answerOfferForUiRequest(ui({ method: "select", title: "Pick", options: ["a", "   "] })), null, "an option that cannot be labelled spoils the set");
});

// Since 18.18.3 omp's `ask` tool reaches an RPC client one field at a time as ordinary `select` requests.
test("omp's field-by-field ask: the 'Other (type your own)' row is a typed answer, so it is never a button", () => {
  const radio = compose.answerOfferForUiRequest(ui({ method: "select", title: "Which color?", options: ["Red", "Blue", "Other (type your own)"] }));
  assert.deepEqual(labelsOf(radio), ["Red", "Blue"]);
  assert.deepEqual(answersOf(radio), [{ value: "Red" }, { value: "Blue" }]);
  // Three choices plus the Other row used to be four entries, and so no buttons at all.
  const three = compose.answerOfferForUiRequest(ui({ method: "select", title: "Which?", options: ["A", "B", "C", "Other (type your own)"] }));
  assert.deepEqual(labelsOf(three), ["A", "B", "C"]);
  assert.equal(compose.answerOfferForUiRequest(ui({ method: "select", title: "Which?", options: ["Other (type your own)"] })), null, "nothing but the typed row");
});

test("omp's field-by-field ask: a multi-choice field is ticked in the chat, so it gets no buttons", () => {
  const done = "\u2714 Done selecting";
  const first = ui({ method: "select", title: "Which tags?", options: ["a", "b", "c", done] });
  const again = ui({ method: "select", title: "(1 selected) Which tags?", options: ["a", "b", "c"] });
  const other = ui({ method: "select", title: "(2 selected) Which tags?", options: ["a", "Other (type your own)", done] });
  for (const request of [first, again, other]) assert.equal(compose.answerOfferForUiRequest(request), null);
  assert.equal(compose.summarizeUiRequest(first).body, "Which tags?\n1. a\n2. b\n3. c\nOpen the chat to continue.", "its control row is not listed as a choice");
  assert.equal(compose.summarizeUiRequest(again).body, "(1 selected) Which tags?\n1. a\n2. b\n3. c\nOpen the chat to continue.");
});

test("omp 18.20 names its checkbox groups: even a required one with nothing ticked gets no buttons", () => {
  const checkbox = ui({ method: "select", title: "Notes above.\n\nWhich tags?", options: ["a", "b", "Other (type your own)"], selectionMarker: "checkbox", checkedIndices: [], markableCount: 3 });
  assert.equal(compose.answerOfferForUiRequest(checkbox), null, "a tap would tick a box, not answer");
  assert.ok(compose.summarizeUiRequest(checkbox).body.endsWith("Open the chat to continue."));
  // A radio group still answers from the lock screen.
  const radio = ui({ method: "select", title: "Notes above.\n\nWhich color?", options: ["Red", "Blue", "Other (type your own)"], selectionMarker: "radio", initialIndex: 0 });
  assert.deepEqual(labelsOf(compose.answerOfferForUiRequest(radio)), ["Red", "Blue"]);
});

const ask = (questions) => ui({ method: "ask", questions });
const question = (fields = {}) => ({ id: "q1", question: "Which?", options: [{ label: "Alpha" }, { label: "Beta" }], ...fields });

test("an ask with ONE question that takes ONE answer gets a button per option, in omp's answer shape", () => {
  const offer = compose.answerOfferForUiRequest(ask([question()]));
  assert.deepEqual(labelsOf(offer), ["Alpha", "Beta"]);
  assert.deepEqual(answersOf(offer), [
    { answers: [{ id: "q1", selectedOptions: ["Alpha"] }] },
    { answers: [{ id: "q1", selectedOptions: ["Beta"] }] },
  ]);
  const three = compose.answerOfferForUiRequest(ask([question({ options: [{ label: "a" }, { label: "b" }, { label: "c" }] })]));
  assert.equal(three.choices.length, 3);
});

test("an ask that is multi-select, several questions, has over three options or none gets no buttons", () => {
  assert.equal(compose.answerOfferForUiRequest(ask([question({ multi: true })])), null);
  assert.equal(compose.answerOfferForUiRequest(ask([question(), question({ id: "q2" })])), null);
  assert.equal(compose.answerOfferForUiRequest(ask([question({ options: ["a", "b", "c", "d"].map((label) => ({ label })) })])), null);
  assert.equal(compose.answerOfferForUiRequest(ask([question({ options: [] })])), null, "free text only");
  assert.equal(compose.answerOfferForUiRequest(ask([])), null);
  assert.equal(compose.answerOfferForUiRequest(ask([question({ options: [{ label: "ok" }, { description: "no label" }] })])), null);
  assert.equal(compose.answerOfferForUiRequest(ask([question(), "junk"])), null, "a second entry, even junk, means more than one question");
});

test("typed input, an editor, a link and anything unknown get no buttons", () => {
  for (const method of ["input", "editor", "open_url", "notify", "setStatus", "cancel", "mystery"]) {
    assert.equal(compose.answerOfferForUiRequest(ui({ method, title: "x", options: ["a"] })), null, method);
  }
});

test("a request with no id cannot be answered, so it gets no buttons", () => {
  assert.equal(compose.answerOfferForUiRequest({ method: "confirm", title: "Allow tool: bash" }), null);
  assert.equal(compose.answerOfferForUiRequest({ id: "", method: "confirm", title: "Allow tool: bash" }), null);
});

test("an offer carries the request's own deadline, and nothing when it has none", () => {
  assert.equal(compose.answerOfferForUiRequest(ui({ method: "confirm", title: "t", expiresAt: 123 })).expiresAt, 123);
  assert.equal("expiresAt" in compose.answerOfferForUiRequest(ui({ method: "confirm", title: "t" })), false);
});

test("button labels are cut to fit a button and the answer keeps the full text", () => {
  const long = "Use the experimental parser with strict mode";
  const offer = compose.answerOfferForUiRequest(ui({ method: "select", title: "Pick", options: [long, "short"] }));
  assert.equal(offer.choices[0].label.length, 24);
  assert.ok(offer.choices[0].label.endsWith("…"));
  assert.equal(offer.choices[0].answer.value, long);
  assert.equal(offer.choices[1].label, "short");
});

// ---------------------------------------------------------------------------
// ACP approvals
// ---------------------------------------------------------------------------

const permission = (options, extra = {}) => ({ type: "permission_request", requestId: "perm-1", toolCall: { title: "Run npm test", kind: "execute" }, options, ...extra });
const option = (optionId, name, kind) => ({ optionId, name, kind });

test("an approval is answerable with the agent's first allow-once and first reject-once, under the agent's names", () => {
  const offer = compose.answerOfferForPermission(permission([
    option("always", "Always allow", "allow_always"),
    option("yes", "Run it", "allow_once"),
    option("never", "Never", "reject_always"),
    option("no", "Not now", "reject_once"),
  ]));
  assert.equal(offer.kind, "permission");
  assert.equal(offer.requestId, "perm-1");
  assert.deepEqual(labelsOf(offer), ["Run it", "Not now"], "allow first, then reject; never the always options");
  assert.deepEqual(answersOf(offer), [{ optionId: "yes" }, { optionId: "no" }]);
});

test("NEVER a button for a lasting grant: only *_always options means no buttons at all", () => {
  assert.equal(compose.answerOfferForPermission(permission([option("a", "Allow always", "allow_always"), option("n", "Never", "reject_always")])), null);
  // And an agent that sends two "always" kinds (session / forever) never gets either as a button.
  const offer = compose.answerOfferForPermission(permission([
    option("s", "Allow for session", "allow_always"),
    option("f", "Allow always", "allow_always"),
    option("y", "Allow", "allow_once"),
  ]));
  assert.deepEqual(answersOf(offer), [{ optionId: "y" }]);
  for (const choice of offer.choices) assert.ok(!["s", "f"].includes(choice.answer.optionId));
});

test("when an agent offers several one-shot options only the first of each kind is used", () => {
  const offer = compose.answerOfferForPermission(permission([
    option("y1", "Allow", "allow_once"),
    option("y2", "Allow differently", "allow_once"),
    option("n1", "Deny", "reject_once"),
    option("n2", "Deny differently", "reject_once"),
  ]));
  assert.deepEqual(answersOf(offer), [{ optionId: "y1" }, { optionId: "n1" }]);
});

test("a lone reject-once is still a button; nothing usable, or no id, is none", () => {
  assert.deepEqual(labelsOf(compose.answerOfferForPermission(permission([option("n", "Decline", "reject_once")]))), ["Decline"]);
  assert.equal(compose.answerOfferForPermission(permission([])), null);
  assert.equal(compose.answerOfferForPermission(permission([{ optionId: "x", name: "No kind" }])), null);
  assert.equal(compose.answerOfferForPermission(permission([option("y", "Allow", "allow_once")], { requestId: "" })), null);
  assert.equal(compose.answerOfferForPermission({ type: "permission_request", options: [option("y", "Allow", "allow_once")] }), null);
});

test("a permission button label is cut to fit, but the option id is the full one", () => {
  const offer = compose.answerOfferForPermission(permission([option("opt-1", "Allow this one command for this one time only", "allow_once")]));
  assert.ok(offer.choices[0].label.length <= 24);
  assert.equal(offer.choices[0].label, "Allow this one command…", "cut at a space: the space goes, not the word's end");
  assert.equal(offer.choices[0].answer.optionId, "opt-1");
});

// ---------------------------------------------------------------------------
// Digests: a button belongs to ONE request
// ---------------------------------------------------------------------------

test("a dialog's digest ignores bookkeeping the wrapper adds and changes with anything a person would read", () => {
  const base = { id: "r", method: "select", title: "Pick", options: ["a", "b"] };
  const digest = compose.uiRequestDigest(base);
  assert.equal(compose.uiRequestDigest({ ...base, expiresAt: Date.now() + 5000, timeout: 5000 }), digest);
  assert.notEqual(compose.uiRequestDigest({ ...base, options: ["a", "c"] }), digest);
  assert.notEqual(compose.uiRequestDigest({ ...base, title: "Pick one" }), digest);
  assert.notEqual(compose.uiRequestDigest({ ...base, method: "confirm" }), digest);
  assert.notEqual(
    compose.uiRequestDigest(ask([question()])),
    compose.uiRequestDigest(ask([question({ options: [{ label: "Alpha" }, { label: "Gamma" }] })])),
  );
});

test("an approval's digest follows the tool call and which options exist", () => {
  const options = [option("y", "Allow", "allow_once"), option("n", "Deny", "reject_once")];
  const digest = compose.permissionDigest({ title: "rm -rf build" }, options);
  assert.equal(compose.permissionDigest({ title: "rm -rf build" }, options), digest);
  assert.notEqual(compose.permissionDigest({ title: "rm -rf /" }, options), digest, "perm-1 after a restart is a different request");
  assert.notEqual(compose.permissionDigest({ title: "rm -rf build" }, [option("y", "Allow", "allow_always")]), digest);
  assert.notEqual(compose.permissionDigest(null, options), digest);
});

// ---------------------------------------------------------------------------
// Sequence ids
// ---------------------------------------------------------------------------

test("a sequence id is cody- plus 24 hex, charset-safe for ntfy, stable, and unique per request", () => {
  const id = compose.sequenceIdFor("session-1", "req-1");
  assert.match(id, /^cody-[0-9a-f]{24}$/);
  assert.ok(id.length <= 64);
  assert.equal(compose.sequenceIdFor("session-1", "req-1"), id);
  assert.notEqual(compose.sequenceIdFor("session-1", "req-2"), id);
  assert.notEqual(compose.sequenceIdFor("session-2", "req-1"), id);
  assert.notEqual(compose.sequenceIdFor("ab", "c"), compose.sequenceIdFor("a", "bc"), "the boundary between the two parts is part of the hash");
  assert.match(compose.sequenceIdFor("sess/with:odd chars?", "perm 1/#"), /^cody-[0-9a-f]{24}$/, "whatever the inputs look like");
});

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

test("titles read '<kind> · <chat title>' on one line and stay under 120 characters", () => {
  assert.equal(compose.buildTitle("approval", "Fix login"), "Approval needed · Fix login");
  assert.equal(compose.buildTitle("finished", "  spaced\n  out  "), "Reply finished · spaced out");
  const long = compose.buildTitle("error", "x".repeat(500));
  assert.equal(Array.from(long).length, 120);
  assert.ok(long.endsWith("…"));
});

test("every kind has a title and a tag, so a new kind in the catalog cannot ship without them", () => {
  for (const id of catalog.NOTIFICATION_EVENT_IDS) {
    assert.ok(compose.EVENT_TITLES[id], `title for ${id}`);
    assert.ok(compose.EVENT_TAGS[id], `tag for ${id}`);
  }
});

test("clipping never splits a character, by count or by bytes", () => {
  assert.equal(compose.clipChars("short", 10), "short");
  assert.equal(compose.clipChars("0123456789", 5), "0123…");
  const emoji = "🚀".repeat(10);
  assert.equal(Array.from(compose.clipChars(emoji, 4)).length, 4, "an emoji counts once");
  assert.equal(compose.clipChars(emoji, 4), "🚀🚀🚀…");

  assert.equal(compose.clipBytes("ascii only", 100), "ascii only");
  const cut = compose.clipBytes("日本語日本語", 10);
  assert.equal(cut, "日本語", "9 bytes: the 4th character does not fit");
  assert.ok(Buffer.byteLength(cut) <= 10);
  for (let max = 0; max < 30; max += 1) {
    const clipped = compose.clipBytes("a🚀b日本語c", max);
    assert.ok(Buffer.byteLength(clipped) <= max, `${max} bytes`);
    assert.equal(clipped.includes("�"), false, `no broken character at ${max} bytes`);
  }
});

test("a body is cut to 1500 characters AND under ntfy's message limit even when every character is wide", () => {
  assert.equal(compose.buildBody("  hello\r\n\r\n\r\n\r\nworld  "), "hello\n\nworld");
  const ascii = compose.buildBody("a".repeat(5000));
  assert.equal(ascii.length, 1500);
  const wide = compose.buildBody("日".repeat(5000));
  assert.ok(Buffer.byteLength(wide) <= 3500, `${Buffer.byteLength(wide)} bytes`);
  assert.ok(Buffer.byteLength(wide) > 3000, "but not needlessly short");
  const emoji = compose.buildBody("🚀".repeat(5000));
  assert.ok(Buffer.byteLength(emoji) <= 3500);
  assert.equal(emoji.includes("�"), false);
});

test("the project tag is the working directory's own name, made safe", () => {
  assert.equal(compose.projectTag("/home/me/code/my-project"), "my-project");
  assert.equal(compose.projectTag("/home/me/code/my project.v2/"), "my project.v2");
  assert.equal(compose.projectTag("/work/we!rd,name;here"), "we-rd-name-here");
  assert.equal(compose.projectTag("/x/" + "n".repeat(100)).length, 32);
  assert.equal(compose.projectTag(""), null);
  assert.equal(compose.projectTag(undefined), null);
  assert.equal(compose.projectTag("/"), null);
});

test("a reply is quoted from its start; a waiting reply from the line that asks", () => {
  assert.equal(compose.replyExcerpt("All done.\n\n\nTests pass."), "All done.\nTests pass.");
  assert.equal(Array.from(compose.replyExcerpt("x".repeat(1000))).length, 300);

  const reply = "I compared both approaches at length.\nThe first is simpler.\nThe second scales better.\nWhich one do you want me to use?";
  assert.equal(compose.questionExcerpt(reply), "… Which one do you want me to use?");
  assert.equal(compose.questionExcerpt("Shall I go ahead?"), "Shall I go ahead?", "a one-line question is quoted whole, no ellipsis");
  assert.equal(compose.questionExcerpt("Nothing to ask here, just a statement."), "Nothing to ask here, just a statement.", "no line asks: quoted from the start");
});

// ---------------------------------------------------------------------------
// What each dialog says
// ---------------------------------------------------------------------------

test("a tool approval is an approval naming the tool; every other dialog is a question", () => {
  const approval = compose.summarizeUiRequest(ui({ method: "confirm", title: "Allow tool: bash", message: "Run: rm -rf build" }));
  assert.equal(approval.event, "approval");
  assert.equal(approval.body, "Tool: bash\nRun: rm -rf build");

  assert.deepEqual(compose.summarizeUiRequest(ui({ method: "confirm", title: "Overwrite?", message: "It exists." })), { event: "question", body: "Overwrite?\nIt exists." });
  assert.deepEqual(compose.summarizeUiRequest(ui({ method: "select", title: "Pick", options: ["a", "b"] })), { event: "question", body: "Pick\n1. a\n2. b" });
  assert.deepEqual(compose.summarizeUiRequest(ui({ method: "input", title: "Branch name?" })), { event: "question", body: "Branch name?" });
  assert.equal(compose.summarizeUiRequest(ui({ method: "editor", title: "Edit the message" })).event, "question");
  assert.equal(compose.summarizeUiRequest(ui({ method: "notify", message: "hi" })), null);
  assert.equal(compose.summarizeUiRequest(ui({ method: "setStatus" })), null);
});

test("a tool approval select is an approval naming the tool; the grant rows are left to the chat", () => {
  const simple = compose.summarizeUiRequest(approvalSelect(["Approve", "Deny"]));
  assert.deepEqual(simple, { event: "approval", body: "Tool: bash\nOrigin: built-in\nnpm test" });

  const broader = compose.summarizeUiRequest(approvalSelect(["Approve Directory: /repo", "Approve Once", SESSION_LABEL, "Deny"]));
  assert.equal(broader.event, "approval");
  assert.equal(broader.body, "Tool: bash\nOrigin: built-in\nnpm test\nOpen the chat to choose how long to allow it.");
  assert.equal(broader.body.includes("Directory"), false, "no option list that could read as a button");

  // A list this code cannot read still says what is being asked, and sends the person to the chat.
  const unreadable = compose.summarizeUiRequest(approvalSelect(["Approve", "Always Approve", "Deny"]));
  assert.equal(unreadable.event, "approval");
  assert.match(unreadable.body, /^Tool: bash\n.*Open the chat to choose/s);
});

test("a link request never puts the link in the notification", () => {
  const summary = compose.summarizeUiRequest(ui({ method: "open_url", title: "Sign in", url: "https://auth.example.com/login?code=ONE-TIME-SECRET" }));
  assert.equal(summary.event, "question");
  assert.equal(summary.body.includes("ONE-TIME-SECRET"), false);
  assert.equal(summary.body.includes("https://"), false);
});

test("an ask lists its questions and their options, numbered only when there are several", () => {
  const one = compose.summarizeUiRequest(ask([question({ header: "Pick" })]));
  assert.equal(one.body, "Pick: Which?\n   - Alpha\n   - Beta");
  const two = compose.summarizeUiRequest(ask([question(), question({ id: "q2", question: "Why?", options: [] })]));
  assert.equal(two.body, "1. Which?\n   - Alpha\n   - Beta\n2. Why?");
});

test("an approval from an ACP agent says what it wants to do, in the agent's words", () => {
  assert.equal(compose.summarizePermission({ toolCall: { title: "Write src/index.ts", kind: "edit" } }), "Write src/index.ts");
  assert.equal(compose.summarizePermission({ toolCall: null }), "The agent wants permission to use a tool.");
  assert.equal(compose.summarizePermission({}), "The agent wants permission to use a tool.");
});
