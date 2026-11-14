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
  askCallPending,
  askWithdrawnByMessage,
  createAskWalkTracker,
  dialogBelongsToAsk,
  isAskDoneRow,
  isAskMultiStep,
  isAskOtherRow,
  isAskSelectedTitle,
  isAskToolCall,
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
  assert.deepEqual(parseAskWalkTitle("(12 selected) Which features?"), { context: "", question: "Which features?", selected: 12 });
  assert.deepEqual(parseAskWalkTitle("Which features?"), { context: "", question: "Which features?", selected: 0 });
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
  assert.equal(view.radio, false, "an engine that sends no marker never says so");
  assert.equal(view.context, "");
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

// What a real omp 18.20.0 child sends for `ask` over RPC (recorded with a mock model, the prose shortened): every
// prompt leads with the text around the field, a blank line, then the question; a select names its markers.
const CONTEXT = "Every extra is billed monthly.\n\n1. Search indexes every file.\n2. Export writes a nightly archive.\n\nnpm run build\n\nExtra | Cost\nSearch | 4 USD";
const QUESTION = "Which extras should be switched on?";
const EXTRAS = ["Search", "Export", "Alerts", OTHER, DONE];
const withContext = (question, selected = 0) => `${CONTEXT}\n\n${selected > 0 ? `(${selected} selected) ` : ""}${question}`;
const marked = (id, title, options, fields) => ({ id, method: "select", title, options, ...fields });
const extras = (id, checkedIndices, initialIndex = 0) =>
  marked(id, withContext(QUESTION, checkedIndices.length), EXTRAS, { selectionMarker: "checkbox", initialIndex, checkedIndices, markableCount: 4 });

test("omp 18.20 puts the text around the field above the question, with the count on the question's own line", () => {
  assert.deepEqual(parseAskWalkTitle(withContext(QUESTION, 2)), { context: CONTEXT, question: QUESTION, selected: 2 });
  assert.deepEqual(parseAskWalkTitle(withContext(QUESTION)), { context: CONTEXT, question: QUESTION, selected: 0 });
  assert.equal(isAskSelectedTitle(withContext(QUESTION, 1)), true, "the count is on the last line, not the first");
  assert.equal(isAskSelectedTitle(withContext(QUESTION)), false);
  assert.equal(isAskSelectedTitle(`(3 selected) a line of the explanation\n\n${QUESTION}`), false, "only the question line can carry it");
});

test("a step is multi-choice when its marker, its count or its Done row says so", () => {
  assert.equal(isAskMultiStep({ title: QUESTION, options: ["A", OTHER], selectionMarker: "checkbox" }), true);
  assert.equal(isAskMultiStep({ title: QUESTION, options: ["A", OTHER], selectionMarker: "radio" }), false);
  assert.equal(isAskMultiStep({ title: withContext(QUESTION, 1), options: ["A", OTHER] }), true);
  assert.equal(isAskMultiStep({ title: QUESTION, options: ["A", OTHER, DONE] }), true);
  assert.equal(isAskMultiStep({ title: QUESTION, options: ["A", OTHER] }), false);
  assert.equal(isAskMultiStep({ title: QUESTION }), false);
});

test("omp 18.20 radio group: the chosen row is named, nothing is ticked, and a pick sends the label", () => {
  const walk = createAskWalkTracker();
  const question = "Which plan do you want?";
  const first = marked("1", withContext(question), ["Free", "Pro", "Team", OTHER], { selectionMarker: "radio", initialIndex: 1 });
  const view = walk.observe(first);
  assert.equal(view.radio, true);
  assert.equal(view.multi, false);
  assert.equal(view.ticksKnown, false);
  assert.equal(view.question, question);
  assert.equal(view.context, CONTEXT);
  assert.deepEqual(kinds(view), ["option", "option", "option", "other"]);
  assert.deepEqual(ticks(view), [undefined, undefined, undefined, undefined], "a radio row is never ticked; the request's initialIndex is the chosen one");
  assert.equal(walk.reply(first, { value: "Team" }), null, "a radio pick ends the field: the dialog goes away");

  // A typed answer that was left blank comes back as the same group with the cursor on Other.
  const again = marked("2", withContext(question), ["Free", "Pro", "Team", OTHER], { selectionMarker: "radio", initialIndex: 3 });
  assert.equal(walk.observe(again).radio, true);
});

