"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Check } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { extensionPrompt } from "@/lib/extension-title";
import type { ExtensionDialogRequest, ExtensionDialogResponse } from "@/lib/pending-input";

export type { ExtensionDialogRequest, ExtensionDialogResponse } from "@/lib/pending-input";

type SelectRequest = Extract<ExtensionDialogRequest, { method: "select" }>;

/** One row of a `select` dialog. */
interface Choice {
  /** Exactly what omp sent; an answer sends it back unchanged. */
  label: string;
  /**
   * How a row of the `ask` walk is marked: a box (`ticked` says whether it is ticked) or a radio dot (the cursor row is
   * the chosen one). Unset on every plain row, and on the rows after the marked ones, which are actions.
   */
  mark?: "box" | "radio";
  /** Set on a checkbox row of the `ask` walk: whether it is ticked. Unset on every other row. */
  ticked?: boolean;
  /** The answer typed behind a ticked "Other" row. */
  typed?: string;
  /** The "Other (type your own)" row, which the screen words in the user's language. */
  other?: boolean;
  description?: string;
}

/**
 * The rows of a `select`. A step of the `ask` walk lists its rows minus the
 * "Done selecting" one, which is the primary button instead (lib/ask-walk.ts).
 */
function choicesOf(request: SelectRequest): Choice[] {
  const describe = (index: number): string | undefined => {
    const description = request.optionDetails?.[index]?.description;
    return typeof description === "string" && description !== "" ? description : undefined;
  };
  const { walk } = request;
  if (!walk) return request.options.map((label, index) => ({ label, description: describe(index) }));
  const choices: Choice[] = [];
  walk.rows.forEach((row, index) => {
    if (row.kind === "done") return;
    const mark = row.kind === "action" ? undefined : walk.radio ? "radio" : row.ticked !== undefined ? "box" : undefined;
    choices.push({ label: row.label, mark, ticked: row.ticked, typed: row.typed, other: row.kind === "other", description: describe(index) });
  });
  return choices;
}

/** The box or dot in front of a row of an `ask` step. */
function RowMark({ shape, on }: { shape: "box" | "radio"; on: boolean }) {
  return (
    <span
      aria-hidden="true"
      style={{
        flexShrink: 0,
        width: 18,
        height: 18,
        marginTop: 1,
        boxSizing: "border-box",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: shape === "box" ? 4 : "50%",
        border: `1px solid ${on ? "var(--accent)" : "var(--border)"}`,
        background: shape === "box" && on ? "var(--accent)" : "transparent",
        color: "var(--on-accent)",
      }}
    >
      {shape === "box" && on && <Check size={13} strokeWidth={3} />}
      {shape === "radio" && on && <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--accent)" }} />}
    </span>
  );
}

