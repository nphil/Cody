import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

/**
 * The model's `ask` tool, as the browser shows it (omp 18.18.3 and later send it as a walk of plain dialogs).
 *
 * The rendering is exercised for real through the lib/ask-walk tracker the hook uses, so the screen and the tracker
 * cannot drift apart: a checkbox step shows the ticks, the count and a Done button; every click sends back the exact
 * row string omp offered (the screen words "Other" and "Done" in the user's language, omp still gets its own text);
 * a secret prompt is masked. The repo has no DOM test library, so clicks run through a tiny hook runtime that renders
 * the real component function and hands back the handlers it produced (the house style of DeviceTrustCard.test.mjs).
 */

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { ExtensionInputCard } = await jiti.import("./ExtensionDialog.tsx");
const { InputDock, AskWithdrawNote } = await jiti.import("./InputDock.tsx");
const { createAskWalkTracker } = await jiti.import("../lib/ask-walk.ts");

const read = (relative) => readFileSync(new URL(relative, import.meta.url), "utf8");
const hook = read("../hooks/useAgentSession.ts");
const dock = read("./InputDock.tsx");
const locales = Object.fromEntries(["en", "ja", "zh-CN"].map((name) => [name, JSON.parse(read(`../lib/i18n/locales/${name}.json`))]));

const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;

/** Renders `run()` with a minimal hook runtime; components expand into host elements. */
function mount(run) {
  const slots = [];
  let index = 0;
  const dispatcher = {
    useState(initial) {
      const slot = (slots[index] ??= { value: typeof initial === "function" ? initial() : initial });
      index += 1;
      return [slot.value, (next) => { slot.value = typeof next === "function" ? next(slot.value) : next; }];
    },
    useRef(initial) { const slot = (slots[index] ??= { current: initial }); index += 1; return slot; },
    useId() { index += 1; return `:t${index}:`; },
    useMemo(factory) { index += 1; return factory(); },
    useCallback(callback) { index += 1; return callback; },
    useSyncExternalStore(_subscribe, getSnapshot) { index += 1; return getSnapshot(); },
    useEffect() {},
    useLayoutEffect() {},
  };
  const expand = (node) => {
    if (Array.isArray(node)) return node.map(expand);
    if (node === null || node === undefined || typeof node === "boolean") return null;
    if (typeof node !== "object") return node;
    const { type, props } = node;
    if (typeof type === "function") return expand(type(props));
    if (typeof type === "object") return { type: "icon", props: {}, children: [] }; // forwardRef icons
    return { type, props, children: expand(props.children ?? null) };
  };
  const previous = internals.H;
  internals.H = dispatcher;
  try {
    return expand(run());
  } finally {
    internals.H = previous;
  }
}

function nodes(tree, out = []) {
  if (Array.isArray(tree)) { tree.forEach((child) => nodes(child, out)); return out; }
  if (tree && typeof tree === "object") { out.push(tree); nodes(tree.children, out); }
  return out;
}
const textOf = (tree) => (Array.isArray(tree) ? tree.map(textOf).join("") : typeof tree === "string" || typeof tree === "number" ? String(tree) : tree ? textOf(tree.children) : "");
const buttons = (tree) => nodes(tree).filter((node) => node.type === "button");
const buttonStartingWith = (tree, label) => buttons(tree).find((node) => textOf(node).startsWith(label));

const OTHER = "Other (type your own)";
const DONE = "✔ Done selecting";

/** A `select` request as the hook hands it to the card: the tracker's view attached when it is a walk step. `fields` are what omp 18.20 adds to a select (its markers). */
function step(walk, id, title, options, fields = {}) {
  const request = { type: "extension_ui_request", id, method: "select", title, options, ...fields };
  const view = walk.observe(request);
  return view ? { ...request, walk: view } : request;
}

function card(request, answers = []) {
  return mount(() => React.createElement(ExtensionInputCard, {
    request,
    selectedOptionIndex: 0,
    onSelectOption: () => {},
    onRespond: (response) => answers.push(response),
  }));
}

