"use client";

/**
 * "Change model" in the helper window: stop THIS helper and have the main
 * agent start the job again on the model you pick. omp cannot change the
 * model of a helper that is already running, so a switch is always
 * "stop, then start again"; the server side (lib/omp/agent-switch.ts, behind
 * POST /api/agent/<id>/switch-helper) stops the helper, tells the main agent,
 * and leaves a line in the chat saying you did it.
 *
 * Unticked, the choice covers just that one restart (an extension in the chat
 * swaps the model as the helper starts; omp 18.19+). Ticked, it is also saved
 * as the model for every later helper of that kind (Settings › Models ›
 * Helper agents), which works on any omp. An engine too old for the extension
 * only offers the ticked form, and the panel says why.
 */
import { ArrowLeftRight, Loader2 } from "lucide-react";
import { useMemo, useState } from "react";
import { Check } from "@/components/ui/field";
import { Select } from "@/components/ui/Select";
import { toast } from "@/components/ui/toast";
import { useHelperChoices } from "@/hooks/useHelperChoices";
import { invalidateSettingsRoutes, useSettingsRoute } from "@/hooks/useSettingsData";
import { describeHelperSelector, helperOptionGroups, helperSelectorOf, type HelperOptionWords } from "@/lib/helper-agents";
import { useI18n } from "@/lib/i18n";

const AGENTS_ROUTE = "/api/omp-agents";

interface SwitchAnswer {
  ok?: boolean;
  told?: boolean;
  error?: string;
  code?: string;
  settingSaved?: boolean;
}

/** The server's refusal codes, as the sentence a person needs. */
const REFUSAL_KEYS: Readonly<Record<string, string>> = {
  already_finished: "subagentTranscript.switchFinished",
  needs_setting: "subagentTranscript.switchNeedsSetting",
  no_scratch: "subagentTranscript.switchNoScratch",
  session_not_running: "subagentTranscript.switchNotRunning",
};

