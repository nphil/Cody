"use client";

import { ArrowLeft, ArrowRight, Check, Loader2 } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useI18n } from "@/lib/i18n";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/primitives";
import { DefaultModelStep, ProvidersStep, SignInStep, ThemeStep, WebSearchStep, getWizardSteps, type WizardStepId } from "./setup-wizard-steps";
import type { EngineSummary } from "./EnginePicker";

/**
 * The post-onboarding setup wizard, hosted as a dialog INSIDE the main app
 * view (the app shell stays visible behind it — this is a Cody feature, not
 * part of account creation). The flow mirrors the active engine's own
 * onboarding — for omp that is its TUI setup wizard: providers (sign-in and
 * local endpoints), web search provider, default model, theme. Step sets are
 * per-engine via getWizardSteps; every step writes through the same routes
 * Settings uses, so skipping the wizard and configuring manually in Settings
 * is always equivalent.
 *
 * Finish and "Skip setup" persist server-side (the wizard never re-offers);
 * dismissing the dialog only hides it for this page load.
 */

export function SetupWizard({ engine, hasModelsUi, onDone, onDismiss }: {
  engine: EngineSummary | null;
  hasModelsUi: boolean;
  /** Finished or skipped: persisted, never offered again. */
  onDone: () => void;
  /** Dialog dismissed (X / backdrop / Esc): hide for now, offer again later. */
  onDismiss: () => void;
}) {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const steps = useMemo(() => getWizardSteps(engine?.id ?? null, hasModelsUi), [engine?.id, hasModelsUi]);
  const [stepIndex, setStepIndex] = useState(0);
  const [finishing, setFinishing] = useState(false);
  const step: WizardStepId = steps[stepIndex] ?? "theme";
  const isLast = stepIndex >= steps.length - 1;

  const finish = useCallback(async () => {
    setFinishing(true);
    // Best-effort: a failed write only means the wizard offers itself again
    // next load, which beats trapping the user here.
    await fetch("/api/engines/setup-complete", { method: "POST" }).catch(() => {});
    onDone();
  }, [onDone]);

  const titles: Record<WizardStepId, { title: string; subtitle: string }> = {
    providers: { title: t("setupWizard.providersTitle"), subtitle: t("setupWizard.providersSubtitle") },
    webSearch: { title: t("setupWizard.webSearchTitle"), subtitle: t("setupWizard.webSearchSubtitle") },
    model: { title: t("setupWizard.modelTitle"), subtitle: t("setupWizard.modelSubtitle") },
    signIn: {
      title: t("setupWizard.authTitle", { name: engine?.shortName ?? "" }).trim(),
      subtitle: t("setupWizard.authSubtitle", { name: engine?.shortName ?? "the engine" }),
    },
    theme: { title: t("setupWizard.themeTitle"), subtitle: t("setupWizard.themeSubtitle") },
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !finishing) onDismiss(); }}>
      <DialogContent
        ariaLabel={t("setupWizard.title")}
        style={{
          width: isMobile ? "calc(100vw - 16px)" : 880,
          maxWidth: "calc(100vw - 16px)",
          height: isMobile ? "calc(100dvh - 16px)" : "80vh",
          maxHeight: "calc(100dvh - 16px)",
          padding: 0,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <div className="setup-wizard-head">
          <DialogTitle style={{ fontSize: 16, margin: 0, fontWeight: 600 }}>{titles[step].title}</DialogTitle>
          <p className="setup-wizard-subtitle">{titles[step].subtitle}</p>
          <p className="setup-wizard-step">
            {t("setupWizard.stepLabel", { current: String(stepIndex + 1), total: String(steps.length) })}
          </p>
        </div>

        <div className="setup-wizard-content">
          {step === "providers" && <ProvidersStep />}
          {step === "webSearch" && <WebSearchStep />}
          {step === "model" && <DefaultModelStep />}
          {step === "signIn" && <SignInStep engine={engine} />}
          {step === "theme" && <ThemeStep />}
        </div>

        <div className="setup-wizard-actions">
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <button type="button" className="engine-link" onClick={() => void finish()} disabled={finishing}>
              {t("setupWizard.skip")}
            </button>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {stepIndex > 0 && (
              <button type="button" className="login-ghost engine-button setup-wizard-btn" onClick={() => setStepIndex((index) => index - 1)} disabled={finishing}>
                <ArrowLeft size={14} aria-hidden /> {t("setupWizard.back")}
              </button>
            )}
            <button
              type="button"
              className="login-primary engine-button setup-wizard-btn"
              onClick={() => (isLast ? void finish() : setStepIndex((index) => index + 1))}
              disabled={finishing}
            >
              {finishing
                ? <Loader2 size={14} aria-hidden style={{ animation: "spin 0.9s linear infinite" }} />
                : isLast ? <Check size={14} aria-hidden /> : <ArrowRight size={14} aria-hidden />}
              {isLast ? t("setupWizard.finish") : t("setupWizard.next")}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
