import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { readFile } from "node:fs/promises";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { createSettingsBusy, SettingsOpenerContext, useSettingsOpener } = await jiti.import("./settings/shell-context.tsx");
const { SAVED_LINGER_MS, readSaveStatus, reportSaveStatus, resetSaveStatus, trackSave, SaveStatusCorner } = await jiti.import("./settings/SaveStatus.tsx");
const { Directory } = await jiti.import("./settings/Directory.tsx");
const { DangerZone } = await jiti.import("./settings/DangerZone.tsx");
const { PromptDialog, ConfirmDialog } = await jiti.import("./ui/field.tsx");
const { NativeSetting, ToggleSwitch } = await jiti.import("./settings/primitives.tsx");

/**
 * The shell contracts every Settings hub codes against: the busy register a
 * login SSE or an install stream holds while it runs, the per-panel save
 * corner, the Directory and Danger-zone primitives, and the opener context
 * that lets a toast or the composer open Settings without prop threading.
 */

test("the busy register stays busy until every hold is released, and releasing twice is harmless", () => {
  const busy = createSettingsBusy();
  const seen = [];
  const unsubscribe = busy.subscribe(() => seen.push(busy.isBusy()));
  assert.equal(busy.isBusy(), false);

  const releaseLogin = busy.hold("Sign-in to Anthropic");
  const releaseInstall = busy.hold("Installing pi");
  assert.equal(busy.isBusy(), true);
  assert.deepEqual(busy.reasons(), ["Sign-in to Anthropic", "Installing pi"]);

  releaseLogin();
  assert.equal(busy.isBusy(), true, "the install still holds");
  releaseLogin();
  assert.equal(busy.isBusy(), true, "a second release of the same hold changes nothing");
  releaseInstall();
  assert.equal(busy.isBusy(), false);
  assert.deepEqual(busy.reasons(), []);
  assert.deepEqual(seen, [true, true, true, false], "subscribers hear each real change only");
  unsubscribe();
});

test("the save corner shows saving until the last overlapping write lands, then clears after 1.5 s", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    resetSaveStatus();
    reportSaveStatus("engine", "saving");
    reportSaveStatus("engine", "saving");
    reportSaveStatus("engine", "saved");
    assert.equal(readSaveStatus("engine").state, "saving", "one write is still in flight");
    reportSaveStatus("engine", "saved");
    assert.equal(readSaveStatus("engine").state, "saved");
    mock.timers.tick(SAVED_LINGER_MS - 1);
    assert.equal(readSaveStatus("engine").state, "saved");
    mock.timers.tick(1);
    assert.equal(readSaveStatus("engine").state, "idle");

    const retry = () => {};
    reportSaveStatus("engine", "error", "HTTP 500", { retry });
    assert.deepEqual(readSaveStatus("engine"), { state: "error", message: "HTTP 500", retry });
    mock.timers.tick(10_000);
    assert.equal(readSaveStatus("engine").state, "error", "an error stays until the next attempt");
    reportSaveStatus("engine", "saving");
    assert.equal(readSaveStatus("engine").state, "saving");
    assert.equal(readSaveStatus("other").state, "idle", "panels are independent");
  } finally {
    mock.timers.reset();
    resetSaveStatus();
  }
});

test("a later 'saved' from an overlapping write does not erase an 'error'; only a new 'saving' does", () => {
  resetSaveStatus();
  // A write already showing "saving" fails first…
  reportSaveStatus("engine", "saving");
  reportSaveStatus("engine", "error", "HTTP 500", { retry: () => {} });
  assert.equal(readSaveStatus("engine").state, "error");
  // …then a DIFFERENT, overlapping write that was already in flight lands
  // successfully. It must not silently clear the failure and its Retry.
  reportSaveStatus("engine", "saved");
  assert.equal(readSaveStatus("engine").state, "error", "the failure and its Retry must stay visible");
  assert.equal(readSaveStatus("engine").message, "HTTP 500");
  // Only a fresh write starting ("saving") may replace it; that write's own
  // outcome then lands normally.
  reportSaveStatus("engine", "saving");
  assert.equal(readSaveStatus("engine").state, "saving");
  reportSaveStatus("engine", "saved");
  assert.equal(readSaveStatus("engine").state, "saved", "the new write's own success is not blocked by the old error");
  resetSaveStatus();
});

test("trackSave follows a promise and hands a retry to the error state", async () => {
  resetSaveStatus();
  let attempts = 0;
  const ok = await trackSave("providers", async () => { attempts += 1; });
  assert.equal(ok, true);
  assert.equal(readSaveStatus("providers").state, "saved");
  const failed = await trackSave("providers", async () => { attempts += 1; throw new Error("nope"); });
  assert.equal(failed, false);
  const status = readSaveStatus("providers");
  assert.equal(status.state, "error");
  assert.equal(status.message, "nope");
  assert.equal(typeof status.retry, "function");
  status.retry();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(attempts, 3, "retry re-runs the same write");
  resetSaveStatus();
});

