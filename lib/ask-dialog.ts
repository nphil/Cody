import type { OmpAskQuestion } from "@/lib/pi-types";

/**
 * Client-side model of omp's `ask` dialog (omp >= 18.4).
 *
 * omp rejects an answer set that breaks its rules by THROWING inside the
 * dialog, which fails the agent's tool call. So the form is built so a
 * rejectable answer can never be submitted: the helpers below keep each
 * question's draft valid at every step, and `buildAskAnswers` re-checks the
 * whole set. Rules (mirrors parseAskDialogResponse in omp's rpc-mode.ts):
 *  - one answer per question, in question order, `id` = the question's id;
 *  - `selectedOptions` are option labels, no duplicates;
 *  - single-select (`multi` falsy): at most ONE of (one selected label | custom text);
 *  - multi: any labels plus optional custom text;
 *  - `customInput` is trimmed and omitted when empty;
 *  - every question needs an answer (a selection or custom text).
 */

export interface AskDraft {
  /** Selected option INDEXES (labels may repeat, indexes cannot). */
  selected: number[];
  custom: string;
}

export interface AskAnswer {
  id: string;
  selectedOptions: string[];
  customInput?: string;
}

/** Every question starts with its recommended option (an index) preselected. */
export function initialAskDrafts(questions: readonly OmpAskQuestion[]): AskDraft[] {
  return questions.map((question) => {
    const recommended = question.recommended;
    const valid = typeof recommended === "number"
      && Number.isInteger(recommended)
      && recommended >= 0
      && recommended < question.options.length;
    return { selected: valid ? [recommended] : [], custom: "" };
  });
}

/** Choose/toggle an option. Single-select replaces the choice and drops custom text. */
export function toggleAskOption(question: OmpAskQuestion, draft: AskDraft, optionIndex: number): AskDraft {
  if (!question.multi) return { selected: [optionIndex], custom: "" };
  const selected = draft.selected.includes(optionIndex)
    ? draft.selected.filter((index) => index !== optionIndex)
    : [...draft.selected, optionIndex].sort((a, b) => a - b);
  return { ...draft, selected };
}

/** Type in "Other". In single-select, real text replaces any chosen option. */
export function setAskCustom(question: OmpAskQuestion, draft: AskDraft, custom: string): AskDraft {
  if (!question.multi && custom.trim() !== "") return { selected: [], custom };
  return { ...draft, custom };
}

function selectedLabels(question: OmpAskQuestion, draft: AskDraft): string[] {
  const labels: string[] = [];
  for (const index of draft.selected) {
    const label = question.options[index]?.label;
    if (label !== undefined && !labels.includes(label)) labels.push(label);
  }
  return labels;
}

/** One question's answer, or null while it has neither a selection nor custom text. */
export function buildAskAnswer(question: OmpAskQuestion, draft: AskDraft): AskAnswer | null {
  const custom = draft.custom.trim();
  let selectedOptions = selectedLabels(question, draft);
  if (!question.multi) {
    // Single-select carries exactly one answer; custom text (the latest edit) wins.
    selectedOptions = custom !== "" ? [] : selectedOptions.slice(0, 1);
  }
  if (selectedOptions.length === 0 && custom === "") return null;
  return custom !== ""
    ? { id: question.id, selectedOptions, customInput: custom }
    : { id: question.id, selectedOptions };
}

export function isAskAnswered(question: OmpAskQuestion, draft: AskDraft): boolean {
  return buildAskAnswer(question, draft) !== null;
}

/** All answers in question order, or null while any question is unanswered. */
export function buildAskAnswers(
  questions: readonly OmpAskQuestion[],
  drafts: readonly AskDraft[],
): AskAnswer[] | null {
  const answers: AskAnswer[] = [];
  for (let index = 0; index < questions.length; index++) {
    const answer = buildAskAnswer(questions[index]!, drafts[index] ?? { selected: [], custom: "" });
    if (!answer) return null;
    answers.push(answer);
  }
  return answers;
}
