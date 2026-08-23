import { resolveOmpBin } from "../omp/omp-cli";
import { isRecord } from "../type-guards";
import { ROLE_NAMES, type PlanDraft, type PlanRationale } from "./derive";
import { runOneShotModel } from "./one-shot";
import type { Roster } from "./roster";

/**
 * Ask a model to assign Cody's roles. The run itself — spawning the user's own
 * omp binary in print mode and picking the answer out of its NDJSON stream —
 * lives in ./one-shot; this module owns the planner's prompt and the parsing of
 * what comes back.
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
    "`ladder` is provider ids ordered best first: how quality should degrade when a provider is exhausted. Direct providers the user pays for or is signed in to come first, gateway aggregators that resell other vendors' models (OpenRouter and its kind) after them as the backup route, and local providers last.",
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

  const answer = await runOneShotModel({
    bin,
    model,
    systemPrompt: SYSTEM_PROMPT,
    prompt: buildUserPrompt(roster),
    timeoutMs: PLANNER_TIMEOUT_MS,
  });
  if (!answer.text) return { ok: false, reason: answer.error ?? "the planner returned no answer" };

  const json = extractJsonObject(answer.text);
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
}
