/**
 * Which "spend saved resets without asking" switches the quota popover offers,
 * and what each one currently says.
 *
 * omp 18.18.7 split the single `<group>.autoRedeem` setting into one per limit
 * (`autoRedeem5h`, `autoRedeemWeekly`, and Claude's `autoRedeemFable`); 18.8.3
 * has only the single one. The running engine's own schema decides which
 * exist: this reads it through an injected lookup and offers exactly those,
 * never a key the engine does not have. The value a lookup returns is already
 * the one omp acts on (the settings reader fills a window key from the legacy
 * one the way the engine does in memory), so nothing here re-implements that.
 */
import { autoRedeemSettingKeys, type SavedResetProvider } from "./credential-notices";

export type AutoRedeemChoice = "unset" | "yes" | "no";

/** Which limit a switch governs. `all` is the single pre-18.18.7 switch. */
export type AutoRedeemWindow = "5h" | "weekly" | "fable" | "all";

export interface AutoRedeemControl {
  /** The settings key this switch reads and writes. */
  key: string;
  window: AutoRedeemWindow;
  value: AutoRedeemChoice;
}

export interface AutoRedeemGroup {
  provider: SavedResetProvider;
  controls: AutoRedeemControl[];
  /** The Claude Fable switch is among `controls`: Fable launch resets are a
   *  separate consent the other switches do not cover. */
  hasFable: boolean;
}

/** One setting as the settings source knows it; undefined when this engine's schema has no such key. */
export type AutoRedeemLookup = (key: string) => { value?: unknown } | undefined;

export const CLAUDE_FABLE_AUTO_REDEEM_KEY = "claudeResets.autoRedeemFable";

/** Providers with saved resets, in the order the popover lists them. */
const PROVIDER_ORDER: readonly SavedResetProvider[] = ["anthropic", "openai-codex"];

/** What omp reads from a stored value: `yes`/`no`, a legacy boolean, else `unset` (ask first). */
export function normalizeAutoRedeemValue(value: unknown): AutoRedeemChoice {
  if (value === "yes" || value === true) return "yes";
  if (value === "no" || value === false) return "no";
  return "unset";
}

/**
 * The switches to show for the given providers. A provider the engine has no
 * auto-redeem setting for is left out entirely.
 */
export function buildAutoRedeemGroups(lookup: AutoRedeemLookup, providers: readonly string[]): AutoRedeemGroup[] {
  const groups: AutoRedeemGroup[] = [];
  for (const provider of PROVIDER_ORDER) {
    if (!providers.includes(provider)) continue;
    const [key5h, keyWeekly, keyLegacy] = autoRedeemSettingKeys(provider) as readonly [string, string, string];
    const candidates: Array<[string, AutoRedeemWindow]> = [[key5h, "5h"], [keyWeekly, "weekly"]];
    if (provider === "anthropic") candidates.push([CLAUDE_FABLE_AUTO_REDEEM_KEY, "fable"]);
    const controls: AutoRedeemControl[] = [];
    for (const [key, window] of candidates) {
      const row = lookup(key);
      if (row) controls.push({ key, window, value: normalizeAutoRedeemValue(row.value) });
    }
    if (controls.length === 0) {
      const legacy = lookup(keyLegacy);
      if (legacy) controls.push({ key: keyLegacy, window: "all", value: normalizeAutoRedeemValue(legacy.value) });
    }
    if (controls.length > 0) groups.push({ provider, controls, hasFable: controls.some((control) => control.window === "fable") });
  }
  return groups;
}
