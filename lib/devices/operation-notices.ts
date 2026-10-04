/**
 * What the person is told, in a pop-up, about the device operations an agent runs.
 *
 * An agent that inspects a device sends a burst of small commands (a dozen
 * `getvar`s, a few `getprop`s). Each one used to raise a pop-up for every event
 * it produced - started, acquiring, running, each line of output, finished - so
 * ten commands buried the chat in dozens of toasts. A pop-up is for the moments
 * a person must act or would want to know, and nothing else:
 *
 *  - an operation is waiting for their approval (they have to act),
 *  - a long or bulk operation finished (a backup, a flash, a dump),
 *  - something failed, or the system cancelled it (a device left the USB bus).
 *
 * Everything else - progress, output, the routine read that succeeded - lives
 * in the Devices panel, which groups it. This module is the one place that
 * decides, so a test can pin the decision; it is pure and imports only types,
 * because the server half of the device bridge must not pull the page's
 * protocol implementations into the server bundle.
 */

import type { DeviceOperationSnapshot, OperationEvent, OperationState } from "./operations";

export type DeviceNoticeLevel = "info" | "warning" | "success";

export interface DeviceNotice {
  level: DeviceNoticeLevel;
  message: string;
  /** The browser's notice shelf folds repeats of the same key into one notice with a count. */
  dedupeKey: string;
  /** A failure: a run of these in quick succession is one pop-up plus a summary, not one each (see DeviceNoticeBatcher). */
  burst?: true;
}

/** The `notice` frame the server sends for one: `source: "device"` tells the browser to show it as written. */
export function deviceNoticeFrame(notice: DeviceNotice): { type: "notice"; source: "device"; level: DeviceNoticeLevel; message: string; dedupeKey: string } {
  return { type: "notice", source: "device", level: notice.level, message: notice.message, dedupeKey: notice.dedupeKey };
}

/**
 * How the chat's notice shelf shows such a frame: its level stays what it was (a warning is amber, never an engine's
 * red error), and a repeat carrying the same key folds into one notice with a count. Null when there is nothing to say.
 */
export function shelfItemFor(frame: Record<string, unknown>): { type: DeviceNoticeLevel; message: string; dedupeKey?: string } | null {
  const message = typeof frame.message === "string" ? frame.message.trim() : "";
  if (!message) return null;
  return {
    type: frame.level === "warning" || frame.level === "success" ? frame.level : "info",
    message,
    ...(typeof frame.dedupeKey === "string" ? { dedupeKey: frame.dedupeKey } : {}),
  };
}

/** Past this a successful operation is "long" and its finish is worth a pop-up. */
export const LONG_OPERATION_MS = 15_000;

/** Actions that move whole files or images: their finish is worth a pop-up however quickly they ran. */
const BULK_ACTIONS: Record<string, true> = { flash: true, dump: true, push: true, pull: true, sideload: true, install: true };

const MAX_TARGET_CHARS = 120;
const MAX_DETAIL_CHARS = 200;

function clip(text: string, limit: number): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > limit ? `${single.slice(0, limit - 1)}…` : single;
}

function isFinished(state: OperationState): boolean {
  return state === "succeeded" || state === "failed" || state === "cancelled";
}

/** "fastboot reboot-bootloader", "adb pull /sdcard/a.img", "edl backup": what the operation was, in a few words. */
export function describeOperation(snapshot: DeviceOperationSnapshot): string {
  const { protocol, action, command, target, options } = snapshot.request;
  const kind = typeof options?.kind === "string" ? options.kind : undefined;
  const what = action === "exec" ? (command ?? kind ?? "command") : `${action}${target ? ` ${target}` : ""}`;
  return `${protocol} ${clip(what, MAX_TARGET_CHARS)}`;
}

/** How long it ran once it was allowed to run: the wait for an approval is the person's time, not the operation's. */
function runMillis(snapshot: DeviceOperationSnapshot): number {
  const running = snapshot.events.findLast((event) => event.type === "state" && event.state === "running");
  return Math.max(0, snapshot.updatedAt - (running?.at ?? snapshot.createdAt));
}

function onDevice(label: string | undefined): string {
  return label ? ` on ${label}` : "";
}

/**
 * The pop-up, if any, for one event of an operation. `previous` is the snapshot the bridge held before this one:
 * without it a finish cannot be told from a replay (a page that reconnects to a restarted server re-sends every
 * finished operation it remembers, and none of those is news).
 */
