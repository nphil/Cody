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
const { PromptDialog } = await jiti.import("./ui/field.tsx");

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
  assert.match(html, /role="listitem"[^>]*tabindex="0"/, "an openable row is focusable");
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
