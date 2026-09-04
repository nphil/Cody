"use client";

/**
 * Settings › Behavior: how the engine works. Two layers over one file:
 * the curated cards (gate `configEditor`: omp's config.yml, hand-built) and
 * the engine's own schema, complete (gate `nativeSettings`). STUB: the
 * curated layer is yesterday's Safety, AI Model Defaults and Agent &
 * Intelligence tabs stacked, and the schema layer is `OmpSchemaSettings`
 * unchanged; the Behavior slice replaces both with `RECOMMENDED_CARDS`
 * bound to the schema and `SchemaSettingsList`.
 *
 * Every curated write goes through the config writer (section spread, FIFO)
 * and reports to this panel's save corner. The schema panel keeps its own
 * copy of the file, so it reloads when the WRITER settles a write and only
 * then: its own saves never bounce it.
 */
import dynamic from "next/dynamic";
import { AlertCircle, ArrowDown, ArrowUp, Sparkles, X } from "lucide-react";
import { useCallback } from "react";
import { useConfigWriteSeq, useNativeSettings, type CompactionMethod, type NativeSettings } from "@/hooks/useConfigWriter";
import { invalidateSettingsRoutes } from "@/hooks/useSettingsData";
import { NativeSetting, TERMINAL_ONLY_BADGE, ToggleSwitch, nativeOptionStyle, nativeSelectStyle } from "../primitives";
import { SaveStatusCorner, useSaveStatus } from "../SaveStatus";
import { useSettingsShell } from "../shell-context";

const PanelLoading = () => <div role="status" style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 12, padding: 20 }}>Loading settings…</div>;
const OmpSchemaSettings = dynamic(() => import("../OmpSchemaSettings").then((module) => module.OmpSchemaSettings), { loading: PanelLoading });

export const ENGINE_PANEL_ID = "engine";

const COMPACTION_METHOD_LABELS: Record<CompactionMethod, string> = {
  remote: "Server compaction",
  snapcompact: "Snapcompact",
  handoff: "Handoff",
  shake: "Shake",
  soft: "Soft summary",
};
const DEFAULT_COMPACTION_METHOD_ORDER: CompactionMethod[] = ["remote", "snapcompact", "handoff", "shake", "soft"];

/** Ordered editor for compaction.methodOrder: enabled methods in preference
 * order with move/remove, remaining methods addable, and a one-click return to
 * omp's default order. An empty list is valid: it turns automatic context
 * maintenance off, which is what the legacy "Off" strategy mapped to. */
