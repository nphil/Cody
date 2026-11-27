"use client";

import { Terminal } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { sendWirelessShell, WirelessRequestError, type WirelessShellResult } from "@/lib/devices/wireless-browser";
import { WIRELESS_MAX_COMMAND_CHARS, type WirelessShellAction } from "@/lib/devices/wireless-types";
import { useI18n } from "@/lib/i18n";
import { Button, Disclosure, Notice, TextField } from "./ui";

type ShellRun = { state: "running" } | { state: "failed"; message: string; code?: string } | { state: "done"; result: WirelessShellResult };

/** Only for commands the person types here. A change of chat or loss of connection unmounts it, dropping the local output. */
export function WirelessShell({ sessionId, selectionId, disabled }: { sessionId: string; selectionId: string; disabled: boolean }): React.ReactElement {
  const { t } = useI18n();
  const [command, setCommand] = useState("");
  const [pendingReview, setReview] = useState<Omit<WirelessShellAction, "rootCapableConfirmed"> | null>(null);
  const review = pendingReview?.selectionId === selectionId && pendingReview.sessionId === sessionId ? pendingReview : null;
  const [run, setRun] = useState<ShellRun | null>(null);
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);

  const malformed = /[\p{C}\p{Zl}\p{Zp}]/u.test(command);
  const showReview = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (disabled || !command.trim() || malformed || active.current) return;
    setRun(null);
    setReview({ sessionId, selectionId, command });
  };

  const confirm = async (): Promise<void> => {
    if (!review || disabled || active.current) return;
    const request = new AbortController();
    active.current = request;
    setRun({ state: "running" });
    setReview(null);
    setCommand("");
    try {
      const result = await sendWirelessShell({ ...review, rootCapableConfirmed: true }, request.signal);
      if (!request.signal.aborted) setRun({ state: "done", result });
    } catch (error) {
      if (!request.signal.aborted) setRun({
        state: "failed",
        message: error instanceof Error ? error.message : String(error),
        code: error instanceof WirelessRequestError ? error.code : undefined,
      });
    } finally {
      active.current = null;
    }
  };

  const locked = disabled || run?.state === "running";
  return (
    <Disclosure summary={t("devices.wirelessShellTitle")}>
      {review ? (
        <WirelessShellReview command={review.command} locked={locked} onBack={() => setReview(null)} onRun={() => void confirm()} />
      ) : (
        <form onSubmit={showReview} autoComplete="off" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <TextField
            label={t("devices.wirelessShellCommand")}
            hint={t(malformed ? "devices.wirelessShellPrintable" : "devices.wirelessShellHint")}
            aria-invalid={malformed}
            value={command}
            onChange={(event) => setCommand(event.currentTarget.value)}
            disabled={locked}
            maxLength={WIRELESS_MAX_COMMAND_CHARS}
            autoComplete="off"
            mono
          />
          <Button type="submit" full icon={<Terminal size={16} />} disabled={locked || malformed || !command.trim()}>
            {t(run?.state === "running" ? "devices.wirelessShellRunning" : "devices.wirelessShellReview")}
          </Button>
        </form>
      )}
      {run?.state === "failed" && (
        <Notice tone="error" role="alert">{run.code === "secure_context_required" ? t("devices.wirelessSecurePage") : run.message}</Notice>
      )}
      {run?.state === "done" && <WirelessShellOutput result={run.result} />}
    </Disclosure>
  );
}

export function WirelessShellReview({ command, locked, onBack, onRun }: { command: string; locked: boolean; onBack: () => void; onRun: () => void }): React.ReactElement {
  const { t } = useI18n();
  return (
    <>
      <Output title={t("devices.wirelessShellCommand")} text={command} />
      <Notice tone="warning">{t("devices.wirelessCommandRisk")}</Notice>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <Button autoFocus onClick={onBack} disabled={locked} style={{ flex: "1 1 100px" }}>{t("devices.wirelessShellBack")}</Button>
        <Button tone="warning" onClick={onRun} disabled={locked} style={{ flex: "1 1 150px" }}>{t("devices.wirelessShellRun")}</Button>
      </div>
    </>
  );
}

export function WirelessShellOutput({ result }: { result: WirelessShellResult }): React.ReactElement {
  const { t } = useI18n();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
      <span role="status" style={{ fontSize: 12, color: result.exitCode === 0 ? "var(--status-success)" : "var(--status-warning)" }}>
        {t("devices.wirelessShellExit", { code: result.exitCode })}
      </span>
      {result.stdout && <Output title={t("devices.wirelessShellOutput")} text={result.stdout} />}
      {result.stderr && <Output title={t("devices.wirelessShellErrors")} text={result.stderr} />}
    </div>
  );
}

function Output({ title, text }: { title: string; text: string }): React.ReactElement {
  return (
    <div style={{ minWidth: 0 }}>
      <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{title}</span>
      <pre tabIndex={0} aria-label={title} dir="ltr" style={{ margin: "4px 0 0", padding: "8px 10px", maxHeight: 160, overflow: "auto", background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", fontFamily: "var(--font-mono)", fontSize: 12, lineHeight: 1.45, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
        {text}
      </pre>
    </div>
  );
}