export function noticeForOperation(
  snapshot: DeviceOperationSnapshot,
  event: OperationEvent | undefined,
  previous: DeviceOperationSnapshot | undefined,
  deviceLabel?: string,
): DeviceNotice | null {
  if (event?.type === "confirmation" && event.confirmation) {
    // A person who clicked the button themselves is looking at the card that asks.
    if (snapshot.origin === "user") return null;
    const { binding, sendDelaySeconds } = event.confirmation;
    const wait = sendDelaySeconds ? ` After you approve it waits ${sendDelaySeconds} s before sending.` : "";
    return {
      level: "warning",
      message: `Approval needed: ${clip(binding.action, MAX_TARGET_CHARS)} - ${clip(binding.target, MAX_TARGET_CHARS)}${onDevice(deviceLabel)}. Open the Devices panel to review and approve.${wait}`,
      dedupeKey: `device:approval:${event.confirmation.id}`,
    };
  }

  // A finish arrives as a snapshot with no event. It is news when it is the step from running to finished, and
  // also when it CORRECTS a finish already filed: the bridge records "completion unknown" as a failure when a page
  // goes quiet, and the real outcome (it succeeded, or failed some other way) arrives later. Only a repeat of the
  // state already announced is silent - and so is a snapshot the bridge never saw start (a restarted server being
  // replayed to).
  if (event !== undefined || !isFinished(snapshot.state) || !previous || previous.state === snapshot.state) return null;

  const what = `${describeOperation(snapshot)}${onDevice(deviceLabel)}`;
  const long = runMillis(snapshot) >= LONG_OPERATION_MS;
  const fromAgent = snapshot.origin !== "user";

  if (snapshot.state === "failed") {
    // A command the person typed fails in front of them; a long one they walked away from, or any the agent ran, does not.
    if (!fromAgent && !long) return null;
    const why = clip(snapshot.error ?? "no reason was reported", MAX_DETAIL_CHARS);
    return { level: "warning", message: `${what} failed: ${why}`, dedupeKey: `device:failed:${what}:${why}`, burst: true };
  }
  if (snapshot.state === "cancelled") {
    // Stopping something yourself is not news; the system stopping it (a device left the bus) is.
    if (!snapshot.error) return null;
    const why = clip(snapshot.error, MAX_DETAIL_CHARS);
    return { level: "warning", message: `${what} was cancelled: ${why}`, dedupeKey: `device:cancelled:${what}:${why}`, burst: true };
  }
  if (!long && !(fromAgent && BULK_ACTIONS[snapshot.request.action])) return null;
  const summary = clip(snapshot.result?.summary.split("\n")[0] ?? "done", MAX_DETAIL_CHARS);
  return { level: "success", message: `${what} finished: ${summary}`, dedupeKey: `device:done:${snapshot.id}` };
}

interface BatcherOptions {
  /** How long after a failure pop-up further failures are held back and summarised. */
  windowMs?: number;
  now?: () => number;
  /** Runs `run` after `ms` and returns the function that cancels it. */
  schedule?: (run: () => void, ms: number) => () => void;
}

/**
 * Failures come in bursts - a device vanishes and every command queued behind it fails - and ten red pop-ups say
 * what one says. The first failure of a burst is shown at once; the rest of its window is held and shown as a single
 * "N more failed" summary when the window closes. Everything that is not a failure passes straight through.
 */
export class DeviceNoticeBatcher {
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly schedule: (run: () => void, ms: number) => () => void;
  private windowEndsAt = 0;
  private held: DeviceNotice[] = [];
  private cancelWindow: (() => void) | undefined;

  constructor(private readonly emit: (notice: DeviceNotice) => void, options: BatcherOptions = {}) {
    this.windowMs = options.windowMs ?? 5_000;
    this.now = options.now ?? Date.now;
    this.schedule = options.schedule ?? ((run, ms) => {
      const handle = setTimeout(run, ms);
      handle.unref?.();
      return () => clearTimeout(handle);
    });
  }

  push(notice: DeviceNotice): void {
    if (!notice.burst) {
      this.emit(notice);
      return;
    }
    const now = this.now();
    // A window is open while its timer is pending and its time is not up. Once it is not, settle it BEFORE starting
    // the next: its timer may not have fired yet (a busy event loop, a clock that jumped), and what it held back is
    // summarised, not thrown away with it.
    if (this.cancelWindow === undefined || now >= this.windowEndsAt) {
      this.closeWindow();
      this.windowEndsAt = now + this.windowMs;
      this.cancelWindow = this.schedule(() => this.closeWindow(), this.windowMs);
      this.emit(notice);
      return;
    }
    this.held.push(notice);
  }

  /** Ends the open window: cancels its timer and says, once, how many failures it held back. */
  private closeWindow(): void {
    this.cancelWindow?.();
    this.cancelWindow = undefined;
    const held = this.held;
    this.held = [];
    if (held.length === 0) return;
    const latest = held[held.length - 1];
    this.emit({
      level: "warning",
      message: `${held.length} more device ${held.length === 1 ? "operation" : "operations"} failed or were cancelled. Latest: ${latest.message}`,
      dedupeKey: "device:failed:summary",
    });
  }

  /** The session is going away: nobody is left to tell. */
  dispose(): void {
    this.cancelWindow?.();
    this.cancelWindow = undefined;
    this.held = [];
  }
}
