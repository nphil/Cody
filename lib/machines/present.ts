import { DEFAULT_LOCAL_MACHINE_NAME, type MachineKind, type MachineReason, type MachineState, type MachineStatus } from "./types";

/**
 * What the top bar, its dropdown and the Settings card agree on when they put
 * a machine into words and colours. Pure and browser-safe, so the decisions are
 * testable without a DOM.
 */

/** i18n key for the plain sentence that explains why a machine is not online.
 * Every {@link MachineReason} has one under `machines.reason.`. */
export function machineReasonKey(reason: MachineReason): string {
  return `machines.reason.${reason}`;
}

/** i18n key for a status chip ("Online", "Offline", …). */
export function machineStatusKey(status: MachineStatus): string {
  return `machines.status.${status}`;
}

/** The name a machine wears on screen. This server's DEFAULT name is stored in
 * English, so it is shown in the reader's own language (`machines.defaultName`);
 * a name the person chose is shown exactly as typed. */
export function machineDisplayName(machine: { kind: MachineKind; name: string }, translate: (key: string) => string): string {
  return machine.kind === "local" && machine.name === DEFAULT_LOCAL_MACHINE_NAME ? translate("machines.defaultName") : machine.name;
}

/** A figure for the bar: whole percent, never past 100 or below 0. */
export function wholePercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}

/** Bytes as gigabytes with one decimal ("62.6"). The kernel counts in KiB, so
 * this is the figure `free -h` would call 62Gi, written without the jargon. */
export function formatGigabytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0.0";
  return (bytes / 1024 ** 3).toFixed(1);
}

/** The short label under which a machine fits a narrow bar: its first letter,
 * upper-cased. */
export function machineInitial(name: string): string {
  const first = [...name.trim()][0];
  return first ? first.toLocaleUpperCase() : "?";
}

export type MachineSeverity = "normal" | "warning" | "error" | "down" | "pending";

/** How worried to be about one machine, from its numbers or its state. The
 * percentage thresholds are the shared usage ones (70 warns, 90 is an error),
 * so a memory bar and the context ring never disagree about 90%. */
export function machineSeverity(machine: MachineState): MachineSeverity {
  if (machine.status === "offline") return "down";
  if (machine.status === "connecting" || machine.status === "unavailable" || !machine.metrics) return "pending";
  const peak = Math.max(machine.metrics.cpuPercent ?? 0, machine.metrics.memPercent);
  if (peak >= 90) return "error";
  if (peak >= 70) return "warning";
  return "normal";
}

const SEVERITY_RANK: Record<MachineSeverity, number> = { pending: 0, normal: 1, warning: 2, error: 3, down: 4 };

/** The machine that deserves the single indicator a phone has room for: one
 * that is down beats one that is struggling beats one that is fine. Ties go to
 * the busier machine, then to the earlier one in the list. */
export function worstMachine(machines: readonly MachineState[]): MachineState | null {
  let worst: MachineState | null = null;
  let worstRank = -1;
  let worstPeak = -1;
  for (const machine of machines) {
    const rank = SEVERITY_RANK[machineSeverity(machine)];
    const peak = machine.metrics ? Math.max(machine.metrics.cpuPercent ?? 0, machine.metrics.memPercent) : 0;
    if (rank > worstRank || (rank === worstRank && peak > worstPeak)) {
      worst = machine;
      worstRank = rank;
      worstPeak = peak;
    }
  }
  return worst;
}

/**
 * How much of each machine the top bar can afford. The richest level that
 * fits wins. The widths below are the ones the CSS in `app/globals.css`
 * (`.mm-*`) really gives a chip, with a pixel of safety: one source for both
 * halves, so the picker cannot promise room the layout does not have.
 *
 * - `full`: name, labelled CPU and memory bars with their numbers.
 * - `compact`: name, icon-labelled bars with numbers.
 * - `mini`: the machine's initial and a pair of bars, no numbers (just the
 *   pair when there is only one machine: an initial would tell it nothing).
 * - `dot`: one indicator for the worst machine (a phone, or no room at all).
 * - `none`: not even that fits.
 */
export type MeterDensity = "full" | "compact" | "mini" | "dot" | "none";

export const METER_LAYOUT = {
  /** Per density: a chip's fixed width in px, the widest its name may grow,
   * the space between two chips and the button's own horizontal padding. */
  full: { fixed: 99, nameMax: 84, gap: 10, pad: 12 },
  compact: { fixed: 81, nameMax: 64, gap: 10, pad: 12 },
  mini: { fixed: 36, nameMax: 0, gap: 8, pad: 8 },
  /** One machine only: just the pair of bars, no initial. */
  miniSingle: { fixed: 29, nameMax: 0, gap: 8, pad: 8 },
  /** How wide one Latin character of the UI's monospace font is at 11px. */
  nameChar: 6.6,
  /** The one-indicator button: a 16px ring with 4px of padding either side. */
  dot: 24,
} as const;

/** How wide a name draws at 11px: the UI's monospace font is 0.6em per Latin
 * character, and a Chinese or Japanese character is a full em. */
function nameWidth(name: string): number {
  let width = 0;
  for (const char of name) width += (char.codePointAt(0) ?? 0) >= 0x2e80 ? 11 : METER_LAYOUT.nameChar;
  return width;
}

/** The richest density at which every machine fits in `available` px. A phone
 * (`forceDot`) never gets more than the single indicator. */
export function pickMeterDensity(machines: readonly MachineState[], available: number, forceDot: boolean): MeterDensity {
  if (machines.length === 0) return "none";
  if (!forceDot) {
    for (const density of ["full", "compact", "mini"] as const) {
      const layout = density === "mini" && machines.length === 1 ? METER_LAYOUT.miniSingle : METER_LAYOUT[density];
      const chips = machines.reduce((sum, machine) => sum + layout.fixed + Math.min(layout.nameMax, nameWidth(machine.name)), 0);
      if (chips + layout.gap * (machines.length - 1) + layout.pad <= available) return density;
    }
  }
  return available >= METER_LAYOUT.dot ? "dot" : "none";
}
