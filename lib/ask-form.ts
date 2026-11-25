import {
  type ChoiceField,
  type FormField,
  type HtmlForm,
  type TextField,
  parseHtmlForm,
  spansText,
} from "./ask-form-parse";

/**
 * Answers of a parsed `ask` form (omp >= 19.1). Mirrors `pi-tui/src/html-form/data.ts` and the validation in omp's
 * `rpc-mode.ts` (`parseFormDialogResponse`): omp 19.1 THROWS on any submitted data that does not fit the form it
 * parsed, which fails the agent's tool call; omp 19.2 still throws on a wrong shape but only flags a broken field
 * rule. So the form view builds data with `choiceValue`/`textValue`, checks every field with `fieldError`, and
 * re-checks the whole payload with `formDataError` before it is sent (`enforceRules` = the engine blocks on rules).
 */

export { parseHtmlForm };

/** Submitted value of one control: text, a number for `number`/`range` inputs, or a group's checked values. */
export type HtmlFormValue = string | number | string[];

/** Submitted form data by control `name`. Radios, single checkboxes and single selects give one value (omitted when nothing is chosen); checkbox groups and multi-selects give an array; text fields give their text. */
export type HtmlFormData = Record<string, HtmlFormValue>;

/** Label of the free-text answer the UI adds to radio and checkbox groups (`ChoiceField.other`). */
export const OTHER_LABEL = "Other";

/** Whether a choice field reports an array (checkbox group, multi-select) rather than one value. */
export function isArrayChoice(field: ChoiceField): boolean {
  return field.multi && field.options.length > 1;
}

/**
 * Value a choice field contributes given its checked option indices and, when the user chose "Other", that
 * answer's text: it stands in for a radio's value or joins a checkbox group's array. Undefined when the field
 * contributes nothing; blank Other text counts as no answer.
 */
export function choiceValue(field: ChoiceField, checked: ReadonlySet<number>, other?: string): HtmlFormValue | undefined {
  const typed = field.other ? other?.trim() : undefined;
  const values = field.options.flatMap((option, index) => (checked.has(index) && !option.disabled ? [option.value] : []));
  if (isArrayChoice(field)) return typed ? [...values, typed] : values;
  return typed || values[0];
}

/** Value a text field contributes: a number for non-empty numeric `number`/`range` inputs, else the text. */
export function textValue(field: TextField, text: string): HtmlFormValue {
  if ((field.type === "number" || field.type === "range") && text.trim() !== "") {
    const number = Number(text);
    if (Number.isFinite(number)) return number;
  }
  return text;
}

function canParseUrl(text: string): boolean {
  try {
    new URL(text);
    return true;
  } catch {
    return false;
  }
}

/** Whether this runtime has the `v` flag omp compiles patterns with (Chrome 112+, Safari 17+, Node 20+). */
const SUPPORTS_V_FLAG = (() => {
  try {
    new RegExp("a", "v");
    return true;
  } catch {
    return false;
  }
})();

/**
 * `^(?:pattern)$` as omp compiles it (`v` flag), or undefined when the model wrote a pattern that is invalid under
 * that flag: omp ignores such a pattern (a lone trailing `-` in a class is one), so Cody must too, or it would block
 * an answer omp accepts. Only a runtime without the `v` flag falls back to `u`.
 */
function compilePattern(pattern: string): RegExp | undefined {
  try {
    return new RegExp(`^(?:${pattern})$`, SUPPORTS_V_FLAG ? "v" : "u");
  } catch {
    return undefined;
  }
}

/** Why a value does not fit its field; `problemText` words it the way omp does, the form view words it in the user's language. */
export type FieldProblem =
  | { kind: "required" }
  | { kind: "selectOne" }
  | { kind: "number" }
  | { kind: "min"; limit: number }
  | { kind: "max"; limit: number }
  | { kind: "minLength"; limit: number }
  | { kind: "maxLength"; limit: number }
  | { kind: "email" }
  | { kind: "url" }
  | { kind: "pattern"; pattern: string };

/** omp's own wording of a problem (it does not localise them); the form's rejection text carries it. */
export function problemText(problem: FieldProblem): string {
  switch (problem.kind) {
    case "required": return "Required";
    case "selectOne": return "Select at least one";
    case "number": return "Enter a number";
    case "min": return `Must be at least ${problem.limit}`;
    case "max": return `Must be at most ${problem.limit}`;
    case "minLength": return `Needs at least ${problem.limit} characters`;
    case "maxLength": return `At most ${problem.limit} characters`;
    case "email": return "Enter an email address";
    case "url": return "Enter a full URL";
    case "pattern": return `Must match ${problem.pattern.length > 40 ? `${problem.pattern.slice(0, 39)}\u2026` : problem.pattern}`;
  }
}

