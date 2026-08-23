import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { normalizeSessionName } = await jiti.import("./session-namer.ts");

test("keeps a clean three-or-four-word answer as-is", () => {
  assert.equal(normalizeSessionName("Deploy mermaid diagram viewer"), "Deploy mermaid diagram viewer");
  assert.equal(normalizeSessionName("  HomeAssistant  "), "HomeAssistant");
  assert.equal(normalizeSessionName("Fix login (again)"), "Fix login (again)");
});

test("unwraps quotes, markdown and code fences", () => {
  assert.equal(normalizeSessionName('"Proxmox backup script"'), "Proxmox backup script");
  assert.equal(normalizeSessionName("'Proxmox backup script'"), "Proxmox backup script");
  assert.equal(normalizeSessionName("**Proxmox backup script**"), "Proxmox backup script");
  assert.equal(normalizeSessionName("`Proxmox backup script`"), "Proxmox backup script");
  assert.equal(normalizeSessionName("“Proxmox backup script”"), "Proxmox backup script");
  assert.equal(normalizeSessionName("```\nProxmox backup script\n```"), "Proxmox backup script");
  assert.equal(normalizeSessionName("```text\nProxmox backup script\n```"), "Proxmox backup script");
});

test("strips label prefixes, list markers and trailing punctuation", () => {
  assert.equal(normalizeSessionName("Title: Proxmox backup script"), "Proxmox backup script");
  assert.equal(normalizeSessionName("Session name — Proxmox backup script"), "Proxmox backup script");
  assert.equal(normalizeSessionName("- Proxmox backup script"), "Proxmox backup script");
  assert.equal(normalizeSessionName("1. Proxmox backup script"), "Proxmox backup script");
  assert.equal(normalizeSessionName("Proxmox backup script."), "Proxmox backup script");
  assert.equal(normalizeSessionName('**Title: "Proxmox backup script".**'), "Proxmox backup script");
});

test("takes the answer, not the sentence introducing it", () => {
  assert.equal(normalizeSessionName("Here is a good name:\n\nProxmox backup script"), "Proxmox backup script");
  assert.equal(normalizeSessionName("Title:\nProxmox backup script"), "Proxmox backup script");
  // Nothing follows, so a colon-terminated line is the answer after all.
  assert.equal(normalizeSessionName("Proxmox backup:"), "Proxmox backup");
});

test("caps a whole sentence at four words", () => {
  assert.equal(
    normalizeSessionName("This session is about fixing the SSE reconnect race in the sidebar"),
    "This session is about",
  );
});

test("caps length in code points, on a word boundary", () => {
  const long = normalizeSessionName("Authentication middleware refactoring documentation");
  assert.ok(Array.from(long).length <= 40, `too long: ${long}`);
  assert.equal(long, "Authentication middleware refactoring");
  // No word boundary to cut on: a hard cut, still bounded.
  const unbroken = normalizeSessionName("a".repeat(80));
  assert.equal(Array.from(unbroken).length, 40);
});

test("keeps non-Latin answers", () => {
  assert.equal(normalizeSessionName("修复 SSE 重连问题"), "修复 SSE 重连问题");
  assert.equal(normalizeSessionName("「セッション名の生成」"), "セッション名の生成");
  assert.equal(normalizeSessionName("タイトル: セッション名の生成"), "セッション名の生成");
});

test("rejects answers that are not names", () => {
  assert.equal(normalizeSessionName(""), null);
  assert.equal(normalizeSessionName("   \n  "), null);
  assert.equal(normalizeSessionName("```\n```"), null);
  assert.equal(normalizeSessionName("---"), null);
  assert.equal(normalizeSessionName('"..."'), null);
  assert.equal(normalizeSessionName("N/A"), null);
  assert.equal(normalizeSessionName("Untitled"), null);
});

test("rejects refusals, which a four-word cap would disguise as a name", () => {
  assert.equal(normalizeSessionName("I'm sorry, but I can't help with that."), null);
  assert.equal(normalizeSessionName("Sorry — there is not enough information here."), null);
  assert.equal(normalizeSessionName("Unfortunately the message is empty."), null);
  assert.equal(normalizeSessionName("I cannot name this session."), null);
  // A real name that merely starts with a refusal-ish word survives.
  assert.equal(normalizeSessionName("Sorry-state error handling"), "Sorry-state error handling");
  assert.equal(normalizeSessionName("I18n locale parity"), "I18n locale parity");
});
