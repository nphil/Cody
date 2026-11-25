import {
  type FieldProblem,
  type HtmlFormData,
  type HtmlFormValue,
  choiceValue,
  fieldProblem,
  fieldQuestions,
  formDataError,
  parseHtmlForm,
  textValue,
} from "./ask-form";
import { type ChoiceField, type FormField, type FormSpan, type HtmlForm, spansText } from "./ask-form-parse";
import { resolveLocalFileHref } from "./file-links";
import { encodeFilePathForApi } from "./file-paths";

/**
 * What the browser's view of omp 19.1's `ask` form keeps between renders, and the data it sends back. Pure: the
 * React view (components/AskHtmlForm.tsx) only draws these, so the rules are tested without a browser.
 */

/** A radio / checkbox group or select: the ticked option indices, plus the "Other" answer typed behind it. */
export interface ChoiceDraft {
  kind: "choice";
  checked: readonly number[];
  other: string;
}

export interface TextDraft {
  kind: "text";
  text: string;
}

export type FieldDraft = ChoiceDraft | TextDraft;

/** The one form omp is asking about, parsed once: the dock header and the view both read it. */
let lastParsed: { html: string; form: HtmlForm } | undefined;
export function parseFormCached(html: string): HtmlForm {
  if (lastParsed?.html !== html) lastParsed = { html, form: parseHtmlForm(html) };
  return lastParsed.form;
}

/** Where every field starts: the options and text the form's HTML preselected (disabled options never count). */
export function initialDrafts(form: HtmlForm): FieldDraft[] {
  return form.fields.map((field): FieldDraft => {
    if (field.kind === "text") return { kind: "text", text: field.value };
    const preselected = field.options.flatMap((option, index) => (option.checked && !option.disabled ? [index] : []));
    return { kind: "choice", checked: field.multi ? preselected : preselected.slice(0, 1), other: "" };
  });
}

/** A tap on option `index`: a radio / select takes it (and drops the typed Other answer), a checkbox flips it. */
export function pickOption(field: ChoiceField, draft: ChoiceDraft, index: number): ChoiceDraft {
  if (field.options[index]?.disabled !== false) return draft;
  if (!field.multi) return { ...draft, checked: [index], other: "" };
  const checked = draft.checked.includes(index) ? draft.checked.filter((entry) => entry !== index) : [...draft.checked, index].sort((a, b) => a - b);
  return { ...draft, checked };
}

/** Typing an Other answer: a radio's pick gives way to it (a blank answer leaves the pick alone); a checkbox group keeps both. */
export function typeOther(field: ChoiceField, draft: ChoiceDraft, other: string): ChoiceDraft {
  return { ...draft, other, checked: !field.multi && other.trim() !== "" ? [] : draft.checked };
}

/** What `draft` contributes to the answer, exactly as omp builds it from the same choices. */
export function draftValue(field: FormField, draft: FieldDraft | undefined): HtmlFormValue | undefined {
  if (!draft) return undefined;
  if (field.kind === "text") return draft.kind === "text" ? textValue(field, draft.text) : undefined;
  return draft.kind === "choice" ? choiceValue(field, new Set(draft.checked), draft.other) : undefined;
}

const isBlank = (value: HtmlFormValue) => value === "" || (Array.isArray(value) && value.length === 0);

/**
 * The `data` of the reply: one entry per named field. A choice nobody made is left out (omp reads that as nothing
 * ticked); hidden inputs are left to omp, which fills them in itself.
 */
export function buildFormData(form: HtmlForm, drafts: readonly FieldDraft[]): HtmlFormData {
  const data: HtmlFormData = Object.create(null);
  form.fields.forEach((field, index) => {
    if (!field.name) return;
    const value = draftValue(field, drafts[index]);
    if (value === undefined) return;
    // Two controls under one name: a later empty one must not wipe an earlier answer.
    if (Object.hasOwn(data, field.name) && isBlank(value)) return;
    data[field.name] = value;
  });
  return data;
}

/** The problem of every field (undefined = fine; a field with no name is never sent, so never wrong). */
export function fieldProblems(form: HtmlForm, drafts: readonly FieldDraft[]): (FieldProblem | undefined)[] {
  return form.fields.map((field, index) => (field.name ? fieldProblem(field, draftValue(field, drafts[index])) : undefined));
}

