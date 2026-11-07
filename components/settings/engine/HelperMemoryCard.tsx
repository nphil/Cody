"use client";

/**
 * "Helper agents' memory limit": how big a helper agent's history may grow
 * before omp summarises it (`task.agentCompactionThresholdOverrides`), plus the
 * switch for the notes that let it carry on afterwards
 * (`compaction.experimentalContextManagement`, which applies to every chat).
 * The reading and writing of the map is in helper-memory.ts; this file is the
 * controls. Lives in the Behavior hub's Context group.
 */
import type { CSSProperties } from "react";
import { Select } from "@/components/ui/Select";
import type { NativeSettingsHandle } from "@/hooks/useConfigWriter";
import { NativeSetting, ToggleSwitch } from "../primitives";
import { useSaveStatus } from "../SaveStatus";
import {
  DEFAULT_PERCENT, DEFAULT_TOKENS, HELPER_AGENTS, HELPER_MEMORY_DESCRIPTION, HELPER_MEMORY_LABEL, HELPER_MEMORY_SEARCH_ID,
  choiceId, describeLimit, limitChoices, parseChoiceId, readHelperState, withAgentLimit, withSharedLimit,
  type HelperLimit, type HelperMode, type HelperState, type Overrides,
} from "./helper-memory";
import { ENGINE_PANEL_ID } from "./recommended-cards";

const MODES: ReadonlyArray<{ id: HelperMode; label: string }> = [
  { id: "percent", label: "% of the model's window" },
  { id: "tokens", label: "Fixed tokens" },
  { id: "inherit", label: "Same as my chats" },
];

const HINT = "A percentage follows each model's own window size. On a small model (about 100k tokens or less) a low percentage leaves less room than the start-up text every request carries, so give helpers that run on one a higher value under Advanced.";

function radioStyle(selected: boolean): CSSProperties {
  return {
    minHeight: 28,
    padding: "3px 11px",
    border: `1px solid ${selected ? "var(--accent)" : "var(--border)"}`,
    borderRadius: "var(--radius-control)",
    background: selected ? "color-mix(in srgb, var(--accent) 12%, var(--bg-panel))" : "var(--bg)",
    color: selected ? "var(--text)" : "var(--text-muted)",
    cursor: "pointer",
    fontSize: 11.5,
  };
}

/** Every size a helper may be given, as one flat list for a Select. */
function agentOptions(state: HelperState, current: HelperLimit | "same" | "inherit") {
  const sizes = (mode: "percent" | "tokens", own: HelperLimit | "same" | "inherit") => limitChoices(mode, typeof own !== "string" && own.mode === mode ? own.value : null)
    .map((value) => ({ value: choiceId({ mode, value }), label: describeLimit({ mode, value }) }));
  return [
    { value: "same", label: state.shared ? "Same as above" : "Same as my chats" },
    ...(state.shared ? [{ value: "inherit", label: "Same as my chats" }] : []),
    ...sizes("percent", current),
    ...sizes("tokens", current),
  ];
}

export interface HelperMemoryViewProps {
  overrides: Overrides;
  notesOn: boolean;
  onOverrides: (next: Overrides) => void;
  onNotes: (on: boolean) => void;
}

/** The card itself, over plain values: the wired one below feeds it from config.yml. */
export function HelperMemoryView({ overrides, notesOn, onOverrides, onNotes }: HelperMemoryViewProps) {
  const state = readHelperState(overrides);
  const shared = state.shared;
  const chooseMode = (mode: HelperMode) => {
    if (mode === state.mode) return;
    const next = mode === "inherit" ? null : { mode, value: mode === "percent" ? DEFAULT_PERCENT : DEFAULT_TOKENS };
    onOverrides(withSharedLimit(overrides, next));
  };
  return (
    <NativeSetting
      label={HELPER_MEMORY_LABEL}
      description={HELPER_MEMORY_DESCRIPTION}
      searchId={HELPER_MEMORY_SEARCH_ID}
      switchControl={false}
      control={(
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <div role="radiogroup" aria-label="How the limit is set" style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              {MODES.map((option) => (
                <button key={option.id} type="button" role="radio" aria-checked={state.mode === option.id} onClick={() => chooseMode(option.id)} style={radioStyle(state.mode === option.id)}>
                  {option.label}
                </button>
              ))}
            </div>
            {shared && (
              <Select
                aria-label="Limit size"
                value={String(shared.value)}
                onChange={(value) => onOverrides(withSharedLimit(overrides, { mode: shared.mode, value: Number(value) }))}
                options={limitChoices(shared.mode, shared.value).map((value) => ({ value: String(value), label: describeLimit({ mode: shared.mode, value }) }))}
                width="fit-content"
              />
            )}
          </div>
          <span style={{ fontSize: 10.5, color: "var(--text-dim)", lineHeight: 1.4 }}>{HINT}</span>
          <details>
            <summary style={{ cursor: "pointer", fontSize: 11.5, color: "var(--text-muted)" }}>Advanced: each helper</summary>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
              {HELPER_AGENTS.map((agent) => {
                const current = state.agents[agent];
                return (
                  <div key={agent} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                    <code style={{ fontSize: 11, fontFamily: "var(--font-mono, monospace)" }}>{agent}</code>
                    <Select
                      aria-label={`Limit for ${agent}`}
                      value={choiceId(current)}
                      onChange={(id) => {
                        const choice = parseChoiceId(id);
                        if (choice) onOverrides(withAgentLimit(overrides, agent, choice));
                      }}
                      options={agentOptions(state, current)}
                      width="fit-content"
                    />
                  </div>
                );
              })}
            </div>
          </details>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, borderTop: "1px solid var(--border)", paddingTop: 10 }}>
            <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
              <span style={{ fontSize: 12, fontWeight: 600 }}>Notes that survive a summary ({notesOn ? "on" : "off"})</span>
              <span style={{ fontSize: 10.5, color: "var(--text-dim)" }}>Applies to all chats, not only helpers.</span>
            </span>
            <ToggleSwitch checked={notesOn} onChange={onNotes} label="Notes that survive a summary" />
          </div>
        </div>
      )}
    />
  );
}

export function HelperMemoryCard({ native }: { native: NativeSettingsHandle }) {
  const { track } = useSaveStatus(ENGINE_PANEL_ID);
  return (
    <HelperMemoryView
      overrides={native.settings?.task?.agentCompactionThresholdOverrides ?? {}}
      notesOn={native.settings?.compaction?.experimentalContextManagement === true}
      onOverrides={(next) => { void track(() => native.patchSection("task", { agentCompactionThresholdOverrides: next })); }}
      onNotes={(on) => { void track(() => native.patchSection("compaction", { experimentalContextManagement: on })); }}
    />
  );
}