const html = (request, selectedOptionIndex = 0) => renderToStaticMarkup(React.createElement(ExtensionInputCard, {
  request,
  selectedOptionIndex,
  onSelectOption: () => {},
  onRespond: () => {},
}));

test("a plain select keeps its buttons: pressed state, no checkbox, no Done", () => {
  const out = html({ type: "extension_ui_request", id: "s1", method: "select", title: "Pick one", options: ["A", "B"] });
  assert.match(out, /aria-pressed="true"/);
  assert.doesNotMatch(out, /role="checkbox"|aria-checked/);
  assert.doesNotMatch(out, />Done</);
  assert.doesNotMatch(out, /aria-busy/);
});

test("a checkbox step shows its boxes, a hint and a Done button; each click sends omp's exact row", () => {
  const walk = createAskWalkTracker();
  const request = step(walk, "1", "Which features?", ["A", "B", OTHER, DONE]);
  const out = html(request);
  assert.equal((out.match(/role="checkbox"/g) ?? []).length, 3, "A, B and the Other row are boxes; Done is not");
  assert.equal((out.match(/aria-checked="false"/g) ?? []).length, 3);
  assert.match(out, /Select all that apply/);
  assert.match(out, /aria-label="Which features\?"/);
  assert.match(out, />Other \(type your own\)</);
  assert.doesNotMatch(out, /Done selecting/, "the screen words Done itself");

  const answers = [];
  const tree = card(request, answers);
  buttonStartingWith(tree, "B").props.onClick();
  assert.deepEqual(answers, [{ value: "B" }]);

  const again = [];
  buttonStartingWith(card(request, again), "Done").props.onClick();
  assert.deepEqual(again, [{ value: DONE }], "Done answers with the string omp offered");

  const typed = [];
  buttonStartingWith(card(request, typed), "Other").props.onClick();
  assert.deepEqual(typed, [{ value: OTHER }], "the Other row answers with omp's own text, not the translated one");
});

test("a tick stays on screen while omp asks again: the box shows, the rows hold still", () => {
  const walk = createAskWalkTracker();
  const request = step(walk, "1", "Which features?", ["A", "B", OTHER, DONE]);
  const staying = walk.reply(request, { value: "A" });
  assert.ok(staying, "a toggle keeps the dialog up");
  const out = html({ ...request, walk: staying, settling: true });
  assert.match(out, /aria-checked="true"/);
  assert.match(out, /1 selected/);
  assert.match(out, /aria-busy="true"/);
  assert.equal((out.match(/aria-disabled="true"/g) ?? []).length, 4, "three rows and Done wait for omp");
  assert.equal((out.match(/aria-checked="true"/g) ?? []).length, 1, "only A is ticked");

  // The next question replaces the optimistic one and the rows answer again.
  const next = step(walk, "2", "(1 selected) Which features?", ["A", "B", OTHER, DONE]);
  const settled = html(next);
  assert.doesNotMatch(settled, /aria-busy|aria-disabled/);
  assert.match(settled, /aria-label="Which features\?"/, "the heading drops omp's count prefix");
});

test("the text typed behind Other is shown on its row", () => {
  const walk = createAskWalkTracker();
  const first = step(walk, "1", "Which?", ["A", OTHER, DONE]);
  assert.equal(walk.reply(first, { value: OTHER }), null);
  const typed = { type: "extension_ui_request", id: "i1", method: "input", title: "Which?" };
  walk.observe(typed);
  walk.reply(typed, { value: "something else" });
  const out = html(step(walk, "2", "(1 selected) Which?", ["A", OTHER, DONE]));
  assert.match(out, /something else/);
  assert.match(out, /aria-checked="true"/);
});

test("preselected boxes it was never told about: plain rows and the count alone", () => {
  const walk = createAskWalkTracker();
  const out = html(step(walk, "1", "(2 selected) Which?", ["A", "B", "C", OTHER, DONE]));
  assert.doesNotMatch(out, /role="checkbox"|aria-checked/, "no tick is claimed that omp did not confirm");
  assert.match(out, /2 selected/);
  assert.match(out, />Done</);
});

