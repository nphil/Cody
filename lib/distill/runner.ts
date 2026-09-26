import { getHarness } from "../harness";
import { getOneShotAgentDir } from "../omp/isolated-agent-dir";
import { runOneShotModelStreaming } from "../model-plan/one-shot";
import { buildDistillPrompt, looksLikeReplyNotDescription, normalizeThinkingSummary, type DistillKind, type DistillVerbosity } from "./prompts";

/**
 * Running one distill: which engine can, which models to try, and how many at
 * once.
 *
 * Four rules hold this together, and all four exist so the feature cannot
 * break when the engine underneath it changes.
 *
 *  1. FALL THROUGH, never fail hard. A spawn failure, a non-zero exit, a model
 *     the engine no longer knows, a timeout, an empty answer and a thinking
 *     answer that talks to the reader instead of describing the material
 *     (looksLikeReplyNotDescription) are ONE case: try the next selector.
 *     After the last one, try the engine's own default with no --model at
 *     all, which is the only attempt that cannot be invalidated by the
 *     catalog changing. Only then is the distill reported as failed — and a
 *     failed distill leaves the original text exactly as it was, so the
 *     worst outcome is that a summary does not appear.
 *  2. DELTAS ARE AN OPTIMIZATION. The answer is derived the way the session
 *     namer derives it (lib/model-plan/one-shot.ts); the streaming callback is
 *     fed by frames whose vocabulary belongs to the engine, so a run that
 *     recognizes none of them still produces the whole text at the end.
 *  3. BOUNDED WORK. Two distills run at a time per process; the rest queue,
 *     and a queued thinking request for a block is replaced by the newer one
 *     for the same block instead of both running.
 *  4. ISOLATED CHILD. Every one-shot child (this one and the session namer's)
 *     runs against `getOneShotAgentDir()` — an empty `mcp.json` plus symlinked
 *     credentials/config — never the real agent dir directly. Measured on a
 *     real install: the real agent dir's user-scope MCP servers made every
 *     spawn connect to them first, taking 45-58s before the model even
 *     started; the isolated dir removes that tax entirely (~2-4s of fixed
 *     omp startup, the rest is the model's own latency). See
 *     lib/omp/isolated-agent-dir.ts.
 */

/** A summary is a background convenience; a wedged child must not hold a slot
 * for long. A reply is longer input and longer output than a thinking line.
 *
 * 20s was sized for a spawn that should take a few hundred ms; it was in
 * fact timing out on EVERY attempt, because the real agent dir's MCP
 * connections (see rule 4 above) took 45-58s just to reach the model. Fixing
 * that isolation dropped a real, healthy isolated attempt to 8-15s measured
 * against this instance's own configured chain (Haiku, Luna); the engine's
 * own default (whatever a role's retry/fallback chain resolves to — not
 * Cody's business, and not bounded the same way) measured up to ~32s across
 * a legitimate multi-turn retry it ran on its own. 30s of margin over the
 * 8-15s baseline lands at the same order as that measured worst case without
 * reopening the old "every attempt times out" failure. */
export const THINKING_TIMEOUT_MS = 30_000;
export const REPLY_TIMEOUT_MS = 60_000;

/** Model calls are expensive and the browser can ask for many at once. */
export const MAX_CONCURRENT_DISTILLS = 2;
/** Past this, the oldest waiter is dropped: it is the one least likely to
 * still be on screen, and an unbounded queue of 60-second jobs is a leak. */
export const MAX_QUEUED_DISTILLS = 32;

export type DistillEngineState =
  | { status: "ready"; bin: string }
  | { status: "unsupported"; reason: string }
  | { status: "unavailable"; reason: string };

/**
 * Which engines can run a distill at all — the same rule as the session namer
 * (lib/session-namer.ts): print mode (`-p --mode=json`) is the rpc dialect's
 * CLI, and an ACP engine has no equivalent Cody could drive. Those instances
 * hide the feature rather than render it broken.
 */
export function distillEngine(): DistillEngineState {
  const harness = getHarness();
  if (!harness.rpcUi) {
    return {
      status: "unsupported",
      reason: `${harness.displayName} cannot run a one-off model call, so Distill is unavailable on it.`,
    };
  }
  const bin = harness.resolveBinary();
  if (!bin) {
    return { status: "unavailable", reason: `The ${harness.binaryName} binary is not installed.` };
  }
  return { status: "ready", bin };
}

export interface DistillAttemptInput {
  /** Omitted for the final attempt: the engine resolves its own default. */
  model?: string;
  systemPrompt: string;
  prompt: string;
  timeoutMs: number;
  onDelta: (text: string) => void;
  signal?: AbortSignal;
}

/** One model call. The test seam: every failure is a value, never a throw. */
export type DistillAttempt = (input: DistillAttemptInput) => Promise<{ text: string | null; error: string | null }>;

export function engineAttempt(bin: string): DistillAttempt {
  return async (input) => runOneShotModelStreaming({
    bin,
    model: input.model,
    systemPrompt: input.systemPrompt,
    prompt: input.prompt,
    timeoutMs: input.timeoutMs,
    onDelta: input.onDelta,
    signal: input.signal,
    // Isolated, never the real agent dir directly — rule 4 in the module
    // doc above.
    extraEnv: { PI_CODING_AGENT_DIR: getOneShotAgentDir() },
  });
}

