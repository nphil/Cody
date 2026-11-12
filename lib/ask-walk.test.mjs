import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * omp 18.18.3+ walks the `ask` tool's form one field at a time over plain
 * select / input / editor requests. These tests replay the exact request
 * sequences omp's `askChoice` produces (src/tools/ask.ts) and check what the
 * browser makes of them: which rows are ticked, when it must admit it does not
 * know, and that nothing here can mistake a tool approval for a question.
 */
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  askWithdrawnByMessage,
  createAskWalkTracker,
  dialogBelongsToAsk,
  isAskDoneRow,
  isAskOtherRow,
  isAskSelectedTitle,
  isToolApprovalTitle,
  parseAskWalkTitle,
} = await jiti.import("./ask-walk.ts");

const OTHER = "Other (type your own)";
const DONE = "✔ Done selecting";
const select = (id, title, options) => ({ id, method: "select", title, options });
const input = (id, title) => ({ id, method: "input", title });
const labels = (view) => view.rows.map((row) => row.label);
const kinds = (view) => view.rows.map((row) => row.kind);
const ticks = (view) => view.rows.map((row) => row.ticked);

test("the control rows and the count prefix are recognised", () => {
  assert.equal(isAskOtherRow(OTHER), true);
  assert.equal(isAskOtherRow("other (type your own) 2"), true);
  assert.equal(isAskOtherRow("Another option"), false);
  assert.equal(isAskDoneRow(DONE), true);
  assert.equal(isAskDoneRow("Done selecting"), true);
  assert.equal(isAskDoneRow("Selected and done"), false);
  assert.equal(isAskSelectedTitle("(2 selected) Which?"), true);
  assert.equal(isAskSelectedTitle("Which? (2 selected)"), false);
  assert.equal(isAskSelectedTitle(undefined), false);
  assert.deepEqual(parseAskWalkTitle("(12 selected) Which features?"), { question: "Which features?", selected: 12 });
  assert.deepEqual(parseAskWalkTitle("Which features?"), { question: "Which features?", selected: 0 });
});

test("a tool approval is never the model's question, and only a running ask owns plain dialogs", () => {
  assert.equal(isToolApprovalTitle("Allow tool: bash"), true);
  assert.equal(isToolApprovalTitle("allow tool : bash\nfrom MCP"), true);
  assert.equal(isToolApprovalTitle("Allow the tool?"), false);
  assert.equal(isToolApprovalTitle(undefined), false);

  assert.equal(dialogBelongsToAsk({ method: "ask" }, false), true);
  assert.equal(dialogBelongsToAsk({ method: "select", title: "Which?" }, true), true);
  assert.equal(dialogBelongsToAsk({ method: "input", title: "Which?" }, true), true);
  assert.equal(dialogBelongsToAsk({ method: "editor", title: "Notes" }, true), true);
  assert.equal(dialogBelongsToAsk({ method: "select", title: "Which?" }, false), false);
  assert.equal(dialogBelongsToAsk({ method: "select", title: "Allow tool: bash" }, true), false, "an approval can open while ask runs elsewhere");
  assert.equal(dialogBelongsToAsk({ method: "confirm", title: "Which?" }, true), false);
});

test("a message withdraws an open ask from omp 18.14.2", () => {
  assert.equal(askWithdrawnByMessage("18.14.1"), false);
  assert.equal(askWithdrawnByMessage("18.14.2"), true);
  assert.equal(askWithdrawnByMessage("18.14.10"), true);
  assert.equal(askWithdrawnByMessage("18.19.0"), true);
  assert.equal(askWithdrawnByMessage("19.0.0"), true);
  assert.equal(askWithdrawnByMessage("18.8.3"), false);
  assert.equal(askWithdrawnByMessage("17.99.9"), false);
  assert.equal(askWithdrawnByMessage("omp 18.19.0"), true);
  assert.equal(askWithdrawnByMessage(null), false, "an unreadable version claims nothing");
  assert.equal(askWithdrawnByMessage(undefined), false);
  assert.equal(askWithdrawnByMessage(""), false);
});

