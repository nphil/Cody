"use client";

import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent, type Ref } from "react";
import { ChevronDown, MessageCircleQuestion } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { useCopyFeedback } from "@/hooks/useCopyFeedback";
import {
  btwCopyText, btwTurns, canFollowUpBtw, isBtwRunning, latestBtwTurn,
  type BtwRecord, type BtwStatus, type BtwTurn,
} from "@/lib/btw";
import { MarkdownBody } from "./MarkdownBody";

export interface SideQuestionsPanelProps {
  /** Every topic, newest first. */
  records: readonly BtwRecord[];
  /** The main agent is mid-run: the slim bar shows even with no topics. */
  runActive: boolean;
  /** Some topic's latest turn is being answered (omp runs one at a time). */
  answering: boolean;
  /** A question was sent and the engine has not acknowledged it yet. */
  asking: boolean;
  /** Body shown. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Last failure, already in plain words. */
  error: string | null;
  onDismissError: () => void;
  /** Bumps when something outside wants the new-question box focused. */
  focusRequest: number;
  /** true = accepted (the box is cleared); false = refused (the text is kept). */
  onAsk: (question: string, recordId?: string) => Promise<boolean>;
  onCancel: (recordId: string) => void;
  /** Base directory for file links in answers. */
  cwd?: string;
}

/** Topics shown before the footer link folds the rest. */
const MAX_VISIBLE_TOPICS = 3;
/** Same ceiling as SafeMarkdownBody: beyond it the markdown pipeline is skipped. */
const MAX_MARKDOWN_CHARS = 100_000;

const STATUS_KEYS: Record<BtwStatus, string> = {
  running: "btw.statusRunning",
  complete: "btw.statusComplete",
  cancelled: "btw.statusCancelled",
  error: "btw.statusError",
  interrupted: "btw.statusInterrupted",
};

/** 38px is the phone tap-target floor; 16px keeps iOS from zooming on focus. */
const CONTROL_HEIGHT = 38;

const buttonStyle = {
  minHeight: CONTROL_HEIGHT,
  padding: "0 12px",
  fontSize: 12,
  fontFamily: "inherit",
  whiteSpace: "nowrap",
  flexShrink: 0,
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-control)",
  background: "var(--bg)",
  color: "var(--text-muted)",
  cursor: "pointer",
  transition: "background var(--dur-fast) var(--ease-out-warm), color var(--dur-fast) var(--ease-out-warm)",
} as const;

const inputStyle = {
  flex: 1,
  minWidth: 0,
  minHeight: CONTROL_HEIGHT,
  padding: "0 10px",
  fontSize: 16,
  fontFamily: "inherit",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-control)",
  background: "var(--bg)",
  color: "var(--text)",
} as const;

function LiveDot() {
  return <span aria-hidden className="live-status-dot live-pulse inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />;
}

/** One text box + submit button. Clears itself when the ask is accepted, keeps the text when refused. */
function AskForm({ value, onChange, onSubmit, disabled, placeholder, label, buttonLabel, inputRef }: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (text: string) => Promise<boolean>;
  disabled: boolean;
  placeholder: string;
  label: string;
  buttonLabel: string;
  inputRef?: Ref<HTMLInputElement>;
}) {
  const submitting = useRef(false);
  const blank = value.trim() === "";

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const text = value.trim();
    if (!text || disabled || submitting.current) return;
    submitting.current = true;
    try {
      if (await onSubmit(text)) onChange("");
    } finally {
      submitting.current = false;
    }
  };

  return (
    <form onSubmit={submit} className="flex items-center gap-2" style={{ minWidth: 0 }}>
      <input
        ref={inputRef}
        type="text"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={label}
        autoComplete="off"
        enterKeyHint="send"
        className="ui-focus-ring"
        style={{ ...inputStyle, opacity: disabled ? 0.6 : 1 }}
      />
      <button
        type="submit"
        disabled={disabled || blank}
        className="ui-focus-ring"
        style={{
          ...buttonStyle,
          color: "var(--accent)",
          opacity: disabled || blank ? 0.5 : 1,
          cursor: disabled || blank ? "not-allowed" : "pointer",
        }}
      >
        {buttonLabel}
      </button>
    </form>
  );
}

