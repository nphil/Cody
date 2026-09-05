"use client";

import { useI18n } from "@/lib/i18n";
import { EngineRoster } from "./settings/EngineRoster";

/**
 * The onboarding engine picker: a full-screen step, in the login screen's
 * design language, that runs once per instance right after the first account
 * exists. It answers one question — which coding agent drives this Cody — and
 * it is the only place that answer is asked for before Settings.
 *
 * Mounted by AppShell only when GET /api/engines reports `canManage &&
 * !onboarded`, so it never renders for members or for an instance whose
 * administrator already chose. Picking an engine (or keeping the active one)
 * marks the instance onboarded server-side, which is what retires this screen.
 *
 * The cards, the install (POST /api/engines/install + the events stream) and
 * the selection are `EngineRoster` in "pick" mode — the same component that
 * manages engines under Settings › System, so the path the container smoke
 * gate exercises is the one the administrator clicks through here.
 */

export type { EngineSummary, EnginesPayload } from "./settings/EngineRoster";
import type { EnginesPayload } from "./settings/EngineRoster";

export function EnginePicker({ initial, onDone }: {
  /** Roster AppShell already fetched; the picker refetches only after installs. */
  initial?: EnginesPayload | null;
  /** Called once the selection stuck. `engineChanged` is true when the active
   * engine is not the one the app booted with, so the shell can reload. */
  onDone: (engineChanged: boolean) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="engine-overlay" role="dialog" aria-modal="true" aria-label={t("engines.title")}>
      <div className="engine-column">
        <div className="engine-brand">
          <div className="login-wordmark" aria-label="Cody">
            <span style={{ color: "var(--accent)" }}>co</span>
            <span style={{ color: "var(--text)" }}>dy</span>
            <span className="login-caret" aria-hidden />
          </div>
        </div>

        <div className="engine-intro">
          <h1 className="engine-title">{t("engines.title")}</h1>
          <p className="engine-subtitle">{t("engines.subtitle")}</p>
        </div>

        <EngineRoster mode="pick" initial={initial} onSelected={(_engine, engineChanged) => onDone(engineChanged)} />
      </div>
    </div>
  );
}
