import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { scanSessionInfo } = await jiti.import("./session-files.ts");
const { describeMcpMountChange } = await jiti.import("../mount-notice.ts");

function writeSession(dir, beforeFirstMessage) {
  const file = join(dir, "2026-10-06T23-29-58-879Z_01a1138d-705f-73f1-bae4-ba1004dc42cb.jsonl");
  const lines = [
    { type: "title", v: 1, title: "", updatedAt: "2026-10-06T23:29:58.879Z" },
    { type: "session", version: 3, id: "01a1138d-705f-73f1-bae4-ba1004dc42cb", timestamp: "2026-10-06T23:29:58.879Z", cwd: "/tmp/x" },
    ...beforeFirstMessage,
    { type: "message", id: "u1", parentId: "c1", timestamp: "2026-10-06T23:30:00.000Z", message: { role: "user", content: [{ type: "text", text: "Count slowly from 1 to 40" }] } },
    { type: "message", id: "a1", parentId: "u1", timestamp: "2026-10-06T23:30:05.000Z", message: { role: "assistant", content: [{ type: "text", text: "1. One" }] } },
  ];
  writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  return file;
}

test("a chat whose first message sits past the 4 KiB window (omp 18.7's spawn-time mount notice) is still listed with it", () => {
  const dir = mkdtempSync(join(tmpdir(), "cody-scan-"));
  try {
    const notice = { type: "custom_message", id: "c1", parentId: null, customType: "xdev-mount-notice", display: false, content: `<system-notice>\n${"- xd://tool — description\n".repeat(200)}` };
    const info = scanSessionInfo(writeSession(dir, [notice]));
    assert.equal(info.firstMessage, "Count slowly from 1 to 40");
    assert.ok(info.messageCount >= 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a chat with no user message yet still reads as empty", () => {
  const dir = mkdtempSync(join(tmpdir(), "cody-scan-"));
  try {
    const file = join(dir, "s.jsonl");
    writeFileSync(file, [
      JSON.stringify({ type: "session", version: 3, id: "s", timestamp: "2026-10-06T23:29:58.879Z", cwd: "/tmp/x" }),
      JSON.stringify({ type: "custom_message", id: "c1", customType: "xdev-mount-notice", content: "x".repeat(8000) }),
    ].join("\n") + "\n");
    assert.equal(scanSessionInfo(file).firstMessage, "(no messages)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("only MCP tools changing is news to the person", () => {
  assert.equal(describeMcpMountChange({ added: ["preview_screenshot", "open_preview", "device_list"], removed: [] }), null);
  assert.equal(describeMcpMountChange({ added: ["mcp__ha_mcp_ha_get_state", "device_list"], removed: [] }), "1 MCP tool added.");
  assert.equal(describeMcpMountChange({ added: [], removed: ["mcp__a_x", "mcp__a_y"] }), "2 MCP tools removed.");
  assert.equal(describeMcpMountChange(undefined, "<system-notice>\nxd:// device inventory changed.\n- xd://open_preview"), null);
});
