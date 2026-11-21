"use client";

import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { ClickableImage } from "./ImageLightbox";
import { useI18n, type Translate } from "@/lib/i18n";
import { type FieldProblem, fieldQuestions, formDataError } from "@/lib/ask-form";
import type { ChoiceField, FormBlock, FormField, FormSection, FormSpan, HtmlForm, TextField } from "@/lib/ask-form-parse";
import {
  type ChoiceDraft,
  type FieldDraft,
  type TextDraft,
  buildFormData,
  fieldProblems,
  forgetDrafts,
  formImageUrl,
  initialDrafts,
  parseFormCached,
  pickOption,
  plainText,
  recalledDrafts,
  rememberDrafts,
  svgDataUrl,
  typeOther,
} from "@/lib/ask-form-view";
import type { ExtensionDialogResponse, ExtensionFormRequest } from "@/lib/pending-input";

/**
 * omp 19.1's `ask`: the model's HTML form on ONE card, answered with one Submit. Explanations (paragraphs, lists, tables,
 * preformatted text, images) are drawn in the order the model wrote them, between its radio / checkbox / select / text
 * fields. It sits inside the dock's single scroll area: nothing here scrolls on its own, and Cancel / Submit stay pinned
 * at the foot of that area. The HTML is never inserted as markup; every element is built from the parsed form
 * (lib/ask-form-parse.ts), and what is sent back is validated with omp's own rules first (lib/ask-form.ts).
 */

type NonFieldBlock = Exclude<FormBlock, { kind: "field" }>;

interface FormContext {
  t: Translate;
  uid: string;
  drafts: FieldDraft[];
  problems: (FieldProblem | undefined)[];
  attempted: boolean;
  questions: Map<FormField, string>;
  indexOf: Map<FormField, number>;
  /** The field the dock puts the cursor on when the form opens (a choice only: a text field would raise a phone's keyboard). */
  firstNamed: number;
  lastNamed: number;
  update: (index: number, draft: FieldDraft) => void;
  /** Ref callback of the field's first control: Enter moves on to it, a failed Submit focuses it. */
  bind: (index: number) => (element: HTMLElement | null) => void;
}

const ROW_MIN_HEIGHT = 48;

const textStyle: CSSProperties = {
  margin: 0,
  color: "var(--text)",
  fontSize: 13,
  lineHeight: 1.55,
  whiteSpace: "pre-line",
  overflowWrap: "anywhere",
  minWidth: 0,
};

const codeStyle: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "0.92em",
  background: "color-mix(in srgb, var(--text) 10%, transparent)",
  padding: "1px 5px",
  borderRadius: 4,
};

const inputStyle: CSSProperties = {
  width: "100%",
  minHeight: ROW_MIN_HEIGHT,
  boxSizing: "border-box",
  padding: "8px 12px",
  minWidth: 0,
  borderRadius: "var(--radius-control)",
  border: "1px solid var(--border)",
  background: "var(--bg-panel)",
  color: "var(--text)",
  font: "inherit",
  fontSize: 13,
};

const buttonStyle: CSSProperties = {
  minHeight: ROW_MIN_HEIGHT,
  minWidth: 88,
  padding: "8px 16px",
  borderRadius: "var(--radius-control)",
  border: "1px solid var(--border)",
  background: "var(--bg-panel)",
  color: "var(--text)",
  cursor: "pointer",
  font: "inherit",
  fontSize: 13,
  textAlign: "center",
};

// The buttons stay at the foot of the dock's scroll area (as in components/ExtensionDialog.tsx): a long explanation or
// a tall form never pushes them out of reach. They cover the area's whole width and its bottom padding, so a field that
// has scrolled under them leaves no edge showing.
const footerStyle: CSSProperties = {
  position: "sticky",
  bottom: -3,
  zIndex: 1,
  display: "flex",
  alignItems: "center",
  justifyContent: "flex-end",
  gap: 8,
  flexWrap: "wrap",
  margin: "-4px -4px 0",
  padding: "10px 4px 2px",
  background: "linear-gradient(to bottom, transparent, var(--bg) 8px)",
};

