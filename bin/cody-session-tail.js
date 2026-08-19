#!/usr/bin/env node
"use strict";

/* CommonJS so the follower runs under plain `node` from the packaged app
   with zero build step, same as cody-server.js. */
/* eslint-disable @typescript-eslint/no-require-imports */

/**
 * cody-session-tail — read-only live view of an omp session JSONL file.
 *
 * Spawned by lib/terminal-manager.ts inside the FIRST web terminal of a
 * workspace when the browser passes the active chat session. It renders the
 * transcript with ANSI color (roles, one-line tool calls, token/cost lines),
 * then follows appends via fs.watch with a polling fallback. On `q` or
 * Ctrl+C it hands the PTY over to the user's interactive shell so the
 * terminal stays useful.
 *
 * STRICTLY read-only: the session file is only ever opened with `fs.open(r)`.
 * The live `omp --mode rpc-ui` process remains the file's single writer.
 * (`omp --resume` was measured to append a session_exit entry on quit and to
 * never re-read the file, so it is unusable as a concurrent viewer.)
 *
 * Plain Node 22, CommonJS, zero dependencies. User-visible strings resolve
 * from lib/i18n/locales/<locale>.json (en fallback), passed as
 * CODY_TAIL_LOCALE by the terminal manager.
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const RESET = "\u001b[0m";
const BOLD = "\u001b[1m";
const DIM = "\u001b[2m";
const CYAN = "\u001b[36m";
const GREEN = "\u001b[32m";
const YELLOW = "\u001b[33m";
const RED = "\u001b[31m";

const POLL_MS = 700;
const TOOL_LINE_MAX = 160;
const NOTICE_LINE_MAX = 160;

// ---------------------------------------------------------------------------
// i18n: read the shared locale dictionaries shipped next to this script.
// ---------------------------------------------------------------------------

function loadDictionaries(locale) {
  const localesDir = path.join(__dirname, "..", "lib", "i18n", "locales");
  const readDictionary = (name) => {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(localesDir, `${name}.json`), "utf8"));
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  };
  const safe = typeof locale === "string" && /^[A-Za-z][A-Za-z-]{0,9}$/.test(locale) ? locale : "en";
  return { chosen: safe === "en" ? {} : readDictionary(safe), en: readDictionary("en") };
}

const dictionaries = loadDictionaries(process.env.CODY_TAIL_LOCALE);

function t(key, vars) {
  const chosen = dictionaries.chosen[key];
  const fallback = dictionaries.en[key];
  let text = typeof chosen === "string" ? chosen : typeof fallback === "string" ? fallback : key;
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      text = text.split(`{${name}}`).join(String(value));
    }
  }
  return text;
}

// ---------------------------------------------------------------------------
// Session JSONL parsing (lenient, mirrors lib/omp/session-files.ts semantics).
// ---------------------------------------------------------------------------

function parseLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function textOfContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
    else if (block.type === "image") parts.push(DIM + t("terminalTail.image") + RESET);
  }
  return parts.join("\n");
}

function oneLine(value, max) {
  const flat = String(value).replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}\u2026` : flat;
}

function formatCost(total) {
  if (typeof total !== "number" || !Number.isFinite(total)) return null;
  return `$${total.toFixed(4)}`;
}

function formatTokens(count) {
  if (typeof count !== "number" || !Number.isFinite(count)) return null;
  return count.toLocaleString("en-US");
}

/** Compact `{"file":"a.ts","lines":40}` style one-line argument summary. */
function summarizeInput(input) {
  if (!input || typeof input !== "object") return "";
  try {
    return oneLine(JSON.stringify(input), TOOL_LINE_MAX);
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Rendering: each session entry maps to zero or more terminal lines.
// ---------------------------------------------------------------------------

function renderMessage(message) {
  const lines = [];
  if (!message || typeof message !== "object") return lines;
  if (message.role === "user") {
    const text = textOfContent(message.content);
    if (!text.trim()) return lines;
    lines.push("");
    lines.push(`${BOLD}${CYAN}${t("terminalTail.roleUser")}${RESET}`);
    for (const row of text.split("\n")) lines.push(`  ${row}`);
    return lines;
  }
  if (message.role === "assistant") {
    const blocks = Array.isArray(message.content) ? message.content : [];
    const text = textOfContent(message.content);
    const toolCalls = blocks.filter((block) => block && typeof block === "object" && block.type === "toolCall");
    if (text.trim() || toolCalls.length > 0) {
      lines.push("");
      lines.push(`${BOLD}${GREEN}${t("terminalTail.roleAssistant")}${RESET}`);
      if (text.trim()) for (const row of text.split("\n")) lines.push(`  ${row}`);
      for (const call of toolCalls) {
        const name = typeof call.toolName === "string" ? call.toolName : typeof call.name === "string" ? call.name : "tool";
        const input = summarizeInput(call.input ?? call.arguments);
        lines.push(`  ${YELLOW}\u2699 ${name}${RESET}${input ? ` ${DIM}${input}${RESET}` : ""}`);
      }
    }
    const usage = message.usage;
    if (usage && typeof usage === "object") {
      const tokens = formatTokens(usage.totalTokens);
      const cost = formatCost(usage.cost && typeof usage.cost === "object" ? usage.cost.total : undefined);
      if (tokens !== null && cost !== null) {
        lines.push(`  ${DIM}${t("terminalTail.usage", { tokens, cost })}${RESET}`);
      }
    }
    return lines;
  }
  if (message.role === "toolResult") {
    const name = typeof message.toolName === "string" ? message.toolName : "tool";
    const mark = message.isError ? `${RED}\u2717` : `${GREEN}\u2713`;
    const summary = oneLine(textOfContent(message.content), TOOL_LINE_MAX);
    lines.push(`  ${mark}${RESET} ${DIM}${name}${summary ? `: ${summary}` : ""}${RESET}`);
    return lines;
  }
  if (message.role === "custom" && message.display !== false) {
    const summary = oneLine(textOfContent(message.content), NOTICE_LINE_MAX);
    if (summary) lines.push(`  ${DIM}${summary}${RESET}`);
  }
  return lines;
}

function renderEntry(entry) {
  if (!entry || typeof entry !== "object") return [];
  switch (entry.type) {
    case "message":
      return renderMessage(entry.message);
    case "custom_message": {
      if (entry.display === false) return [];
      const summary = oneLine(textOfContent(entry.content), NOTICE_LINE_MAX);
      return summary ? [`  ${DIM}${summary}${RESET}`] : [];
    }
    case "compaction":
      return [`  ${DIM}${t("terminalTail.compaction")}${RESET}`];
    default:
      // title slot, session header, model/thinking changes, labels, custom
      // markers: metadata, not transcript.
      return [];
  }
}

/** Ids on the active branch: leaf (last entry with an id) back to the root. */
function activeBranchIds(entries) {
  const byId = new Map();
  let leaf = null;
  for (const entry of entries) {
    if (entry && typeof entry.id === "string") {
      byId.set(entry.id, entry);
      leaf = entry;
    }
  }
  const branch = new Set();
  let cursor = leaf;
  while (cursor) {
    if (branch.has(cursor.id)) break;
    branch.add(cursor.id);
    cursor = typeof cursor.parentId === "string" ? byId.get(cursor.parentId) : null;
  }
  return branch;
}

// ---------------------------------------------------------------------------
// The follower: initial render, then append-only reads from a byte offset.
// ---------------------------------------------------------------------------

const sessionFile = process.argv[2];
let offset = 0;
let inode = null;
let carry = Buffer.alloc(0);
let stopped = false;
const watchers = [];
let pollTimer = null;

function writeOut(lines) {
  if (lines.length > 0) process.stdout.write(`${lines.join("\r\n")}\r\n`);
}

function readSlice(start, end) {
  const descriptor = fs.openSync(sessionFile, "r");
  try {
    const buffer = Buffer.alloc(end - start);
    let read = 0;
    while (read < buffer.length) {
      const chunk = fs.readSync(descriptor, buffer, read, buffer.length - read, start + read);
      if (chunk <= 0) break;
      read += chunk;
    }
    return buffer.subarray(0, read);
  } finally {
    fs.closeSync(descriptor);
  }
}

/** Consume [offset, size) as JSONL, buffering a trailing partial line. */
function consumeAppended(size) {
  const chunk = readSlice(offset, size);
  offset += chunk.length;
  carry = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
  let boundary;
  const rendered = [];
  while ((boundary = carry.indexOf(0x0a)) !== -1) {
    const line = carry.subarray(0, boundary).toString("utf8");
    carry = Buffer.from(carry.subarray(boundary + 1));
    const entry = parseLine(line);
    if (entry) rendered.push(...renderEntry(entry));
  }
  writeOut(rendered);
}

function renderFromScratch() {
  const stat = fs.statSync(sessionFile);
  inode = stat.ino;
  offset = 0;
  carry = Buffer.alloc(0);
  const body = readSlice(0, stat.size).toString("utf8");
  const complete = body.endsWith("\n") ? body : body.slice(0, body.lastIndexOf("\n") + 1);
  offset = Buffer.byteLength(complete, "utf8");
  const entries = [];
  for (const line of complete.split("\n")) {
    const entry = parseLine(line);
    if (entry) entries.push(entry);
  }
  const branch = activeBranchIds(entries);
  const lines = [`${DIM}${t("terminalTail.header")}${RESET}`];
  for (const entry of entries) {
    // Off-branch entries (abandoned forks) stay hidden in the initial render;
    // live appends are by definition the active branch.
    if (typeof entry.id === "string" && branch.size > 0 && !branch.has(entry.id)) continue;
    lines.push(...renderEntry(entry));
  }
  writeOut(lines);
}

function checkForUpdates() {
  if (stopped) return;
  let stat;
  try {
    stat = fs.statSync(sessionFile);
  } catch {
    return; // transiently missing (mid-rename): the next poll settles it
  }
  try {
    if (stat.ino !== inode || stat.size < offset) {
      // Replaced (title rewrite via temp+rename) or truncated: redraw fully.
      process.stdout.write("\u001b[2J\u001b[H");
      renderFromScratch();
      return;
    }
    if (stat.size > offset) consumeAppended(stat.size);
  } catch {
    // Keep following; the poll loop retries.
  }
}

function stopFollowing() {
  stopped = true;
  clearInterval(pollTimer);
  for (const watcher of watchers) {
    try {
      watcher.close();
    } catch {
      // already closed
    }
  }
}

function handOffToShell(message) {
  stopFollowing();
  if (process.stdin.isTTY) {
    try {
      process.stdin.setRawMode(false);
    } catch {
      // not fatal: the shell re-owns the tty anyway
    }
  }
  process.stdin.pause();
  process.stdin.removeAllListeners("data");
  process.stdout.write(`\r\n${DIM}${message}${RESET}\r\n`);
  const shell = process.env.CODY_TAIL_SHELL || process.env.SHELL || "/bin/sh";
  const child = spawn(shell, ["-i"], { stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 0));
  child.on("error", () => process.exit(1));
}

function startFollowing() {
  renderFromScratch();
  // fs.watch gives low latency; polling guarantees progress on platforms and
  // filesystems where inotify misses events (or after watcher errors).
  try {
    watchers.push(fs.watch(sessionFile, { persistent: true }, checkForUpdates));
  } catch {
    // polling covers it
  }
  try {
    watchers.push(fs.watch(path.dirname(sessionFile), { persistent: true }, checkForUpdates));
  } catch {
    // polling covers it
  }
  pollTimer = setInterval(checkForUpdates, POLL_MS);
}

function main() {
  if (!sessionFile) {
    handOffToShell(t("terminalTail.readError"));
    return;
  }
  try {
    startFollowing();
  } catch {
    handOffToShell(t("terminalTail.readError"));
    return;
  }
  if (process.stdin.isTTY) {
    try {
      process.stdin.setRawMode(true);
    } catch {
      // keyboard exit degrades to SIGINT below
    }
  }
  process.stdin.resume();
  process.stdin.on("data", (data) => {
    const key = data.toString("utf8");
    if (key === "q" || key === "Q" || key.includes("\u0003")) {
      handOffToShell(t("terminalTail.shellHandoff"));
    }
  });
  process.on("SIGINT", () => handOffToShell(t("terminalTail.shellHandoff")));
}

main();
