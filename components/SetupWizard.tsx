"use client";

import dynamic from "next/dynamic";
import { ArrowLeft, ArrowRight, Check, Loader2 } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useI18n } from "@/lib/i18n";
import type { EngineSummary } from "./EnginePicker";

/**
 * The post-onboarding setup wizard: runs once, right after the engine picker,
 * in the same full-screen login design language. Two steps —
 *
 *   1. Providers. For engines with the models capability (omp) this embeds
 *      the real provider editor: OAuth sign-ins (with the paste-the-redirect
 *      fallback), API keys, and custom OpenAI-compatible endpoints with the
 *      Ollama/LM Studio-class presets for local models. Engines that manage
 *      their own auth (Claude Code, Codex) get sign-in guidance instead.
 *   2. A starter primer tuned to the active engine — the handful of things a
 *      newcomer to agent-driven coding actually needs on day one.
 *
 * Finishing (or skipping) POSTs /api/engines/setup-complete, which persists
 * server-side; the wizard never shows again. Everything it offers stays
 * reachable in Settings.
 */

const ModelsConfig = dynamic(() => import("./ModelsConfig").then((module) => module.ModelsConfig), {
  loading: () => (
    <div role="status" style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, height: "100%", color: "var(--text-dim)", fontSize: 12 }}>
      <Loader2 size={14} aria-hidden style={{ animation: "spin 0.9s linear infinite" }} />
    </div>
  ),
});

export function SetupWizard({ engine, hasModelsUi, onDone }: {
  /** The active engine's roster row (name, authHint, experimental). */
  engine: EngineSummary | null;
  /** capabilities.models — whether the provider editor exists for this engine. */
  hasModelsUi: boolean;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const [step, setStep] = useState<"providers" | "primer">("providers");
  const [finishing, setFinishing] = useState(false);

  const finish = useCallback(async () => {
    setFinishing(true);
    // Best-effort: a failed write just means the wizard offers itself again
    // next load, which is strictly better than trapping the user here.
    await fetch("/api/engines/setup-complete", { method: "POST" }).catch(() => {});
    onDone();
  }, [onDone]);

  const primerTips = useMemo(() => {
    if (hasModelsUi) {
      return [
        t("setupWizard.tipOmpModels"),
        t("setupWizard.tipOmpCommands"),
        t("setupWizard.tipOmpCheckpoints"),
        t("setupWizard.tipOmpTerminal"),
        t("setupWizard.tipOmpSettings"),
      ];
    }
    return [
      t("setupWizard.tipCliLogin", { name: engine?.shortName ?? "the engine" }),
      t("setupWizard.tipCliExperimental"),
      t("setupWizard.tipCliCheckpoints"),
      t("setupWizard.tipCliSwitch"),
    ];
  }, [engine?.shortName, hasModelsUi, t]);

  const isLastStep = step === "primer";

  return (
    <div className="engine-overlay" role="dialog" aria-modal="true" aria-label={t("setupWizard.title")}>
      <div className="engine-column setup-wizard-column">
        <div className="engine-brand">
          <div className="login-wordmark" aria-label="Cody">
            <span style={{ color: "var(--accent)" }}>co</span>
            <span style={{ color: "var(--text)" }}>dy</span>
            <span className="login-caret" aria-hidden />
          </div>
        </div>

        <div className="engine-intro">
          <h1 className="engine-title">
            {step === "providers" ? t("setupWizard.providersTitle") : t("setupWizard.primerTitle", { name: engine?.shortName ?? "Cody" })}
          </h1>
          <p className="engine-subtitle">
            {step === "providers"
              ? hasModelsUi ? t("setupWizard.providersSubtitle") : t("setupWizard.authSubtitle", { name: engine?.shortName ?? "the engine" })
              : t("setupWizard.primerSubtitle")}
          </p>
          <p className="setup-wizard-step" aria-label={t("setupWizard.stepLabel", { current: step === "providers" ? "1" : "2", total: "2" })}>
            {t("setupWizard.stepLabel", { current: step === "providers" ? "1" : "2", total: "2" })}
          </p>
        </div>

        {step === "providers" && hasModelsUi && (
          <div className="setup-wizard-body">
            <ModelsConfig embedded onClose={() => {}} />
          </div>
        )}
        {step === "providers" && !hasModelsUi && (
          <div className="setup-wizard-card">
            <p>{engine?.authHint ?? t("setupWizard.authFallback")}</p>
            <p>{t("setupWizard.authTerminalHint")}</p>
          </div>
        )}
        {step === "primer" && (
          <div className="setup-wizard-card">
            <ul className="setup-wizard-tips">
              {primerTips.map((tip) => (
                <li key={tip}>
                  <Check size={13} aria-hidden style={{ color: "var(--accent)", flexShrink: 0, marginTop: 2 }} />
                  <span>{tip}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="setup-wizard-actions">
          {step === "primer" ? (
            <button type="button" className="login-ghost engine-button setup-wizard-btn" onClick={() => setStep("providers")} disabled={finishing}>
              <ArrowLeft size={14} aria-hidden /> {t("setupWizard.back")}
            </button>
          ) : (
            <button type="button" className="engine-link" onClick={() => void finish()} disabled={finishing}>
              {t("setupWizard.skip")}
            </button>
          )}
          <button
            type="button"
            className="login-primary engine-button setup-wizard-btn"
            onClick={() => (isLastStep ? void finish() : setStep("primer"))}
            disabled={finishing}
          >
            {finishing
              ? <Loader2 size={14} aria-hidden style={{ animation: "spin 0.9s linear infinite" }} />
              : isLastStep ? <Check size={14} aria-hidden /> : <ArrowRight size={14} aria-hidden />}
            {isLastStep ? t("setupWizard.finish") : t("setupWizard.next")}
          </button>
        </div>
      </div>
    </div>
  );
}
