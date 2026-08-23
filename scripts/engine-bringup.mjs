#!/usr/bin/env node
/**
 * Does each engine actually START?
 *
 * The transport test (lib/harness/engine-transport.test.mjs) proves the
 * WIRING with no binaries present. This proves the engines themselves: it
 * spawns each installed one and drives the real handshake, which is the layer
 * where a broken install, a missing optional dependency, an adapter that
 * changed its argv, or a protocol version bump actually shows up.
 *
 * What is REQUIRED to pass is credential-free, because a release gate cannot
 * carry the user's account:
 *
 *   ACP engines (claude, codex, hermes) — spawn and answer `initialize`.
 *     That proves the binary exists, runs, and speaks ACP at the version Cody
 *     drives it with.
 *   rpc-ui engines (omp, pi) — spawn with the engine's own `--mode`, then
 *     answer `get_state`. That is the same first command rpc-manager sends.
 *
 * Opening a session is reported but never required, and that line is drawn
 * from measurement rather than caution: with no credentials the Claude
 * adapter HANGS on `session/new` and Codex answers "Authentication required",
 * while Hermes opens one happily. Requiring it would hang the gate on two
 * engines out of three. `--sessions` opts in where credentials exist.
 *
 * An engine that is NOT installed is skipped and reported as such — this runs
 * on developer machines and in a container where only some engines exist. It
 * fails only on an engine that IS installed and does not come up, and the
 * exit code is what the release gate reads.
 *
 * Usage:
 *   node scripts/engine-bringup.mjs             # every installed engine
 *   node scripts/engine-bringup.mjs omp hermes  # only these
 *   node scripts/engine-bringup.mjs --sessions      # also open a session
 *       …needs each engine signed in; without credentials two of three hang
 *       or refuse, which is why it is not the default.
 *   node scripts/engine-bringup.mjs --require omp,hermes
 *       …additionally FAIL if one of those is not installed, which is what
 *       the smoke gate wants: it just installed them, so absent means broken.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

// Plain jiti, exactly as bin/cody-server.js loads the same modules. The
// shipped image carries no tsconfig.json, so asking for tsconfigPaths here
// would work in the repo and be the first thing to break inside the
// container — which is the one place this script has to run.
const jiti = createJiti(import.meta.url);
const { listHarnesses, getHarnessById } = await jiti.import("../lib/harness/index.ts");
const { AcpEngineSession } = await jiti.import("../lib/harness/acp-session.ts");

/** One engine gets this long to come up before it counts as wedged. */
const BRINGUP_TIMEOUT_MS = 60_000;

const args = process.argv.slice(2);
const requireIndex = args.indexOf("--require");
const required = requireIndex === -1
  ? []
  : (args[requireIndex + 1] ?? "").split(",").map((id) => id.trim()).filter(Boolean);
// `requireIndex + 1` is 0 when --require is absent, which would silently
// drop the first engine named on the command line.
const requireValueIndex = requireIndex === -1 ? -1 : requireIndex + 1;
const selected = args.filter((arg, index) => !arg.startsWith("--") && index !== requireValueIndex);
/** Also open a session — only meaningful where the engine is signed in. */
const openSession = args.includes("--sessions");