test("a required field with nothing ticked has no Done button and says why", () => {
  const walk = createAskWalkTracker();
  const first = step(walk, "1", "Which?", ["A", "B", OTHER, DONE]);
  const ticked = walk.reply(first, { value: "A" });
  assert.ok(ticked);
  const second = step(walk, "2", "(1 selected) Which?", ["A", "B", OTHER, DONE]);
  const unticked = walk.reply(second, { value: "A" });
  assert.ok(unticked);
  const third = step(walk, "3", "Which?", ["A", "B", OTHER]);
  const out = html(third);
  assert.doesNotMatch(out, />Done</);
  assert.match(out, /Pick at least one to continue/);
  assert.equal((out.match(/role="checkbox"/g) ?? []).length, 3);
});

test("a radio group is a plain list whose Other row is worded for the user and answers with omp's text", () => {
  const walk = createAskWalkTracker();
  const request = step(walk, "1", "Which plan?", ["Free", "Pro", OTHER]);
  const out = html(request);
  assert.doesNotMatch(out, /role="checkbox"|aria-checked|Select all that apply|Pick at least one/);
  assert.doesNotMatch(out, />Done</);
  assert.match(out, />Other \(type your own\)</);
  const answers = [];
  buttonStartingWith(card(request, answers), "Other").props.onClick();
  assert.deepEqual(answers, [{ value: OTHER }]);
});

test("one tap answers once", () => {
  const walk = createAskWalkTracker();
  const request = step(walk, "1", "Which features?", ["A", "B", OTHER, DONE]);
  const answers = [];
  const tree = card(request, answers);
  const row = buttonStartingWith(tree, "A");
  row.props.onClick();
  row.props.onClick();
  assert.deepEqual(answers, [{ value: "A" }], "a double tap is one answer");
});

test("a secret prompt is masked and kept away from autofill and password managers", () => {
  const secret = html({ type: "extension_ui_request", id: "k1", method: "input", title: "API key", placeholder: "sk-…", secret: true });
  assert.match(secret, /type="password"/);
  assert.match(secret, /autoComplete="new-password"|autocomplete="new-password"/i);
  assert.match(secret, /spellCheck="false"|spellcheck="false"/i);
  assert.match(secret, /data-1p-ignore="true"/);
  assert.match(secret, /data-lpignore="true"/);
  assert.match(secret, /data-bwignore="true"/);

  const plain = html({ type: "extension_ui_request", id: "k2", method: "input", title: "Name", placeholder: "Ada" });
  assert.match(plain, /type="text"/);
  assert.doesNotMatch(plain, /password|new-password|data-1p-ignore|data-lpignore/);
});

test("the dock titles a walk step with its question, not omp's count prefix", () => {
  const walk = createAskWalkTracker();
  const first = step(walk, "1", "Which features?", ["A", "B", OTHER, DONE]);
  walk.reply(first, { value: "A" });
  const request = step(walk, "2", "(1 selected) Which features?", ["A", "B", OTHER, DONE]);
  const out = renderToStaticMarkup(React.createElement(InputDock, {
    pendingInputs: [{ kind: "extension", request, fromAsk: true }],
    onRespond: () => {},
    composerRef: { current: null },
  }));
  assert.match(out, /title="Which features\?"/);
  assert.doesNotMatch(out, /\(1 selected\)/);
  assert.match(out, /role="checkbox"/);
  assert.doesNotMatch(out, /data-testid="ask-withdraw-note"/, "no engine version is known yet, so no claim is made");
});

test("the withdraw warning says what sending a message now does", () => {
  const out = renderToStaticMarkup(React.createElement(AskWithdrawNote));
  assert.match(out, /data-testid="ask-withdraw-note"/);
  assert.match(out, /Sending a message while this question is open withdraws it/);
});