function CompactionMethodOrderEditor({ value, onChange }: {
  value: CompactionMethod[] | undefined;
  onChange: (methodOrder: CompactionMethod[]) => void;
}) {
  const order = value ?? DEFAULT_COMPACTION_METHOD_ORDER;
  const remaining = DEFAULT_COMPACTION_METHOD_ORDER.filter((method) => !order.includes(method));
  const isDefault = order.length === DEFAULT_COMPACTION_METHOD_ORDER.length
    && order.every((method, index) => method === DEFAULT_COMPACTION_METHOD_ORDER[index]);
  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= order.length) return;
    const next = [...order];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };
  const rowButton: React.CSSProperties = {
    padding: 2, border: "none", background: "transparent", color: "var(--text-muted)", cursor: "pointer",
    display: "inline-flex", alignItems: "center",
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
      {order.length === 0 && (
        <div style={{ fontSize: 11.5, color: "var(--text-dim)" }}>No methods — automatic context maintenance is off.</div>
      )}
      {order.map((method, index) => (
        <div key={method} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text)" }}>
          <span style={{ width: 14, color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: 11 }}>{index + 1}</span>
          <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{COMPACTION_METHOD_LABELS[method]}</span>
          <button type="button" aria-label={`Move ${COMPACTION_METHOD_LABELS[method]} up`} disabled={index === 0} onClick={() => move(index, -1)} style={{ ...rowButton, opacity: index === 0 ? 0.4 : 1, cursor: index === 0 ? "default" : "pointer" }}><ArrowUp size={13} /></button>
          <button type="button" aria-label={`Move ${COMPACTION_METHOD_LABELS[method]} down`} disabled={index === order.length - 1} onClick={() => move(index, 1)} style={{ ...rowButton, opacity: index === order.length - 1 ? 0.4 : 1, cursor: index === order.length - 1 ? "default" : "pointer" }}><ArrowDown size={13} /></button>
          <button type="button" aria-label={`Remove ${COMPACTION_METHOD_LABELS[method]}`} onClick={() => onChange(order.filter((entry) => entry !== method))} style={rowButton}><X size={13} /></button>
        </div>
      ))}
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        {remaining.length > 0 && (
          <select
            style={{ ...nativeSelectStyle, minHeight: 26, fontSize: 11.5 }}
            value=""
            aria-label="Add compaction method"
            onChange={(e) => { if (e.target.value) onChange([...order, e.target.value as CompactionMethod]); }}
          >
            <option value="" style={nativeOptionStyle}>Add method…</option>
            {remaining.map((method) => <option key={method} value={method} style={nativeOptionStyle}>{COMPACTION_METHOD_LABELS[method]}</option>)}
          </select>
        )}
        {!isDefault && (
          <button
            type="button"
            onClick={() => onChange([...DEFAULT_COMPACTION_METHOD_ORDER])}
            style={{ padding: "3px 8px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "transparent", color: "var(--text-muted)", fontSize: 11, cursor: "pointer" }}
          >
            Default order
          </button>
        )}
      </div>
    </div>
  );
}

function SectionHeading({ title, description, icon, first }: { title: string; description: string; icon?: React.ReactNode; first?: boolean }) {
  return (
    <div style={first ? undefined : { borderTop: "1px solid var(--border)", paddingTop: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 600 }}>{icon}{title}</div>
      <p style={{ margin: "4px 0 0", color: "var(--text-muted)", fontSize: 12 }}>{description}</p>
    </div>
  );
}

