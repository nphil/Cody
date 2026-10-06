import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";
import ts from "typescript";

/**
 * "Let the agent control <device>?", the chat half.
 *
 * One question replaces every device approval, so what matters is: the person is asked in plain words, a stray
 * key or a repeated click can never consent to hardware control, exactly one answer leaves the card, "Remember"
 * is only offered for a device that can be told apart, and a chat without a device never loads the device bridge.
 *
 * The repo has no DOM test library, so the card's interaction is exercised through a tiny hook runtime (`mount`)
 * that renders the real component function and lets the test call the handlers it returned, the way two clicks
 * dispatched inside one task would.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { DeviceTrustCard } = await jiti.import("./DeviceTrustCard.tsx");
const { InputDock } = await jiti.import("./InputDock.tsx");
const { useDeviceTrustRequests } = await jiti.import("../hooks/useDeviceTrustRequests.ts");
const { deviceTrustHub, NO_TRUST_REQUESTS } = await jiti.import("../lib/devices/trust-hub.ts");
const { setLocale } = await jiti.import("../lib/i18n/index.tsx");

const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;

/** Renders `run()` with a minimal hook runtime. A component's elements are expanded into host elements; a hook's
 *  plain result (`raw`) is returned as is. */
function mount(run, { raw = false } = {}) {
  const slots = [];
  let index = 0;
  let current = null;
  const unsubscribers = [];
  const sameDeps = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const dispatcher = {
    useState(initial) {
      const slot = (slots[index] ??= { value: typeof initial === "function" ? initial() : initial });
      index += 1;
      return [slot.value, (next) => {
        const value = typeof next === "function" ? next(slot.value) : next;
        if (Object.is(value, slot.value)) return;
        slot.value = value;
        render();
      }];
    },
    useRef(initial) { const slot = (slots[index] ??= { current: initial }); index += 1; return slot; },
    useId() { const slot = (slots[index] ??= { id: `:t${index}:` }); index += 1; return slot.id; },
    useMemo(factory, deps) {
      const slot = slots[index];
      index += 1;
      if (slot && sameDeps(slot.deps, deps)) return slot.value;
      const next = { value: factory(), deps };
      slots[index - 1] = next;
      return next.value;
    },
    useCallback(callback, deps) { return dispatcher.useMemo(() => callback, deps); },
    useSyncExternalStore(subscribe, getSnapshot) {
      if (!slots[index]) {
        slots[index] = true;
        unsubscribers.push(subscribe(() => render()));
      }
      index += 1;
      return getSnapshot();
    },
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
  function render() {
    const previous = internals.H;
    internals.H = dispatcher;
    index = 0;
    try { current = raw ? run() : expand(run()); } finally { internals.H = previous; }
    return current;
  }
  render();
  return { tree: () => current, unmount: () => unsubscribers.forEach((off) => off()) };
}

function nodes(tree, out = []) {
  if (Array.isArray(tree)) { tree.forEach((child) => nodes(child, out)); return out; }
  if (tree && typeof tree === "object") { out.push(tree); nodes(tree.children, out); }
  return out;
}
const textOf = (tree) => (Array.isArray(tree) ? tree.map(textOf).join("") : typeof tree === "string" || typeof tree === "number" ? String(tree) : tree ? textOf(tree.children) : "");
const buttons = (tree) => nodes(tree).filter((node) => node.type === "button");
const buttonNamed = (tree, label) => buttons(tree).find((node) => textOf(node) === label);
const checkbox = (tree) => nodes(tree).find((node) => node.type === "input" && node.props.type === "checkbox");

const REQUEST = { id: "trust-1", deviceId: "usb-1", label: "Pixel 7", key: "usb:18d1:ABC123", requestedAt: 1, waiting: 1 };
const NO_KEY = { ...REQUEST, id: "trust-2", key: undefined };

function mountCard(request, answers = []) {
  return mount(() => React.createElement(DeviceTrustCard, { request, onRespond: (allow, remember) => answers.push({ allow, remember }) }));
}

test("the card asks in plain words, with the device named, and offers Allow and Deny", () => {
  const html = renderToStaticMarkup(React.createElement(DeviceTrustCard, { request: REQUEST, onRespond: () => {} }));
  assert.match(html, /role="group"/);
  assert.match(html, /aria-label="Let the agent control Pixel 7\?"/);
  assert.match(html, /<h3[^>]*>Let the agent control Pixel 7\?<\/h3>/);
  assert.match(html, /run commands on it, read and change what it stores, flash firmware and restart it/);
  assert.match(html, />Allow</);
  assert.match(html, />Deny</);
  assert.doesNotMatch(html, /deviceTrust\./);
});

test("neither button can be reached by the dock's Enter or digit shortcuts", () => {
  const html = renderToStaticMarkup(React.createElement(DeviceTrustCard, { request: REQUEST, onRespond: () => {} }));
  assert.doesNotMatch(html, /data-input-choice/);
  const tree = mountCard(REQUEST).tree();
  for (const label of ["Allow", "Deny"]) {
    const button = buttonNamed(tree, label);
    assert.ok(button, `${label} button`);
    assert.equal(button.props["data-input-choice"], undefined);
    assert.equal(button.props.tabIndex, undefined, "both stay ordinary tab stops");
    assert.equal(button.props.style.minHeight, 48);
  }
});

test("Remember is ticked by default when the device has a key, and not offered at all when it has none", () => {
  const withKey = renderToStaticMarkup(React.createElement(DeviceTrustCard, { request: REQUEST, onRespond: () => {} }));
  assert.match(withKey, /<input[^>]*type="checkbox"[^>]*checked=""/);
  assert.match(withKey, /Remember this device/);
  assert.match(withKey, /The agent will not ask again when it reconnects/);

  const withoutKey = renderToStaticMarkup(React.createElement(DeviceTrustCard, { request: NO_KEY, onRespond: () => {} }));
  assert.doesNotMatch(withoutKey, /type="checkbox"/);
  assert.doesNotMatch(withoutKey, /Remember this device/);
  assert.doesNotMatch(withoutKey, /The agent will not ask again/);
});

test("the waiting line appears only when more than one command waits", () => {
  const one = renderToStaticMarkup(React.createElement(DeviceTrustCard, { request: { ...REQUEST, waiting: 1 }, onRespond: () => {} }));
  assert.doesNotMatch(one, /waiting for your answer/);
  const three = renderToStaticMarkup(React.createElement(DeviceTrustCard, { request: { ...REQUEST, waiting: 3 }, onRespond: () => {} }));
  assert.match(three, /3 commands are waiting for your answer\./);
});

test("Allow and Deny pass the person's choice, and Remember only when ticked and possible", () => {
  const allowed = [];
  buttonNamed(mountCard(REQUEST, allowed).tree(), "Allow").props.onClick();
  assert.deepEqual(allowed, [{ allow: true, remember: true }]);

  const unticked = [];
  const card = mountCard(REQUEST, unticked);
  checkbox(card.tree()).props.onChange({ target: { checked: false } });
  assert.equal(checkbox(card.tree()).props.checked, false);
  buttonNamed(card.tree(), "Allow").props.onClick();
  assert.deepEqual(unticked, [{ allow: true, remember: false }]);

  const denied = [];
  buttonNamed(mountCard(REQUEST, denied).tree(), "Deny").props.onClick();
  assert.deepEqual(denied, [{ allow: false, remember: true }]);

  const noKey = [];
  buttonNamed(mountCard(NO_KEY, noKey).tree(), "Allow").props.onClick();
  assert.deepEqual(noKey, [{ allow: true, remember: false }], "a device without a key is never remembered");
});

test("repeated clicks in one task send exactly one answer, then the card reads as sent and inert", () => {
  const answers = [];
  const card = mountCard(REQUEST, answers);
  // Handlers captured from ONE render: a state-only guard would let all of these through.
  const { onClick: allow } = buttonNamed(card.tree(), "Allow").props;
  const { onClick: deny } = buttonNamed(card.tree(), "Deny").props;
  allow();
  allow();
  allow();
  deny();
  assert.equal(answers.length, 1);
  assert.deepEqual(answers[0], { allow: true, remember: true });

  const settled = card.tree();
  assert.equal(buttonNamed(settled, "Allow").props.disabled, true);
  assert.equal(buttonNamed(settled, "Deny").props.disabled, true);
  assert.equal(checkbox(settled).props.disabled, true);
  assert.match(textOf(settled), /Sending your answer…/);
});

test("the dock shows the card for a device-trust item, titled with the device", () => {
  const html = renderToStaticMarkup(React.createElement(InputDock, {
    pendingInputs: [{ kind: "device-trust", request: REQUEST }],
    onRespond: () => {},
    composerRef: { current: null },
  }));
  assert.match(html, /role="region"/);
  assert.match(html, /Control of Pixel 7/);
  assert.match(html, /Let the agent control Pixel 7\?/);
  assert.match(html, />Allow</);
  assert.doesNotMatch(html, /data-input-choice/, "the dock must have nothing to auto-focus or Enter-activate in the trust card");
});

test("the dock mixes the trust question with other kinds and the other kinds keep their choices", () => {
  const permission = {
    requestId: "p1",
    toolCall: { title: "ls" },
    options: [{ optionId: "once", name: "Allow once", kind: "allow_once" }],
  };
  const both = (first) => renderToStaticMarkup(React.createElement(InputDock, {
    pendingInputs: first === "trust"
      ? [{ kind: "device-trust", request: REQUEST }, { kind: "permission", request: permission }]
      : [{ kind: "permission", request: permission }, { kind: "device-trust", request: REQUEST }],
    onRespond: () => {},
    composerRef: { current: null },
  }));
  const trustFirst = both("trust");
  assert.match(trustFirst, /Let the agent control Pixel 7\?/);
  assert.match(trustFirst, /1 \/ 2|1 of 2|1\/2/);
  assert.doesNotMatch(trustFirst, /data-input-choice/);
  const permissionFirst = both("permission");
  assert.match(permissionFirst, /Allow once/);
  assert.match(permissionFirst, /data-input-choice="true"/);
  assert.doesNotMatch(permissionFirst, /Let the agent control Pixel 7\?/);
});

test("the question is real text in English, Japanese and Chinese", () => {
  const original = globalThis.document;
  globalThis.document = { documentElement: {} };
  try {
    const rendered = {};
    for (const locale of ["en", "ja", "zh-CN"]) {
      setLocale(locale);
      const tree = mountCard({ ...REQUEST, waiting: 2 }).tree();
      const text = textOf(tree);
      rendered[locale] = text;
      assert.doesNotMatch(text, /deviceTrust\./, `${locale} shows a raw key`);
      assert.match(text, /Pixel 7/);
      assert.equal(buttons(tree).length, 2);
      for (const button of buttons(tree)) assert.ok(textOf(button).trim().length > 0, `${locale} has an unlabelled button`);
    }
    assert.notEqual(rendered.ja, rendered.en);
    assert.notEqual(rendered["zh-CN"], rendered.en);
    assert.notEqual(rendered.ja, rendered["zh-CN"]);
    assert.ok(!/Let the agent control/.test(rendered.ja) && !/Let the agent control/.test(rendered["zh-CN"]), "titles are translated");
  } finally {
    setLocale("en");
    if (original === undefined) delete globalThis.document;
    else globalThis.document = original;
  }
});

function fakeSource() {
  const listeners = new Set();
  let list = [];
  const answers = [];
  return {
    answers,
    set(next) { list = next; listeners.forEach((listener) => listener()); },
    trustRequests: () => list,
    subscribeTrust(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async answerTrust(requestId, answer) { answers.push({ requestId, answer }); return { remembered: Boolean(answer.remember) }; },
  };
}

test("useDeviceTrustRequests follows the hub for this session only and answers through it", async () => {
  const mine = fakeSource();
  const other = fakeSource();
  const offMine = deviceTrustHub.register("chat-mine", mine);
  const offOther = deviceTrustHub.register("chat-other", other);
  const hook = (sessionId) => mount(() => useDeviceTrustRequests(sessionId), { raw: true });
  const nobody = hook(null);
  const view = hook("chat-mine");
  try {
    assert.equal(view.tree().requests.length, 0);
    assert.equal(nobody.tree().requests, NO_TRUST_REQUESTS, "no session means the shared empty list");

    mine.set([REQUEST]);
    const first = view.tree().requests;
    assert.deepEqual(first.map((request) => request.id), ["trust-1"]);
    mine.set([REQUEST]); // an unrelated trust change: same question, same count
    assert.equal(view.tree().requests, first, "an unchanged list keeps its identity");
    other.set([NO_KEY]);
    assert.equal(view.tree().requests, first, "another chat's question never shows here");

    const result = await view.tree().respond("trust-1", { allow: true, remember: true });
    assert.deepEqual(result, { remembered: true });
    assert.deepEqual(mine.answers, [{ requestId: "trust-1", answer: { allow: true, remember: true } }]);
    assert.deepEqual(other.answers, []);

    await assert.rejects(() => nobody.tree().respond("trust-1", { allow: true }), /no device/i);
    await assert.rejects(() => hook("chat-without-a-device").tree().respond("x", { allow: false }), /no device/i);
  } finally {
    view.unmount();
    nobody.unmount();
    offMine();
    offOther();
  }
});

/** Every file a module can pull in through import/export-from/import(), resolved from the TS source. */
function importClosure(entry) {
  const seen = new Set();
  const resolve = (from, specifier) => {
    let base;
    if (specifier.startsWith("@/")) base = path.join(root, specifier.slice(2));
    else if (specifier.startsWith(".")) base = path.resolve(path.dirname(from), specifier);
    else return null;
    for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}.mjs`, `${base}.js`, path.join(base, "index.ts"), path.join(base, "index.tsx")]) {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    }
    return null;
  };
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const info = ts.preProcessFile(readFileSync(file, "utf8"), true, true);
    for (const { fileName } of info.importedFiles) {
      const target = resolve(file, fileName);
      if (target) visit(target);
    }
  };
  visit(path.join(root, entry));
  return [...seen].map((file) => path.relative(root, file).split(path.sep).join("/"));
}

test("a chat with no device never loads the device bridge: the hook reaches only the trust vocabulary and hub", () => {
  const closure = importClosure("hooks/useDeviceTrustRequests.ts");
  assert.ok(closure.includes("lib/devices/trust-hub.ts"), "the hook reads the hub");
  assert.ok(!closure.includes("lib/devices/client.ts"), `the bridge is reachable from the hook: ${closure.join(", ")}`);
  const devices = closure.filter((file) => file.startsWith("lib/devices/")).sort();
  assert.deepEqual(devices, ["lib/devices/trust-hub.ts", "lib/devices/trust.ts"], "nothing else under lib/devices is pulled in");

  // The hook is what useAgentSession calls, so the chat-side closure must stay clear of the bridge too.
  const dock = importClosure("components/InputDock.tsx");
  assert.ok(!dock.includes("lib/devices/client.ts"), "the dock must not pull in the bridge");
});
