"use client";

import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type RefObject } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, CircleHelp } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { PermissionRequestCard } from "./PermissionRequestCard";
import { ExtensionInputCard } from "./ExtensionDialog";
import type { PendingInput, PendingInputResponse, RefusalDecision } from "@/lib/pending-input";

export interface InputDockProps {
  pendingInputs: PendingInput[];
  onRespond: (item: PendingInput, response: PendingInputResponse) => void | Promise<void>;
  composerRef: RefObject<HTMLTextAreaElement | null>;
}

function inputKey(item: PendingInput): string {
  switch (item.kind) {
    case "extension": return "extension:" + item.request.id;
    case "permission": return "permission:" + item.request.requestId;
    case "refusal": return "refusal:" + item.decision.id;
  }
}

function requestTitle(item: PendingInput, t: ReturnType<typeof useI18n>["t"]): string {
  switch (item.kind) {
    case "extension": return item.request.title;
    case "permission": return t("permissionRequest.heading");
    case "refusal": return t("refusal.title");
  }
}

function RefusalInputCard({
  decision,
  onChoose,
}: {
  decision: RefusalDecision;
  onChoose: (choice: "rewind" | "continue" | "keep", remember: boolean) => void;
}) {
  const { t } = useI18n();
  const [remember, setRemember] = useState(false);
  useEffect(() => setRemember(false), [decision.id]);

  const choiceButtonStyle: CSSProperties = {
    width: "100%",
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
    <div role="group" aria-label={t("refusal.title")} style={{ display: "grid", gap: 8 }}>
      <p style={{ margin: 0, color: "var(--text-muted)", fontSize: 13, lineHeight: 1.5 }}>
        {t("refusal.explanation", { fromModel: decision.fromModel })}
      </p>
      <button
        type="button"
        data-input-choice="true"
        onClick={() => onChoose("rewind", remember)}
        style={{ ...choiceButtonStyle, borderColor: "var(--accent)", background: "var(--accent)", color: "var(--on-accent)" }}
      >
        {t("refusal.rewind")}
      </button>
      {decision.canContinue && decision.toModel ? (
        <button type="button" data-input-choice="true" onClick={() => onChoose("continue", remember)} style={choiceButtonStyle}>
          {t("refusal.continueWith", { model: decision.toModel })}
        </button>
      ) : (
        <button type="button" data-input-choice="true" onClick={() => onChoose("keep", remember)} style={choiceButtonStyle}>
          {t("refusal.keep")}
        </button>
      )}
      <label style={{ display: "flex", alignItems: "center", gap: 10, minHeight: 48, color: "var(--text-muted)", fontSize: 12, cursor: "pointer" }}>
        <input
          type="checkbox"
          checked={remember}
          onChange={(event) => setRemember(event.target.checked)}
          style={{ width: 18, height: 18, accentColor: "var(--accent)", flexShrink: 0 }}
        />
        {t("refusal.remember")}
      </label>
    </div>
  );
}