function BtwTurnView({ turn, cwd }: { turn: BtwTurn; cwd?: string }) {
  const { t } = useI18n();
  const running = turn.status === "running";
  return (
    <div className="flex flex-col gap-1.5" style={{ minWidth: 0 }}>
      <blockquote
        className="text-text-muted"
        style={{
          margin: 0,
          padding: "2px 0 2px 9px",
          borderLeft: "2px solid var(--border)",
          fontSize: 12.5,
          fontStyle: "italic",
          overflowWrap: "anywhere",
          whiteSpace: "pre-wrap",
        }}
      >
        <span className="sr-only">{t("btw.questionLabel")}: </span>
        {turn.question}
      </blockquote>
      {turn.answer.length > MAX_MARKDOWN_CHARS ? (
        <pre
          style={{
            margin: 0, padding: "6px 8px", maxHeight: 320, overflow: "auto", whiteSpace: "pre-wrap",
            overflowWrap: "anywhere", fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-muted)",
          }}
        >
          {turn.answer}
        </pre>
      ) : turn.answer ? (
        <div style={{ fontSize: 13, lineHeight: 1.55, minWidth: 0, overflowWrap: "anywhere" }}>
          <MarkdownBody isStreaming={running} cwd={cwd}>{turn.answer}</MarkdownBody>
        </div>
      ) : running ? (
        <p className="text-text-dim" style={{ margin: 0, fontSize: 12.5 }}>{t("btw.noAnswerYet")}</p>
      ) : null}
      {turn.status === "cancelled" && (
        <p className="text-text-dim" style={{ margin: 0, fontSize: 12 }}>{t("btw.cancelledNote")}</p>
      )}
      {turn.status === "interrupted" && (
        <p className="text-text-dim" style={{ margin: 0, fontSize: 12 }}>{t("btw.interruptedNote")}</p>
      )}
      {turn.status === "error" && (
        <p style={{ margin: 0, fontSize: 12, color: "var(--status-error)", overflowWrap: "anywhere" }}>
          {turn.error ? t("btw.failedNote", { message: turn.error }) : t("btw.failedNoDetail")}
        </p>
      )}
    </div>
  );
}