/** Whether omp would take what the view would send now, and if not why (omp's own words). `enforceRules`: the engine refuses a broken field rule (omp 19.1 and earlier). */
export function submitError(form: HtmlForm, drafts: readonly FieldDraft[], enforceRules = true): string | undefined {
  return formDataError(form, buildFormData(form, drafts), enforceRules);
}

const clip = (text: string, length: number) => (text.length > length ? `${text.slice(0, length - 1).trimEnd()}\u2026` : text);
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * One line for the dock header: the form's own heading, else its first fieldset title or first paragraph, else the
 * question of its first field. The dock clamps it to two lines.
 */
export function formHeadline(form: HtmlForm): string {
  const blocks = form.sections.flatMap((section) => section.blocks);
  const heading = blocks.find((block) => block.kind === "text" && block.heading && spansText(block.spans).trim() !== "");
  if (heading?.kind === "text") return clip(oneLine(spansText(heading.spans)), 200);
  const titled = form.sections.find((section) => section.fieldset && spansText(section.title).trim() !== "");
  if (titled) return clip(oneLine(spansText(titled.title)), 200);
  const text = blocks.find((block) => block.kind === "text" && spansText(block.spans).trim() !== "");
  if (text?.kind === "text") return clip(oneLine(spansText(text.spans)), 200);
  const first = form.fields.find((field) => field.name);
  return first ? clip(fieldQuestions(form).get(first) ?? first.name, 200) : "";
}

/** One question with a handful of option buttons, the only shape a notification can answer without opening the chat. */
export interface SimpleChoice {
  name: string;
  question: string;
  options: { value: string; label: string }[];
}

/**
 * The form's only field when it is a single-pick choice (a radio group or a select) and nothing else on the form
 * takes an answer, else null. Each listed option is checked against the same rules omp applies, so a button
 * offered here is always an answer omp accepts.
 */
export function simpleChoice(form: HtmlForm): SimpleChoice | null {
  const named = form.fields.filter((field) => field.name);
  const [field] = named;
  if (named.length !== 1 || form.fields.length !== 1 || field?.kind !== "choice" || field.multi) return null;
  const options = field.options.flatMap((option) => {
    if (option.disabled) return [];
    return formDataError(form, { [field.name]: option.value }) === undefined ? [{ value: option.value, label: oneLine(spansText(option.label)) || option.value }] : [];
  });
  if (options.length < 2) return null;
  return { name: field.name, question: oneLine(fieldQuestions(form).get(field) ?? field.name), options };
}

/**
 * The URL the browser loads for an `<img src>` of the form: http(s) and `data:image/...` as written, a `file:` URL or
 * absolute path through Cody's file route (it serves the machine omp runs on). Anything else (scripts, blobs, a
 * relative path with no folder to resolve against) is not shown.
 */
export function formImageUrl(src: string): string | null {
  const text = src.trim();
  if (/^https?:\/\//i.test(text) || /^data:image\//i.test(text)) return text;
  const path = resolveLocalFileHref(text);
  return path ? `/api/files/${encodeFilePathForApi(path)}?type=read` : null;
}

/** A `data:` URL for an inline `<svg>`: as an image it cannot run scripts or load anything, and it keeps working in the lightbox. */
export function svgDataUrl(markup: string): string {
  let svg = markup.trim();
  if (!/^<svg[^>]*\sxmlns\s*=/i.test(svg)) svg = svg.replace(/^<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  if (/xlink:/i.test(svg) && !/xmlns:xlink\s*=/i.test(svg)) svg = svg.replace(/^<svg/i, '<svg xmlns:xlink="http://www.w3.org/1999/xlink"');
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** The text of a run of spans on one line. */
export function plainText(spans: readonly FormSpan[]): string {
  return oneLine(spansText(spans));
}

/** What was typed into forms still open: the dock unmounts the view while it is minimised, and the answers must survive that. */
const remembered = new Map<string, { html: string; drafts: FieldDraft[] }>();
const REMEMBERED_LIMIT = 12;

export function rememberDrafts(id: string, html: string, drafts: FieldDraft[]): void {
  remembered.delete(id);
  remembered.set(id, { html, drafts });
  for (const key of remembered.keys()) {
    if (remembered.size <= REMEMBERED_LIMIT) break;
    remembered.delete(key);
  }
}

/** The drafts kept for this exact form (same request id and HTML), if any. */
export function recalledDrafts(id: string, html: string): FieldDraft[] | undefined {
  const entry = remembered.get(id);
  return entry?.html === html ? entry.drafts : undefined;
}

export function forgetDrafts(id: string): void {
  remembered.delete(id);
}