test("the corner renders one polite live region per panel", () => {
  resetSaveStatus();
  reportSaveStatus("engine", "error", "HTTP 500", { retry: () => {} });
  const html = renderToStaticMarkup(React.createElement(SaveStatusCorner, { panelId: "engine" }));
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /Could not save/);
  assert.match(html, /Retry/);
  const idle = renderToStaticMarkup(React.createElement(SaveStatusCorner, { panelId: "idle-panel" }));
  assert.match(idle, /aria-live="polite"/);
  assert.doesNotMatch(idle, /Saved|Saving|Could not save/);
  resetSaveStatus();
});

test("Directory rows are 44px targets, keyboard-openable, with status and chevron", () => {
  const html = renderToStaticMarkup(React.createElement(Directory, {
    sections: [
      {
        id: "connected",
        title: "Connected",
        rows: [
          { id: "anthropic", title: "Anthropic", subtitle: "149 models", status: { tone: "ok", text: "Signed in" }, onOpen: () => {} },
          { id: "ollama", title: "Ollama", status: { tone: "warn", text: "Not reachable" }, actions: React.createElement("button", { type: "button" }, "Rescan") },
        ],
      },
      { id: "discovered", title: "Discovered", rows: [], empty: "Nothing found nearby." },
    ],
  }));
  assert.match(html, /role="list"/);
  // An openable row is a real <button> inside its `role="listitem"`
  // wrapper — AT announces it as interactive, and Enter/Space activation is
  // native — not a clickable div wearing tabindex="0" and a key handler.
  assert.match(html, /<button[^>]*type="button"[^>]*class="settings-directory-row ui-focus-ring"/, "an openable row is a real button");
  assert.doesNotMatch(html, /role="listitem"[^>]*tabindex="0"/, "the listitem wrapper itself is not the focusable element");
  assert.match(html, /min-height:44px/);
  assert.match(html, /Signed in/);
  assert.match(html, /149 models/);
  assert.match(html, /Not reachable/);
  assert.match(html, /Rescan/);
  assert.match(html, /Nothing found nearby\./);
  assert.match(html, /data-directory-row="anthropic"/);
  assert.match(html, /lucide-chevron-right/, "the openable row shows a chevron");
});

test("DangerZone renders its rows under a red heading and nothing when empty", () => {
  const html = renderToStaticMarkup(React.createElement(DangerZone, {
    rows: [{ title: "Delete this account", description: "Every session and token goes with it.", action: React.createElement("button", { type: "button" }, "Delete") }],
  }));
  assert.match(html, /Danger zone/);
  assert.match(html, /Delete this account/);
  assert.match(html, /var\(--status-error\)/);
  assert.equal(renderToStaticMarkup(React.createElement(DangerZone, { rows: [] })), "");
});

test("PromptDialog is the typed counterpart of ConfirmDialog and renders nothing while closed", () => {
  assert.equal(typeof PromptDialog, "function");
  const html = renderToStaticMarkup(React.createElement(PromptDialog, {
    open: false, title: "Rename token", label: "Name", confirmLabel: "Rename", onSubmit: () => {}, onCancel: () => {},
  }));
  assert.doesNotMatch(html, /Rename token/);
});

test("the opener context defaults to a no-op so a stray consumer never throws", () => {
  function Probe() {
    const open = useSettingsOpener();
    open("models", { sub: "catalog" });
    return React.createElement("span", null, typeof open);
  }
  assert.match(renderToStaticMarkup(React.createElement(Probe)), /function/);
  const calls = [];
  const html = renderToStaticMarkup(React.createElement(SettingsOpenerContext.Provider, { value: (tab, opts) => calls.push([tab, opts]) }, React.createElement(Probe)));
  assert.match(html, /function/);
  assert.deepEqual(calls, [["models", { sub: "catalog" }]]);
});

test("toasts can carry one action button, wired through base-ui's actionProps", async () => {
  const source = await readFile(new URL("./ui/toast.tsx", import.meta.url), "utf8");
  assert.match(source, /action\?: ToastAction/);
  assert.match(source, /actionProps: \{ children: options\.action\.label, onClick: options\.action\.onClick \}/);
  assert.match(source, /<Toast\.Action/);
});

test("NativeSetting wraps the whole card in a <label> for a switch structurally, not only by element type", () => {
  const bareSwitch = renderToStaticMarkup(
    React.createElement(NativeSetting, { label: "Enable Advisor" }, React.createElement(ToggleSwitch, { checked: false, onChange: () => {} })),
  );
  assert.match(bareSwitch, /^<label\b/, "a bare ToggleSwitch child still gets the label wrap (back-compat)");

  // SchemaSettingRow/McpCard pass a <SchemaControl> element, which renders a
  // ToggleSwitch internally but is not one itself — `children.type ===
  // ToggleSwitch` can never see through that wrapper, so the boolean case
  // must say so explicitly via `switchControl`.
  const wrappedSwitch = renderToStaticMarkup(
    React.createElement(
      NativeSetting,
      { label: "mcp.enabled", switchControl: true },
      React.createElement("div", null, React.createElement(ToggleSwitch, { checked: false, onChange: () => {} })),
    ),
  );
  assert.match(wrappedSwitch, /^<label\b/, "switchControl wraps even when the toggle is nested inside another element");

  const plainRow = renderToStaticMarkup(
    React.createElement(NativeSetting, { label: "Some text setting" }, React.createElement("input", { type: "text" })),
  );
  assert.match(plainRow, /^<div\b/, "a non-toggle control stays a plain card");
});

