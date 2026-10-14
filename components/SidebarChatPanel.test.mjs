import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { SidebarChatPanel } = await jiti.import("./SidebarChatPanel.tsx");
const { createSideQuestionsBridge } = await jiti.import("../hooks/useSideQuestionsBridge.ts");

const noop = () => {};

/** What the main chat publishes for a chat that can have side questions. */
function sideQuestions(overrides = {}) {
  return {
    sessionId: "chat-1",
    available: true,
    records: [],
    answering: false,
    asking: false,
    error: null,
    dismissError: noop,
    askFromPanel: async () => true,
    askFromComposer: async () => ({ ok: true }),
    cancel: noop,
    applyFrame: noop,
    noteStreamConnected: noop,
    noteHistoryNotice: noop,
    ...overrides,
  };
}

function record(id, overrides = {}) {
  return { id, leafId: null, question: "What is a monad?", answer: "", status: "complete", createdAt: 1, updatedAt: 1, ...overrides };
}

/** The panel as it first paints, with `published` on the bridge (or nothing). */
function render(published) {
  const bridge = createSideQuestionsBridge();
  if (published) bridge.publish("chat-1", published);
  return renderToStaticMarkup(React.createElement(SidebarChatPanel, {
    cwd: "/tmp/ws",
    active: true,
    mainSessionId: "chat-1",
    sideQuestionsBridge: bridge,
  }));
}

function assertOnlyNewChat(html) {
  assert.match(html, /placeholder="Ask anything…"/, "the New chat composer is there");
  assert.doesNotMatch(html, /role="tablist"/);
  assert.doesNotMatch(html, /sidebar-mode/);
  assert.doesNotMatch(html, /role="tabpanel"/, "a tab panel with no tab to name it would be unnamed");
  assert.doesNotMatch(html, /Ask about this chat/);
  assert.doesNotMatch(html, /aria-label="Side question"/);
}

/** One segment of the switch, as markup. */
function segment(html, id) {
  const match = html.match(new RegExp(`<button[^>]*id="sidebar-mode-${id}"[^>]*>`));
  assert.ok(match, `segment ${id} is rendered`);
  return match[0];
}

test("with nothing published the Side Bar is exactly the New chat view", () => {
  assertOnlyNewChat(render());
});

test("a chat that cannot have side questions (another engine, an old omp, no id yet) adds no switch either", () => {
  assertOnlyNewChat(render(sideQuestions({ available: false })));
});

test("where side questions exist a switch offers This chat and New chat, starting on New chat", () => {
  const html = render(sideQuestions());
  assert.match(html, /<div role="tablist" aria-label="Which chat to ask"/);
  const thisChat = segment(html, "session");
  const newChat = segment(html, "new");
  assert.match(thisChat, /aria-selected="false"/);
  assert.match(newChat, /aria-selected="true"/);
  assert.match(thisChat, /aria-controls="sidebar-mode-panel-session"/);
  assert.match(newChat, /aria-controls="sidebar-mode-panel-new"/);
  assert.match(html, />This chat</);
  assert.match(html, />New chat</);
  // Each segment names a panel that exists, and the panel names its segment.
  assert.match(html, /id="sidebar-mode-panel-session"[^>]*aria-labelledby="sidebar-mode-session"/);
  assert.match(html, /id="sidebar-mode-panel-new"[^>]*aria-labelledby="sidebar-mode-new"/);
});

test("both views are on the page, so flipping the switch never unmounts a streaming sidebar answer or a draft", () => {
  const html = render(sideQuestions());
  assert.match(html, /placeholder="Ask anything…"/, "New chat's composer");
  assert.match(html, /aria-label="Side question"/, "This chat's box");
  assert.match(html, /id="sidebar-mode-panel-new"[^>]*style="display:flex/);
  assert.match(html, /id="sidebar-mode-panel-session"[^>]*style="display:none/);
});

test("This chat shows the topics the main chat published", () => {
  const html = render(sideQuestions({ records: [record("a", { question: "Why is the sky blue?", answer: "Rayleigh scattering." })] }));
  assert.match(html, /Why is the sky blue\?/);
  assert.match(html, /Rayleigh scattering\./);
});

test("an answer arriving while New chat shows puts a live dot on the This chat segment", () => {
  const tablist = (html) => html.match(/<div role="tablist"[\s\S]*?<\/div>/)[0];
  const running = render(sideQuestions({ answering: true, records: [record("a", { status: "running", answer: "Partial" })] }));
  assert.match(tablist(running), /live-status-dot/);
  assert.match(tablist(running), /class="sr-only">Answering…</, "announced, not only drawn");
  assert.doesNotMatch(tablist(render(sideQuestions())), /live-status-dot/);
});