test("omp 18.20 checkbox group: the ticks come from every request, so they stick however often omp asks again", () => {
  const walk = createAskWalkTracker();
  const first = extras("1", []);
  const view = walk.observe(first);
  assert.equal(view.question, QUESTION);
  assert.equal(view.context, CONTEXT);
  assert.equal(view.multi, true);
  assert.equal(view.radio, false);
  assert.equal(view.ticksKnown, true);
  assert.deepEqual(kinds(view), ["option", "option", "option", "other", "done"]);
  assert.deepEqual(ticks(view), [false, false, false, false, undefined]);

  // A tap shows its box at once ...
  const staying = walk.reply(first, { value: "Search" });
  assert.deepEqual(ticks(staying), [true, false, false, false, undefined]);
  assert.equal(staying.selected, 1);
  // ... and omp's next request is the truth: the same field under a new id, "(1 selected) " on the question line.
  const second = extras("2", [0]);
  const next = walk.observe(second);
  assert.equal(next.question, QUESTION, "the count is not part of the question");
  assert.equal(next.selected, 1);
  assert.deepEqual(ticks(next), [true, false, false, false, undefined]);

  assert.deepEqual(ticks(walk.reply(second, { value: "Export" })), [true, true, false, false, undefined]);
  const third = extras("3", [0, 1], 1);
  assert.deepEqual(ticks(walk.observe(third)), [true, true, false, false, undefined]);
  assert.equal(walk.observe(third).selected, 2);

  // Unticking: Search goes, Export stays.
  assert.deepEqual(ticks(walk.reply(third, { value: "Search" })), [false, true, false, false, undefined]);
  const fourth = extras("4", [1]);
  assert.deepEqual(ticks(walk.observe(fourth)), [false, true, false, false, undefined]);

  // omp's list wins over the screen's guess: it can refuse a pick.
  const guessed = walk.reply(fourth, { value: "Alerts" });
  assert.deepEqual(ticks(guessed), [false, true, true, false, undefined]);
  assert.deepEqual(ticks(walk.observe(extras("5", [1], 2))), [false, true, false, false, undefined]);

  const sixth = extras("6", [1]);
  walk.observe(sixth);
  assert.equal(walk.reply(sixth, { value: DONE }), null, "Done sends and the dialog goes away");
  assert.equal(walk.observe(select("7", "Pick one", ["x", "y"])), null, "the next plain field is no walk step");
});

test("omp 18.20 checkbox group: a reloaded page and preselected boxes show the ticks omp lists", () => {
  const walk = createAskWalkTracker();
  const view = walk.observe(extras("9", [0, 2], 2));
  assert.equal(view.ticksKnown, true);
  assert.equal(view.selected, 2);
  assert.deepEqual(ticks(view), [true, false, true, false, undefined]);
  // An index that names no row is ignored.
  assert.deepEqual(ticks(walk.observe(marked("10", withContext(QUESTION), EXTRAS, { selectionMarker: "checkbox", checkedIndices: [1, 9], markableCount: 4 }))), [false, true, false, false, undefined]);
});

