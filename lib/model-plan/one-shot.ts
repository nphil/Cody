import { spawn } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { isRecord } from "../type-guards";
import { engineChildEnv } from "../harness/provider-keys";

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
  /** Comma-joined into `--tools=<csv>`, replacing the default `--no-tools`.
   * For a caller that hands the model a live tool (e.g. web_search) rather
   * than running it fully tool-free. An empty array still means zero tools,
   * same as omitting this and getting `--no-tools`. */
  tools?: string[];
  /** Spawn cwd. Defaults to the OS temp dir, matching every existing caller. */
  cwd?: string;
  /** Merged on top of `engineChildEnv()`. Lets a caller redirect state that
   * reads an env var (e.g. `PI_CODING_AGENT_DIR`) without touching the
   * process's own environment. */
  extraEnv?: Record<string, string | undefined>;
  /** IANA zone the child runs under (its `TZ`); absent leaves the server's. */
  timeZone?: string;
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
//
// NESTED keys only: omp reads a config layer by path segments, so a flat
// `memory.backend: off` line is a key literally named "memory.backend" and is
// ignored (verified with `PI_CONFIG_FILES=<overlay> omp config get
// memory.backend` on omp 18.3.4). Written flat, none of this applied, and every
// Distill/session-name run booted the memory system: an ~800 MB embedding
// worker per run, recall into the prompt, and its own transcript retained.
const OVERLAY_YAML = [
  "memory:",
  "  backend: off",
  "autolearn:",
  "  enabled: false",
  "advisor:",
  "  enabled: false",
  "prewalk:",
  "  enabled: false",
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

/** A `tool_execution_start` frame, normalized. */
export interface ToolStartEvent {
  toolCallId: string;
  toolName: string;
  args: unknown;
}

/** A `tool_execution_end` frame, normalized. `resultExcerpt` is bounded here
 * (not left to the caller) because the real payload can be an entire rendered
 * web page — a progress log must never grow with it. */
export interface ToolEndEvent {
  toolCallId: string;
  toolName: string;
  isError: boolean;
  resultExcerpt: string;
}

const TOOL_RESULT_EXCERPT_MAX = 300;

/** Best-effort short text out of a tool result payload. omp's own text
 * results are `{content: [{type: "text", text}], ...}`; anything else (a
 * structured `details` blob, a bare string, or a shape a future omp version
 * changes) still degrades to *some* bounded text rather than throwing. */
function excerptToolResult(result: unknown): string {
  let text = "";
  if (typeof result === "string") {
    text = result;
  } else if (isRecord(result) && Array.isArray(result.content)) {
    text = result.content
      .flatMap((block) => (isRecord(block) && typeof block.text === "string" ? [block.text] : []))
      .join(" ");
  }
  if (!text.trim()) {
    try {
      text = JSON.stringify(result);
    } catch {
      text = String(result);
    }
  }
  text = text.trim().replace(/\s+/g, " ");
  return text.length > TOOL_RESULT_EXCERPT_MAX ? `${text.slice(0, TOOL_RESULT_EXCERPT_MAX - 1)}…` : text;
}

/**
 * The NDJSON reducer, separated from the process so it can be exercised
 * without spawning anything.
 *
 * Every frame type but `turn_end`/`message_end` is noise for the answer, and
 * an unrecognized one is silently ignored: the frame vocabulary belongs to the
 * engine, so a renamed or added type must degrade to "no delta seen", never to
 * a failed run. `onDelta` is an OPTIMIZATION on top of that — the answer is
 * derived exactly the same way whether or not a single delta was recognized.
 *
 * omp's streaming frames carry the FULL accumulated message, never a delta
 * (docs/api.md: "always replace, never append"), so the appended text is the
 * suffix past what was already reported. A frame that is not an extension of
 * what was reported (a restarted or rewritten message) yields no delta at all
 * rather than duplicated text; the final answer still carries the truth.
 */
export function createFrameReader(
  onDelta?: (text: string) => void,
  toolHooks: { onToolStart?: (event: ToolStartEvent) => void; onToolEnd?: (event: ToolEndEvent) => void } = {},
): {
  consume(line: string): void;
  sawFrame(): boolean;
  answer(): string | null;
} {
  const last: LastAnswer = { turn: null, message: null };
  let seen = false;
  let reported = "";

  const report = (text: string | null): void => {
    if (!onDelta || !text || text === reported || !text.startsWith(reported)) return;
    const delta = text.slice(reported.length);
    reported = text;
    onDelta(delta);
  };

  return {
    consume(line: string): void {
      if (!line.trim()) return;
      let frame: unknown;
      try {
        frame = JSON.parse(line);
      } catch {
        return;
      }
      if (!isRecord(frame)) return;
      seen = true;
      const type = frame.type;
      // Tool frames never carry assistant text; handled separately from the
      // answer-bearing types below, and reported before they are skipped.
      if (type === "tool_execution_start") {
        toolHooks.onToolStart?.({
          toolCallId: typeof frame.toolCallId === "string" ? frame.toolCallId : "",
          toolName: typeof frame.toolName === "string" ? frame.toolName : "",
          args: frame.args,
        });
        return;
      }
      if (type === "tool_execution_end") {
        toolHooks.onToolEnd?.({
          toolCallId: typeof frame.toolCallId === "string" ? frame.toolCallId : "",
          toolName: typeof frame.toolName === "string" ? frame.toolName : "",
          isError: frame.isError === true,
          resultExcerpt: excerptToolResult(frame.result),
        });
        return;
      }
      // Any other well-formed frame proves the child spoke; only these four
      // can carry text, and everything else is skipped before it is inspected.
      if (type !== "turn_end" && type !== "message_end" && type !== "message_start" && type !== "message_update") {
        return;
      }
      const text = assistantText(frame);
      report(text);
      if (!text) return;
      // The answer never comes from a partial message.
      if (type === "turn_end") last.turn = text;
      else if (type === "message_end") last.message = text;
    },
    sawFrame: () => seen,
    answer: () => last.turn ?? last.message,
  };
}

/** Extra hooks the streaming caller needs and the plain one does not. */
interface RunHooks {
  onDelta?: (text: string) => void;
  onToolStart?: (event: ToolStartEvent) => void;
  onToolEnd?: (event: ToolEndEvent) => void;
  signal?: AbortSignal;
}

/**
 * Run omp and keep only the latest assistant text.
 *
 * `--mode=json` emits NDJSON event frames, not one JSON answer, so the stream
 * is parsed line by line; notice/session frames are noise. The answer is the
 * last assistant `turn_end`, with the last `message_end` as the fallback for a
 * run that ends without a turn frame.
 */
function runOmpPrint(
  request: OneShotRequest,
  overlayPath: string,
  timeoutMs: number,
  hooks: RunHooks = {},
): Promise<string | null> {
  // A signal that fired BEFORE this call never delivers an "abort" event to a
  // listener added below, so the check has to happen before the spawn: without
  // it a run cancelled a tick early would start a child and hold it for the
  // whole timeout.
  if (hooks.signal?.aborted) return Promise.reject(new Error("the request was cancelled"));
  const { promise, resolve, reject } = Promise.withResolvers<string | null>();
  const child = spawn(request.bin, [
    // Print mode: one prompt, one answer, no interactive session.
    "-p",
    // Event frames instead of rendered text, so the answer can be picked out
    // of a multi-frame run instead of scraped from a terminal transcript.
    "--mode=json",
    // These runs are pure judgement over the prompt they were handed. Tools,
    // skills, rules and extensions would let the model wander the filesystem,
    // spend the turn and (worse) return an answer justified by something it
    // read there. A caller that hands the model a live tool (research)
    // passes `tools` and gets an explicit allow-list instead.
    ...(request.tools ? [`--tools=${request.tools.join(",")}`] : ["--no-tools"]),
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
    // The OS temp dir, not the user's project, unless the caller supplies its
    // own (research uses a dedicated throwaway dir per run rather than the
    // shared OS temp root): in the project directory omp would pick up its
    // MCP config and context files, which is both slower and a way for
    // repository content to reach a model the user did not point at this
    // project.
    // Same environment as every other engine spawn: a provider key saved in
    // Settings must reach the session namer and the planner too, or both
    // silently fall back (a truncated first-message name, the heuristic plan).
    // `extraEnv` layers on top for a caller that needs the child to resolve
    // its OWN state (agent dir, MCP config, skills) somewhere other than the
    // real install — see research.ts's module doc for why.
  ], { cwd: request.cwd ?? tmpdir(), stdio: ["ignore", "pipe", "pipe"], env: engineChildEnv(request.extraEnv, { timeZone: request.timeZone }) });

  const reader = createFrameReader(hooks.onDelta, { onToolStart: hooks.onToolStart, onToolEnd: hooks.onToolEnd });
  let pending = "";
  let stderr = "";
  let settled = false;

  const timeoutError = `the model did not answer within ${Math.round(timeoutMs / 1000)}s`;
  const timer = setTimeout(() => {
    settled = true;
    child.kill("SIGKILL");
    // Settle here rather than waiting for `close`: a killed omp that left a
    // grandchild holding the stdio pipes open never emits one, and the caller
    // has already waited out the whole timeout.
    reject(new Error(timeoutError));
  }, timeoutMs);

  // A caller that walked away (the browser closed the SSE connection) must not
  // leave a model call running for the rest of its timeout.
  const onAbort = (): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    child.kill("SIGKILL");
    reject(new Error("the request was cancelled"));
  };
  hooks.signal?.addEventListener("abort", onAbort, { once: true });
  // The signal can fire between the guard above and this registration.
  if (hooks.signal?.aborted) onAbort();

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    pending += chunk;
    let newline = pending.indexOf("\n");
    while (newline !== -1) {
      reader.consume(pending.slice(0, newline));
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
    hooks.signal?.removeEventListener("abort", onAbort);
    if (settled) return;
    settled = true;
    reject(new Error(`could not run omp: ${error.message}`));
  });
  child.on("close", (code) => {
    clearTimeout(timer);
    hooks.signal?.removeEventListener("abort", onAbort);
    reader.consume(pending);
    if (settled) return; // already settled by the timer or an abort
    settled = true;
    if (!reader.sawFrame()) {
      const detail = stderr.trim().split("\n").at(-1);
      reject(new Error(`omp produced no output${code === null ? "" : ` (exit ${code})`}${detail ? `: ${detail}` : ""}`));
      return;
    }
    // A non-zero exit that still produced an answer is not a failure the
    // caller can act on; an exit with no answer is reported as one below.
    resolve(reader.answer());
  });

  return promise;
}

