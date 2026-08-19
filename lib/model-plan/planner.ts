import { spawn } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resolveOmpBin } from "../omp/omp-cli";
import { isRecord } from "../type-guards";
import { ROLE_NAMES, type PlanDraft, type PlanRationale } from "./derive";
import type { Roster } from "./roster";

/**
 * Ask a model to assign Cody's roles, by running the user's own omp binary in
 * print mode. Cody never links the (Bun-only) SDK, so this is the only way to
 * make a model call from the Node server.
 *
 * Every failure is a value, never an exception: the route answers with the
 * heuristic plan plus a warning naming the cause, because an onboarding step
 * that dead-ends on a flaky model call is worse than one that proposes a
 * defensible plan the user can edit.
 */

export type PlannerOutcome =
  | { ok: true; draft: PlanDraft }
  | { ok: false; reason: string };

const PLANNER_TIMEOUT_MS = 120_000;
const STDERR_KEEP = 2_000;

// The ambient config of a real install injects memory recall and a second
// planning turn into a print-mode run. Measured on this machine: with the
// operator's config the planner sent 14.1k input tokens and produced a spurious
// extra turn, so the useful answer was not the last one; with this overlay plus
// --no-prewalk it is a single turn at 10.5k.
const OVERLAY_YAML = [
  "memory.backend: off",
  "autolearn.enabled: false",
  "advisor.enabled: false",
  "prewalk.enabled: false",
  "",
].join("\n");

const SYSTEM_PROMPT = [
  "You assign models to the roles of a coding agent.",
  "Answer with a single JSON object and nothing else: no prose, no explanation outside the JSON, no markdown fence.",
  "Use only the model selectors given to you. Never invent, abbreviate or reformat a selector.",
].join(" ");

// What each role actually drives. Without this the model guesses from the
// names, and "smol"/"tiny"/"slow" are not guessable.
const ROLE_BRIEF = [
  "default - the main session: every ordinary turn the user drives.",
  "task - general-purpose subagents doing delegated multi-step work.",
  "smol - the deliberately mechanical subagent: bulk edits, data collection, no judgement.",
  "tiny - constant cheap background work: session titles, classifiers, small extractions. It runs unattended, many times per session.",
  "plan - planning and design turns, where reasoning depth pays off.",
  "slow - the deliberate role for the hardest problems; quality over latency.",
  "designer - UI and UX work: reads screenshots, writes interface code.",
  "vision - anything with images attached; the model must accept image input.",
  "commit - commit messages: short, formulaic, high volume.",
  "advisor - a passive reviewer invoked on every single turn, so its cost is paid constantly.",
].join("\n");

function buildUserPrompt(roster: Roster): string {
  return [
    "Assign models to roles for this installation.",
    "",
    "Available models and providers (JSON):",
    JSON.stringify(roster),
    "",
    "`local: true` means the model is served on the user's own machine: free and private, but it competes with the user's own hardware and is usually weaker.",
    "",
    "The roles:",
    ROLE_BRIEF,
    "",
    "Answer with exactly this JSON shape:",
    '{"roles":{"<role>":"<selector>"},"ladder":["<provider id>"],"rationale":[{"subject":"<role or topic>","text":"<one short sentence>"}]}',
    "",
    `Rules. Role names must come from this list: ${ROLE_NAMES.join(", ")}. Omit any role you have no opinion on rather than guessing.`,
    "Every selector must be one of the `selector` values above, copied exactly.",
    "`ladder` is provider ids ordered best first: how quality should degrade when a provider is exhausted. Put local providers last.",
    "`rationale` explains the assignments, one short sentence per entry.",
  ].join("\n");
}

/**
 * The outermost balanced `{...}`, which also handles the code fence and any
 * leading or trailing prose the model wraps its answer in — the brace scan
 * starts at the first `{` and stops at its match, so anything outside is
 * ignored. String state is tracked so a brace inside a rationale sentence
 * cannot end the scan early.
 */
function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}" && (depth -= 1) === 0) return text.slice(start, i + 1);
  }
  return null;
}

/** Text of an assistant `turn_end` / `message_end` frame. omp's message content
 * is a block array (a bare string in older frames); only text blocks carry the
 * answer. */
