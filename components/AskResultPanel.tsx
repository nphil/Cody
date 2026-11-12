"use client";

import { askAnswersFromDetails, askAnswerShown, ASK_NO_ANSWER, passwordFieldNames, type AskNote, type AskRow } from "@/lib/ask-result";
import { useI18n } from "@/lib/i18n";
import { isRecord } from "@/lib/type-guards";

/**
 * The answers to an `ask` tool call, in the card's expanded area: each
 * question (muted) over what was answered. Everything is plain text nodes, so
 * a model-authored question or a typed answer can never inject markup. A
 * password field's answer (found in the call's own form HTML) shows as bullets.
 *
 * Reads the bounded `details` projection of lib/ask-result.ts
 * keepAskToolResultDetails, which history loads keep for `ask` results.
 */
export function AskResultPanel({ details, input }: { details: unknown; input?: unknown }) {
  const { t } = useI18n();
  const { rows, notes, timedOut } = askAnswersFromDetails(details);
  if (rows.length === 0) return null;
  const passwords = passwordFieldNames(isRecord(input) ? input.html : undefined);

  const notesFor = (row: AskRow): AskNote[] =>
    notes.filter((note) => (note.name && row.name ? note.name === row.name : note.question === row.question));

  return (
    <div
      role="group"
      aria-label={t("askResult.title")}
      style={{
        borderTop: "1px solid var(--border)",
        background: "var(--bg-subtle)",
        padding: "8px 10px",
        display: "grid",
        gap: 8,
        minWidth: 0,
      }}
    >
      {rows.map((row, index) => {
        const shown = askAnswerShown(row, passwords);
        const rowNotes = notesFor(row);
        return (
          <div key={index} style={{ display: "grid", gap: 2, minWidth: 0 }}>
            <div style={{ fontSize: 11, color: "var(--text-muted)", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
              {row.question}
            </div>
            <div style={{ fontSize: 12.5, color: "var(--text)", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
              {shown.trim() === "" || shown === ASK_NO_ANSWER ? t("askResult.noAnswer") : shown}
            </div>
            {rowNotes.map((note, noteIndex) => (
              <div
                key={noteIndex}
                style={{ fontSize: 11, color: "var(--text-dim)", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
              >
                {note.option ? `${note.option}: ${note.text}` : `${t("askResult.note")}: ${note.text}`}
              </div>
            ))}
          </div>
        );
      })}
      {timedOut && (
        <div
          role="status"
          style={{
            justifySelf: "start",
            maxWidth: "100%",
            fontSize: 10.5,
            color: "var(--status-warning)",
            border: "1px solid color-mix(in srgb, var(--status-warning) 35%, transparent)",
            background: "color-mix(in srgb, var(--status-warning) 8%, transparent)",
            borderRadius: 5,
            padding: "2px 6px",
            overflowWrap: "anywhere",
          }}
        >
          {t("askResult.timedOut")}
        </div>
      )}
    </div>
  );
}
