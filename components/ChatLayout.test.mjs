import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("populated chat keeps the timeline in a bounded right rail", async () => {
  const [chatWindow, messageView, styles] = await Promise.all([
    readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8"),
    readFile(new URL("./MessageView.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(chatWindow, /className="chat-transcript-layout relative min-w-0 flex-1 overflow-hidden"/);
  assert.match(chatWindow, /right: "var\(--chat-minimap-width\)"/);
  assert.match(chatWindow, /paddingRight: `calc\(\$\{CHAT_COLUMN_PADDING\}px \+ var\(--chat-minimap-width\)\)`/);
  assert.match(chatWindow, /<ChatMinimap[\s\S]*messageRefs=\{messageRefs\}/);
  assert.doesNotMatch(chatWindow, /\{isMobile \? null : \(/);

  assert.match(styles, /\.chat-transcript-layout \{[\s\S]*grid-template-columns: minmax\(0, 1fr\) var\(--chat-minimap-width\)/);
  assert.match(styles, /\.chat-transcript-scroll,[\s\S]*\.chat-column-frame,[\s\S]*\.chat-notice-overlay/);
  assert.match(styles, /\.chat-turn,[\s\S]*\.chat-message,[\s\S]*\.chat-user-message/);
  assert.match(messageView, /className="chat-user-message"/);
});