// What a real omp 18.20.0 child sends for `ask` (the prose shortened): the text around the field leads the title, and a
// select names its markers, its chosen row and (for a checkbox group) its ticked rows.
const CONTEXT = "Plans differ in how many projects you may keep.\n\n- Free: one private project.\n- Pro: unlimited projects.\n\nnpm run build\n\nPlan | Cost\nPro | 9 USD";
const withContext = (question, selected = 0) => `${CONTEXT}\n\n${selected > 0 ? `(${selected} selected) ` : ""}${question}`;
const EXTRAS = ["Search", "Export", "Alerts", OTHER, DONE];
const extras = (walk, id, checkedIndices, initialIndex = 0) =>
  step(walk, id, withContext("Which extras?", checkedIndices.length), EXTRAS, { selectionMarker: "checkbox", initialIndex, checkedIndices, markableCount: 4 });
const ticked = (out) => (out.match(/aria-checked="true"/g) ?? []).length;

test("omp 18.20 radio group: the explanation shows whole, the chosen row has its dot, each row answers with its own text", () => {
  const walk = createAskWalkTracker();
  const request = step(walk, "1", withContext("Which plan?"), ["Free", "Pro", "Team", OTHER], { selectionMarker: "radio", initialIndex: 1 });
  const out = html(request, 1);
  assert.match(out, /role="radiogroup"/);
  assert.equal((out.match(/role="radio"/g) ?? []).length, 4);
  assert.equal(ticked(out), 1, "only the chosen row has its dot");
  assert.doesNotMatch(out, /role="checkbox"|Select all that apply|Pick at least one|>Done</);
  for (const line of ["Plans differ in how many projects you may keep.", "- Free: one private project.", "npm run build", "Plan | Cost"]) {
    assert.ok(out.includes(line), `the explanation lost "${line}"`);
  }
  assert.match(out, /data-testid="ask-question"[^>]*>Which plan\?</, "the question sits under the explanation");

  const answers = [];
  buttonStartingWith(card(request, answers), "Team").props.onClick();
  assert.deepEqual(answers, [{ value: "Team" }]);
});

test("the explanation is plain wrapping text: nothing clips it or cuts it to a few lines", () => {
  const walk = createAskWalkTracker();
  const out = html(extras(walk, "1", []));
  const style = /<div data-testid="ask-context" style="([^"]*)"/.exec(out)?.[1] ?? "";
  assert.match(style, /white-space:pre-wrap/);
  assert.match(style, /overflow-wrap:anywhere/);
  assert.doesNotMatch(style, /(^|;)(overflow|max-height|height|text-overflow):|line-clamp/);
});

test("omp 18.20 checkbox group: the boxes show the ticks omp lists, the hint counts them and Done is the primary button", () => {
  const walk = createAskWalkTracker();
  const request = extras(walk, "1", [0, 3], 3);
  const out = html(request);
  assert.equal((out.match(/role="checkbox"/g) ?? []).length, 4, "Search, Export, Alerts and the Other row are boxes; Done is not");
  assert.equal(ticked(out), 2);
  assert.match(out, /2 selected/);
  assert.match(out, />Done</);
  assert.doesNotMatch(out, /Done selecting/);
  assert.match(out, /position:sticky;bottom:-3px/, "the buttons stay in reach while a long explanation scrolls");
  const tree = card(request);
  assert.equal(buttonStartingWith(tree, "Search").props["aria-checked"], true);
  assert.equal(buttonStartingWith(tree, "Export").props["aria-checked"], false);
});

test("omp 18.20 checkbox group: ticking and unticking stick across omp's re-sent requests", () => {
  const walk = createAskWalkTracker();
  const first = extras(walk, "1", []);
  assert.equal(ticked(html(first)), 0);

  // The tap shows its box while omp's next request is on its way, the rows holding still ...
  const staying = walk.reply(first, { value: "Export" });
  const waiting = html({ ...first, walk: staying, settling: true });
  assert.equal(ticked(waiting), 1);
  assert.match(waiting, /aria-busy="true"/);

  // ... and omp's own list takes over: the same field under a new id, "(1 selected) " on its question.
  const second = extras(walk, "2", [1], 1);
  const settled = html(second);
  assert.equal(ticked(settled), 1);
  assert.doesNotMatch(settled, /aria-busy/);
  assert.match(settled, /aria-label="Which extras\?"/, "the count prefix is not part of the heading");

  // Unticking it empties the box again, and the next request agrees.
  const unticking = walk.reply(second, { value: "Export" });
  assert.equal(ticked(html({ ...second, walk: unticking, settling: true })), 0);
  assert.equal(ticked(html(extras(walk, "3", [], 1))), 0);
});

