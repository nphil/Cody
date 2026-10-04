import type { EngineEvent, EngineSession } from "../harness/types";
import { readPermissionOptions } from "../permission-request";
import { isRecord } from "../type-guards";
import { askQuestions, permissionDigest, strings, uiRequestDigest } from "./compose";
import { recipientForSession } from "./recipients";
import { isConfigured } from "./store";
import { claimAnswerToken, releaseAnswerToken, verifyAnswerToken, type AnswerTokenPayload } from "./tokens";

/**
 * What happens when a phone taps an answer button.
 *
 * The request that arrives has no cookie and no login — only a token — so every
 * way it could be wrong is checked here, in this order, and anything but a
 * clean pass answers nothing:
 *
 *  1. The token is genuine, unexpired and has not been used (401).
 *  2. The person it was issued to is still entitled to this chat, still has
 *     notifications and answer buttons switched on (403). Turning buttons off,
 *     or handing the chat to another account, therefore kills every button
 *     already on a phone.
 *  3. The session is alive and the request is still waiting (410) — and is
 *     still the SAME request: ids can repeat after a restart, so the token's
 *     digest must match what is pending now.
 *  4. The answer is still one the request offers (410): a select option that is
 *     gone, a permission option that is not a one-shot choice.
 *
 * Only then is the same command the browser would send handed to the session.
 * The token is spent before anything is awaited, so two taps cannot both get
 * through; it is handed back only when the answer never reached the session
 * (it was restarting), so the person can tap again.
 */

export interface AnswerOutcome {
  status: 200 | 401 | 403 | 410 | 502 | 503;
  body: { ok: true } | { error: string; code: "invalid_token" | "forbidden" | "gone" | "session_restarting" | "answer_failed" };
}

export interface AnswerDeps {
  getSession: (sessionId: string) => EngineSession | undefined;
  now?: () => number;
}

function refuse(status: Exclude<AnswerOutcome["status"], 200>, code: Extract<AnswerOutcome["body"], { code: string }>["code"], error: string): AnswerOutcome {
  return { status, body: { error, code } };
}

const GONE = refuse(410, "gone", "That request is no longer waiting for an answer.");

/**
 * The answer, rebuilt from what the request offers right now rather than
 * copied from the token: a field the request does not understand is never
 * forwarded, and an option that has gone is no answer at all.
 */
function cleanUiAnswer(pending: EngineEvent, answer: Record<string, unknown>): Record<string, unknown> | null {
  switch (pending.method) {
    case "confirm":
      return typeof answer.confirmed === "boolean" ? { confirmed: answer.confirmed } : null;
    case "select":
      return typeof answer.value === "string" && strings(pending.options).includes(answer.value) ? { value: answer.value } : null;
    case "ask": {
      const given = answer.answers;
      if (!Array.isArray(given) || given.length !== 1 || !Array.isArray(pending.questions) || pending.questions.length !== 1) return null;
      const entry: unknown = given[0];
      const [question] = askQuestions(pending);
      if (!question || question.multi || !isRecord(entry) || entry.id !== question.id) return null;
      const chosen = entry.selectedOptions;
      if (!Array.isArray(chosen) || chosen.length !== 1 || typeof chosen[0] !== "string" || !question.options.includes(chosen[0])) return null;
      return { answers: [{ id: question.id, selectedOptions: [chosen[0]] }] };
    }
    default:
      return null;
  }
}

/** The command to send, or null when the request is gone, has changed, or no longer offers this answer. */
function buildCommand(session: EngineSession, payload: AnswerTokenPayload): Record<string, unknown> | null {
  if (payload.k === "permission") {
    const pending = session.getPendingPermission?.(payload.rid);
    if (!pending || permissionDigest(pending.toolCall, pending.options) !== payload.d) return null;
    const option = readPermissionOptions(pending.options).find((candidate) => candidate.optionId === payload.a.optionId);
    // A phone tap only ever grants or refuses ONE call. An "always" option is
    // never answerable from here, whatever a token claims.
    if (!option || (option.kind !== "allow_once" && option.kind !== "reject_once")) return null;
    return { type: "respond_permission", requestId: payload.rid, optionId: option.optionId };
  }
  const pending = session.getPendingUiRequest?.(payload.rid);
  if (!pending || uiRequestDigest(pending) !== payload.d) return null;
  const answer = cleanUiAnswer(pending, payload.a);
  return answer ? { type: "extension_ui_response", id: payload.rid, ...answer } : null;
}

function errorCode(error: unknown): string | null {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : null;
}

/** Verify `token` and, if it is good for something that is still waiting, answer it. Never throws. */
export async function answerFromToken(token: unknown, deps: AnswerDeps): Promise<AnswerOutcome> {
  const now = (deps.now ?? Date.now)();
  const verdict = verifyAnswerToken(token, now);
  if (!verdict.ok) {
    return refuse(401, "invalid_token", verdict.reason === "expired" ? "This button has expired." : "This button is not valid.");
  }
  const { payload } = verdict;
  if (!claimAnswerToken(payload, now)) return refuse(401, "invalid_token", "This button was already used.");

  try {
    const recipient = recipientForSession(payload.sid, payload.u);
    if (!recipient || !isConfigured(recipient.prefs) || !recipient.prefs.answerButtons) {
      return refuse(403, "forbidden", "This button no longer works for this chat.");
    }
    const session = deps.getSession(payload.sid);
    if (!session || !session.isAlive()) return GONE;
    const command = buildCommand(session, payload);
    if (!command) return GONE;

    let result: unknown;
    try {
      result = await session.send(command);
    } catch (error) {
      const code = errorCode(error);
      if (code === "session_dead") return GONE;
      // It never reached the session: the person may try again.
      releaseAnswerToken(payload);
      return code === "session_restarting"
        ? refuse(503, "session_restarting", "The chat is restarting. Try again in a moment.")
        : refuse(502, "answer_failed", "The answer could not be delivered.");
    }
    // ACP says so when the approval was settled in between.
    if (payload.k === "permission" && isRecord(result) && result.answered === false) return GONE;

    // The observer takes the notification down on every device: answering
    // settles the request in-process (cody_ui_request_resolved /
    // permission_resolved), so no second clear is needed from here.
    return { status: 200, body: { ok: true } };
  } catch {
    releaseAnswerToken(payload);
    return refuse(502, "answer_failed", "The answer could not be delivered.");
  }
}