test("a checkbox group: each pick toggles, the count follows, Done ends the field", () => {
  const walk = createAskWalkTracker();
  const first = select("1", "Which features?", ["A", "B", "C", OTHER, DONE]);
  const view = walk.observe(first);
  assert.equal(view.question, "Which features?");
  assert.equal(view.multi, true);
  assert.equal(view.selected, 0);
  assert.equal(view.ticksKnown, true);
  assert.deepEqual(labels(view), ["A", "B", "C", OTHER, DONE]);
  assert.deepEqual(kinds(view), ["option", "option", "option", "other", "done"]);
  assert.deepEqual(ticks(view), [false, false, false, false, undefined]);
  assert.equal(walk.observe(first), view, "a replay of the same request answers the same");

  const staying = walk.reply(first, { value: "B" });
  assert.equal(staying.selected, 1);
  assert.deepEqual(ticks(staying), [false, true, false, false, undefined]);

  const second = select("2", "(1 selected) Which features?", ["A", "B", "C", OTHER, DONE]);
  const next = walk.observe(second);
  assert.equal(next.question, "Which features?", "the count prefix is not part of the question");
  assert.equal(next.selected, 1);
  assert.equal(next.ticksKnown, true);
  assert.deepEqual(ticks(next), [false, true, false, false, undefined]);

  const unticked = walk.reply(second, { value: "B" });
  assert.equal(unticked.selected, 0);
  assert.deepEqual(ticks(unticked), [false, false, false, false, undefined]);

  const third = select("3", "Which features?", ["A", "B", "C", OTHER, DONE]);
  const again = walk.observe(third);
  assert.equal(again.multi, true);
  assert.equal(again.ticksKnown, true);
  assert.deepEqual(ticks(again), [false, false, false, false, undefined]);

  assert.equal(walk.reply(third, { value: DONE }), null, "Done sends and the dialog goes away");
  assert.equal(walk.observe(select("4", "Pick one", ["x", "y"])), null, "the next plain field is no walk step");
});

test("a required group shows no Done row until one box is ticked: its first pick is still tracked", () => {
  const walk = createAskWalkTracker();
  const first = select("1", "Which?", ["A", "B", OTHER]);
  const view = walk.observe(first);
  assert.equal(view.multi, false, "indistinguishable from a radio group at this point");
  assert.deepEqual(kinds(view), ["option", "option", "other"]);
  assert.equal(walk.reply(first, { value: "A" }), null);

  const second = select("2", "(1 selected) Which?", ["A", "B", OTHER, DONE]);
  const next = walk.observe(second);
  assert.equal(next.multi, true);
  assert.equal(next.ticksKnown, true, "one pick on an empty field is the count of 1");
  assert.deepEqual(ticks(next), [true, false, false, undefined]);

  // Unticking the only box hides Done again: the field is still the same one.
  const toggled = walk.reply(second, { value: "A" });
  assert.equal(toggled.selected, 0);
  const third = select("3", "Which?", ["A", "B", OTHER]);
  const back = walk.observe(third);
  assert.equal(back.multi, true, "the walk knows this is the checkbox group it was ticking");
  assert.equal(back.ticksKnown, true);
  assert.deepEqual(ticks(back), [false, false, false]);
});

test("preselected boxes are counted but never named: the screen shows the count alone", () => {
  const walk = createAskWalkTracker();
  const first = select("1", "(2 selected) Which?", ["A", "B", "C", OTHER, DONE]);
  const view = walk.observe(first);
  assert.equal(view.selected, 2);
  assert.equal(view.ticksKnown, false);
  assert.deepEqual(ticks(view), [undefined, undefined, undefined, undefined, undefined]);

  const staying = walk.reply(first, { value: "C" });
  assert.equal(staying.ticksKnown, false, "it cannot tell which way the pick went");
  assert.equal(staying.selected, 2, "the count waits for omp's next question");

  const second = select("2", "(3 selected) Which?", ["A", "B", "C", OTHER, DONE]);
  assert.equal(walk.observe(second).ticksKnown, false);
  assert.equal(walk.observe(second).selected, 3);

  // Nothing ticked is a fact again, whatever came before.
  const empty = select("3", "Which?", ["A", "B", "C", OTHER, DONE]);
  const reset = walk.observe(empty);
  assert.equal(reset.ticksKnown, true);
  assert.deepEqual(ticks(reset), [false, false, false, false, undefined]);
});

test("a count that disagrees with the mirror turns the ticks off instead of showing wrong ones", () => {
  const walk = createAskWalkTracker();
  const first = select("1", "Which?", ["A", "B", OTHER, DONE]);
  walk.observe(first);
  walk.reply(first, { value: "A" });
  const second = select("2", "(2 selected) Which?", ["A", "B", OTHER, DONE]);
  const view = walk.observe(second);
  assert.equal(view.ticksKnown, false);
  assert.deepEqual(ticks(view), [undefined, undefined, undefined, undefined]);
});