export function EnginePanel() {
  const { capabilities, isMobile, harnessLabel, prefs, callbacks } = useSettingsShell();
  const curated = capabilities.configEditor;
  const native = useNativeSettings(curated);
  const settings = native.settings;
  const { track } = useSaveStatus(ENGINE_PANEL_ID);
  const writeSeq = useConfigWriteSeq();

  const patchTop = (patch: Partial<NativeSettings>) => { void track(() => native.patchTop(patch)); };
  const patchSection = <K extends keyof NativeSettings & string>(section: K, patch: Partial<NonNullable<NativeSettings[K]>> & object) => { void track(() => native.patchSection(section, patch)); };
  const patchApproval = (patch: Parameters<typeof native.patchApproval>[0]) => { void track(() => native.patchApproval(patch)); };
  // The schema panel wrote the same file: forget the cached curated copy
  // (this route only, so the schema list does not reload itself).
  const onSchemaSaved = useCallback(() => invalidateSettingsRoutes("/api/omp-settings", { exact: true }), []);

  const grid = { display: "grid", gridTemplateColumns: isMobile ? "1fr" : "repeat(2, minmax(0, 1fr))", gap: 10 } as const;
  const advisorOn = settings?.advisor?.enabled ?? prefs.advisorEnabled;

  return (
    <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
      {curated && (
        <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 18 }}>
          <SaveStatusCorner panelId={ENGINE_PANEL_ID} />
          {native.error && (
            <div role="alert" style={{ padding: "10px 14px", borderRadius: "var(--radius-card)", background: "var(--bg-panel)", border: "1px solid var(--status-error)", color: "var(--status-error)", fontSize: 12, display: "flex", alignItems: "center", gap: 8 }}>
              <AlertCircle size={14} aria-hidden="true" /> {native.error}
            </div>
          )}

          {/* SAFETY */}
          <section style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <SectionHeading first title="Tool Safety & Approvals" description={`Tool execution safety rules and permission prompts. Persisted in ${harnessLabel}'s config.yml.`} />
            <div style={grid}>
              <NativeSetting label="Approval Mode" description="Choose when OMP asks before tool calls.">
                <select
                  style={nativeSelectStyle}
                  value={settings?.tools?.approvalMode ?? "yolo"}
                  onChange={(event) => patchSection("tools", { approvalMode: event.target.value as "always-ask" | "write" | "yolo" })}
                >
                  <option value="always-ask" style={nativeOptionStyle}>Always ask</option>
                  <option value="write" style={nativeOptionStyle}>Allow writes</option>
                  <option value="yolo" style={nativeOptionStyle}>Auto approve (YOLO)</option>
                </select>
              </NativeSetting>
              <NativeSetting label="Bash Override" description="Override default approval policy specifically for terminal commands.">
                <select
                  style={nativeSelectStyle}
                  value={settings?.tools?.approval?.bash ?? "prompt"}
                  onChange={(event) => patchApproval({ bash: event.target.value as "allow" | "prompt" | "deny" })}
                >
                  <option value="allow" style={nativeOptionStyle}>Allow</option>
                  <option value="prompt" style={nativeOptionStyle}>Always ask</option>
                  <option value="deny" style={nativeOptionStyle}>Deny</option>
                </select>
              </NativeSetting>
              <NativeSetting label="Extension Tool Requests" description="Automatically approve extension tool authorization requests.">
                <select
                  style={nativeSelectStyle}
                  value={settings?.tools?.approval?.extension ?? "prompt"}
                  onChange={(event) => patchApproval({ extension: event.target.value as "allow" | "prompt" })}
                >
                  <option value="prompt" style={nativeOptionStyle}>Ask every time</option>
                  <option value="allow" style={nativeOptionStyle}>Auto approve</option>
                </select>
              </NativeSetting>
            </div>
          </section>

          {/* MODEL DEFAULTS */}
          <section style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <SectionHeading title="Model Defaults" description="Default reasoning effort, response verbosity, personality tone, and thinking display." />
            <div style={grid}>
              <NativeSetting label="Reasoning" description="Default effort level for thinking-capable models.">
                <select
                  style={nativeSelectStyle}
                  value={settings?.defaultThinkingLevel ?? "high"}
                  onChange={(e) => patchTop({ defaultThinkingLevel: e.target.value as NativeSettings["defaultThinkingLevel"] })}
                >
                  {["auto", "minimal", "low", "medium", "high", "xhigh", "max"].map((l) => (
                    <option key={l} value={l} style={nativeOptionStyle}>{l}</option>
                  ))}
                </select>
              </NativeSetting>
              <NativeSetting label="Verbosity" description="Response detail level for supporting providers.">
                <select
                  style={nativeSelectStyle}
                  value={settings?.textVerbosity ?? "medium"}
                  onChange={(e) => patchTop({ textVerbosity: e.target.value as NativeSettings["textVerbosity"] })}
                >
                  {["low", "medium", "high"].map((l) => (
                    <option key={l} value={l} style={nativeOptionStyle}>{l}</option>
                  ))}
                </select>
              </NativeSetting>
              <NativeSetting label="Personality" description="Style included in OMP's system prompt.">
                <select
                  style={nativeSelectStyle}
                  value={settings?.personality ?? "default"}
                  onChange={(e) => patchTop({ personality: e.target.value as NativeSettings["personality"] })}
                >
                  {["default", "friendly", "pragmatic", "none"].map((p) => (
                    <option key={p} value={p} style={nativeOptionStyle}>{p}</option>
                  ))}
                </select>
              </NativeSetting>
              <NativeSetting
                label="Hide thinking blocks"
                description="Removes reasoning from the harness's own terminal transcript. Cody draws its own thinking blocks; use Expand thinking blocks under Preferences."
                badge={TERMINAL_ONLY_BADGE}
                searchId="hide-thinking-blocks-curated"
              >
                <ToggleSwitch
                  checked={settings?.hideThinkingBlock ?? false}
                  onChange={(checked) => patchTop({ hideThinkingBlock: checked })}
                />
              </NativeSetting>
              <NativeSetting label="External Thinking" description="Private scratchpad reasoning via think tool.">
                <ToggleSwitch
                  checked={settings?.externalThinking ?? false}
                  onChange={(checked) => patchTop({ externalThinking: checked })}
                />
              </NativeSetting>
            </div>
          </section>

          {/* ADVISOR */}
          <section style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <SectionHeading title="Advisor Review" description="Configured advisor model role passively reviews turns and injects guidance notes." icon={<Sparkles size={14} aria-hidden="true" style={{ color: "var(--accent)" }} />} />
            <div style={grid}>
              <NativeSetting label="Enable Advisor" description="Enable Advisor for new sessions with the advisor role.">
                <ToggleSwitch
                  checked={advisorOn}
                  onChange={(enabled) => {
                    callbacks.onAdvisorChange(enabled);
                    patchSection("advisor", { enabled });
                  }}
                />
              </NativeSetting>
              {advisorOn && (
                <NativeSetting label="Advisor Backlog" description="Wait briefly when advisor falls behind.">
                  <select
                    style={nativeSelectStyle}
                    value={settings?.advisor?.syncBacklog ?? "off"}
                    onChange={(e) => patchSection("advisor", { syncBacklog: e.target.value as "off" | "1" | "3" | "5" })}
                  >
                    <option value="off" style={nativeOptionStyle}>Off</option>
                    <option value="1" style={nativeOptionStyle}>1 turn</option>
                    <option value="3" style={nativeOptionStyle}>3 turns</option>
                    <option value="5" style={nativeOptionStyle}>5 turns</option>
                  </select>
                </NativeSetting>
              )}
            </div>
            {advisorOn && (
              <NativeSetting label="Review Subagents" description="Apply Advisor passive review to subagent tasks.">
                <ToggleSwitch
                  checked={settings?.advisor?.subagents ?? false}
                  onChange={(checked) => patchSection("advisor", { subagents: checked })}
                />
              </NativeSetting>
            )}
          </section>

          {/* COMPACTION */}
          <section style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <SectionHeading title="Context Compaction" description="OMP automatically compacts oversized context to prevent hitting context limits." />
            <div style={grid}>
              <NativeSetting label="Automatic Compaction" description="Compact context before model context limit is hit.">
                <ToggleSwitch
                  checked={settings?.compaction?.enabled ?? true}
                  onChange={(checked) => patchSection("compaction", { enabled: checked })}
                />
              </NativeSetting>
              <NativeSetting label="Continue After Compaction" description="Resume task execution after compaction completes.">
                <ToggleSwitch
                  checked={settings?.compaction?.autoContinue ?? true}
                  onChange={(checked) => patchSection("compaction", { autoContinue: checked })}
                />
              </NativeSetting>
              <NativeSetting label="Method Order" description="Preferred order of context-maintenance methods; unavailable methods fall through to the next.">
                <CompactionMethodOrderEditor
                  value={settings?.compaction?.methodOrder}
                  onChange={(methodOrder) => patchSection("compaction", { methodOrder })}
                />
              </NativeSetting>
              <NativeSetting label="Compact Mid-Turn" description="Check context limits between tool execution steps.">
                <ToggleSwitch
                  checked={settings?.compaction?.midTurnEnabled ?? true}
                  onChange={(checked) => patchSection("compaction", { midTurnEnabled: checked })}
                />
              </NativeSetting>
            </div>
          </section>

          {/* MEMORY & AUTO-LEARN */}
          <section style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <SectionHeading title="Memory & Auto-Learn" description="Durable project memory storage and automatic lesson capture." />
            <div style={grid}>
              <NativeSetting label="Memory Backend" description="Where durable knowledge is stored across sessions.">
                <select
                  style={nativeSelectStyle}
                  value={settings?.memory?.backend ?? "mnemopi"}
                  onChange={(e) => patchSection("memory", { backend: e.target.value as NonNullable<NativeSettings["memory"]>["backend"] })}
                >
                  <option value="off" style={nativeOptionStyle}>Off</option>
                  <option value="local" style={nativeOptionStyle}>Local summaries</option>
                  <option value="mnemopi" style={nativeOptionStyle}>Mnemopi SQLite</option>
                  <option value="hindsight" style={nativeOptionStyle}>Hindsight</option>
                </select>
              </NativeSetting>
              <NativeSetting label="Enable Auto-Learn" description="Capture reusable lessons after completed runs.">
                <ToggleSwitch
                  checked={settings?.autolearn?.enabled ?? true}
                  onChange={(checked) => patchSection("autolearn", { enabled: checked })}
                />
              </NativeSetting>
              <NativeSetting label="Private Capture Turn" description="Run private lesson-capture turn at completion.">
                <ToggleSwitch
                  checked={settings?.autolearn?.autoContinue ?? true}
                  onChange={(checked) => patchSection("autolearn", { autoContinue: checked })}
                />
              </NativeSetting>
              <NativeSetting label="Memory Scope" description="Scoping for Mnemopi knowledge storage.">
                <select
                  style={nativeSelectStyle}
                  value={settings?.mnemopi?.scoping ?? "per-project"}
                  onChange={(e) => patchSection("mnemopi", { scoping: e.target.value as NonNullable<NativeSettings["mnemopi"]>["scoping"] })}
                >
                  <option value="per-project" style={nativeOptionStyle}>Per project</option>
                  <option value="per-project-tagged" style={nativeOptionStyle}>Per project, tagged recall</option>
                  <option value="global" style={nativeOptionStyle}>Global</option>
                </select>
              </NativeSetting>
              <NativeSetting label="Recall on Session Start" description="Load relevant memories into first turn.">
                <ToggleSwitch
                  checked={settings?.mnemopi?.autoRecall ?? true}
                  onChange={(checked) => patchSection("mnemopi", { autoRecall: checked })}
                />
              </NativeSetting>
              <NativeSetting label="Retain Completed Turns" description="Store completed conversation turns in memory.">
                <ToggleSwitch
                  checked={settings?.mnemopi?.autoRetain ?? true}
                  onChange={(checked) => patchSection("mnemopi", { autoRetain: checked })}
                />
              </NativeSetting>
            </div>
          </section>

          {/* RETRY */}
          <section style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <SectionHeading title="Automatic Retry" description="Rules for automatically retrying failed turns." />
            <div style={grid}>
              <NativeSetting label="Automatic Retry" description="Retry failed turns automatically.">
                <ToggleSwitch
                  checked={settings?.retry?.enabled ?? true}
                  onChange={(checked) => patchSection("retry", { enabled: checked })}
                />
              </NativeSetting>
              <NativeSetting label="Max Attempts" description="Retry limit before giving up.">
                <select
                  style={nativeSelectStyle}
                  value={String(settings?.retry?.maxRetries ?? 2)}
                  onChange={(e) => patchSection("retry", { maxRetries: Number(e.target.value) })}
                >
                  {[0, 1, 2, 3, 4, 5].map((n) => (
                    <option key={n} value={n} style={nativeOptionStyle}>{n}</option>
                  ))}
                </select>
              </NativeSetting>
              <NativeSetting label="Model Fallback" description="Fall back to alternative model when retries exhaust.">
                <ToggleSwitch
                  checked={settings?.retry?.modelFallback ?? false}
                  onChange={(checked) => patchSection("retry", { modelFallback: checked })}
                />
              </NativeSetting>
            </div>
          </section>
        </div>
      )}

      {/* ALL <ENGINE> SETTINGS, rendered from the engine's own schema. The
          panel carries its own "All {shortName} Settings" heading. */}
      {capabilities.nativeSettings && (
        <div style={curated ? { borderTop: "1px solid var(--border)" } : undefined}>
          <OmpSchemaSettings
            isMobile={isMobile}
            harnessLabel={harnessLabel}
            reloadToken={writeSeq}
            onSaved={onSchemaSaved}
          />
        </div>
      )}
    </div>
  );
}
