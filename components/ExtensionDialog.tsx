"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useI18n } from "@/lib/i18n";
import type { ExtensionDialogRequest, ExtensionDialogResponse } from "@/lib/pending-input";

export type { ExtensionDialogRequest, ExtensionDialogResponse } from "@/lib/pending-input";

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
  const { t } = useI18n();
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

  return (
    <div role="group" aria-label={request.title} style={{ display: "grid", gap: 8, minWidth: 0 }}>
      {request.method === "confirm" && (
        <div style={{ color: "var(--text-muted)", fontSize: 13, lineHeight: 1.55, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
          {request.message}
        </div>
      )}
      {request.method === "select" && (
        <div role="group" aria-label={request.title} style={{ display: "grid", gap: 6, maxHeight: "32vh", overflowY: "auto", overscrollBehavior: "contain" }}>
          {request.options.map((option, index) => {
            const description = request.optionDetails?.[index]?.description;
            return (
              <button
                key={option}
                type="button"
                data-input-choice="true"
                aria-pressed={selectedOptionIndex === index}
                onFocus={() => onSelectOption(index)}
                onClick={() => respond({ value: option })}
                style={{
                  ...buttonStyle,
                  borderColor: selectedOptionIndex === index ? "var(--accent)" : "var(--border)",
                  background: selectedOptionIndex === index ? "var(--bg-hover)" : "var(--bg-panel)",
                }}
              >
                {option}
                {typeof description === "string" && description !== "" && (
                  <span style={{ display: "block", marginTop: 2, color: "var(--text-muted)", fontSize: 12, lineHeight: 1.5, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                    {description}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
      {request.method === "input" && (
        <input
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
          <button type="button" data-input-choice="true" onClick={submit} style={{ ...buttonStyle, textAlign: "center", borderColor: "var(--accent)", background: "var(--accent)", color: "var(--on-accent)" }}>
            {t("chatWindow.confirm")}
          </button>
        ) : request.method !== "select" ? (
          <button type="button" data-input-choice="true" onClick={submit} style={{ ...buttonStyle, textAlign: "center", borderColor: "var(--accent)", background: "var(--accent)", color: "var(--on-accent)" }}>
            {t("chatWindow.submit")}
          </button>
        ) : null}
      </div>
    </div>
  );
}