async function runOneShot(request: OneShotRequest, hooks: RunHooks): Promise<OneShotResult> {
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let dir: string | null = null;
  try {
    dir = mkdtempSync(join(tmpdir(), "cody-one-shot-"));
    const overlayPath = join(dir, "overlay.yml");
    writeFileSync(overlayPath, OVERLAY_YAML, "utf8");
    const text = await runOmpPrint(request, overlayPath, timeoutMs, hooks);
    if (!text) return { text: null, error: "the model returned no answer" };
    return { text, error: null };
  } catch (error) {
    return { text: null, error: error instanceof Error ? error.message : String(error) };
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

/** Ask a model one question and return its last assistant text. */
export async function runOneShotModel(request: OneShotRequest): Promise<OneShotResult> {
  return runOneShot(request, {});
}

/**
 * The same run, reporting the answer as it arrives.
 *
 * `onDelta` receives each newly appended piece of assistant text so a caller
 * streaming to a browser can paint before the run ends. It is strictly an
 * optimization: the returned result is derived exactly as `runOneShotModel`
 * derives it, so a run whose streaming frames were never recognized still
 * answers with the full text.
 *
 * `onToolStart`/`onToolEnd` report the child's own tool calls (e.g. research's
 * web_search) as they happen, for a caller building a progress log.
 */
export async function runOneShotModelStreaming(
  request: OneShotRequest & {
    onDelta?: (text: string) => void;
    onToolStart?: (event: ToolStartEvent) => void;
    onToolEnd?: (event: ToolEndEvent) => void;
    signal?: AbortSignal;
  },
): Promise<OneShotResult> {
  return runOneShot(request, {
    onDelta: request.onDelta,
    onToolStart: request.onToolStart,
    onToolEnd: request.onToolEnd,
    signal: request.signal,
  });
}