function assistantText(frame: Record<string, unknown>): string | null {
  const message = frame.message;
  if (!isRecord(message) || message.role !== "assistant") return null;
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const text = content
    .flatMap((block) => (isRecord(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : []))
    .join("");
  return text.trim() ? text : null;
}

interface PlannerAnswer {
  turn: string | null;
  message: string | null;
}

/**
 * Run the planner and keep only the latest assistant text.
 *
 * `--mode=json` emits NDJSON event frames, not one JSON answer, so the stream
 * is parsed line by line; notice/session/message_update frames are noise. The
 * answer is the last assistant `turn_end`, with the last `message_end` as the
 * fallback for a run that ends without a turn frame.
 */
function runPlanner(bin: string, overlayPath: string, model: string, prompt: string): Promise<PlannerAnswer> {
  const { promise, resolve, reject } = Promise.withResolvers<PlannerAnswer>();
  const child = spawn(bin, [
    // Print mode: one prompt, one answer, no interactive session.
    "-p",
    // Event frames instead of rendered text, so the answer can be picked out
    // of a multi-frame run instead of scraped from a terminal transcript.
    "--mode=json",
    // The planner is pure judgement over the roster it was handed. Tools,
    // skills and extensions would let it wander the filesystem, spend the turn
    // and (worse) return a plan justified by something it read there.
    "--no-tools",
    "--no-skills",
    // Prewalk runs a preliminary planning turn of its own. Without this the run
    // produces two turns and the useful answer is not the last one.
    "--no-prewalk",
    "--no-extensions",
    "--config",
    overlayPath,
    "--system-prompt",
    SYSTEM_PROMPT,
    "--model",
    model,
    prompt,
    // The OS temp dir, not the user's project: in the project directory omp
    // would pick up its MCP config and context files, which is both slower and
    // a way for repository content to reach a model the user did not point at
    // this project.
  ], { cwd: tmpdir(), stdio: ["ignore", "pipe", "pipe"] });

  const answer: PlannerAnswer = { turn: null, message: null };
  let pending = "";
  let stderr = "";
  let timedOut = false;
  let sawFrame = false;

  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, PLANNER_TIMEOUT_MS);

  const consume = (line: string): void => {
    if (!line.trim()) return;
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(frame)) return;
    sawFrame = true;
    if (frame.type !== "turn_end" && frame.type !== "message_end") return;
    const text = assistantText(frame);
    if (!text) return;
    if (frame.type === "turn_end") answer.turn = text;
    else answer.message = text;
  };

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    pending += chunk;
    let newline = pending.indexOf("\n");
    while (newline !== -1) {
      consume(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
      newline = pending.indexOf("\n");
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-STDERR_KEEP);
  });

  child.on("error", (error) => {
    clearTimeout(timer);
    reject(new Error(`could not run omp: ${error.message}`));
  });
  child.on("close", (code) => {
    clearTimeout(timer);
    consume(pending);
    if (timedOut) {
      reject(new Error(`the planner did not answer within ${PLANNER_TIMEOUT_MS / 1000}s`));
      return;
    }
    if (!sawFrame) {
      const detail = stderr.trim().split("\n").at(-1);
      reject(new Error(`omp produced no output${code === null ? "" : ` (exit ${code})`}${detail ? `: ${detail}` : ""}`));
      return;
    }
    resolve(answer);
  });

  return promise;
}

function readDraft(raw: unknown): PlanDraft | null {
  if (!isRecord(raw) || !isRecord(raw.roles)) return null;
  const roles = Object.fromEntries(Object.entries(raw.roles)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim().length > 0));
  if (Object.keys(roles).length === 0) return null;
  const ladder = Array.isArray(raw.ladder)
    ? raw.ladder.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
    : [];
  const rationale = Array.isArray(raw.rationale)
    ? raw.rationale.flatMap((entry): PlanRationale[] => (isRecord(entry) && typeof entry.subject === "string" && typeof entry.text === "string"
      ? [{ subject: entry.subject, text: entry.text }]
      : []))
    : [];
  return { roles, ladder, rationale };
}

/** Plan with a model. `model` is a roster selector; the caller picks it. */
export async function planWithModel(model: string, roster: Roster): Promise<PlannerOutcome> {
  const bin = resolveOmpBin();
  if (!bin) return { ok: false, reason: "omp binary not found" };

  const dir = mkdtempSync(join(tmpdir(), "cody-model-plan-"));
  const overlayPath = join(dir, "planner.yml");
  try {
    writeFileSync(overlayPath, OVERLAY_YAML, "utf8");
    const answer = await runPlanner(bin, overlayPath, model, buildUserPrompt(roster));
    const text = answer.turn ?? answer.message;
    if (!text) return { ok: false, reason: "the planner returned no answer" };
    const json = extractJsonObject(text);
    if (!json) return { ok: false, reason: "the planner did not answer with JSON" };
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch (error) {
      return { ok: false, reason: `the planner's JSON could not be parsed: ${error instanceof Error ? error.message : String(error)}` };
    }
    const draft = readDraft(parsed);
    if (!draft) return { ok: false, reason: "the planner assigned no roles" };
    return { ok: true, draft };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
