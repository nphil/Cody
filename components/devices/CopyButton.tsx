"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { Button } from "./ui";

/**
 * Copies `text` and says so: "Copied" is shown only after the browser accepted it, and when the clipboard is not
 * available (an insecure page) the button says that instead of pretending.
 */
export function CopyButton({ text, label, ariaLabel }: { text: string; label: string; ariaLabel?: string }): React.ReactElement {
  const { t } = useI18n();
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const finish = (next: "copied" | "failed"): void => {
    setState(next);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState("idle"), 2_500);
  };
  const copy = (): void => {
    if (!navigator.clipboard) {
      finish("failed");
      return;
    }
    navigator.clipboard.writeText(text).then(() => finish("copied"), () => finish("failed"));
  };
  return (
    <Button
      tone="quiet"
      icon={state === "copied" ? <Check size={14} /> : <Copy size={14} />}
      ariaLabel={ariaLabel}
      onClick={copy}
      style={{ minWidth: 0, padding: "4px 10px" }}
    >
      <span role="status">{state === "copied" ? t("devices.sheet.copied") : state === "failed" ? t("devices.clipboardUnavailableShort") : label}</span>
    </Button>
  );
}
