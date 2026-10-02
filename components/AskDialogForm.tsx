"use client";

import { useId, useRef, useState, type CSSProperties } from "react";
import { useI18n } from "@/lib/i18n";
import {
  buildAskAnswers,
  initialAskDrafts,
  isAskAnswered,
  setAskCustom,
  toggleAskOption,
  type AskDraft,
} from "@/lib/ask-dialog";
import type { ExtensionAskRequest, ExtensionDialogResponse } from "@/lib/pending-input";

const ROW_MIN_HEIGHT = 38;

const controlStyle: CSSProperties = {
  minHeight: 48,
  padding: "8px 12px",
  borderRadius: "var(--radius-control)",
  border: "1px solid var(--border)",
  background: "var(--bg-panel)",
  color: "var(--text)",
  cursor: "pointer",
  font: "inherit",
  fontSize: 13,
  textAlign: "center",
};

/**
 * omp's `ask` dialog: every question on ONE form, so the agent gets all the
 * answers in a single reply. One column, so it holds up on a phone. The form
 * is local state keyed by the request id (the InputDock remounts it per id),
 * so a replay of the same request after an SSE reconnect keeps what was typed.
 */
export function AskDialogForm({
  request,
  onRespond,
}: {
  request: ExtensionAskRequest;
  onRespond: (response: ExtensionDialogResponse) => void;
}) {
  const { t } = useI18n();
  const uid = useId();
  const { questions } = request;
  const [drafts, setDrafts] = useState<AskDraft[]>(() => initialAskDrafts(questions));
  const answeredRef = useRef(false);

  const answers = buildAskAnswers(questions, drafts);
  const answeredCount = questions.filter((question, index) => isAskAnswered(question, drafts[index]!)).length;

  const respond = (response: ExtensionDialogResponse) => {
    if (answeredRef.current) return;
    answeredRef.current = true;
    onRespond(response);
  };
  const submit = () => {
    if (answers) respond({ answers });
  };
  const update = (index: number, next: AskDraft) =>
    setDrafts((current) => current.map((draft, i) => (i === index ? next : draft)));

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          submit();
        }
      }}
      style={{ display: "grid", gap: 14, minWidth: 0 }}
    >
      {questions.map((question, qIndex) => {
        const draft = drafts[qIndex]!;
        const groupId = `${uid}-q${qIndex}`;
        const customActive = draft.custom.trim() !== "";
        return (
          <div
            key={question.id}
            role={question.multi ? "group" : "radiogroup"}
            aria-labelledby={`${groupId}-label`}
            style={{ display: "grid", gap: 6, minWidth: 0 }}
          >
            <div id={`${groupId}-label`} style={{ display: "grid", gap: 2, minWidth: 0 }}>
              {question.header && (
                <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.04em", color: "var(--accent)", textTransform: "uppercase", overflowWrap: "anywhere" }}>
                  {question.header}
                </span>
              )}
              <span style={{ color: "var(--text)", fontSize: 13, fontWeight: 600, lineHeight: 1.5, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                {question.question}
              </span>
              <span style={{ color: "var(--text-dim)", fontSize: 11 }}>
                {question.multi ? t("askDialog.multiHint") : t("askDialog.singleHint")}
              </span>
            </div>
            {question.options.map((option, oIndex) => {
              const checked = draft.selected.includes(oIndex);
              return (
                <label
                  key={oIndex}
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 10,
                    minHeight: ROW_MIN_HEIGHT,
                    boxSizing: "border-box",
                    padding: "8px 10px",
                    minWidth: 0,
                    cursor: "pointer",
                    borderRadius: "var(--radius-control)",
                    border: `1px solid ${checked ? "var(--accent)" : "var(--border)"}`,
                    background: checked ? "var(--bg-hover)" : "var(--bg-panel)",
                  }}
                >
                  <input
                    type={question.multi ? "checkbox" : "radio"}
                    name={groupId}
                    checked={checked}
                    data-input-choice={qIndex === 0 && oIndex === 0 ? "true" : undefined}
                    onChange={() => update(qIndex, toggleAskOption(question, draft, oIndex))}
                    style={{ width: 18, height: 18, margin: "1px 0 0", flexShrink: 0, accentColor: "var(--accent)", cursor: "pointer" }}
                  />
                  <span style={{ display: "grid", gap: 3, minWidth: 0, flex: 1 }}>
                    <span style={{ color: "var(--text)", fontSize: 13, lineHeight: 1.5, overflowWrap: "anywhere" }}>
                      {option.label}
                      {question.recommended === oIndex && (
                        <span style={{ marginLeft: 8, color: "var(--accent)", fontSize: 11, fontWeight: 600 }}>
                          {t("askDialog.recommended")}
                        </span>
                      )}
                    </span>
                    {option.description && (
                      <span style={{ color: "var(--text-muted)", fontSize: 12, lineHeight: 1.5, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                        {option.description}
                      </span>
                    )}
                    {option.preview && (
                      <span
                        style={{
                          color: "var(--text-muted)",
                          background: "var(--bg-subtle)",
                          fontFamily: "var(--font-mono)",
                          fontSize: 11,
                          lineHeight: 1.5,
                          whiteSpace: "pre-wrap",
                          overflowWrap: "anywhere",
                          maxHeight: "6em",
                          overflowY: "auto",
                          padding: "4px 6px",
                          borderRadius: "var(--radius-control)",
                        }}
                      >
                        {option.preview}
                      </span>
                    )}
                  </span>
                </label>
              );
            })}
            <input
              type="text"
              value={draft.custom}
              aria-label={`${t("askDialog.other")}: ${question.question}`}
              placeholder={`${t("askDialog.other")} — ${t("askDialog.otherPlaceholder")}`}
              onChange={(event) => update(qIndex, setAskCustom(question, draft, event.target.value))}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  submit();
                }
              }}
              style={{
                width: "100%",
                minHeight: ROW_MIN_HEIGHT,
                boxSizing: "border-box",
                padding: "8px 10px",
                borderRadius: "var(--radius-control)",
                border: `1px solid ${customActive ? "var(--accent)" : "var(--border)"}`,
                background: "var(--bg-panel)",
                color: "var(--text)",
                outline: "none",
                font: "inherit",
                fontSize: 13,
              }}
            />
          </div>
        );
      })}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
        {questions.length > 1 && (
          <span style={{ flex: "1 1 auto", color: "var(--text-dim)", fontSize: 11, fontVariantNumeric: "tabular-nums" }}>
            {t("askDialog.answered", { answered: answeredCount, total: questions.length })}
          </span>
        )}
        <button type="button" onClick={() => respond({ cancelled: true })} style={{ ...controlStyle, color: "var(--text-muted)" }}>
          {t("chatWindow.cancel")}
        </button>
        <button
          type="submit"
          disabled={!answers}
          style={{
            ...controlStyle,
            borderColor: "var(--accent)",
            background: "var(--accent)",
            color: "var(--on-accent)",
            opacity: answers ? 1 : 0.5,
            cursor: answers ? "pointer" : "not-allowed",
          }}
        >
          {t("chatWindow.submit")}
        </button>
      </div>
    </form>
  );
}
