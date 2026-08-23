import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

process.env.CODY_HARNESS = "omp";
process.env.CODY_OMP_BIN = "/bin/echo";
process.env.CODY_TERMINAL_SHELL = "/bin/sh";
// The attach follower is resolved from the package root (bin/cody-session-tail.js).
process.env.CODY_PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { TerminalManager } = await jiti.import("./terminal-manager.ts");
// omp resolves through its OWN cache (lib/omp/omp-cli.ts), not the shared
// engine-bin one — clearing the wrong cache leaves the real binary resolving
// and the test proves nothing.
const { invalidateOmpCliCache } = await jiti.import("./omp/omp-cli.ts");

function waitForExit(manager, id, output, onOutput, includeReplay = true) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`terminal did not exit; output: ${output.value}`)), 5_000);
    const unsubscribe = manager.subscribe(id, (event) => {
      if (event.type === "output" && event.replay && !includeReplay) return;
      if (event.type === "output") {
        output.value += event.data;
        onOutput(event.data);
      }
      if (event.type === "exit") {
        clearTimeout(timeout);
        unsubscribe();
        resolve();
      }
    });
  });
}

function waitForOutput(manager, id, predicate, label) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error(`timed out waiting for ${label}; output: ${output}`));
    }, 5_000);
    const unsubscribe = manager.subscribe(id, (event) => {
      if (event.type !== "output") return;
      output += event.data;
      if (predicate(output)) {
        clearTimeout(timeout);
        unsubscribe();
        resolve(output);
      }
    });
  });
}

function scratchSession(root) {
  const sessionEntry = (entry) => `${JSON.stringify(entry)}\n`;
  const file = path.join(root, "session.jsonl");
  writeFileSync(file, [
    sessionEntry({ type: "session", version: 3, id: "01a09999-0000-7000-8000-eeeeffff0000", timestamp: "2026-08-18T20:00:00.000Z", cwd: root }),
    sessionEntry({ type: "message", id: "u1", parentId: null, timestamp: "2026-08-18T20:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "ATTACH-SEED-USER" }] } }),
    sessionEntry({ type: "message", id: "a1", parentId: "u1", timestamp: "2026-08-18T20:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "ATTACH-SEED-ASSISTANT" }], usage: { totalTokens: 12, cost: { total: 0.0001 } } } }),
  ].join(""));
  return file;
}

test("a new Cody terminal starts the engine once, then continues as a plain shell", async () => {
  const manager = new TerminalManager();
  const terminal = manager.create(process.cwd(), "Smoke terminal", 80, 24);
  const output = { value: "" };
  let sentInitialCommand = false;

  try {
    await waitForExit(manager, terminal.id, output, () => {
      if (sentInitialCommand || !output.value.includes("this is a plain shell now")) return;
      sentInitialCommand = true;
      manager.write(terminal.id, "printf 'CODY_SHELL_READY\\n'; exit\n");
    });

    assert.match(output.value, /Cody: starting omp/);
    assert.match(output.value, /CODY_SHELL_READY/);

    const continuedAt = output.value.length;
    manager.continue(terminal.id, 80, 24);
    manager.write(terminal.id, "printf 'CODY_CONTINUED_SHELL\\n'; exit\n");
    await waitForExit(manager, terminal.id, output, () => {}, false);

    const continuedOutput = output.value.slice(continuedAt);
    assert.match(continuedOutput, /CODY_CONTINUED_SHELL/);
    assert.doesNotMatch(continuedOutput, /Cody: starting omp/);
  } finally {
    manager.dispose();
  }
});

test("the first terminal of a workspace attaches to the chat read-only; later ones get the engine", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "cody-attach-"));
  const ws = path.join(root, "ws");
  mkdirSync(ws);
  const sessionFile = scratchSession(root);
  const pristine = readFileSync(sessionFile);
  const attach = { sessionFile, locale: "en" };
  const manager = new TerminalManager();

  try {
    // First terminal: read-only chat view.
    const first = manager.create(ws, undefined, 80, 24, attach);
    assert.equal(first.attached, true);
    await waitForOutput(manager, first.id, (out) => out.includes("ATTACH-SEED-ASSISTANT"), "initial transcript");

    // Concurrent second terminal: normal engine wrapper, never a second view.
    const second = manager.create(ws, undefined, 80, 24, attach);
    assert.equal(second.attached, undefined);
    await waitForOutput(manager, second.id, (out) => /Cody: starting omp/.test(out), "engine wrapper banner");

    // A concurrent writer appends; the attached terminal renders it live.
    appendFileSync(sessionFile, `${JSON.stringify({ type: "message", id: "u2", parentId: "a1", timestamp: "2026-08-18T20:01:00.000Z", message: { role: "user", content: [{ type: "text", text: "ATTACH-LIVE-APPEND" }] } })}\n`);
    await waitForOutput(manager, first.id, (out) => out.includes("ATTACH-LIVE-APPEND"), "live append");

    // The view is strictly read-only: the session file is byte-identical
    // (plus exactly the writer's own append).
    const grown = readFileSync(sessionFile);
    assert.deepEqual(grown.subarray(0, pristine.length), pristine);
    assert.match(grown.subarray(pristine.length).toString("utf8"), /^\{"type":"message","id":"u2"/);

    // Close every terminal; reopening attaches again.
    manager.close(first.id);
    manager.close(second.id);
    const third = manager.create(ws, undefined, 80, 24, attach);
    assert.equal(third.attached, true);
    await waitForOutput(manager, third.id, (out) => out.includes("ATTACH-LIVE-APPEND"), "reattached transcript");
  } finally {
    manager.dispose();
  }
});

test("an engine switch closes terminals running the old engine and leaves plain shells alone", async () => {
  // The PTY lives on globalThis and outlives the reload an engine switch
  // triggers, and terminalCommand baked the engine's binary into the wrapper
  // at spawn time. Without this teardown the terminal panel reattaches to a
  // live REPL of the PREVIOUS engine — still announcing it in the replay
  // buffer — inside a Cody that reports a different engine everywhere else.
  const manager = new TerminalManager();
  try {
    const engineTerminal = manager.create(process.cwd(), "Engine terminal", 80, 24);

    // Same engine (a re-affirming select) must not kill anything.
    assert.equal(manager.closeTerminalsForOtherEngines("omp"), 0);
    assert.equal(manager.list(process.cwd()).some((t) => t.id === engineTerminal.id), true);

    // A different engine takes it down.
    assert.equal(manager.closeTerminalsForOtherEngines("hermes"), 1);
    assert.equal(manager.list(process.cwd()).some((t) => t.id === engineTerminal.id), false);
  } finally {
    manager.dispose();
  }
});

test("a terminal that fell through to a plain shell is never closed by a switch", async () => {
  // A user's shell is not the switch's to close. With no engine binary
  // resolvable the wrapper is skipped entirely, so the record carries no
  // engine and must survive.
  const previous = process.env.CODY_OMP_BIN;
  process.env.CODY_OMP_BIN = path.join(tmpdir(), "cody-no-such-engine-binary");
  // The binary lookup is memoized for the process lifetime.
  invalidateOmpCliCache();
  const manager = new TerminalManager();
  try {
    const shell = manager.create(process.cwd(), "Plain shell", 80, 24);
    assert.equal(manager.closeTerminalsForOtherEngines("hermes"), 0);
    assert.equal(manager.list(process.cwd()).some((t) => t.id === shell.id), true);
  } finally {
    manager.dispose();
    if (previous === undefined) delete process.env.CODY_OMP_BIN;
    else process.env.CODY_OMP_BIN = previous;
    invalidateOmpCliCache();
  }
});