export interface DistillChainOptions {
  chain: readonly string[];
  kind: DistillKind;
  verbosity?: DistillVerbosity;
  text: string;
  /** Everyday language instead of developer shorthand; see
   * lib/distill-preferences.ts's `plainLanguage`. Defaults to false so every
   * existing caller keeps today's (technical) phrasing. */
  plain?: boolean;
  attempt: DistillAttempt;
  onDelta: (text: string) => void;
  signal?: AbortSignal;
}

export type DistillChainResult =
  | { ok: true; text: string; model: string }
  | { ok: false; message: string };

/**
 * Try each selector in turn, then the engine's default.
 *
 * `model` in the success answer is the selector that produced the text, or the
 * empty string when the engine's own default did — Cody was not told which
 * model that is and will not invent a name for it.
 */
export async function runDistillChain(options: DistillChainOptions): Promise<DistillChainResult> {
  const { systemPrompt, prompt } = buildDistillPrompt(options.kind, options.verbosity, options.text, options.plain ?? false);
  const timeoutMs = options.kind === "thinking" ? THINKING_TIMEOUT_MS : REPLY_TIMEOUT_MS;
  // `undefined` is the engine's own default and is always the last attempt.
  const models: Array<string | undefined> = [...options.chain, undefined];

  let lastError = "no model produced a summary";
  // A thinking summary is ONE normalized sentence: streaming its raw text
  // would paint a paragraph into a one-line box and then snap it, so only a
  // reply distill streams. The `done` event carries the whole text either way.
  const streams = options.kind === "reply";
  // Once a failed attempt has painted text into the browser, later attempts
  // stream nothing: their `done` replaces what is there, but a second stream
  // interleaved with the first would be gibberish while it ran.
  let deltasSpent = false;

  for (const model of models) {
    if (options.signal?.aborted) return { ok: false, message: "the request was cancelled" };
    let emitted = false;
    const answer = await options.attempt({
      model,
      systemPrompt,
      prompt,
      timeoutMs,
      signal: options.signal,
      onDelta: (delta) => {
        if (!streams || deltasSpent || !delta) return;
        emitted = true;
        options.onDelta(delta);
      },
    });
    if (emitted) deltasSpent = true;

    const text = options.kind === "thinking"
      ? normalizeThinkingSummary(answer.text ?? "")
      : (answer.text ?? "").trim();
    if (text && options.kind === "thinking" && looksLikeReplyNotDescription(text)) {
      // Answered the reader instead of describing the material (AGENTS.md's
      // Distill section, "answering not describing"): the same failure as an
      // empty answer — try the next selector rather than show it.
      lastError = "the model answered the material instead of describing it";
      continue;
    }
    if (text) return { ok: true, text, model: model ?? "" };
    // Everything else is the same failure: try the next model.
    lastError = answer.error ?? "the model returned no summary";
  }
  return { ok: false, message: lastError };
}

/** A queued request replaced by a newer one for the same thinking block. */
export class DistillSupersededError extends Error {
  constructor() {
    super("superseded");
    this.name = "DistillSupersededError";
  }
}

/** The waitlist rejected the OLDEST entry because it is full. That entry is
 * usually one the reader has already scrolled past (it has been waiting
 * longest), so losing it must read as "never asked yet", never as a failed
 * distill — the client (hooks/useDistill.ts) treats this message like
 * `DistillSupersededError`'s but additionally clears its own record of the
 * request, so the block gets a fresh attempt the next time it is genuinely
 * visible instead of staying latched at "Could not distill". */
export class DistillQueueOverflowError extends Error {
  constructor() {
    super("too many summaries are already queued");
    this.name = "DistillQueueOverflowError";
  }
}

interface Waiter {
  /** `${sessionId}:${entryId}:${blockIndex}` for a thinking request; null for
   * anything that must not be collapsed with another request. */
  key: string | null;
  resolve: () => void;
  reject: (error: Error) => void;
}

let running = 0;
const waiting: Waiter[] = [];

function releaseSlot(): void {
  const next = waiting.shift();
  // Hand the slot over rather than releasing and re-taking it.
  if (next) next.resolve();
  else running -= 1;
}

function acquireSlot(key: string | null): Promise<void> {
  if (running < MAX_CONCURRENT_DISTILLS) {
    running += 1;
    return Promise.resolve();
  }
  if (key) {
    // A newer summary of the same block makes the queued older one pointless:
    // it would spend a model call to paint text the client has already
    // replaced. Only NOT-YET-STARTED requests are collapsed; a running one is
    // left to finish, since killing it would waste the tokens already spent.
    for (let index = waiting.length - 1; index >= 0; index -= 1) {
      if (waiting[index].key !== key) continue;
      const [stale] = waiting.splice(index, 1);
      stale.reject(new DistillSupersededError());
    }
  }
  if (waiting.length >= MAX_QUEUED_DISTILLS) {
    waiting.shift()?.reject(new DistillQueueOverflowError());
  }
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  waiting.push({ key, resolve, reject });
  return promise;
}

/**
 * Run `task` once a slot is free. Rejects with DistillSupersededError when a
 * newer request for the same `key` arrives before this one starts.
 */
export async function withDistillSlot<T>(key: string | null, task: () => Promise<T>): Promise<T> {
  await acquireSlot(key);
  try {
    return await task();
  } finally {
    releaseSlot();
  }
}

/** Test-only: the queue is process-wide state, so a test that fills it must be
 * able to prove it emptied again. */
export function distillQueueDepth(): { running: number; waiting: number } {
  return { running, waiting: waiting.length };
}