const BtwTopicCard = memo(function BtwTopicCard({ record, cwd, busy, draft, onDraftChange, onFollowUp, onCancel }: {
  record: BtwRecord;
  cwd?: string;
  /** Another question is being asked or answered: no follow-up form. */
  busy: boolean;
  draft: string;
  onDraftChange: (recordId: string, value: string) => void;
  onFollowUp: (recordId: string, text: string) => Promise<boolean>;
  onCancel: (recordId: string) => void;
}) {
  const { t } = useI18n();
  const { copied, copy } = useCopyFeedback();
  const latest = latestBtwTurn(record);
  const running = isBtwRunning(record);
  const copyValue = useMemo(() => btwCopyText(record), [record]);
  const showFollowUp = !busy && canFollowUpBtw(record);
  const changeDraft = useCallback((value: string) => onDraftChange(record.id, value), [onDraftChange, record.id]);
  const submitFollowUp = useCallback((text: string) => onFollowUp(record.id, text), [onFollowUp, record.id]);

  return (
    <article
      className="flex flex-col gap-2"
      style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg)", padding: "8px 10px", minWidth: 0 }}
    >
      {btwTurns(record).map((turn, index) => (
        <BtwTurnView key={index} turn={turn} cwd={cwd} />
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <span
          className="inline-flex items-center gap-1.5 text-text-dim"
          style={{ fontSize: 11.5, marginRight: "auto", color: latest.status === "error" ? "var(--status-error)" : undefined }}
        >
          {running && <LiveDot />}
          {t(STATUS_KEYS[latest.status])}
        </span>
        {running && (
          <button
            type="button"
            onClick={() => onCancel(record.id)}
            title={t("btw.cancelTitle")}
            className="ui-focus-ring"
            style={buttonStyle}
          >
            {t("btw.cancel")}
          </button>
        )}
        {copyValue !== undefined && (
          <button
            type="button"
            onClick={() => copy(copyValue)}
            title={t("btw.copyTitle")}
            className="ui-focus-ring"
            style={buttonStyle}
          >
            {copied ? t("btw.copied") : t("btw.copy")}
          </button>
        )}
      </div>
      {showFollowUp && (
        <AskForm
          value={draft}
          onChange={changeDraft}
          onSubmit={submitFollowUp}
          disabled={false}
          placeholder={t("btw.followUpPlaceholder")}
          label={t("btw.followUpLabel")}
          buttonLabel={t("btw.followUp")}
        />
      )}
    </article>
  );
});

/**
 * Side questions (/btw): a composer-attached card, same family as the todo and
 * subagent panels. Presentational only — every piece of state that matters
 * (topics, open, error, busy flags) lives in `useSideQuestions`; this keeps
 * just the text drafts, the "show all" fold and focus.
 */
export const SideQuestionsPanel = memo(function SideQuestionsPanel({
  records, runActive, answering, asking, open, onOpenChange, error, onDismissError,
  focusRequest, onAsk, onCancel, cwd,
}: SideQuestionsPanelProps) {
  const { t, tn } = useI18n();
  const bodyId = useId();
  const [showAll, setShowAll] = useState(false);
  const [askDraft, setAskDraft] = useState("");
  const [followUpDrafts, setFollowUpDrafts] = useState<Record<string, string>>({});
  const inputRef = useRef<HTMLInputElement>(null);
  const pendingFocus = useRef(false);
  const seenFocusRequest = useRef(focusRequest);
  const busy = asking || answering;

  // Callbacks come from the hook and may change identity every render; the
  // memoised topic cards must not, or each streamed frame re-renders them all.
  const onAskRef = useRef(onAsk);
  const onCancelRef = useRef(onCancel);
  useEffect(() => {
    onAskRef.current = onAsk;
    onCancelRef.current = onCancel;
  });
  const askNewTopic = useCallback((text: string) => onAskRef.current(text), []);
  const askFollowUp = useCallback((recordId: string, text: string) => onAskRef.current(text, recordId), []);
  const cancelTopic = useCallback((recordId: string) => onCancelRef.current(recordId), []);
  const changeDraft = useCallback((recordId: string, value: string) => {
    setFollowUpDrafts((drafts) => {
      if (value === "") {
        if (!(recordId in drafts)) return drafts;
        const { [recordId]: _removed, ...rest } = drafts;
        return rest;
      }
      return drafts[recordId] === value ? drafts : { ...drafts, [recordId]: value };
    });
  }, []);

  // An outside request to focus the box is remembered until the box exists
  // (the panel may still be collapsed when it arrives).
  useEffect(() => {
    if (focusRequest === seenFocusRequest.current) return;
    seenFocusRequest.current = focusRequest;
    pendingFocus.current = true;
  }, [focusRequest]);
  useEffect(() => {
    if (!pendingFocus.current || !open) return;
    const input = inputRef.current;
    if (!input) return;
    pendingFocus.current = false;
    if (!input.disabled) input.focus();
  }, [open, focusRequest, busy]);

  // An emptied list is a new chat: fold the list again.
  const empty = records.length === 0;
  useEffect(() => {
    if (empty) setShowAll(false);
  }, [empty]);

  if (empty && !runActive && !open && !error) return null;

  const visible = showAll ? records : records.slice(0, MAX_VISIBLE_TOPICS);
  const truncatable = records.length > MAX_VISIBLE_TOPICS;
  const collapsedError = !open && error ? error : null;

  const toggle = () => {
    if (!open) pendingFocus.current = true;
    onOpenChange(!open);
  };

  return (
    <section
      aria-label={t("btw.panelTitle")}
      className="overflow-hidden border border-border bg-bg-subtle"
      style={{ borderRadius: "var(--radius-card)", width: "100%", marginBottom: 8 }}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={toggle}
        title={open ? t("chatWindow.collapsePanel") : t("chatWindow.expandPanel")}
        className={`ui-focus-ring flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-xs text-text-muted ${open ? "border-b border-border" : ""}`}
        style={{ background: "none", minHeight: CONTROL_HEIGHT, flexWrap: "nowrap" }}
      >
        <MessageCircleQuestion size={14} strokeWidth={1.8} aria-hidden className="shrink-0" />
        <strong className="shrink-0 whitespace-nowrap font-medium text-text">{t("btw.panelTitle")}</strong>
        <span
          className="ml-auto inline-flex min-w-0 items-center gap-1.5"
          style={{ color: collapsedError ? "var(--status-error)" : undefined }}
        >
          {collapsedError ? (
            <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap" title={collapsedError}>{collapsedError}</span>
          ) : answering ? (
            <>
              <LiveDot />
              <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{t("btw.statusRunning")}</span>
            </>
          ) : records.length > 0 ? (
            <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{tn("btw.summaryTopics", records.length)}</span>
          ) : !open ? (
            // Nothing to summarise yet: the bar reads as the box it opens.
            <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-text-dim">{t("btw.askPlaceholder")}</span>
          ) : null}
        </span>
        <ChevronDown
          size={14}
          strokeWidth={1.8}
          aria-hidden
          className="shrink-0"
          style={{
            color: "var(--text-dim)",
            transform: open ? "rotate(0deg)" : "rotate(-90deg)",
            transition: "transform var(--dur-fast) var(--ease-out-warm)",
          }}
        />
      </button>
      {open && (
        <div
          id={bodyId}
          className="flex flex-col gap-2 px-3 py-2.5"
          style={{ maxHeight: "min(36vh, 320px)", overflowY: "auto", overscrollBehavior: "contain" }}
        >
          {empty && <p className="text-text-dim" style={{ margin: 0, fontSize: 12.5, lineHeight: 1.5 }}>{t("btw.panelHint")}</p>}
          <AskForm
            value={askDraft}
            onChange={setAskDraft}
            onSubmit={askNewTopic}
            disabled={busy}
            placeholder={t("btw.askPlaceholder")}
            label={t("btw.askLabel")}
            buttonLabel={asking ? t("btw.asking") : t("btw.ask")}
            inputRef={inputRef}
          />
          {error && (
            <div
              role="alert"
              className="flex items-center gap-2"
              style={{ fontSize: 12.5, color: "var(--status-error)" }}
            >
              <span style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>{error}</span>
              <button type="button" onClick={onDismissError} className="ui-focus-ring" style={buttonStyle}>
                {t("btw.dismiss")}
              </button>
            </div>
          )}
          {visible.map((record) => (
            <BtwTopicCard
              key={record.id}
              record={record}
              cwd={cwd}
              busy={busy}
              draft={followUpDrafts[record.id] ?? ""}
              onDraftChange={changeDraft}
              onFollowUp={askFollowUp}
              onCancel={cancelTopic}
            />
          ))}
        </div>
      )}
      {open && truncatable && (
        <button
          type="button"
          className="ui-focus-ring w-full cursor-pointer border-t border-border bg-transparent px-3 py-2 text-left text-xs text-accent hover:text-accent-hover"
          style={{ minHeight: CONTROL_HEIGHT }}
          aria-expanded={showAll}
          onClick={() => setShowAll((value) => !value)}
        >
          {showAll ? t("btw.showFewer") : t("btw.showAll", { count: records.length })}
        </button>
      )}
    </section>
  );
});
