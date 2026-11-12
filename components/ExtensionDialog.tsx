"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Check } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { splitExtensionTitle } from "@/lib/extension-title";
import type { ExtensionDialogRequest, ExtensionDialogResponse } from "@/lib/pending-input";

export type { ExtensionDialogRequest, ExtensionDialogResponse } from "@/lib/pending-input";

type SelectRequest = Extract<ExtensionDialogRequest, { method: "select" }>;

/** One row of a `select` dialog. */
interface Choice {
  /** Exactly what omp sent; an answer sends it back unchanged. */
  label: string;
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
    choices.push({ label: row.label, ticked: row.ticked, typed: row.typed, other: row.kind === "other", description: describe(index) });
  });
  return choices;
}

/** An extension request rendered inside the composer-attached InputDock. */
export function ExtensionInputCard({
  request,
  selectedOptionIndex,
  onSelectOption,
  onRespond,
}: {
  request: Exclude<ExtensionDialogRequest, { method: "ask" }>;
  selectedOptionIndex: number;
  onSelectOption: (index: number) => void;
  onRespond: (response: ExtensionDialogResponse) => void;
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

  // A step of the `ask` tool's walk shows its own question, its checkboxes and a Done button.
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
  const title = splitExtensionTitle(walk ? walk.question : request.title);
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

  return (
    <div role="group" aria-label={walk ? walk.question : request.title} style={{ display: "grid", gap: 8, minWidth: 0 }}>
      {title.details !== "" && (
        <div style={{ color: "var(--text-muted)", fontSize: 12, lineHeight: 1.55, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
          {title.details}
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
          role="group"
          aria-label={walk ? walk.question : select.title}
          aria-busy={settling || undefined}
          style={{ display: "grid", gap: 6, maxHeight: "32vh", overflowY: "auto", overscrollBehavior: "contain" }}
        >
          {choices.map((choice, index) => {
            const checkbox = choice.ticked !== undefined;
            const ticked = choice.ticked === true;
            const emphasised = checkbox ? ticked : selectedOptionIndex === index;
            return (
              <button
                key={choice.label}
                type="button"
                data-input-choice="true"
                role={checkbox ? "checkbox" : undefined}
                aria-checked={checkbox ? ticked : undefined}
                aria-pressed={checkbox ? undefined : selectedOptionIndex === index}
                aria-disabled={settling || undefined}
                onFocus={() => onSelectOption(index)}
                onClick={() => respond({ value: choice.label })}
                style={{
                  ...buttonStyle,
                  ...(checkbox ? { display: "flex", alignItems: "flex-start", gap: 10 } : null),
                  cursor: settling ? "progress" : "pointer",
                  borderColor: emphasised ? "var(--accent)" : "var(--border)",
                  background: emphasised ? "var(--bg-hover)" : "var(--bg-panel)",
                }}
              >
                {checkbox && (
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
                      borderRadius: 4,
                      border: `1px solid ${ticked ? "var(--accent)" : "var(--border)"}`,
                      background: ticked ? "var(--accent)" : "transparent",
                      color: "var(--on-accent)",
                    }}
                  >
                    {ticked && <Check size={13} strokeWidth={3} />}
                  </span>
                )}
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
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
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
