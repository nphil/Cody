/**
 * What the composer shows about omp's `/slow` and the provider usage-limit
 * stage, derived from `get_state` (omp 18.6.3+).
 *
 * Both are ENGINE-REPORTED and both follow the active model: a model with no
 * slow mode reports `slowModeSupported: false`, and the usage-limit stage only
 * exists for a Claude subscription account. An older omp, pi and the ACP
 * engines send none of the fields, so every function here answers "nothing to
 * show" for them — the caller renders nothing rather than a disabled control.
 */
import type { SlowModeScope, UsageLimitState } from "./pi-types";

export interface SlowModeState {
	enabled: boolean;
	/** `global` is persisted config every chat shares; `session` is this chat's own flex tier. */
	scope: SlowModeScope;
}

export interface SlowModeFields {
	slowModeSupported?: unknown;
	slowModeEnabled?: unknown;
	slowModeScope?: unknown;
}

/**
 * The slow-mode switch's state, or `null` when the switch must not render:
 * the engine does not report slow mode at all, or the active model has none.
 * A missing scope on a supporting model is read as the narrower `session`, so
 * the switch never promises to affect other chats on the engine's silence.
 */
export function deriveSlowModeState(fields: SlowModeFields | null | undefined): SlowModeState | null {
	if (!fields || fields.slowModeSupported !== true) return null;
	return {
		enabled: fields.slowModeEnabled === true,
		scope: fields.slowModeScope === "global" ? "global" : "session",
	};
}

/** Validate the engine's `usageLimit` payload; anything malformed is "no stage". */
export function readUsageLimit(raw: unknown): UsageLimitState | null {
	if (!raw || typeof raw !== "object") return null;
	const value = raw as Record<string, unknown>;
	const resetsAtSec = typeof value.resetsAtSec === "number" && Number.isFinite(value.resetsAtSec) && value.resetsAtSec > 0
		? value.resetsAtSec
		: undefined;
	if (value.stage === "low_priority") {
		if (resetsAtSec === undefined) return null;
		const left = value.allowanceLeftPercent;
		return {
			stage: "low_priority",
			resetsAtSec,
			...(typeof left === "number" && Number.isFinite(left)
				? { allowanceLeftPercent: Math.min(100, Math.max(0, left)) }
				: {}),
		};
	}
	if (value.stage === "wrap_up") {
		return {
			stage: "wrap_up",
			...(resetsAtSec !== undefined ? { resetsAtSec } : {}),
			extraUsage: value.extraUsage === true,
		};
	}
	return null;
}

/** Field-wise equality, so a poll that changed nothing keeps the same state identity. */
export function sameUsageLimit(a: UsageLimitState | null, b: UsageLimitState | null): boolean {
	if (a === b) return true;
	if (!a || !b || a.stage !== b.stage) return false;
	if (a.resetsAtSec !== b.resetsAtSec) return false;
	if (a.stage === "low_priority" && b.stage === "low_priority") return a.allowanceLeftPercent === b.allowanceLeftPercent;
	if (a.stage === "wrap_up" && b.stage === "wrap_up") return a.extraUsage === b.extraUsage;
	return false;
}

/**
 * The stage to announce in the chat, or `null` for nothing to say.
 *
 * `previous` is what this chat last saw: `undefined` before the first read.
 * Entering a stage — including finding the chat already in one on the first
 * read, which is exactly when someone is asking why replies are slow — and
 * moving from one stage to the other are announced. Leaving a stage is not:
 * the field also disappears when the model switches to a provider that has no
 * such account, and "back to normal" would be a false claim then.
 */
export function usageLimitStageToAnnounce(
	previous: UsageLimitState | null | undefined,
	next: UsageLimitState | null,
): UsageLimitState["stage"] | null {
	if (!next) return null;
	return previous && previous.stage === next.stage ? null : next.stage;
}

export type Translate = (key: string, vars?: Record<string, string | number>) => string;

export interface UsageLimitText {
	/** One sentence for the chat notice and the popover tooltip. */
	notice: string;
	/** The compact line under the quota headline. */
	line: string;
}

/** `resetsAtSec` as an ISO string, or null when it is absent or not a real instant. */
function resetIso(resetsAtSec: number | undefined): string | null {
	if (resetsAtSec === undefined) return null;
	const at = new Date(resetsAtSec * 1000);
	return Number.isFinite(at.getTime()) ? at.toISOString() : null;
}

/**
 * Plain-words copy for a stage. `formatTime` is the caller's local-time
 * formatter (`formatResetTime` bound to the reader's locale), so the wording
 * never decides which zone a clock time is in.
 */
export function describeUsageLimit(
	limit: UsageLimitState,
	t: Translate,
	formatTime: (iso: string) => string | null,
): UsageLimitText {
	const iso = resetIso(limit.resetsAtSec);
	const time = iso ? formatTime(iso) : null;
	if (limit.stage === "low_priority") {
		const left = limit.allowanceLeftPercent === undefined ? null : Math.round(limit.allowanceLeftPercent);
		return {
			notice: [
				time ? t("slowMode.noticeLowPriority", { time }) : t("slowMode.noticeLowPriorityNoTime"),
				left === null ? null : t("slowMode.allowanceLeft", { percent: left }),
			].filter(Boolean).join(" "),
			line: [
				t("slowMode.lineLowPriority"),
				time ? t("slowMode.until", { time }) : null,
				left === null ? null : t("slowMode.allowanceLeftShort", { percent: left }),
			].filter(Boolean).join(" \u00b7 "),
		};
	}
	return {
		notice: [
			time ? t("slowMode.noticeWrapUp", { time }) : t("slowMode.noticeWrapUpNoTime"),
			t(limit.extraUsage ? "slowMode.extraUsageOn" : "slowMode.extraUsageOff"),
		].join(" "),
		line: [
			t("slowMode.lineWrapUp"),
			time ? t("slowMode.until", { time }) : null,
			t(limit.extraUsage ? "slowMode.extraUsageOnShort" : "slowMode.extraUsageOffShort"),
		].filter(Boolean).join(" \u00b7 "),
	};
}