/**
 * Why `value` is not an acceptable answer for `field`, or undefined when it is. Enforces `required`, numeric
 * `min`/`max`, `minlength`/`maxlength`, `email` and `url` shapes and `pattern` (anchored; an invalid pattern is
 * ignored), exactly as omp does on submit.
 */
export function fieldProblem(field: FormField, value: HtmlFormValue | undefined): FieldProblem | undefined {
  if (field.kind === "choice") {
    const empty = value === undefined || (Array.isArray(value) && value.length === 0);
    if (!field.required || !empty) return undefined;
    return { kind: isArrayChoice(field) ? "selectOne" : "required" };
  }
  const text = value === undefined ? "" : String(value);
  if (text.trim() === "") return field.required ? { kind: "required" } : undefined;
  if (field.type === "number" || field.type === "range") {
    const number = Number(text);
    if (!Number.isFinite(number)) return { kind: "number" };
    if (field.min !== undefined && number < field.min) return { kind: "min", limit: field.min };
    if (field.max !== undefined && number > field.max) return { kind: "max", limit: field.max };
  }
  if (field.minLength !== undefined && text.length < field.minLength) return { kind: "minLength", limit: field.minLength };
  if (field.maxLength !== undefined && text.length > field.maxLength) return { kind: "maxLength", limit: field.maxLength };
  if (field.type === "email" && !/^[^\s@]+@[^\s@]+$/.test(text)) return { kind: "email" };
  if (field.type === "url" && !canParseUrl(text)) return { kind: "url" };
  if (field.pattern && compilePattern(field.pattern)?.test(text) === false) return { kind: "pattern", pattern: field.pattern };
  return undefined;
}

/** {@link fieldProblem} in omp's wording; undefined when the value fits. */
export function fieldError(field: FormField, value: HtmlFormValue | undefined): string | undefined {
  const problem = fieldProblem(field, value);
  return problem ? problemText(problem) : undefined;
}

/** Data the form submits untouched: hidden inputs, preselected options and prefilled text. */
export function defaultFormData(form: HtmlForm): HtmlFormData {
  // A null prototype keeps a control named `__proto__` an ordinary key instead of hitting the inherited setter.
  const data: HtmlFormData = Object.create(null);
  for (const [name, value] of form.hidden) data[name] = value;
  for (const field of form.fields) {
    if (!field.name) continue;
    const value =
      field.kind === "text"
        ? textValue(field, field.value)
        : choiceValue(field, new Set(field.options.flatMap((option, index) => (option.checked ? [index] : []))));
    if (value !== undefined) data[field.name] = value;
  }
  return data;
}

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * The question each field answers: its own label, else the text block right before it (`<p>Which database?</p>`
 * above a radio group), else its section title, else a lone option's label (a single checkbox), else its name.
 */
export function fieldQuestions(form: HtmlForm): Map<FormField, string> {
  const questions = new Map<FormField, string>();
  for (const section of form.sections) {
    const title = spansText(section.title);
    let caption = "";
    for (const block of section.blocks) {
      if (block.kind === "field") {
        const field = block.field;
        const own = spansText(field.label);
        const lone = field.kind === "choice" && field.options.length === 1 ? spansText(field.options[0]!.label) : "";
        questions.set(field, oneLine(own || caption || title || lone || field.name));
        caption = "";
        continue;
      }
      caption = block.kind === "text" ? spansText(block.spans) : "";
    }
  }
  return questions;
}

// ---- the engine's acceptance rules (rpc-mode.ts `parseFormDialogResponse`) ----------------------------------------

/** Value a choice field's submitted entry gives: each string must be an enabled option value, except one free-text "Other" entry. */
function parseFormChoice(field: ChoiceField, value: unknown): HtmlFormValue | undefined {
  const label = JSON.stringify(field.name);
  if (value === undefined) return choiceValue(field, new Set());
  const array = isArrayChoice(field);
  const shape = array ? "an array of strings" : "one string, not an array";
  if (array !== Array.isArray(value)) throw new Error(`Form field ${label} must carry ${shape}`);
  const entries: unknown[] = array ? (value as unknown[]) : [value];
  const checked = new Set<number>();
  let other: string | undefined;
  for (const entry of entries) {
    if (typeof entry !== "string") throw new Error(`Form field ${label} must carry ${shape}`);
    const enabled = field.options.findIndex((option) => !option.disabled && option.value === entry);
    const index = enabled >= 0 ? enabled : field.options.findIndex((option) => option.value === entry);
    if (index >= 0 && field.options[index]!.disabled) {
      throw new Error(`Form field ${label} carries disabled option ${JSON.stringify(entry)}`);
    }
    if (index >= 0 && !checked.has(index)) checked.add(index);
    else if (index < 0 && field.other && other === undefined) other = entry;
    else throw new Error(`Form field ${label} carries unexpected value ${JSON.stringify(entry)}`);
  }
  return choiceValue(field, checked, other);
}