export function InputDock({ pendingInputs, onRespond, composerRef }: InputDockProps) {
  const { t } = useI18n();
  const rootRef = useRef<HTMLElement>(null);
  const focusTargetRef = useRef<HTMLButtonElement>(null);
  const previousKeyRef = useRef<string | null>(null);
  const [minimized, setMinimized] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [selectedOptionIndex, setSelectedOptionIndex] = useState(0);

  const safeIndex = pendingInputs.length ? Math.min(activeIndex, pendingInputs.length - 1) : 0;
  const item = pendingInputs[safeIndex] ?? null;
  const itemIdentity = item ? inputKey(item) : null;
  const total = pendingInputs.length;

  useEffect(() => {
    if (activeIndex !== safeIndex) setActiveIndex(safeIndex);
  }, [activeIndex, safeIndex]);

  useEffect(() => {
    setSelectedOptionIndex(0);
  }, [itemIdentity]);

  useEffect(() => {
    if (!itemIdentity) {
      previousKeyRef.current = null;
      return;
    }
    if (previousKeyRef.current === itemIdentity) return;
    previousKeyRef.current = itemIdentity;
    const composer = composerRef.current;
    if (minimized || !composer || composer.value !== "" || document.activeElement === composer) return;
    requestAnimationFrame(() => {
      if (document.activeElement === composer || composer.value !== "") return;
      const target = rootRef.current?.querySelector<HTMLElement>('[data-input-choice="true"]') ?? focusTargetRef.current;
      target?.focus({ preventScroll: true });
    });
  }, [composerRef, itemIdentity, minimized]);

  if (!item) return null;

  const respond = (response: PendingInputResponse) => {
    void onRespond(item, response);
  };

  const onDockKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    const editable = target.closest("input, textarea, [contenteditable='true']");

    if (event.key === "Escape") {
      if (item.kind === "extension") {
        event.preventDefault();
        respond({ kind: "extension", response: { cancelled: true } });
      }
      return;
    }
    if (editable) return;

    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      if (total > 1) {
        event.preventDefault();
        setActiveIndex((index) => (index + (event.key === "ArrowRight" ? 1 : -1) + total) % total);
      }
      return;
    }

    const choices = [...(rootRef.current?.querySelectorAll<HTMLButtonElement>('[data-input-choice="true"]') ?? [])];
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (choices.length === 0) return;
      event.preventDefault();
      const current = choices.indexOf(document.activeElement as HTMLButtonElement);
      const next = (current + (event.key === "ArrowDown" ? 1 : -1) + choices.length) % choices.length;
      choices[next]?.focus({ preventScroll: true });
      if (item.kind === "extension" && item.request.method === "select") setSelectedOptionIndex(next);
      return;
    }
    if (/^[1-9]$/.test(event.key)) {
      const choice = choices[Number(event.key) - 1];
      if (choice) {
        event.preventDefault();
        choice.click();
      }
      return;
    }
    if (event.key === "Enter" && target === event.currentTarget) {
      const firstChoice = choices[0];
      if (firstChoice) {
        event.preventDefault();
        firstChoice.click();
      }
    }
  };

  const selectRequest = (delta: number) => setActiveIndex((index) => (index + delta + total) % total);
  const position = total > 1 ? t("inputDock.position", { current: safeIndex + 1, total }) : null;

  return (
    <section
      ref={rootRef}
      data-testid="input-dock"
      role="region"
      aria-label={t("inputDock.heading")}
      aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown 1-9 Enter Escape"
      onKeyDown={onDockKeyDown}
      style={{
        margin: "-12px -12px 10px -14px",
        padding: "4px 8px 8px 12px",
        borderBottom: "1px solid var(--border)",
        borderRadius: "var(--radius-card) var(--radius-card) 0 0",
        minWidth: 0,
      }}
    >
      {minimized ? (
        <button
          type="button"
          onClick={() => setMinimized(false)}
          aria-label={t("inputDock.expand")}
          aria-expanded={false}
          style={{
            width: "100%",
            minHeight: 48,
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "0 8px",
            border: 0,
            borderRadius: "var(--radius-control)",
            background: "transparent",
            color: "var(--text)",
            cursor: "pointer",
            textAlign: "left",
            font: "inherit",
          }}
        >
          <CircleHelp size={17} color="var(--accent)" aria-hidden="true" />
          <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 13, fontWeight: 600 }}>
            {t("inputDock.waiting")}
          </span>
          {position && <span style={{ color: "var(--text-dim)", fontSize: 11, fontVariantNumeric: "tabular-nums" }}>{position}</span>}
          <ChevronDown size={16} color="var(--text-muted)" aria-hidden="true" />
        </button>
      ) : (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 4, minHeight: 48, minWidth: 0 }}>
            <CircleHelp size={17} color="var(--accent)" aria-hidden="true" style={{ flexShrink: 0, marginLeft: 4 }} />
            <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", justifyContent: "center", gap: 2 }}>
              <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.04em", color: "var(--accent)", textTransform: "uppercase" }}>{t("inputDock.heading")}</span>
              <span title={requestTitle(item, t)} style={{ color: "var(--text-muted)", fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {requestTitle(item, t)}
              </span>
            </span>
            {position && <span style={{ flexShrink: 0, color: "var(--text-dim)", fontSize: 11, fontVariantNumeric: "tabular-nums" }}>{position}</span>}
            {total > 1 && (
              <>
                <button type="button" onClick={() => selectRequest(-1)} aria-label={t("inputDock.previous")} title={t("inputDock.previous")} style={headerButtonStyle}>
                  <ChevronLeft size={16} aria-hidden="true" />
                </button>
                <button type="button" onClick={() => selectRequest(1)} aria-label={t("inputDock.next")} title={t("inputDock.next")} style={headerButtonStyle}>
                  <ChevronRight size={16} aria-hidden="true" />
                </button>
              </>
            )}
            <button ref={focusTargetRef} type="button" onClick={() => setMinimized(true)} aria-label={t("inputDock.minimize")} title={t("inputDock.minimize")} aria-expanded={true} style={headerButtonStyle}>
              <ChevronDown size={16} aria-hidden="true" />
            </button>
          </div>
          <div style={{ maxHeight: "calc(40vh - 56px)", overflowY: "auto", overscrollBehavior: "contain", padding: "0 4px 2px", minWidth: 0 }}>
            {item.kind === "extension" && (
              <ExtensionInputCard
                key={item.request.id}
                request={item.request}
                selectedOptionIndex={selectedOptionIndex}
                onSelectOption={setSelectedOptionIndex}
                onRespond={(response) => respond({ kind: "extension", response })}
              />
            )}
            {item.kind === "permission" && (
              <PermissionRequestCard
                key={item.request.requestId}
                request={item.request}
                onRespond={(_requestId, optionId) => respond({ kind: "permission", optionId })}
              />
            )}
            {item.kind === "refusal" && (
              <RefusalInputCard
                key={item.decision.id}
                decision={item.decision}
                onChoose={(choice, remember) => respond({ kind: "refusal", choice, remember })}
              />
            )}
          </div>
        </>
      )}
    </section>
  );
}

const headerButtonStyle: CSSProperties = {
  width: 48,
  height: 48,
  minWidth: 48,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  border: "1px solid transparent",
  borderRadius: "var(--radius-control)",
  background: "transparent",
  color: "var(--text-muted)",
  cursor: "pointer",
  flexShrink: 0,
};