test("omp 18.20: a row past markableCount is a plain button, not a box", () => {
  const walk = createAskWalkTracker();
  const request = step(walk, "1", withContext("Which?"), ["A", "B", "Skip these", DONE], { selectionMarker: "checkbox", checkedIndices: [0], markableCount: 2 });
  const tree = card(request);
  const skip = buttonStartingWith(tree, "Skip these");
  assert.equal(skip.props.role, undefined);
  assert.equal(skip.props["aria-checked"], undefined);
  assert.equal(buttonStartingWith(tree, "A").props.role, "checkbox");
  assert.equal(ticked(html(request)), 1);
  const answers = [];
  buttonStartingWith(card(request, answers), "Skip these").props.onClick();
  assert.deepEqual(answers, [{ value: "Skip these" }], "an action is answered with its own text");
});

test("omp 18.20: the words typed behind Other show on its ticked row", () => {
  const walk = createAskWalkTracker();
  const first = extras(walk, "1", [1], 1);
  walk.reply(first, { value: OTHER });
  const typed = { type: "extension_ui_request", id: "i1", method: "input", title: withContext("Which extras?") };
  walk.observe(typed);
  walk.reply(typed, { value: "Weekly digest" });
  const out = html(extras(walk, "2", [1, 3], 3));
  assert.match(out, /Weekly digest/);
  assert.equal(ticked(out), 2);
});

test("a text field of the ask shows the explanation above it and the question under it", () => {
  const request = { type: "extension_ui_request", id: "i1", method: "input", title: withContext("Your name?"), placeholder: "Ada" };
  const out = renderToStaticMarkup(React.createElement(ExtensionInputCard, {
    request,
    selectedOptionIndex: 0,
    onSelectOption: () => {},
    onRespond: () => {},
    fromAsk: true,
  }));
  assert.match(out, /data-testid="ask-context"/);
  assert.ok(out.includes("Plans differ in how many projects you may keep."));
  assert.match(out, /data-testid="ask-question"[^>]*>Your name\?</);
  assert.match(out, /placeholder="Ada"/);

  // Any other extension's prompt keeps its question on line 1 and shows the rest as details.
  const other = html({ type: "extension_ui_request", id: "i2", method: "input", title: "Token?\nPaste it from the console." });
  assert.doesNotMatch(other, /data-testid="ask-context"|data-testid="ask-question"/);
  assert.match(other, /Paste it from the console\./);
});

