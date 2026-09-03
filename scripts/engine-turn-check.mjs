#!/usr/bin/env node
/**
 * Does each engine complete a REAL turn through Cody?
 *
 * `scripts/engine-bringup.mjs` proves an installed engine starts;
 * `lib/harness/engine-transport.test.mjs` proves the wiring with no binaries.
 * This is the layer above both: a running Cody instance, its HTTP API, and a
 * prompt that must come back as a reply — the path a user's first message
 * takes, credentials included. Run it against `scripts/mock-model-server.mjs`
 * (every reply carries `MOCK-TURN-OK`) and no account is needed at all; see
 * docs/harnesses.md "Proving a turn without credentials" for how each engine
 * is pointed at the mock.
 *
 * For every engine asked for it: select it, open a session with a prompt,
 * follow the event stream to the end of the turn, then check that the marker
 * reached the streamed reply, the persisted transcript AND the session list.
 * A missing marker, an error event, or a turn that never ends is a FAIL, and
 * the exit code is the sum of failures.
 *
 * Usage:
 *   node scripts/engine-turn-check.mjs --base http://127.0.0.1:30177 \
 *        --user admin --pass secret --cwd /path/to/workspace omp pi hermes
 *   node scripts/engine-turn-check.mjs --cookie <cody_session value> claude codex
 *   --marker TEXT      what the reply must contain (default MOCK-TURN-OK)
 *   --timeout SECONDS  per-turn budget (default 120)
 *   --keep             leave the active engine as the last one checked
 *                      (default: restore the engine that was active before)
 */

const args = process.argv.slice(2);
const opts = { base: "http://127.0.0.1:30177", marker: "MOCK-TURN-OK", timeout: 120, keep: false };
const engines = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--keep") opts.keep = true;
  else if (a.startsWith("--")) opts[a.slice(2)] = args[++i];
  else engines.push(a);
}
if (engines.length === 0) {
  console.error("usage: engine-turn-check.mjs [--base URL] (--cookie VALUE | --user U --pass P) [--cwd DIR] <engine> [<engine> …]");
  process.exit(2);
}
opts.timeout = Number(opts.timeout) || 120;

async function readJson(res) {
  const text = await res.text();
  try { return { status: res.status, body: JSON.parse(text) }; } catch { return { status: res.status, body: text.slice(0, 300) }; }
}

let cookie = opts.cookie ? `cody_session=${opts.cookie}` : null;
if (!cookie) {
  if (!opts.user || !opts.pass) { console.error("either --cookie or --user/--pass is required"); process.exit(2); }
  const res = await fetch(`${opts.base}/api/accounts/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: opts.user, password: opts.pass }),
  });
  const match = (res.headers.get("set-cookie") ?? "").match(/cody_session=([^;]+)/);
  if (!match) { console.error(`login failed: HTTP ${res.status}`); process.exit(2); }
  cookie = `cody_session=${match[1]}`;
}
const headers = { Cookie: cookie, "Content-Type": "application/json" };
const get = async (path) => readJson(await fetch(`${opts.base}${path}`, { headers }));
const post = async (path, body) => readJson(await fetch(`${opts.base}${path}`, { method: "POST", headers, body: JSON.stringify(body) }));

const roster = await get("/api/engines");
if (roster.status !== 200) { console.error(`GET /api/engines -> ${roster.status} ${JSON.stringify(roster.body).slice(0, 200)}`); process.exit(2); }
const previouslyActive = roster.body?.active ?? null;
const cwd = opts.cwd ?? process.cwd();

async function driveTurn(engine) {
  const started = Date.now();
  const elapsed = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;
  const log = (line) => console.log(`  [${engine} ${elapsed()}] ${line}`);
  const selected = await post("/api/engines/select", { id: engine });
  if (selected.status !== 200) { log(`select -> ${selected.status} ${JSON.stringify(selected.body).slice(0, 160)}`); return false; }
  const created = await post("/api/agent/new", { cwd, type: "prompt", message: `Turn check on ${engine}. Reply briefly.` });
  const sessionId = created.body?.sessionId;
  if (!sessionId) { log(`agent/new -> ${created.status} ${JSON.stringify(created.body).slice(0, 200)}`); return false; }
  log(`session ${sessionId}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeout * 1000);
  let reply = ""; let ended = false; let failure = null; let renamed = null; const seen = new Map();
  try {
    const res = await fetch(`${opts.base}/api/agent/${encodeURIComponent(sessionId)}/events`, { headers: { Cookie: cookie }, signal: controller.signal });
    const reader = res.body.getReader(); const decoder = new TextDecoder(); let buffer = "";
    stream: while (true) {
      const { value, done } = await reader.read().catch(() => ({ done: true }));
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, index); buffer = buffer.slice(index + 2);
        const line = frame.split("\n").find((entry) => entry.startsWith("data: "));
        if (!line) continue;
        let event; try { event = JSON.parse(line.slice(6)); } catch { continue; }
        const type = event.type ?? "?";
        seen.set(type, (seen.get(type) ?? 0) + 1);
        if (type === "session" && event.sessionId && event.sessionId !== sessionId) renamed = event.sessionId;
        if (type === "message_update" || type === "message_end") {
          const message = event.message ?? event;
          // Only the assistant's own text counts: omp also streams system
          // notices and custom messages through the same events, and a long
          // notice must not stand in for the reply.
          if (message.role !== "assistant") continue;
          const content = message.content;
          const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => part?.text ?? "").join("") : "";
          if (text.length > reply.length) reply = text;
          if (type === "message_end" && message.stopReason === "error") failure = message.errorMessage ?? "assistant turn ended with an error";
        }
        if (type === "prompt_error" || type === "error") failure = JSON.stringify(event).slice(0, 300);
        if (type === "agent_end" || type === "turn_end") { ended = true; break stream; }
      }
    }
  } catch (error) {
    if (!controller.signal.aborted) failure = failure ?? String(error);
  } finally {
    clearTimeout(timer); controller.abort();
  }
  const finalId = renamed ?? sessionId;
  const marker = reply.includes(opts.marker);
  log(`events: ${[...seen.entries()].map(([type, count]) => `${type}×${count}`).join(" ")}`);
  log(`turn ended: ${ended}; marker in reply: ${marker}; reply: ${JSON.stringify(reply).slice(0, 120)}`);
  if (failure) log(`failure: ${failure}`);
  const transcript = await get(`/api/sessions/${encodeURIComponent(finalId)}`);
  const persisted = transcript.status === 200 && JSON.stringify(transcript.body).includes(opts.marker);
  const listed = Boolean((await get("/api/sessions")).body?.sessions?.some((session) => session.id === finalId));
  log(`transcript persisted: ${persisted}; listed: ${listed}`);
  return ended && marker && persisted && listed && !failure;
}

let failures = 0;
for (const engine of engines) {
  console.log(`\n== ${engine}`);
  const ok = await driveTurn(engine).catch((error) => { console.log(`  [${engine}] threw: ${error?.message ?? error}`); return false; });
  console.log(`RESULT ${engine}: ${ok ? "PASS" : "FAIL"}`);
  if (!ok) failures++;
}
// Restore the engine that was active before the run, so a check never leaves
// the instance switched to whichever engine happened to be last.
if (!opts.keep && previouslyActive) await post("/api/engines/select", { id: previouslyActive }).catch(() => {});
console.log(`\n${failures === 0 ? "ALL ENGINES PASS" : `${failures} ENGINE(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
