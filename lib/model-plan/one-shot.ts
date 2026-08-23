import { spawn } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { isRecord } from "../type-guards";

/**
 * One prompt, one answer, run through the user's own omp binary in print mode.
 * Cody never links the (Bun-only) SDK, so spawning omp is the only way this
 * Node server can reach a model at all.
 *
 * Both callers — the onboarding planner and the session namer — need the same
 * shape of run: no tools, no ambient config, the answer picked out of an NDJSON
 * stream, and a hard timeout. Only the prompts differ.
 *
 * Every failure is a value, never an exception. Both callers are background
 * conveniences with a defensible fallback (a heuristic plan, a truncated
 * title), so a flaky model call must degrade rather than propagate.
 */

export interface OneShotRequest {
  /** Path to the omp binary; the caller resolves it (and decides what to do
   * when omp is not installed at all). */
  bin: string;
  /** Model selector, exactly as it appears in the roster. Omitted, omp resolves
   * its own default — the right answer for a caller with no opinion. */
  model?: string;
  systemPrompt: string;
  prompt: string;
  timeoutMs?: number;
}

/** The model's last answer, or the reason there is none — never both. */
export interface OneShotResult {
  text: string | null;
  error: string | null;
}

const DEFAULT_TIMEOUT_MS = 120_000;
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

interface LastAnswer {
  turn: string | null;
  message: string | null;
}

/**
 * Run omp and keep only the latest assistant text.
 *
 * `--mode=json` emits NDJSON event frames, not one JSON answer, so the stream
 * is parsed line by line; notice/session/message_update frames are noise. The
 * answer is the last assistant `turn_end`, with the last `message_end` as the
 * fallback for a run that ends without a turn frame.
 */
function runOmpPrint(request: OneShotRequest, overlayPath: string, timeoutMs: number): Promise<LastAnswer> {
  const { promise, resolve, reject } = Promise.withResolvers<LastAnswer>();
  const child = spawn(request.bin, [
    // Print mode: one prompt, one answer, no interactive session.
    "-p",
    // Event frames instead of rendered text, so the answer can be picked out
    // of a multi-frame run instead of scraped from a terminal transcript.
    "--mode=json",
    // These runs are pure judgement over the prompt they were handed. Tools,
    // skills, rules and extensions would let the model wander the filesystem,
    // spend the turn and (worse) return an answer justified by something it
    // read there.
    "--no-tools",
    "--no-skills",
    "--no-rules",
    // Prewalk runs a preliminary planning turn of its own. Without this the run
    // produces two turns and the useful answer is not the last one.
    "--no-prewalk",
    "--no-extensions",
    // A throwaway question is not a session, and omp's own title generator is
    // itself a model call — one per run, for a transcript nobody will read.
    "--no-session",
    "--no-title",
    // `--flag=value`, NOT `--flag value`. omp's parser takes only the joined
    // form for a value flag: passed as two argv entries the flag is silently
    // ignored, which is not a parse error and produces no warning. Measured
    // against omp 18 — with the space form the overlay never loaded (the
    // advisor still ran and memory was still injected) and --system-prompt
    // never applied, so every run silently used omp's default coding-assistant
    // prompt and answered the caller's prompt as if it were a user request.
    `--config=${overlayPath}`,
    `--system-prompt=${request.systemPrompt}`,
    ...(request.model ? [`--model=${request.model}`] : []),
    request.prompt,
    // The OS temp dir, not the user's project: in the project directory omp
    // would pick up its MCP config and context files, which is both slower and
    // a way for repository content to reach a model the user did not point at
    // this project.
  ], { cwd: tmpdir(), stdio: ["ignore", "pipe", "pipe"] });

  const answer: LastAnswer = { turn: null, message: null };
  let pending = "";
  let stderr = "";
  let timedOut = false;
  let sawFrame = false;

  const timeoutError = `the model did not answer within ${Math.round(timeoutMs / 1000)}s`;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
    // Settle here rather than waiting for `close`: a killed omp that left a
    // grandchild holding the stdio pipes open never emits one, and the caller
    // has already waited out the whole timeout.
    reject(new Error(timeoutError));
  }, timeoutMs);

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
    if (timedOut) return; // already settled by the timer
    if (!sawFrame) {
      const detail = stderr.trim().split("\n").at(-1);
      reject(new Error(`omp produced no output${code === null ? "" : ` (exit ${code})`}${detail ? `: ${detail}` : ""}`));
      return;
    }
    resolve(answer);
  });

  return promise;
}

/** Ask a model one question and return its last assistant text. */
export async function runOneShotModel(request: OneShotRequest): Promise<OneShotResult> {
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let dir: string | null = null;
  try {
    dir = mkdtempSync(join(tmpdir(), "cody-one-shot-"));
    const overlayPath = join(dir, "overlay.yml");
    writeFileSync(overlayPath, OVERLAY_YAML, "utf8");
    const answer = await runOmpPrint(request, overlayPath, timeoutMs);
    const text = answer.turn ?? answer.message;
    if (!text) return { text: null, error: "the model returned no answer" };
    return { text, error: null };
  } catch (error) {
    return { text: null, error: error instanceof Error ? error.message : String(error) };
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}