const rowStyle = (active: boolean, disabled: boolean): CSSProperties => ({
  display: "flex",
  alignItems: "center",
  gap: 12,
  minHeight: ROW_MIN_HEIGHT,
  boxSizing: "border-box",
  padding: "8px 12px",
  minWidth: 0,
  cursor: disabled ? "not-allowed" : "pointer",
  opacity: disabled ? 0.55 : 1,
  borderRadius: "var(--radius-control)",
  border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
  background: active ? "var(--bg-hover)" : "var(--bg-panel)",
});

const patternText = (pattern: string) => (pattern.length > 40 ? `${pattern.slice(0, 39)}\u2026` : pattern);

function problemMessage(t: Translate, problem: FieldProblem): string {
  switch (problem.kind) {
    case "required": return t("askForm.problem.required");
    case "selectOne": return t("askForm.problem.selectOne");
    case "number": return t("askForm.problem.number");
    case "min": return t("askForm.problem.min", { limit: problem.limit });
    case "max": return t("askForm.problem.max", { limit: problem.limit });
    case "minLength": return t("askForm.problem.minLength", { limit: problem.limit });
    case "maxLength": return t("askForm.problem.maxLength", { limit: problem.limit });
    case "email": return t("askForm.problem.email");
    case "url": return t("askForm.problem.url");
    case "pattern": return t("askForm.problem.pattern", { pattern: patternText(problem.pattern) });
  }
}

function Spans({ spans }: { spans: readonly FormSpan[] }) {
  return (
    <>
      {spans.map((span, index) =>
        span.style === "code" ? (
          <code key={index} style={codeStyle}>{span.text}</code>
        ) : span.style === "strong" ? (
          <strong key={index}>{span.text}</strong>
        ) : span.style === "em" ? (
          <em key={index}>{span.text}</em>
        ) : (
          <span key={index}>{span.text}</span>
        ),
      )}
    </>
  );
}

function Required({ t }: { t: Translate }) {
  return <span style={{ color: "var(--accent)", fontSize: 12, fontWeight: 600 }}>{t("askForm.required")}</span>;
}

function FieldError({ id, text }: { id: string; text: string }) {
  return (
    <div id={id} style={{ color: "var(--status-error)", fontSize: 12, lineHeight: 1.4, overflowWrap: "anywhere" }}>
      {text}
    </div>
  );
}

/** An image of the form (a picture or an inline svg). One that cannot be shown is replaced by its alt text. */
function FormImage({ src, alt }: { src: string; alt: string }) {
  const { t } = useI18n();
  const [failed, setFailed] = useState(false);
  const url = formImageUrl(src);
  if (!url || failed) {
    return (
      <div role="img" aria-label={alt || t("askForm.imageUnavailable")} style={{ ...textStyle, color: "var(--text-muted)", fontStyle: "italic" }}>
        {alt || t("askForm.imageUnavailable")}
      </div>
    );
  }
  return (
    <div style={{ minWidth: 0 }}>
      <ClickableImage
        src={url}
        alt={alt}
        onError={() => setFailed(true)}
        style={{ display: "block", maxWidth: "100%", height: "auto", borderRadius: 6, border: "1px solid var(--border)", background: "#fff" }}
      />
    </div>
  );
}