test("omp 18.20 checkbox group: the typed Other answer stays on its row while omp keeps Other ticked", () => {
  const walk = createAskWalkTracker();
  const first = extras("1", [1], 1);
  walk.observe(first);
  assert.equal(walk.reply(first, { value: OTHER }), null, "omp asks for the text next, so the select goes away");
  // The text prompt repeats the text above the field and the question: no count, no marker fields, no options.
  const typed = { id: "i1", method: "input", title: withContext(QUESTION) };
  assert.equal(walk.observe(typed), null);
  assert.equal(walk.reply(typed, { value: "  Weekly digest  " }), null);

  const second = extras("2", [1, 3], 3);
  const view = walk.observe(second);
  assert.deepEqual(ticks(view), [false, true, false, true, undefined]);
  assert.equal(view.rows[3].typed, "Weekly digest");
  assert.equal(view.selected, 2);

  // Another tick keeps the words on the row; picking Other again clears them.
  const third = extras("3", [0, 1, 3], 0);
  assert.equal(walk.observe(third).rows[3].typed, "Weekly digest");
  const cleared = walk.reply(third, { value: OTHER });
  assert.equal(cleared.rows[3].ticked, false);
  assert.equal(cleared.rows[3].typed, undefined);
  const fourth = walk.observe(extras("4", [0, 1], 3));
  assert.equal(fourth.rows[3].ticked, false);
  assert.equal(fourth.rows[3].typed, undefined);

  // Another field never inherits the words.
  const regions = marked("5", withContext("Which regions?"), ["EU", "US", OTHER, DONE], { selectionMarker: "checkbox", checkedIndices: [2], markableCount: 3 });
  const other = walk.observe(regions);
  assert.deepEqual(ticks(other), [false, false, true, undefined]);
  assert.equal(other.rows[2].typed, undefined);
});

test("omp 18.20 checkbox group: a blank typed answer leaves Other unticked", () => {
  const walk = createAskWalkTracker();
  const first = extras("1", [0]);
  walk.observe(first);
  walk.reply(first, { value: OTHER });
  const typed = { id: "i1", method: "input", title: withContext(QUESTION) };
  walk.observe(typed);
  walk.reply(typed, { value: "   " });
  const view = walk.observe(extras("2", [0], 3));
  assert.deepEqual(ticks(view), [true, false, false, false, undefined]);
  assert.equal(view.rows[3].typed, undefined);
});

test("omp 18.20: rows past markableCount are plain actions, and Done is still found by its words", () => {
  const walk = createAskWalkTracker();
  const options = ["A", "B", OTHER, "Remove all", DONE];
  const first = marked("1", withContext("Which?"), options, { selectionMarker: "checkbox", initialIndex: 0, checkedIndices: [0], markableCount: 3 });
  const view = walk.observe(first);
  assert.deepEqual(kinds(view), ["option", "option", "other", "action", "done"]);
  assert.deepEqual(ticks(view), [true, false, false, undefined, undefined]);
  assert.equal(view.selected, 1);
  assert.equal(walk.reply(first, { value: "Remove all" }), null, "omp acts on it and asks again: nothing is claimed in between");

  // Without markableCount every row is marked except a trailing Done row.
  const bare = marked("2", withContext("Which?"), ["A", "B", DONE], { selectionMarker: "checkbox", checkedIndices: [] });
  assert.deepEqual(kinds(walk.observe(bare)), ["option", "option", "done"]);

  // The marker fields of a radio group count the same way, and a count larger than the list is the whole list.
  const radio = marked("3", withContext("Which?"), ["A", "B", "Cancel"], { selectionMarker: "radio", initialIndex: 0, markableCount: 2 });
  assert.deepEqual(kinds(walk.observe(radio)), ["option", "option", "action"]);
  const wide = marked("4", withContext("Which?"), ["A", "B"], { selectionMarker: "radio", markableCount: 9 });
  assert.deepEqual(kinds(walk.observe(wide)), ["option", "option"]);
});