test("Other: a typed answer counts as one tick and the row clears it", () => {
  const walk = createAskWalkTracker();
  const first = select("1", "Which?", ["A", "B", OTHER, DONE]);
  walk.observe(first);
  assert.equal(walk.reply(first, { value: OTHER }), null, "omp asks for the text next, so the select goes away");

  const typed = input("i1", "Which?");
  assert.equal(walk.observe(typed), null);
  assert.equal(walk.reply(typed, { value: "  mine  " }), null);

  const second = select("2", "(1 selected) Which?", ["A", "B", OTHER, DONE]);
  const view = walk.observe(second);
  assert.equal(view.ticksKnown, true);
  assert.deepEqual(ticks(view), [false, false, true, undefined]);
  assert.equal(view.rows[2].typed, "mine", "the row shows what was typed behind it, trimmed");
  assert.equal(view.rows[0].typed, undefined);

  const cleared = walk.reply(second, { value: OTHER });
  assert.equal(cleared.selected, 0, "picking Other again clears the typed answer and asks nothing");
  assert.deepEqual(ticks(cleared), [false, false, false, undefined]);
  assert.equal(cleared.rows[2].typed, undefined, "clearing the row forgets the text");

  const third = select("3", "Which?", ["A", "B", OTHER, DONE]);
  assert.deepEqual(ticks(walk.observe(third)), [false, false, false, undefined]);
});

test("Other: a blank or cancelled typed answer leaves it unchecked", () => {
  for (const response of [{ value: "   " }, { cancelled: true }]) {
    const walk = createAskWalkTracker();
    const first = select("1", "Which?", ["A", OTHER, DONE]);
    walk.observe(first);
    walk.reply(first, { value: OTHER });
    const typed = input("i1", "Which?");
    walk.observe(typed);
    walk.reply(typed, response);
    const view = walk.observe(select("2", "Which?", ["A", OTHER, DONE]));
    assert.equal(view.ticksKnown, true);
    assert.deepEqual(ticks(view), [false, false, undefined]);
  }
});

test("a radio group is a plain list whose last row opens a typed answer", () => {
  const walk = createAskWalkTracker();
  const first = select("1", "Which plan?", ["Free", "Pro", OTHER]);
  const view = walk.observe(first);
  assert.equal(view.multi, false);
  assert.deepEqual(kinds(view), ["option", "option", "other"]);
  assert.equal(walk.reply(first, { value: OTHER }), null);
  const typed = input("i1", "Which plan?");
  walk.observe(typed);
  assert.equal(walk.reply(typed, { value: "Team" }), null, "no checkbox field was open, so there is nothing to tick");

  // Without an Other row (a field that forbids it) it is just a select.
  assert.equal(walk.observe(select("2", "Which plan?", ["Free", "Pro"])), null);
});

test("cancelling a step ends the field in progress", () => {
  const walk = createAskWalkTracker();
  const first = select("1", "Which?", ["A", "B", OTHER, DONE]);
  walk.observe(first);
  walk.reply(first, { value: "A" });
  const second = select("2", "(1 selected) Which?", ["A", "B", OTHER, DONE]);
  walk.observe(second);
  assert.equal(walk.reply(second, { cancelled: true }), null);
  // A fresh, unrelated radio-looking field with the same words is not the old checkbox group.
  const view = walk.observe(select("3", "Which?", ["A", "B", OTHER]));
  assert.equal(view.multi, false);
});

test("a withdrawn dialog ends the walk; a withdrawn stranger changes nothing", () => {
  const walk = createAskWalkTracker();
  const first = select("1", "Which?", ["A", "B", OTHER, DONE]);
  walk.observe(first);
  walk.reply(first, { value: "A" });
  const second = select("2", "(1 selected) Which?", ["A", "B", OTHER, DONE]);
  walk.observe(second);

  walk.withdrawn("unrelated");
  assert.equal(walk.observe(select("3", "Which?", ["A", "B", OTHER])).multi, true, "still the same checkbox group");

  walk.withdrawn("3");
  assert.equal(walk.observe(select("4", "Which?", ["A", "B", OTHER])).multi, false, "the ask was withdrawn: a new ask starts clean");

  // A withdrawn typed-answer input ends it as well.
  const again = select("5", "Q?", ["A", OTHER, DONE]);
  walk.observe(again);
  walk.reply(again, { value: OTHER });
  walk.observe(input("i1", "Q?"));
  walk.withdrawn("i1");
  assert.equal(walk.observe(select("6", "Q?", ["A", OTHER])).multi, false);
});

test("answering one step twice (a double tap) toggles once", () => {
  const walk = createAskWalkTracker();
  const first = select("1", "Which?", ["A", "B", OTHER, DONE]);
  walk.observe(first);
  assert.ok(walk.reply(first, { value: "A" }));
  assert.equal(walk.reply(first, { value: "A" }), null);
  const view = walk.observe(select("2", "(1 selected) Which?", ["A", "B", OTHER, DONE]));
  assert.equal(view.ticksKnown, true);
  assert.deepEqual(ticks(view), [true, false, false, undefined]);
});

test("anything but a select is not a walk step, and an approval keeps its own shape", () => {
  const walk = createAskWalkTracker();
  assert.equal(walk.observe({ id: "c", method: "confirm", title: "Sure?" }), null);
  assert.equal(walk.observe({ id: "e", method: "editor", title: "Notes" }), null);
  assert.equal(walk.observe(select("a", "Allow tool: bash", ["Approve", "Approve for this session", "Deny"])), null);
});