/** An extension request rendered inside the composer-attached InputDock. */
export function ExtensionInputCard({
  request,
  selectedOptionIndex,
  onSelectOption,
  onRespond,
  fromAsk = false,
}: {
  request: Exclude<ExtensionDialogRequest, { method: "ask" }>;
  selectedOptionIndex: number;
  onSelectOption: (index: number) => void;
  onRespond: (response: ExtensionDialogResponse) => void;
  /** The model's own question: its prompt carries the text around the field first and the question last. */
  fromAsk?: boolean;
}) {
  const { t, tn } = useI18n();
  const editorPrefill = request.method === "editor" ? request.prefill ?? "" : "";
  const [value, setValue] = useState(editorPrefill);
  const answeredRef = useRef(false);

  useEffect(() => {
    setValue(editorPrefill);
    answeredRef.current = false;
  }, [request.id, request.method, editorPrefill]);

  const respond = (response: ExtensionDialogResponse) => {
    if (answeredRef.current) return;
    answeredRef.current = true;
    onRespond(response);
  };
  const submit = () => request.method === "confirm"
    ? respond({ confirmed: true })
    : respond({ value });

  // A step of the `ask` tool's walk shows the text around its field, its own question, its boxes or dots and a Done button.
  const select = request.method === "select" ? request : null;
  const walk = select?.walk;
  // The pick was sent and omp's next question has not come yet: the rows hold still, so a second tap cannot land on a stale list.
  const settling = select?.settling === true;
  const choices = select ? choicesOf(select) : [];
  const doneRow = walk?.rows.find((row) => row.kind === "done");
  const walkHint = walk?.multi
    ? [
        t("askDialog.multiHint"),
        walk.selected > 0 ? tn("askWalk.selected", walk.selected) : null,
        doneRow ? null : t("askWalk.pickOne"),
      ].filter((part): part is string => part !== null).join(" · ")
    : null;
  const prompt = extensionPrompt(request, fromAsk);
  // An extension asked for a secret (a token, a password): mask what is typed and keep the browser and password managers out of it.
  const secret = request.method === "input" && request.secret === true;

  const buttonStyle: CSSProperties = {
    minHeight: 48,
    padding: "8px 12px",
    borderRadius: "var(--radius-control)",
    border: "1px solid var(--border)",
    background: "var(--bg-panel)",
    color: "var(--text)",
    cursor: "pointer",
    font: "inherit",
    fontSize: 13,
    textAlign: "left",
  };
  const primaryStyle: CSSProperties = {
    ...buttonStyle,
    textAlign: "center",
    borderColor: "var(--accent)",
    background: "var(--accent)",
    color: "var(--on-accent)",
  };
  const detailStyle: CSSProperties = {
    display: "block",
    marginTop: 2,
    color: "var(--text-muted)",
    fontSize: 12,
    lineHeight: 1.5,
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
  };
  // What the model wrote around its question is the thing to read before answering, so it gets the larger type.
  const contextStyle: CSSProperties = {
    color: "var(--text-muted)",
    fontSize: prompt.ask ? 13 : 12,
    lineHeight: 1.55,
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
    ...(prompt.ask ? { paddingLeft: 10, borderLeft: "2px solid var(--border)" } : null),
  };
  // The buttons stay at the foot of the dock's scroll area: a long explanation or list never pushes them out of reach.
  // They cover the area's whole width and its bottom padding, so a row that has scrolled under them leaves no edge showing.
  const footerStyle: CSSProperties = {
    position: "sticky",
    bottom: -3,
    zIndex: 1,
    display: "flex",
    justifyContent: "flex-end",
    gap: 8,
    flexWrap: "wrap",
    margin: "-4px -4px 0",
    padding: "10px 4px 2px",
    background: "linear-gradient(to bottom, transparent, var(--bg) 8px)",
  };

  return (
    <div role="group" aria-label={prompt.ask ? prompt.headline : request.title} style={{ display: "grid", gap: 8, minWidth: 0 }}>
      {prompt.details !== "" && (
        <div data-testid={prompt.ask ? "ask-context" : undefined} style={contextStyle}>
          {prompt.details}
        </div>
      )}
      {prompt.inBody && (
        <div data-testid="ask-question" style={{ color: "var(--text)", fontSize: 13, fontWeight: 600, lineHeight: 1.45, overflowWrap: "anywhere" }}>
          {prompt.headline}
        </div>
      )}
      {request.method === "confirm" && (
        <div style={{ color: "var(--text-muted)", fontSize: 13, lineHeight: 1.55, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
          {request.message}
        </div>
      )}
      {walkHint !== null && (
        <div aria-live="polite" style={{ color: "var(--text-dim)", fontSize: 11 }}>
          {walkHint}
        </div>
      )}
      {select && (
        <div
          role={walk?.radio ? "radiogroup" : "group"}
          aria-label={walk ? walk.question : select.title}
          aria-busy={settling || undefined}
          style={{ display: "grid", gap: 6 }}
        >
          {choices.map((choice, index) => {
            const box = choice.mark === "box";
            const radio = choice.mark === "radio";
            const ticked = choice.ticked === true;
            const chosen = selectedOptionIndex === index;
            const emphasised = box ? ticked : chosen;
            return (
              <button
                key={choice.label}
                type="button"
                data-input-choice="true"
                role={box ? "checkbox" : radio ? "radio" : undefined}
                aria-checked={box ? ticked : radio ? chosen : undefined}
                aria-pressed={box || radio ? undefined : chosen}
                aria-disabled={settling || undefined}
                onFocus={() => onSelectOption(index)}
                onClick={() => respond({ value: choice.label })}
                style={{
                  ...buttonStyle,
                  ...(box || radio ? { display: "flex", alignItems: "flex-start", gap: 10 } : null),
                  cursor: settling ? "progress" : "pointer",
                  borderColor: emphasised ? "var(--accent)" : "var(--border)",
                  background: emphasised ? "var(--bg-hover)" : "var(--bg-panel)",
                }}
              >
                {(box || radio) && <RowMark shape={box ? "box" : "radio"} on={box ? ticked : chosen} />}
                <span style={{ minWidth: 0, flex: 1 }}>
                  {choice.other ? t("askWalk.other") : choice.label}
                  {choice.typed !== undefined && <span style={detailStyle}>{choice.typed}</span>}
                  {choice.description !== undefined && <span style={detailStyle}>{choice.description}</span>}
                </span>
              </button>
            );
          })}
        </div>
      )}
      {request.method === "input" && (
        <input
          data-input-autofocus="true"
          type={secret ? "password" : "text"}
          autoComplete={secret ? "new-password" : undefined}
          autoCapitalize={secret ? "off" : undefined}
          autoCorrect={secret ? "off" : undefined}
          spellCheck={secret ? false : undefined}
          data-1p-ignore={secret ? true : undefined}
          data-lpignore={secret ? "true" : undefined}
          data-bwignore={secret ? "true" : undefined}
          value={value}
          placeholder={request.placeholder}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit();
            }
          }}
          style={{
            width: "100%",
            minHeight: 48,
            boxSizing: "border-box",
            padding: "10px 12px",
            borderRadius: "var(--radius-control)",
            border: "1px solid var(--border)",
            background: "var(--bg-panel)",
            color: "var(--text)",
            outline: "none",
            font: "inherit",
            fontSize: 13,
          }}
        />
      )}
      {request.method === "editor" && (
        <textarea
          data-input-autofocus="true"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit();
            }
          }}
          style={{
            width: "100%",
            minHeight: 96,
            maxHeight: "24vh",
            boxSizing: "border-box",
            padding: 10,
            borderRadius: "var(--radius-control)",
            border: "1px solid var(--border)",
            background: "var(--bg-panel)",
            color: "var(--text)",
            outline: "none",
            resize: "vertical",
            overflowY: "auto",
            font: "inherit",
            fontSize: 13,
            lineHeight: 1.55,
          }}
        />
      )}
      <div style={footerStyle}>
        <button type="button" onClick={() => respond({ cancelled: true })} style={{ ...buttonStyle, textAlign: "center", color: "var(--text-muted)" }}>
          {t("chatWindow.cancel")}
        </button>
        {request.method === "confirm" ? (
          <button type="button" data-input-choice="true" onClick={submit} style={primaryStyle}>
            {t("chatWindow.confirm")}
          </button>
        ) : request.method === "select" ? (
          doneRow ? (
            <button
              type="button"
              data-input-choice="true"
              aria-disabled={settling || undefined}
              onClick={() => respond({ value: doneRow.label })}
              style={{ ...primaryStyle, cursor: settling ? "progress" : "pointer" }}
            >
              {t("askWalk.done")}
            </button>
          ) : null
        ) : (
          <button type="button" data-input-choice="true" onClick={submit} style={primaryStyle}>
            {t("chatWindow.submit")}
          </button>
        )}
      </div>
    </div>
  );
}