test("Drawer's own Back/×/Escape/scrim consult the shell's busy register, and the phone × leaves Settings like every other level's ×", async () => {
  const source = await readFile(new URL("./settings/Drawer.tsx", import.meta.url), "utf8");
  // Back, Escape and the scrim all route through requestClose, which must
  // check busy before falling to the dirty guard — a login SSE deserves the
  // same confirmation a shell-level pop already gets.
  assert.match(source, /const requestClose = useCallback\(\(\) => \{\s*\n\s*if \(shell\?\.busy\.isBusy\(\)\) \{/, "requestClose checks the busy register first");
  assert.match(source, /setConfirmBusyLeave\(true\)/);
  // Parity: the phone header's × leaves Settings entirely through the
  // shell's own onClose, not a second drawer-local Back.
  assert.match(source, /shell\.callbacks\.onClose\(\)/);
  assert.match(source, /aria-label="Close settings"/);
});

test("openSub levels (schema TOC drill-in) get a Drawer-level's modal treatment, and the hub beneath goes inert while one is open", async () => {
  const source = await readFile(new URL("./settings/MobileStack.tsx", import.meta.url), "utf8");
  assert.match(source, /function LevelPanel/);
  assert.match(source, /role="dialog"/);
  assert.match(source, /aria-modal="true"/);
  assert.match(source, /useFocusTrap\(panelRef, isTop\)/, "reuses Drawer's focus trap instead of a second implementation");
  assert.match(source, /SettingsHighlightContext\.Provider value=\{shell\?\.highlight/, "re-provides the search highlight one hop into the pushed level");
  assert.match(source, /inert=\{covered\}/, "the root list and the hub panel go inert while any level covers them");
});

test("the schema highlight effect keys on highlightId (not the volatile index identity), the push guard resets when it clears, and retry jumps to Models › Assignments", async () => {
  const source = await readFile(new URL("./settings/engine/SchemaSettingsList.tsx", import.meta.url), "utf8");
  // index.byKey/index.tabs get a new identity on every optimistic write
  // (useSchemaIndex.ts); depending on them re-ran this on every toggle while
  // a highlight was showing. index.status is stable across writes.
  assert.match(source, /\}, \[highlightId, index\.status, isMobile, openSub, singleTab\]\);/);
  assert.doesNotMatch(source, /\[highlightId, index\.rows\.length, index\.byKey, index\.tabs/);
  assert.match(source, /if \(!highlightId\) pushedFor\.current = null;/, "the push guard resets once the highlight clears, so re-tapping the same result re-pushes a level");
  assert.match(source, /callbacks\.selectSection\("models", "assignments"\)/, "the retry chip jumps to Assignments, not the Catalog default");
  assert.match(source, /switchControl=\{isToggle\}/, "the row's own boolean control gets the full-card label");
  assert.match(source, /const \[openState, setOpenState\] = useState<OpenState>\(\(\) => \{/, "SchemaLevel seeds its open groups from the highlighted row instead of starting all-collapsed");
});

test("Extensions sub-panels only reference aria-labelledby ids that exist; a single visible segment falls back to aria-label", async () => {
  const source = await readFile(new URL("./settings/panels/ExtensionsPanel.tsx", import.meta.url), "utf8");
  assert.match(source, /views\.length > 1\s*\n\s*\? \{ role: "tabpanel" as const/, "role=tabpanel/aria-labelledby only when the SegmentedControl actually renders");
  assert.match(source, /"aria-label": view\?\.label/);
  assert.match(source, /switchControl=\{isToggle\}/, "MCP's bound boolean cards get the full-card label too");
});

test("ConfirmDialog, PromptDialog and Drawer's dialog presentation carry .ui-dialog so the coarse-pointer 16px/44px rules reach them outside .settings-shell", async () => {
  const fieldSource = await readFile(new URL("./ui/field.tsx", import.meta.url), "utf8");
  const uiDialogCount = (fieldSource.match(/className="ui-dialog"/g) ?? []).length;
  assert.equal(uiDialogCount, 2, "both ConfirmDialog and PromptDialog carry the class");
  assert.equal(typeof ConfirmDialog, "function");

  const drawerSource = await readFile(new URL("./settings/Drawer.tsx", import.meta.url), "utf8");
  assert.match(drawerSource, /className="ui-dialog"/, "Drawer's presentation=\"dialog\" branch carries it too (e.g. ModelCatalog's pin-to-exact-list dialog)");

  const cssSource = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(cssSource, /@media \(hover: none\), \(pointer: coarse\) \{[\s\S]*?\.ui-dialog[\s\S]*?font-size: 16px !important;/, "the 16px input rule extends to .ui-dialog");
  assert.match(cssSource, /\.ui-dialog button:not\(\[role="switch"\]\)/, "the 44px button rule extends to .ui-dialog");
});
