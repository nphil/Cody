import { OMP_BIN_MISSING, resolveOmpBin } from "../omp/omp-cli";
import { effectiveTimeZone } from "../time-zone-prefs";
import { isRecord } from "../type-guards";
import { ROLE_NAMES, type PlanDraft, type PlanRationale } from "./derive";
import { runOneShotModel } from "./one-shot";
import type { Roster } from "./roster";

/**
 * Ask a model to assign Cody's roles. The run itself — spawning the user's own
 * omp binary in print mode and picking the answer out of its NDJSON stream —
 * lives in ./one-shot; this module owns the planner's prompt and answer parsing.
 *
 * Every failure is a value, never an exception: an onboarding step that
 * dead-ends on a flaky model call is worse than one that proposes a defensible
 * heuristic the user can edit.
 */
export type PlannerOutcome =
  | { ok: true; draft: PlanDraft }
  | { ok: false; reason: string };

const PLANNER_TIMEOUT_MS = 120_000;

const SYSTEM_PROMPT = [
  "You assign models to the roles of a coding agent.",
  "Answer with a single JSON object and nothing else: no prose, no explanation outside the JSON, no markdown fence.",
  "Use only the model selectors given to you. Never invent, abbreviate, or reformat a selector.",
].join(" ");

// What each role actually drives. Without this, names such as smol and slow
// invite guesses that conflict with OMP's real role behavior. Exported so the
// researched-preset planner (lib/model-presets/research.ts) can reuse the same
// wording instead of re-describing OMP's roles from scratch, extending it with
// roles this planner does not assign (e.g. memory).
export const ROLE_BRIEF_LINES: Record<string, string> = {
  default: "default - the main session: every ordinary user-driven turn.",
  task: "task - general-purpose subagents doing balanced, multi-step delegated work; do not spend the frontier model by default.",
  smol: "smol - deliberately mechanical subagents: bulk edits, data collection, and low-judgement work.",
  tiny: "tiny - constant small background work: titles, classifiers, and extractions.",
  plan: "plan - planning and design turns, where deliberate reasoning pays off.",
  slow: "slow - the deliberate role for the hardest problems; quality over latency.",
  vision: "vision - anything with images attached; the model must accept image input.",
  commit: "commit - short, formulaic commit messages at high volume.",
  advisor: "advisor - OMP's rigorous second-opinion reviewer, not a cheapest background classifier.",
};
const ROLE_BRIEF = Object.values(ROLE_BRIEF_LINES).join("\n");

function buildUserPrompt(roster: Roster): string {
  return [
    "Assign models to roles for this installation.",
    "",
    "Available models and providers (JSON):",
    JSON.stringify(roster),
    "",
    "`local: true` means the endpoint is actually on a loopback or private-network address. A free or zero-priced remote model is not local.",
    [
      "`rolePriority.smol` and `rolePriority.slow` are zero-based OMP native suitability ranks; lower is preferred.",
      "They are based only on exact selectors or exact bare ids.",
    ].join(" "),
    "",
    "The roles:",
    ROLE_BRIEF,
    "",
    "Answer with exactly this JSON shape:",
    '{"roles":{"<role>":"<selector>"},"ladder":["<provider id>"],"rationale":[{"subject":"<role or topic>","text":"<one short sentence>"}]}',
    "",
    `Rules. Role names must come from this list: ${ROLE_NAMES.join(", ")}. Omit a role only when no available model can satisfy its required image input.`,
    [
      "Use a native-smol or otherwise lightweight model for smol, tiny, and commit whenever one is available.",
      "Use a native-slow model for slow, plan, and advisor whenever one is available.",
      "Reasoning is a preference, not a reason to leave a chat-only roster unusable.",
    ].join(" "),
    [
      "Vision must use vision: true, and any image-capable source must keep image-capable fallbacks.",
      "Task should be a balanced multi-step choice rather than the frontier by default.",
    ].join(" "),
    [
      "Provider policy is fixed: openai-codex and anthropic subscriptions first, then other direct APIs.",
      "Then use gateways such as OpenRouter, then local runtimes.",
      "Keep both subscriptions eligible regardless of their ladder order.",
      "Do not infer live quota or quality from names, context length, or catalog price; price is only weak within-provider tier evidence.",
    ].join(" "),
    [
      "Include every available provider id in ladder.",
      "Cody validates provider tiers, fills omitted providers, and derives exact model, role, and wildcard fallback chains.",
      "Never silently exclude an enabled provider.",
    ].join(" "),
    "rationale explains assignments honestly in one short sentence per entry; never call an unknown-price model lightest or strongest.",
  ].join("\n");
}

/**
 * Return the outermost balanced `{...}`. The scanner handles a code fence or
 * extra prose and ignores braces inside strings. Exported so other one-shot
 * JSON planners (lib/model-presets/research.ts) parse a model's answer the
 * same defensive way instead of duplicating the scanner.
 */
export function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }

    if (character === '"') inString = true;
    else if (character === "{") depth += 1;
    else if (character === "}" && (depth -= 1) === 0) return text.slice(start, index + 1);
  }

  return null;
}

function readDraft(raw: unknown): PlanDraft | null {
  if (!isRecord(raw) || !isRecord(raw.roles)) return null;

  const roles = Object.fromEntries(
    Object.entries(raw.roles).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim().length > 0,
    ),
  );
  if (Object.keys(roles).length === 0) return null;

  const ladder = Array.isArray(raw.ladder)
    ? raw.ladder.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
    : [];
  const rationale = Array.isArray(raw.rationale)
    ? raw.rationale.flatMap((entry): PlanRationale[] => (
      isRecord(entry) && typeof entry.subject === "string" && typeof entry.text === "string"
        ? [{ subject: entry.subject, text: entry.text }]
        : []
    ))
    : [];

  return { roles, ladder, rationale };
}

/** Plan with a model. `model` is a roster selector; the caller picks it. */
export async function planWithModel(model: string, roster: Roster): Promise<PlannerOutcome> {
  const bin = resolveOmpBin();
  if (!bin) return { ok: false, reason: OMP_BIN_MISSING };

  const answer = await runOneShotModel({
    bin,
    model,
    systemPrompt: SYSTEM_PROMPT,
    prompt: buildUserPrompt(roster),
    timeoutMs: PLANNER_TIMEOUT_MS,
    timeZone: effectiveTimeZone(null).zone,
  });
  if (!answer.text) return { ok: false, reason: answer.error ?? "the planner returned no answer" };

  const json = extractJsonObject(answer.text);
  if (!json) return { ok: false, reason: "the planner did not answer with JSON" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    return {
      ok: false,
      reason: `the planner's JSON could not be parsed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const draft = readDraft(parsed);
  if (!draft) return { ok: false, reason: "the planner assigned no roles" };
  return { ok: true, draft };
}