export function SubagentModelSwitch({ sessionId, subagentId, agent, transcriptPath }: {
  sessionId: string;
  subagentId: string;
  agent: string;
  /** Where the helper's transcript is, so the main agent can read what it already did. */
  transcriptPath?: string;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<string | null>(null);
  const [keep, setKeep] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const { input } = useHelperChoices(open);
  // Only read once the panel is open: the list is not free to build and most dialogs never use this.
  const agents = useSettingsRoute<{ canSwitchOnce?: boolean }>(AGENTS_ROUTE, { enabled: open });
  const mustKeep = agents.data?.canSwitchOnce === false;
  const words = useMemo<HelperOptionWords>(
    () => ({
      groupRoles: t("subagentTranscript.switchGroupRoles"),
      groupModels: t("subagentTranscript.switchGroupModels"),
      groupCurrent: t("subagentTranscript.switchGroupCurrent"),
      roleModel: (model) => t("subagentTranscript.switchRoleModel", { model }),
      roleEngineChoice: t("subagentTranscript.switchRoleEngine"),
      custom: (selector) => t("subagentTranscript.switchCustom", { selector }),
    }),
    [t],
  );
  const groups = useMemo(() => helperOptionGroups({ ...input, words }), [input, words]);
  const selector = choice === null ? null : helperSelectorOf(choice);

  const refusal = (answer: SwitchAnswer): string => {
    const key = answer.code ? REFUSAL_KEYS[answer.code] : undefined;
    if (!key) return answer.error ?? t("subagentTranscript.switchFailed");
    const sentence = t(key, { agent });
    return answer.code === "already_finished" && answer.settingSaved ? `${sentence} ${t("subagentTranscript.switchFinishedSaved", { agent })}` : sentence;
  };

  const run = async () => {
    if (!selector || busy) return;
    setBusy(true);
    setProblem(null);
    try {
      const response = await fetch(`/api/agent/${encodeURIComponent(sessionId)}/switch-helper`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subagentId, agent, model: selector, alsoFuture: keep || mustKeep, ...(transcriptPath ? { transcriptPath } : {}) }),
      });
      const answer = (await response.json().catch(() => ({}))) as SwitchAnswer;
      if (answer.settingSaved || (response.ok && (keep || mustKeep))) invalidateSettingsRoutes(AGENTS_ROUTE, { exact: true });
      if (!response.ok || answer.error) {
        setProblem(refusal(answer));
        return;
      }
      const model = describeHelperSelector(selector, input);
      if (answer.told === false) toast.error(t("subagentTranscript.switchNotTold", { model }));
      else toast.success(t("subagentTranscript.switchDone", { model }), t("subagentTranscript.switchDoneDetail"));
      setOpen(false);
      setChoice(null);
      setKeep(false);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : t("subagentTranscript.switchFailed"));
    } finally {
      setBusy(false);
    }
  };

  const buttonBase = { minHeight: 32, padding: "6px 12px", borderRadius: "var(--radius-control)", fontSize: 12, touchAction: "manipulation" } as const;

  return (
    <section aria-label={t("subagentTranscript.switchTitle")} data-subagent-model-switch style={{ flexShrink: 0, padding: "0 18px 8px", minWidth: 0 }}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="ui-focus-ring"
        style={{ display: "inline-flex", alignItems: "center", gap: 6, minHeight: 28, padding: 0, background: "none", border: "none", cursor: "pointer", fontSize: 11.5, color: "var(--accent)", touchAction: "manipulation" }}
      >
        <ArrowLeftRight size={12} aria-hidden="true" />
        {t("subagentTranscript.switchOpen")}
      </button>
      {open && (
        <div style={{ display: "grid", gap: 8, marginTop: 4, padding: "10px 12px", border: "1px solid var(--border)", borderRadius: "var(--radius-card)", background: "var(--bg-panel)" }}>
          <p style={{ margin: 0, fontSize: 11, lineHeight: 1.45, color: "var(--text-muted)" }}>{t("subagentTranscript.switchExplain")}</p>
          <Select
            value={choice}
            onChange={setChoice}
            options={groups}
            placeholder={t("subagentTranscript.switchPlaceholder")}
            aria-label={t("subagentTranscript.switchModelLabel")}
            disabled={busy}
            search={{ placeholder: t("subagentTranscript.switchSearch"), empty: t("subagentTranscript.switchSearchEmpty") }}
          />
          <div style={{ display: "grid", gap: 3 }}>
            <Check label={t("subagentTranscript.switchKeep", { agent })} checked={keep || mustKeep} onChange={setKeep} disabled={busy || mustKeep} />
            <span style={{ fontSize: 10.5, lineHeight: 1.4, color: "var(--text-dim)" }}>
              {mustKeep ? t("subagentTranscript.switchKeepRequired", { agent }) : t("subagentTranscript.switchKeepHelp")}
            </span>
          </div>
          {problem && <div role="alert" style={{ fontSize: 11.5, lineHeight: 1.4, color: "var(--status-error)", wordBreak: "break-word" }}>{problem}</div>}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={() => { void run(); }}
              disabled={!selector || busy}
              className="ui-focus-ring"
              style={{ ...buttonBase, display: "inline-flex", alignItems: "center", gap: 6, border: "none", fontWeight: 600, background: selector && !busy ? "var(--accent)" : "var(--bg-hover)", color: selector && !busy ? "var(--on-accent)" : "var(--text-dim)", cursor: busy ? "wait" : selector ? "pointer" : "default" }}
            >
              {busy && <Loader2 size={13} aria-hidden="true" className="icon-spin" />}
              {busy ? t("subagentTranscript.switchBusy") : t("subagentTranscript.switchConfirm")}
            </button>
            <button
              type="button"
              onClick={() => { setOpen(false); setProblem(null); }}
              disabled={busy}
              className="ui-focus-ring"
              style={{ ...buttonBase, background: "none", border: "1px solid var(--border)", color: "var(--text-muted)", cursor: busy ? "default" : "pointer" }}
            >
              {t("subagentTranscript.switchNotNow")}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