test("omp 18.19 frames (the question alone, no marker fields) still go through the client-side mirror", () => {
  const walk = createAskWalkTracker();
  const plan = select("1", "Which plan do you want?", ["Free", "Pro", "Team", OTHER]);
  const radio = walk.observe(plan);
  assert.equal(radio.radio, false, "an older engine never says it is a radio group");
  assert.equal(radio.context, "");
  assert.equal(walk.reply(plan, { value: "Team" }), null);

  const first = select("2", QUESTION, EXTRAS);
  assert.deepEqual(ticks(walk.observe(first)), [false, false, false, false, undefined]);
  assert.deepEqual(ticks(walk.reply(first, { value: "Search" })), [true, false, false, false, undefined]);
  const second = select("3", `(1 selected) ${QUESTION}`, EXTRAS);
  assert.deepEqual(ticks(walk.observe(second)), [true, false, false, false, undefined]);
  assert.deepEqual(ticks(walk.reply(second, { value: "Export" })), [true, true, false, false, undefined]);
  const third = select("4", `(2 selected) ${QUESTION}`, EXTRAS);
  assert.deepEqual(ticks(walk.observe(third)), [true, true, false, false, undefined]);
  assert.deepEqual(ticks(walk.reply(third, { value: "Search" })), [false, true, false, false, undefined]);
  const fourth = select("5", `(1 selected) ${QUESTION}`, EXTRAS);
  assert.deepEqual(ticks(walk.observe(fourth)), [false, true, false, false, undefined]);
  assert.equal(walk.reply(fourth, { value: OTHER }), null);
  const typed = input("i1", QUESTION);
  walk.observe(typed);
  walk.reply(typed, { value: "Weekly digest" });
  const fifth = walk.observe(select("6", `(2 selected) ${QUESTION}`, EXTRAS));
  assert.deepEqual(ticks(fifth), [false, true, false, true, undefined]);
  assert.equal(fifth.rows[3].typed, "Weekly digest");
});

test("the ask tool is recognised however the model reaches it", () => {
  assert.equal(isAskToolCall("ask", { html: "<form></form>" }), true);
  assert.equal(isAskToolCall("ask", undefined), true);
  // omp 18.20 mounts ask under xd://, so the call is a write to that address.
  assert.equal(isAskToolCall("write", { path: "xd://ask", content: "{\"html\":\"<form></form>\"}" }), true);
  assert.equal(isAskToolCall("write", { path: "  XD://Ask " }), true);
  assert.equal(isAskToolCall("write", { path: "xd://github" }), false);
  assert.equal(isAskToolCall("write", { path: "xd://ask/help" }), false);
  assert.equal(isAskToolCall("write", { path: "notes.txt", content: "xd://ask" }), false);
  assert.equal(isAskToolCall("bash", { path: "xd://ask" }), false);
  assert.equal(isAskToolCall("write", null), false);
  assert.equal(isAskToolCall("write", "xd://ask"), false);
  assert.equal(isAskToolCall(undefined, undefined), false);
});

test("a reloaded page finds an open ask in the transcript: its call is the last one and has no result", () => {
  const call = (id, toolName, input) => ({ role: "assistant", content: [{ type: "text", text: "One moment." }, { type: "toolCall", toolCallId: id, toolName, input }] });
  const result = (id) => ({ role: "toolResult", toolCallId: id, content: [] });
  const ask = call("t1", "write", { path: "xd://ask", content: "{}" });

  assert.equal(askCallPending([{ role: "user", content: "hi" }, ask]), true);
  assert.equal(askCallPending([call("t1", "ask", {})]), true);
  assert.equal(askCallPending([ask, result("t1")]), false, "answered");
  assert.equal(askCallPending([ask, result("t1"), { role: "assistant", content: [{ type: "text", text: "Done." }] }]), false, "the model moved on");
  assert.equal(askCallPending([ask, call("t2", "bash", { command: "ls" }), result("t2")]), false, "only the last assistant message can be waiting");
  assert.equal(askCallPending([call("t3", "bash", { command: "ls" })]), false);
  assert.equal(askCallPending([call("t4", "write", { path: "notes.txt", content: "x" })]), false);
  assert.equal(askCallPending([{ role: "user", content: "hi" }]), false);
  assert.equal(askCallPending([{ role: "assistant", content: "plain text" }]), false);
  assert.equal(askCallPending([]), false);
});