function withTimeout(promise, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${BRINGUP_TIMEOUT_MS / 1000}s`)), BRINGUP_TIMEOUT_MS)),
  ]);
}

/** Spawn an ACP engine through the real session class and complete the
 * handshake. Uses the adapter's own createSession, so this exercises the spec
 * Cody actually ships rather than a hand-built argv. */
async function bringUpAcp(adapter, cwd, { openSession }) {
  const session = adapter.createSession({ sessionId: "", cwd });
  // Without this the check is worthless. A per-turn session spawns nothing
  // until a prompt, so its waitUntilReady() resolves instantly and this
  // script would report a handshake that never happened — rubber-stamping
  // exactly the half-finished migration it exists to catch.
  if (!(session instanceof AcpEngineSession)) {
    await session.destroyAndWait().catch(() => {});
    throw new Error("declares no ACP session — createSession returned a per-turn session, so no handshake is possible");
  }
  const notices = [];
  // Unsubscribed before teardown below. Killing the child while connect() is
  // still in session/new makes the session report a failed start, which is
  // true of the teardown and not of the engine — printed under a green line
  // it reads as a contradiction.
  const stopListening = session.onEvent((event) => {
    if (event.type === "notice") notices.push(`${event.level}: ${event.message}`);
  });
  try {
    // The required half: no credentials involved.
    await withTimeout(session.waitUntilConnected(), `${adapter.id} initialize`);
    if (!openSession) return { detail: "spawned + initialize", notices };

    try {
      await withTimeout(session.waitUntilReady(), `${adapter.id} session/new`);
      const state = await withTimeout(session.send({ type: "get_state" }), `${adapter.id} get_state`);
      if (!state || typeof state !== "object") throw new Error("get_state returned nothing");
      return { detail: "initialize + session/new + get_state", notices };
    } catch (error) {
      // Not a failure of the engine — a session it will not open without an
      // account. Said out loud, so a green line is never mistaken for
      // "signed in and ready to work".
      return {
        detail: `spawned + initialize (no session: ${error instanceof Error ? error.message : String(error)})`,
        notices,
      };
    }
  } finally {
    stopListening();
    await session.destroyAndWait().catch(() => {});
  }
}

/** Spawn an rpc-dialect engine the way rpc-manager does and ask it for state.
 * NDJSON in, NDJSON out, one JSON object per line. */
function bringUpRpcUi(adapter, binary, cwd) {
  const { mode, supportsCwdFlag } = adapter.rpcUi;
  const argv = ["--mode", mode, ...(supportsCwdFlag ? ["--cwd", cwd] : [])];
  const child = spawn(binary, argv, { cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] });

  return withTimeout(new Promise((resolve, reject) => {
    let pending = "";
    let stderr = "";
    let answered = false;

    const finish = (error, value) => {
      if (answered) return;
      answered = true;
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
      if (error) reject(error); else resolve(value);
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      pending += chunk;
      let index = pending.indexOf("\n");
      while (index !== -1) {
        const line = pending.slice(0, index).trim();
        pending = pending.slice(index + 1);
        index = pending.indexOf("\n");
        if (!line) continue;
        let frame;
        try { frame = JSON.parse(line); } catch { continue; }
        // The engine answers a command with a frame naming it. Anything else
        // on the way (ready frames, notices) is normal startup chatter.
        if (frame && typeof frame === "object" && frame.command === "get_state") {
          if (frame.success === false) finish(new Error(`get_state was rejected: ${JSON.stringify(frame)}`));
          else finish(null, { detail: `--mode ${mode} + get_state` });
        }
      }
    });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString("utf8")).slice(-2000); });
    child.on("error", (error) => finish(new Error(`could not spawn ${binary}: ${error.message}`)));
    child.on("exit", (code, signal) => {
      finish(new Error(`exited ${signal ? `on ${signal}` : `with code ${code}`} before answering get_state${stderr ? `\n${stderr.trim()}` : ""}`));
    });

    // rpc-ui accepts commands as soon as stdin is open; a command sent before
    // the ready frame is queued, not dropped.
    child.stdin.write(`${JSON.stringify({ type: "get_state", id: "bringup" })}\n`);
  }), `${adapter.id} bring-up`);
}

const engines = (selected.length > 0
  ? selected.map((id) => {
    const adapter = getHarnessById(id);
    if (!adapter) throw new Error(`Unknown engine "${id}"`);
    return adapter;
  })
  : listHarnesses());

const results = [];
for (const adapter of engines) {
  const binary = adapter.resolveBinary();
  if (!binary) {
    results.push({ id: adapter.id, status: "skipped", detail: "not installed" });
    continue;
  }
  const cwd = mkdtempSync(join(tmpdir(), `cody-bringup-${adapter.id}-`));
  const started = Date.now();
  const transport = adapter.rpcUi ? "rpc-ui" : "acp";
  try {
    const outcome = adapter.rpcUi
      ? await bringUpRpcUi(adapter, binary, cwd)
      : await bringUpAcp(adapter, cwd, { openSession });
    results.push({
      id: adapter.id,
      status: "ok",
      transport,
      ms: Date.now() - started,
      detail: outcome.detail,
      notices: outcome.notices ?? [],
    });
  } catch (error) {
    results.push({
      id: adapter.id,
      status: "failed",
      transport,
      ms: Date.now() - started,
      detail: error instanceof Error ? error.message : String(error),
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

for (const result of results) {
  if (result.status === "ok") {
    console.log(`ok       ${result.id.padEnd(8)} ${String(result.transport).padEnd(7)} ${result.detail} (${result.ms}ms)`);
    for (const notice of result.notices) console.log(`         └─ ${notice}`);
  } else if (result.status === "skipped") {
    console.log(`skipped  ${result.id.padEnd(8)} ${result.detail}`);
  } else {
    console.log(`FAILED   ${result.id.padEnd(8)} ${String(result.transport).padEnd(7)} ${result.detail}`);
  }
}

const failed = results.filter((result) => result.status === "failed");
const missing = required.filter((id) => results.find((result) => result.id === id)?.status === "skipped");
for (const id of missing) console.log(`FAILED   ${id.padEnd(8)} required by --require but not installed`);

const ran = results.filter((result) => result.status === "ok").length;
console.log(`\n${ran} engine(s) came up, ${failed.length} failed, ${results.length - ran - failed.length} skipped`);
process.exit(failed.length + missing.length > 0 ? 1 : 0);
