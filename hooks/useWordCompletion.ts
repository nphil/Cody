"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { sendAgentCommand } from "@/lib/agent-client";
import { isUnsupportedCommandError } from "@/lib/subagent-types";
import {
  WORD_COMPLETION_DELAY_MS,
  acceptSuggestion,
  isSuggestionCurrent,
  readSuffix,
  shouldRequestWordSuggestion,
  type WordSuggestion,
} from "@/lib/word-completion";

/** After an engine error that is not "unsupported" (a cold or crashed
 * prediction daemon), stay quiet this long instead of retrying per keystroke. */
const ERROR_COOLDOWN_MS = 30_000;

// An older omp (`Unknown command: predict_word`) or a non-omp engine will not
// learn the command mid-page, so one refusal turns the feature off until the
// page reloads — silently; nothing in the composer ever said it was there.
let unsupportedForPage = false;

interface Options {
  sessionId: string | null | undefined;
  /** Everything the caller knows that rules completion out: wrong engine,
   * touch device, IME composition, an open slash/@/history menu, bash mode. */
  enabled: boolean;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  /** The composer text. Changing it is what dismisses a suggestion and
   * schedules the next request. */
  value: string;
  /** The collapsed caret offset, or -1 while a range is selected. Changing it
   * dismisses a suggestion the same way. */
  caret: number;
}

/**
 * Ghost-text word completion for the composer. Asks the live session
 * (`predict_word`) once typing pauses, keeps at most one suggestion, and drops
 * it the moment the composer no longer matches what was asked about.
 */
export function useWordCompletion({ sessionId, enabled, textareaRef, value, caret }: Options) {
  const [suggestion, setSuggestion] = useState<WordSuggestion | null>(null);
  // The overlay measures whether the ghost fits on its line; one that would
  // be clipped is never accepted, because the user could not see what Tab did.
  const [fitting, setFitting] = useState<WordSuggestion | null>(null);
  const requestSeqRef = useRef(0);
  const quietUntilRef = useRef(0);
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  // Any change of text, caret or eligibility invalidates what is showing and
  // what is in flight. The new request waits out the pause.
  useEffect(() => {
    requestSeqRef.current += 1;
    const seq = requestSeqRef.current;
    setSuggestion(null);
    setFitting(null);
    const id = sessionIdRef.current;
    if (!enabled || !id || unsupportedForPage) return;
    const timer = setTimeout(() => {
      const ta = textareaRef.current;
      if (!ta || Date.now() < quietUntilRef.current) return;
      const { value: text, selectionStart: cursor, selectionEnd } = ta;
      if (cursor !== selectionEnd || document.activeElement !== ta) return;
      if (!shouldRequestWordSuggestion(text, cursor)) return;
      sendAgentCommand<{ suffix?: string | null }>(id, { type: "predict_word", text, cursor })
        .then((data) => {
          if (seq !== requestSeqRef.current) return;
          const suffix = readSuffix(data);
          const now = textareaRef.current;
          if (!suffix || !now) return;
          const next: WordSuggestion = { text, cursor, suffix };
          if (!isSuggestionCurrent(next, now.value, now.selectionStart, now.selectionEnd)) return;
          setSuggestion(next);
        })
        .catch((error: unknown) => {
          if (isUnsupportedCommandError(error)) unsupportedForPage = true;
          else quietUntilRef.current = Date.now() + ERROR_COOLDOWN_MS;
        });
    }, WORD_COMPLETION_DELAY_MS);
    return () => clearTimeout(timer);
  }, [enabled, value, caret, textareaRef]);

  const shown = suggestion && fitting === suggestion ? suggestion : null;

  const sendFeedback = useCallback((given: WordSuggestion, accepted: boolean) => {
    const id = sessionIdRef.current;
    if (!id || unsupportedForPage) return;
    sendAgentCommand(id, {
      type: "predict_word_feedback",
      text: given.text,
      cursor: given.cursor,
      suggestion: given.suffix,
      accepted,
    }).catch(() => {
      // Feedback only teaches the engine; losing it changes nothing visible.
    });
  }, []);

  /** Accept the showing suggestion. Returns the inserted text and the new
   * caret, or null when nothing is showing / the composer has moved on. */
  const accept = useCallback((withSpace: boolean) => {
    const ta = textareaRef.current;
    if (!shown || !ta || !isSuggestionCurrent(shown, ta.value, ta.selectionStart, ta.selectionEnd)) return null;
    sendFeedback(shown, true);
    requestSeqRef.current += 1;
    setSuggestion(null);
    return acceptSuggestion(shown, withSpace);
  }, [shown, textareaRef, sendFeedback]);

  /** The user said no (Escape). Typing past a suggestion is not a verdict on
   * it, so only this path reports `accepted: false`. */
  const reject = useCallback(() => {
    if (!shown) return;
    sendFeedback(shown, false);
    requestSeqRef.current += 1;
    setSuggestion(null);
  }, [shown, sendFeedback]);

  /** Silent dismissal (blur). */
  const clear = useCallback(() => {
    requestSeqRef.current += 1;
    setSuggestion(null);
  }, []);

  return { suggestion, shown, accept, reject, clear, reportFit: setFitting };
}