function TableBlock({ block }: { block: Extract<FormBlock, { kind: "table" }> }) {
  const cellStyle: CSSProperties = {
    padding: "6px 8px",
    border: "1px solid var(--border)",
    textAlign: "left",
    verticalAlign: "top",
    overflowWrap: "anywhere",
    whiteSpace: "pre-line",
  };
  const header = block.rows.slice(0, block.headerRows);
  const body = block.rows.slice(block.headerRows);
  return (
    <table style={{ width: "100%", borderCollapse: "collapse", color: "var(--text)", fontSize: 12, lineHeight: 1.5 }}>
      {header.length > 0 && (
        <thead>
          {header.map((row, r) => (
            <tr key={r}>
              {row.map((cell, c) => (
                <th key={c} scope="col" style={{ ...cellStyle, fontWeight: 600, background: "var(--bg-subtle)" }}>
                  <Spans spans={cell} />
                </th>
              ))}
            </tr>
          ))}
        </thead>
      )}
      <tbody>
        {body.map((row, r) => (
          <tr key={r}>
            {row.map((cell, c) => (
              <td key={c} style={cellStyle}>
                <Spans spans={cell} />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function BlockView({ block }: { block: NonFieldBlock }) {
  switch (block.kind) {
    case "text":
      return block.heading ? (
        <div role="heading" aria-level={3} style={{ ...textStyle, fontSize: 14, fontWeight: 700 }}>
          <Spans spans={block.spans} />
        </div>
      ) : (
        <p style={textStyle}>
          <Spans spans={block.spans} />
        </p>
      );
    case "list": {
      const List = block.ordered ? "ol" : "ul";
      return (
        <List style={{ ...textStyle, paddingLeft: 22, display: "grid", gap: 2 }}>
          {block.items.map((item, index) => (
            <li key={index} style={{ minWidth: 0 }}>
              <Spans spans={item} />
            </li>
          ))}
        </List>
      );
    }
    case "pre":
      return (
        <pre
          style={{
            margin: 0,
            padding: "8px 10px",
            borderRadius: "var(--radius-control)",
            background: "color-mix(in srgb, var(--text) 8%, transparent)",
            color: "var(--text)",
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            lineHeight: 1.5,
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
            minWidth: 0,
          }}
        >
          {block.text}
        </pre>
      );
    case "table":
      return <TableBlock block={block} />;
    case "image":
      return <FormImage src={block.src} alt={block.alt} />;
    case "svg":
      return <FormImage src={svgDataUrl(block.markup)} alt={block.alt} />;
  }
}

/** One text-like field: its label (and a Required tag) above the control, the problem under it. */
function TextView({ ctx, field, index }: { ctx: FormContext; field: TextField; index: number }) {
  const { t } = ctx;
  const draft = ctx.drafts[index] as TextDraft;
  const id = `${ctx.uid}-f${index}`;
  const errorId = `${id}-error`;
  const problem = ctx.attempted ? ctx.problems[index] : undefined;
  const hasLabel = field.label.length > 0;
  const shared = {
    id,
    value: draft.text,
    placeholder: field.placeholder || undefined,
    autoComplete: "off",
    "aria-required": field.required || undefined,
    "aria-invalid": problem ? true : undefined,
    "aria-describedby": problem ? errorId : undefined,
    "aria-label": hasLabel ? undefined : ctx.questions.get(field) ?? field.name,
    style: { ...inputStyle, ...(problem ? { borderColor: "var(--status-error)" } : null) },
  };
  const numeric = field.type === "number" || field.type === "range";
  const control = field.multiline ? (
    <textarea
      {...shared}
      ref={ctx.bind(index)}
      rows={Math.min(Math.max(field.rows, 3), 8)}
      onChange={(event) => ctx.update(index, { kind: "text", text: event.target.value })}
      style={{ ...shared.style, resize: "vertical", lineHeight: 1.5 }}
    />
  ) : (
    <input
      {...shared}
      ref={ctx.bind(index)}
      type={inputType(field.type)}
      inputMode={numeric ? "decimal" : undefined}
      step={numeric ? "any" : undefined}
      min={field.min}
      max={field.max}
      enterKeyHint={index === ctx.lastNamed ? "send" : "next"}
      spellCheck={field.type === "text" || field.type === "search" ? undefined : false}
      onChange={(event) => ctx.update(index, { kind: "text", text: event.target.value })}
    />
  );
  return (
    <div data-testid={`ask-form-field-${field.name}`} data-ask-field={index} style={{ display: "grid", gap: 6, minWidth: 0 }}>
      {(hasLabel || field.required) && (
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
          {hasLabel ? (
            <label htmlFor={id} style={{ color: "var(--text)", fontSize: 13, fontWeight: 600, lineHeight: 1.5, overflowWrap: "anywhere", minWidth: 0 }}>
              <Spans spans={field.label} />
            </label>
          ) : (
            <span />
          )}
          {field.required && <Required t={t} />}
        </div>
      )}
      {control}
      {problem && <FieldError id={errorId} text={problemMessage(t, problem)} />}
    </div>
  );
}

const NATIVE_TYPES = new Set(["text", "email", "url", "tel", "search", "password", "number", "date", "time", "datetime-local", "month", "week"]);

/** The `<input type>` that shows an omp field: a slider asks for a number, and a type no browser has is plain text. */
function inputType(type: string): string {
  if (type === "range") return "number";
  return NATIVE_TYPES.has(type) ? type : "text";
}

/** A radio group, checkbox group, single select or multi-select. */
function ChoiceView({ ctx, field, index, context }: { ctx: FormContext; field: ChoiceField; index: number; context: NonFieldBlock[] }) {
  const { t } = ctx;
  const draft = ctx.drafts[index] as ChoiceDraft;
  const id = `${ctx.uid}-f${index}`;
  const errorId = `${id}-error`;
  const problem = ctx.attempted ? ctx.problems[index] : undefined;
  const question = ctx.questions.get(field) ?? field.name;
  const hasLabel = field.label.length > 0;
  const firstEnabled = field.options.findIndex((option) => !option.disabled);
  const autofocus = index === ctx.firstNamed ? "true" : undefined;
  const frame = { "data-testid": `ask-form-field-${field.name}`, "data-ask-field": index, style: { display: "grid", gap: 8, minWidth: 0 } as CSSProperties };

  if (field.select && !field.multi) {
    return (
      <div {...frame}>
        {(hasLabel || field.required) && (
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
            {hasLabel ? (
              <label htmlFor={id} style={{ color: "var(--text)", fontSize: 13, fontWeight: 600, lineHeight: 1.5, overflowWrap: "anywhere", minWidth: 0 }}>
                <Spans spans={field.label} />
              </label>
            ) : (
              <span />
            )}
            {field.required && <Required t={t} />}
          </div>
        )}
        <select
          id={id}
          ref={ctx.bind(index)}
          value={draft.checked[0] === undefined ? "" : String(draft.checked[0])}
          data-input-autofocus={autofocus}
          aria-required={field.required || undefined}
          aria-invalid={problem ? true : undefined}
          aria-describedby={problem ? errorId : undefined}
          aria-label={hasLabel ? undefined : question}
          onChange={(event) => ctx.update(index, pickOption(field, draft, Number(event.target.value)))}
          style={{ ...inputStyle, ...(problem ? { borderColor: "var(--status-error)" } : null) }}
        >
          {draft.checked.length === 0 && <option value="" disabled>{"\u2014"}</option>}
          {field.options.map((option, optionIndex) => (
            <option key={optionIndex} value={String(optionIndex)} disabled={option.disabled}>
              {plainText(option.label) || option.value}
            </option>
          ))}
        </select>
        {problem && <FieldError id={errorId} text={problemMessage(t, problem)} />}
      </div>
    );
  }

  const hint = field.options.length > 1 ? (field.multi ? t("askDialog.multiHint") : t("askDialog.singleHint")) : "";
  const otherActive = draft.other.trim() !== "";
  return (
    <div
      {...frame}
      role={field.multi ? "group" : "radiogroup"}
      aria-label={hasLabel ? plainText(field.label) : question}
      aria-required={field.required || undefined}
      aria-invalid={problem ? true : undefined}
      aria-describedby={problem ? errorId : undefined}
    >
      {context.map((block, blockIndex) => (
        <BlockView key={blockIndex} block={block} />
      ))}
      {(hint || field.required) && (
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", color: "var(--text-dim)", fontSize: 12 }}>
          {hint && <span>{hint}</span>}
          {field.required && <Required t={t} />}
        </div>
      )}
      {field.options.map((option, optionIndex) => {
        const checked = draft.checked.includes(optionIndex);
        return (
          <label key={optionIndex} className="ask-form-row" style={rowStyle(checked, option.disabled)}>
            <input
              type={field.multi ? "checkbox" : "radio"}
              name={id}
              checked={checked}
              disabled={option.disabled}
              ref={optionIndex === firstEnabled ? ctx.bind(index) : undefined}
              data-input-autofocus={optionIndex === firstEnabled ? autofocus : undefined}
              onChange={() => ctx.update(index, pickOption(field, draft, optionIndex))}
              style={{ width: 20, height: 20, margin: 0, flexShrink: 0, accentColor: "var(--accent)", cursor: "inherit" }}
            />
            <span style={{ ...textStyle, flex: 1, color: "var(--text)" }}>
              <Spans spans={option.label} />
            </span>
          </label>
        );
      })}
      {field.other && (
        <input
          type="text"
          value={draft.other}
          autoComplete="off"
          ref={firstEnabled < 0 ? ctx.bind(index) : undefined}
          enterKeyHint={index === ctx.lastNamed ? "send" : "next"}
          aria-label={`${t("askDialog.other")}: ${question}`}
          placeholder={`${t("askDialog.other")} \u2014 ${t("askDialog.otherPlaceholder")}`}
          onChange={(event) => ctx.update(index, typeOther(field, draft, event.target.value))}
          style={{ ...inputStyle, borderColor: otherActive ? "var(--accent)" : "var(--border)" }}
        />
      )}
      {problem && <FieldError id={errorId} text={problemMessage(t, problem)} />}
    </div>
  );
}

/**
 * The blocks of one section in the order the model wrote them. Text between a choice group's own options belongs
 * to that group (omp's own dialog puts it above the options); a field with no name carries no answer and is not drawn.
 */
function SectionBlocks({ ctx, section }: { ctx: FormContext; section: FormSection }) {
  const nodes: ReactNode[] = [];
  const { blocks } = section;
  for (let at = 0; at < blocks.length; at++) {
    const block = blocks[at]!;
    if (block.kind !== "field") {
      nodes.push(<BlockView key={at} block={block} />);
      continue;
    }
    const { field } = block;
    if (!field.name) continue;
    const index = ctx.indexOf.get(field);
    if (index === undefined) continue;
    if (field.kind === "text") {
      nodes.push(<TextView key={at} ctx={ctx} field={field} index={index} />);
      continue;
    }
    const end = block.optionsEnd ?? 0;
    const between = blocks.slice(at + 1, end);
    const owned = !between.some((later) => later.kind === "field" && later.field.name);
    const context = owned ? between.filter((later): later is NonFieldBlock => later.kind !== "field") : [];
    nodes.push(<ChoiceView key={at} ctx={ctx} field={field} index={index} context={context} />);
    if (owned && end > at + 1) at = end - 1;
  }
  return <>{nodes}</>;
}

function SectionView({ ctx, section, index }: { ctx: FormContext; section: FormSection; index: number }) {
  const titleId = `${ctx.uid}-s${index}`;
  const hasTitle = section.title.length > 0;
  if (!section.fieldset) return <SectionBlocks ctx={ctx} section={section} />;
  return (
    <div
      role="group"
      aria-labelledby={hasTitle ? titleId : undefined}
      style={{
        display: "grid",
        gap: 10,
        minWidth: 0,
        padding: "12px",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-card)",
        background: "var(--bg-subtle)",
      }}
    >
      {hasTitle && (
        <div id={titleId} style={{ ...textStyle, fontWeight: 700 }}>
          <Spans spans={section.title} />
        </div>
      )}
      <SectionBlocks ctx={ctx} section={section} />
    </div>
  );
}

const isTextEntry = (target: EventTarget): target is HTMLInputElement | HTMLTextAreaElement =>
  target instanceof HTMLTextAreaElement ||
  (target instanceof HTMLInputElement && target.type !== "checkbox" && target.type !== "radio");

export function AskHtmlForm({
  request,
  onRespond,
}: {
  request: ExtensionFormRequest;
  onRespond: (response: ExtensionDialogResponse) => void;
}) {
  const { t, tn } = useI18n();
  const uid = useId();
  const form: HtmlForm = useMemo(() => parseFormCached(request.html), [request.html]);
  const [drafts, setDrafts] = useState<FieldDraft[]>(() => recalledDrafts(request.id, request.html) ?? initialDrafts(form));
  const [attempted, setAttempted] = useState(false);
  const [rejected, setRejected] = useState<string | null>(null);
  const answeredRef = useRef(false);
  const controls = useRef<(HTMLElement | null)[]>([]);

  const questions = useMemo(() => fieldQuestions(form), [form]);
  const indexOf = useMemo(() => new Map(form.fields.map((field, index) => [field, index] as const)), [form]);
  const problems = useMemo(() => fieldProblems(form, drafts), [form, drafts]);
  const named = useMemo(() => form.fields.flatMap((field, index) => (field.name ? [index] : [])), [form]);
  const problemCount = problems.filter(Boolean).length;

  useEffect(() => {
    if (!answeredRef.current) rememberDrafts(request.id, request.html, drafts);
  }, [request.id, request.html, drafts]);

  const respond = (response: ExtensionDialogResponse) => {
    if (answeredRef.current) return;
    answeredRef.current = true;
    forgetDrafts(request.id);
    onRespond(response);
  };

  // Focus moves inside the tap or key handler itself: a phone only opens the keyboard for focus given during the gesture.
  const focusField = (index: number) => {
    const control = controls.current[index];
    control?.focus();
    control?.scrollIntoView({ block: "nearest" });
  };

  const submit = () => {
    if (answeredRef.current) return;
    const data = buildFormData(form, drafts);
    const first = problems.findIndex((problem) => problem !== undefined);
    // The field rules above are omp's; asking omp's own check as well keeps a mismatch from sending an answer it would refuse.
    const refused = first < 0 ? formDataError(form, data) : undefined;
    if (first >= 0 || refused !== undefined) {
      setAttempted(true);
      setRejected(refused ?? null);
      if (first >= 0) focusField(first);
      return;
    }
    respond({ data });
  };

  const advance = (from: number) => {
    const next = controls.current.findIndex((control, index) => index > from && control);
    if (next >= 0) focusField(next);
    else submit();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    const target = event.target;
    if (event.nativeEvent.isComposing) return;
    // A select keeps its arrows and letters; the dock's own shortcuts must not take them.
    if (target instanceof HTMLSelectElement && event.key !== "Escape") event.stopPropagation();
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submit();
      return;
    }
    // Escape cancels the question, and a cancelled question stops the agent's turn: the first one in a field that holds
    // typed text only leaves the field.
    if (event.key === "Escape" && isTextEntry(target) && target.value !== "") {
      event.stopPropagation();
      target.blur();
      return;
    }
    // Enter in a single-line field or on a choice moves to the next question, and sends from the last one.
    if (event.key === "Enter" && !event.shiftKey && target instanceof HTMLInputElement) {
      const field = Number((target.closest("[data-ask-field]") as HTMLElement | null)?.dataset.askField);
      if (Number.isInteger(field)) {
        event.preventDefault();
        advance(field);
      }
    }
  };

  const ctx: FormContext = {
    t,
    uid,
    drafts,
    problems,
    attempted,
    questions,
    indexOf,
    firstNamed: named[0] ?? -1,
    lastNamed: named.at(-1) ?? -1,
    update: (index, draft) => setDrafts((current) => current.map((entry, at) => (at === index ? draft : entry))),
    bind: (index) => (element) => {
      controls.current[index] = element;
    },
  };

  const hint =
    attempted && problemCount > 0
      ? tn("askForm.needsAttention", problemCount)
      : attempted && rejected
        ? t("askForm.problem.rejected", { reason: rejected })
        : null;
  const deadline = request.expiresAt ? new Date(request.expiresAt).toLocaleTimeString() : null;

  return (
    <form
      className="ask-form"
      data-testid="ask-form"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      onKeyDown={onKeyDown}
      style={{ display: "grid", gap: 12, minWidth: 0 }}
    >
      {deadline && <div style={{ color: "var(--text-dim)", fontSize: 12, lineHeight: 1.5 }}>{t("askForm.timeLimit", { time: deadline })}</div>}
      {form.sections.map((section, index) => (
        <SectionView key={index} ctx={ctx} section={section} index={index} />
      ))}
      <div style={footerStyle}>
        {hint && (
          <span role="alert" data-testid="ask-form-hint" style={{ flex: "1 1 140px", minWidth: 0, color: "var(--status-error)", fontSize: 12, lineHeight: 1.4, overflowWrap: "anywhere" }}>
            {hint}
          </span>
        )}
        <button type="button" data-testid="ask-form-cancel" onClick={() => respond({ cancelled: true })} style={{ ...buttonStyle, color: "var(--text-muted)" }}>
          {t("chatWindow.cancel")}
        </button>
        <button
          type="submit"
          data-testid="ask-form-submit"
          style={{ ...buttonStyle, borderColor: "var(--accent)", background: "var(--accent)", color: "var(--on-accent)", fontWeight: 600 }}
        >
          {t("chatWindow.submit")}
        </button>
      </div>
    </form>
  );
}