function parseChoiceOrHiddenFallback(field: ChoiceField, value: unknown, hiddenValue: string | undefined): HtmlFormValue | undefined {
  if (hiddenValue === undefined) return parseFormChoice(field, value);
  const echo = Array.isArray(value) ? value.indexOf(hiddenValue) : value === hiddenValue ? 0 : -1;
  if (echo < 0) return parseFormChoice(field, value);
  const withoutEcho = Array.isArray(value) ? value.filter((_, index) => index !== echo) : undefined;
  if (Array.isArray(value) && !field.options.some((option) => option.value === hiddenValue)) return parseFormChoice(field, withoutEcho);
  try {
    return parseFormChoice(field, value);
  } catch {
    return parseFormChoice(field, withoutEcho);
  }
}

function parseFormText(field: TextField, value: unknown): HtmlFormValue {
  if (value === undefined) return textValue(field, "");
  const numeric = field.type === "number" || field.type === "range";
  if (typeof value === "string" || (numeric && typeof value === "number" && Number.isFinite(value))) return textValue(field, String(value));
  throw new Error(`Form field ${JSON.stringify(field.name)} must carry a string${numeric ? " or a number" : ""}`);
}

/**
 * The data omp would hand the model for `submitted`, or the error omp would fail the tool call with. Same checks
 * as omp's `parseFormDialogResponse`: unknown names, wrong shapes, disabled/unknown option values, and (with
 * `enforceRules`, omp 19.1 and earlier) every field's `fieldError`. omp 19.2 flags a broken `required` / `pattern` /
 * `min` / `max` in its own form but sends the answer on, so callers on 19.2+ pass `false`. Hidden inputs keep the
 * form's own values.
 */
export function parseFormSubmission(form: HtmlForm, submitted: unknown, enforceRules = true): { data: HtmlFormData } | { error: string } {
  try {
    if (typeof submitted !== "object" || submitted === null || Array.isArray(submitted)) {
      throw new Error("Form dialog response must carry a data object");
    }
    const record = submitted as Record<string, unknown>;
    const named = form.fields.filter((field) => field.name);
    const names = new Set([...named.map((field) => field.name), ...form.hidden.map(([name]) => name)]);
    for (const name of Object.keys(record)) {
      if (!names.has(name)) throw new Error(`Form dialog data carries unknown field ${JSON.stringify(name)}`);
    }
    const data: HtmlFormData = Object.assign(Object.create(null), Object.fromEntries(form.hidden));
    const hidden = new Map(form.hidden);
    const byName = new Map<string, FormField[]>();
    for (const field of named) byName.set(field.name, [...(byName.get(field.name) ?? []), field]);
    for (const [name, fields] of byName) {
      const entry = Object.hasOwn(record, name) ? record[name] : undefined;
      const hiddenValue = hidden.get(name);
      let mismatch: unknown;
      const values = fields.map((field) => {
        try {
          const value = field.kind === "choice" ? parseChoiceOrHiddenFallback(field, entry, hiddenValue) : parseFormText(field, entry);
          return { field, value, carried: true };
        } catch (error) {
          if (fields.length === 1) throw error;
          mismatch ??= error;
          const value = field.kind === "choice" ? parseFormChoice(field, undefined) : parseFormText(field, undefined);
          return { field, value, carried: false };
        }
      });
      if (!values.some(({ carried }) => carried)) throw mismatch;
      for (const { field, value, carried } of values) {
        const problem = enforceRules ? fieldError(field, value) : undefined;
        if (problem) throw new Error(`Form field ${JSON.stringify(name)}: ${problem}`);
        if (carried && value !== undefined) data[name] = value;
      }
    }
    return { data };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** True when `data` (what the view built) would be accepted as submitted. */
export function formDataError(form: HtmlForm, data: HtmlFormData, enforceRules = true): string | undefined {
  const parsed = parseFormSubmission(form, data, enforceRules);
  return "error" in parsed ? parsed.error : undefined;
}

export interface FormAnswer {
  name: string;
  question: string;
  answer: string;
}

function answerText(field: FormField, value: HtmlFormValue | undefined): string {
  if (value === undefined) return "";
  if (field.kind === "text") return String(value);
  const labelOf = (raw: string): string => {
    const option = field.options.find((candidate) => candidate.value === raw);
    if (option) return oneLine(spansText(option.label)) || raw;
    return field.other ? `${OTHER_LABEL}: ${raw}` : raw;
  };
  return Array.isArray(value) ? value.map(labelOf).join(", ") : labelOf(String(value));
}

/** Answers of every named field, in form order, with option values shown as their labels (omp's `details.answers`). */
export function formAnswers(form: HtmlForm, data: HtmlFormData): FormAnswer[] {
  const questions = fieldQuestions(form);
  const answers: FormAnswer[] = [];
  for (const field of form.fields) {
    if (!field.name) continue;
    answers.push({ name: field.name, question: questions.get(field) ?? field.name, answer: answerText(field, data[field.name]) });
  }
  return answers;
}
