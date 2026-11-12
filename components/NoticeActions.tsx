"use client";

/**
 * The buttons under a notice-shelf message that has something to do about it
 * (see `NoticeCta` in hooks/credential-notices.ts):
 *
 * - signed out of a provider: one button that opens Settings › Providers on that
 *   provider's own drawer, the same hand-off the quota popover uses;
 * - saved resets omp says are eligible but unspent: "Use reset" (only when one
 *   is spendable right now, asked to confirm like the popover's own button,
 *   because spending is final) and a link to the auto-use settings.
 */
import { useCallback, useRef, useState } from "react";
import { toast } from "@/components/ui/toast";
import { ConfirmDialog } from "@/components/ui/field";
import { useSettingsOpener } from "@/components/settings/shell-context";
import { useSchemaIndex } from "@/hooks/useSchemaIndex";
import { useResetCredits } from "@/hooks/useUsage";
import {
  autoRedeemSettingKeys,
  credentialProviderName,
  pickRedeemableResetCredit,
  type NoticeCta,
  type SavedResetProvider,
} from "@/hooks/credential-notices";
import { useI18n } from "@/lib/i18n";

const BUTTON_STYLE = {
  flexShrink: 0,
  padding: "1px 8px",
  border: "1px solid var(--border)",
  borderRadius: 5,
  background: "transparent",
  color: "var(--text)",
  cursor: "pointer",
  fontSize: 11.5,
} as const;

export function NoticeActions({ action }: { action: NoticeCta }) {
  return action.kind === "sign_in" ? <SignInAction provider={action.provider} /> : <SavedResetActions provider={action.provider} />;
}

function SignInAction({ provider }: { provider: string }) {
  const { t } = useI18n();
  const openSettings = useSettingsOpener();
  return (
    <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
      <button
        type="button"
        className="ui-focus-ring"
        style={BUTTON_STYLE}
        onClick={() => openSettings("providers", { highlight: `provider-${provider}` })}
      >
        {t("agentSession.noticeSignIn", { provider: credentialProviderName(provider) })}
      </button>
    </div>
  );
}

function SavedResetActions({ provider }: { provider: SavedResetProvider }) {
  const { t } = useI18n();
  const openSettings = useSettingsOpener();
  const schema = useSchemaIndex();
  const resetCredits = useResetCredits(true);
  const [confirming, setConfirming] = useState(false);
  const pendingRef = useRef(false);
  const name = credentialProviderName(provider);
  const pick = pickRedeemableResetCredit(resetCredits.snapshot, provider);
  // The setting this engine really has: per-window keys on 18.18.7+, one key before.
  const settingRow = autoRedeemSettingKeys(provider).map((key) => schema.byKey.get(key)).find((row) => row !== undefined);

  const redeem = useCallback(async () => {
    if (!pick || pendingRef.current) return;
    pendingRef.current = true;
    try {
      const outcome = await resetCredits.redeem(pick.accountId, pick.creditId);
      if (outcome.outcome === "reset" || outcome.outcome === "already_redeemed") {
        toast.success(t("agentSession.noticeResetUsed", { provider: name }));
      } else if (outcome.outcome === "no_credit" || outcome.outcome === "nothing_to_reset") {
        toast.info(outcome.message ?? t("usage.resetCreditUnavailable"));
      } else {
        toast.error(t("agentSession.noticeResetFailed"), outcome.message ?? t("usage.resetCreditInconclusive"));
      }
      setConfirming(false);
      resetCredits.refresh();
    } catch {
      toast.error(t("agentSession.noticeResetFailed"), t("usage.resetCreditInconclusive"));
    } finally {
      pendingRef.current = false;
    }
  }, [name, pick, resetCredits, t]);

  return (
    <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
      {pick && (
        <button type="button" className="ui-focus-ring" style={BUTTON_STYLE} onClick={() => setConfirming(true)}>
          {t("agentSession.noticeUseReset")}
        </button>
      )}
      <button
        type="button"
        className="ui-focus-ring"
        style={BUTTON_STYLE}
        onClick={() => openSettings("engine", settingRow ? { highlight: settingRow.searchId } : undefined)}
      >
        {t("agentSession.noticeAutoRedeemSettings")}
      </button>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t("usage.useOneReset")}
        description={t("usage.resetCreditConfirm", { account: name })}
        confirmLabel={t("usage.useOneReset")}
        cancelLabel={t("usage.cancelReset")}
        busy={resetCredits.redeeming}
        onConfirm={() => void redeem()}
      />
    </div>
  );
}
