import { isRecord } from "@/lib/type-guards";
import { describeEngineCrash, readEngineCrashNotice } from "@/lib/engine-crash";
import { translate } from "@/lib/i18n";
import { toast } from "./ui/toast";

/** How long a crash pop-up stays: long enough to read the reason and the next step. */
const CRASH_TOAST_MS = 15_000;

/**
 * The pop-up for one `engine_crashed` frame of the running-sessions stream
 * (app/api/agent/running/events). `chatTitle` is the page's own name for the
 * chat when the server did not send one; `open` brings that chat up.
 * Returns false for a frame that is not a crash notice.
 */
export function showEngineCrashToast(frame: unknown, chatTitle: string | undefined, open: (() => void) | null): boolean {
  const notice = readEngineCrashNotice(frame);
  if (!notice) return false;
  const words = describeEngineCrash(notice, translate);
  const serverTitle = isRecord(frame) && typeof frame.title === "string" ? frame.title.trim() : "";
  const name = serverTitle || chatTitle?.trim() || translate("engineCrash.untitledChat");
  toast.error(
    translate("engineCrash.toastTitle", { title: name }),
    [words.headline, words.detail, words.next].filter((part): part is string => part !== null).join(" "),
    {
      durationMs: CRASH_TOAST_MS,
      clamp: true,
      ...(open ? { action: { label: translate("engineCrash.open"), onClick: open } } : {}),
    },
  );
  return true;
}