test("the dock lets an ask be read: its question wraps in the header and one scroll area holds the text, the rows and the buttons", () => {
  const walk = createAskWalkTracker();
  const question = "Which of the following extras should be switched on for this whole workspace?";
  const request = step(walk, "1", withContext(question), EXTRAS, { selectionMarker: "checkbox", initialIndex: 0, checkedIndices: [], markableCount: 4 });
  const dockOf = (item) => renderToStaticMarkup(React.createElement(InputDock, { pendingInputs: [item], onRespond: () => {}, composerRef: { current: null } }));
  const out = dockOf({ kind: "extension", request, fromAsk: true });
  assert.match(out, /-webkit-line-clamp:2/);
  assert.match(out, /max-height:max\(120px,/);
  assert.equal((out.match(/overflow-y:auto/g) ?? []).length, 1, "text, rows and buttons share one scroll area");
  assert.match(out, /title="Which of the following extras/);

  // Any other extension dialog keeps the shorter area and the one-line header.
  const plain = dockOf({ kind: "extension", request: { type: "extension_ui_request", id: "p", method: "select", title: "Pick one", options: ["A", "B"] } });
  assert.match(plain, /max-height:calc\(40vh - 56px\)/);
  assert.doesNotMatch(plain, /-webkit-line-clamp/);
});

test("the dock wiring: one card per field, the note only on engines that withdraw, focus and scroll start in the right place", () => {
  // One card for a whole checkbox field: omp asks it again after every tick under a new id.
  assert.match(dock, /function extensionKey\(request: ExtensionDialogRequest\): string \{/);
  assert.match(dock, /`walk:\$\{request\.walk\.context\}\\n\$\{request\.walk\.question\}`/);
  assert.match(dock, /case "extension": return "extension:" \+ extensionKey\(item\.request\);/);
  assert.match(dock, /key=\{extensionKey\(item\.request\)\}/);
  // The warning needs a dialog of the model's own and an engine that withdraws it.
  assert.match(dock, /const fromAsk = item\.kind === "extension" && item\.fromAsk === true;/);
  assert.match(dock, /fromAsk && askWithdrawnByMessage\(engineVersion\) && <AskWithdrawNote \/>/);
  assert.match(dock, /import \{ useEngineVersion \} from "@\/hooks\/useEngineVersion";/);
  assert.match(dock, /const engineVersion = useEngineVersion\(\);/);
  // A text field takes the focus, a select the row omp's own cursor is on; a new question starts at the top of its text.
  assert.match(dock, /querySelector<HTMLElement>\('\[data-input-autofocus="true"\]'\)/);
  assert.match(dock, /querySelectorAll<HTMLElement>\('\[data-input-choice="true"\]'\)\[initialCursor\]/);
  assert.match(dock, /item\.request\.initialIndex \?\? 0/);
  assert.match(dock, /scrollRef\.current\?\.scrollTo\(\{ top: 0 \}\)/);
  // Arrow keys bring the row into view, clear of the buttons that stay at the foot of the area.
  assert.match(dock, /choices\[next\]\?\.scrollIntoView\(\{ block: "nearest" \}\);/);
  assert.match(dock, /scrollPaddingBottom: 64,/);
});

test("the hook feeds the walk tracker: observe, reply, withdraw, and which dialogs are the model's", () => {
  assert.match(hook, /const \[askWalk\] = useState\(createAskWalkTracker\);/);
  // Every request is observed; a select that is a walk step carries its view.
  assert.match(hook, /const walk = askWalk\.observe\(request\);\s+setExtensionDialog\(walk \? \{ \.\.\.request, walk \} : request\);/);
  // A tick keeps the dialog up (settling) and a fallback clears it if omp never asks again.
  assert.match(hook, /const staying = askWalk\.reply\(request, response\);/);
  assert.match(hook, /\{ \.\.\.request, walk: staying, settling: true \}/);
  assert.match(hook, /ASK_WALK_SETTLE_MS/);
  // A withdrawn dialog ends the walk.
  assert.match(hook, /askWalk\.withdrawn\(request\.targetId\);/);
  // The model's `ask` tool is what is waiting while it runs, whatever it is called (omp 18.20 mounts it as `write xd://ask`);
  // after a reload the transcript says so, while the agent runs.
  assert.match(hook, /const ask = isAskToolCall\(name, event\.args\);/);
  assert.match(hook, /tools\.push\(\{ id, name, startedAt: Date\.now\(\), ask \}\)/);
  assert.match(hook, /agentPhase\?\.kind === "running_tools" && agentPhase\.tools\.some\(\(tool\) => tool\.ask === true\)/);
  assert.match(hook, /\(agentRunning && askCallPending\(messages\)\)/);
  assert.match(hook, /fromAsk: walkStep \|\| dialogBelongsToAsk\(extensionDialog, askToolRunning\)/);
});

test("the walk and withdrawal copy is real in all three locales", () => {
  const keys = ["askWalk.done", "askWalk.other", "askWalk.pickOne", "askWalk.selected.one", "askWalk.selected.other", "inputDock.askWithdrawn"];
  for (const key of keys) {
    for (const [name, dictionary] of Object.entries(locales)) {
      assert.equal(typeof dictionary[key], "string", `${name} is missing ${key}`);
      assert.ok(dictionary[key].trim().length > 0, `${name}:${key} is empty`);
    }
    assert.notEqual(locales.ja[key], locales.en[key], `ja:${key} was not translated`);
    assert.notEqual(locales["zh-CN"][key], locales.en[key], `zh-CN:${key} was not translated`);
  }
});
