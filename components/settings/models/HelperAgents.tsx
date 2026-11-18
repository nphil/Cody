"use client";

/**
 * Settings › Models › Helper agents: one row per helper agent omp can start
 * (`task`, `scout`, `reviewer`, … plus the ones you wrote), with the model it
 * runs on and the size its memory may reach before it summarises.
 *
 * The model is `task.agentModelOverrides` in omp's config.yml, which omp reads
 * every time it starts a helper: a change applies to the next helper, never
 * to one that is already running (that has its own "Change model" in the
 * helper window). Where there is no setting the row shows what the agent
 * file chooses, or says the helper follows the chat that starts it, so the
 * row always tells the truth about what runs and why.
 *
 * The roster itself (built-in agents, your agents folder, each project's
 * `.omp/agents`) comes from `/api/omp-agents`; this file only draws it. The
 * memory limit is the same `task.agentCompactionThresholdOverrides` the
 * Behavior hub's "Helper agents' memory limit" card edits.
 *
 * English only, like the rest of Settings (docs/agents/settings.md).
 */
import type { CSSProperties, ReactNode } from "react";
import { Select, type SelectGroup } from "@/components/ui/Select";
import { useConfigWriter, useNativeSettings } from "@/hooks/useConfigWriter";
import { useHelperChoices } from "@/hooks/useHelperChoices";
import { invalidateSettingsRoutes, setSettingsRouteData, useSettingsRoute } from "@/hooks/useSettingsData";
import {
  HELPER_RESET_VALUE,
  describeHelperSelector,
  fileModelFollowsChat,
  helperModelStatus,
  helperOptionGroups,
  helperResetLabel,
  helperSelectorOf,
  helperValue,
  type AgentDefinitionInfo,
  type HelperAgentRow,
  type HelperChoicesInput,
  type HelperModelStatus,
} from "@/lib/helper-agents";
import { chipStyle } from "../primitives";
import { useSaveStatus } from "../SaveStatus";
import { SettingsSection } from "../SettingsSection";
import { useSettingsShell } from "../shell-context";
import {
  choiceId, describeLimit, limitChoices, parseChoiceId, parseOverride, withAgentLimit,
  type HelperLimit, type Overrides,
} from "../engine/helper-memory";

const AGENTS_ROUTE = "/api/omp-agents";

interface AgentsBody {
  agents?: HelperAgentRow[];
  /** Why omp's own agents could not be listed; your own are still shown. */
  bundledError?: string | null;
}

const captionStyle: CSSProperties = { fontSize: 10.5, color: "var(--text-dim)" };
const noteStyle: CSSProperties = { fontSize: 11, lineHeight: 1.45, color: "var(--text-dim)", overflowWrap: "anywhere" };

/** Where an agent file lives, as a person would say it. */
function originLabel(definition: AgentDefinitionInfo): string {
  if (definition.origin === "bundled") return "built into omp";
  if (definition.origin === "user") return "your agents folder";
  const folder = definition.projectRoot?.split("/").filter(Boolean).pop();
  return folder ? `the ${folder} project` : "a project";
}

/** The model line: what the agent runs on and why, in one sentence. */
function statusSentence(row: HelperAgentRow, status: HelperModelStatus, input: HelperChoicesInput): string {
  const model = status.selector
    ? describeHelperSelector(status.selector.selector, input)
    : status.list
      ? status.list.join(", then ")
      : null;
  if (status.source === "setting") {
    const why = row.codyDefault !== null && row.setting === row.codyDefault ? "Cody's default for this agent" : "set here";
    return `Runs on ${model ?? "its configured model"}, ${why}.`;
  }
  if (status.source === "file") {
    const own = row.definitions.find((definition) => !fileModelFollowsChat(definition.model));
    return `Runs on ${model ?? "its file's model"}, as its agent file chooses (${own ? originLabel(own) : "agent file"}).`;
  }
  return "Runs on the model of the chat that starts it; nothing here or in the agent file chooses one.";
}

/** The things worth a second look about the current choice. */
function warnings(status: HelperModelStatus): string[] {
  const found: string[] = [];
  if (status.varies) found.push("Agent files in different places choose different models. The first one found for a chat's folder is used.");
  if (status.list) found.push("This is a list written in config.yml. Choosing a model here replaces it.");
  else if (status.selector?.kind === "custom") found.push("This value was written by hand in config.yml. Choosing a model here replaces it.");
  else if (status.source === "setting" && status.selector?.kind === "model") found.push("One exact model has no fallback chain: if it fails, the helper fails. A role keeps its fallback chain.");
  return found;
}

function badgesFor(row: HelperAgentRow): ReactNode[] {
  const labels: string[] = [];
  for (const definition of row.definitions) {
    const label = definition.origin === "bundled" ? "Built in" : definition.origin === "user" ? "Your agents folder" : `Project: ${definition.projectRoot?.split("/").filter(Boolean).pop() ?? "?"}`;
    if (!labels.includes(label)) labels.push(label);
  }
  if (row.definitions.length === 0) labels.push("No agent file");
  return labels.map((label) => (
    <span key={label} style={label === "No agent file" ? { ...chipStyle, color: "var(--status-warning)" } : chipStyle}>{label}</span>
  ));
}

function Captioned({ caption, children }: { caption: string; children: ReactNode }) {
  return (
    <div style={{ display: "grid", gap: 3, minWidth: 0 }}>
      <span style={captionStyle}>{caption}</span>
      {children}
    </div>
  );
}

/** The memory-limit choices: the engine's default, a share of the model's window, or a fixed size. */
function limitGroups(own: HelperLimit | null): SelectGroup[] {
  const sizes = (mode: "percent" | "tokens") => limitChoices(mode, own?.mode === mode ? own.value : null)
    .map((value) => ({ value: choiceId({ mode, value }), label: describeLimit({ mode, value }) }));
  return [
    { label: "Default", options: [{ value: choiceId("inherit"), label: "Same as my chats" }] },
    { label: "Share of the model's window", options: sizes("percent") },
    { label: "Fixed size", options: sizes("tokens") },
  ];
}

interface RowProps {
  row: HelperAgentRow;
  input: HelperChoicesInput;
  overrides: Overrides | null;
  onModel: (row: HelperAgentRow, selector: string | null) => void;
  onLimit: (agent: string, choice: HelperLimit | "same" | "inherit") => void;
  isLast?: boolean;
}

function HelperRow({ row, input, overrides, onModel, onLimit, isLast }: RowProps) {
  const status = helperModelStatus(row);
  const current = status.selector?.selector ?? status.list?.join(", ") ?? null;
  const value = current ? helperValue(current) : null;
  const groups = helperOptionGroups({ ...input, current, reset: helperResetLabel(row, input) });
  const own = overrides ? parseOverride(overrides[row.name]) : null;
  const notes = warnings(status);
  return (
    <div data-helper-agent={row.name} style={{ display: "grid", gap: 8, minWidth: 0, padding: "12px 14px", borderBottom: isLast ? "none" : "1px solid var(--border)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", minWidth: 0 }}>
        <code style={{ fontSize: 12.5, fontWeight: 600, fontFamily: "var(--font-mono)", overflowWrap: "anywhere" }}>{row.name}</code>
        {badgesFor(row)}
      </div>
      {row.description && <div style={{ ...noteStyle, color: "var(--text-muted)" }}>{row.description}</div>}
      <div
        className="model-role-row"
        style={{ display: "grid", gridTemplateColumns: overrides ? "minmax(0, 1.5fr) minmax(0, 1fr)" : "minmax(0, 1fr)", gap: 10, alignItems: "start" }}
      >
        <Captioned caption="Model">
          <Select
            value={value}
            onChange={(next) => {
              if (next === HELPER_RESET_VALUE) onModel(row, row.codyDefault);
              else {
                const selector = helperSelectorOf(next);
                if (selector) onModel(row, selector);
              }
            }}
            options={groups}
            placeholder="Same model as the chat that starts it"
            aria-label={`Model for ${row.name}`}
            popupWidth={320}
            search={{ placeholder: "Search models", empty: "No model matches" }}
          />
        </Captioned>
        {overrides && (
          <Captioned caption="Memory limit">
            <Select
              value={choiceId(own ?? "inherit")}
              onChange={(next) => {
                const choice = parseChoiceId(next);
                if (choice) onLimit(row.name, choice);
              }}
              options={limitGroups(own)}
              aria-label={`Memory limit for ${row.name}`}
            />
          </Captioned>
        )}
      </div>
      <div style={noteStyle}>{statusSentence(row, status, input)}</div>
      {notes.map((note) => <div key={note} style={{ ...noteStyle, color: "var(--status-warning)" }}>{note}</div>)}
    </div>
  );
}

export function HelperAgents({ panelId }: { panelId: string }) {
  const { capabilities } = useSettingsShell();
  const writer = useConfigWriter();
  const { track } = useSaveStatus(panelId);
  const route = useSettingsRoute<AgentsBody>(AGENTS_ROUTE);
  const { input } = useHelperChoices();
  const native = useNativeSettings(capabilities.configEditor);
  // The memory limit lives in the same config.yml; without its editor (or while
  // it loads) the column is left out rather than shown dead.
  const overrides: Overrides | null = native.enabled && !native.unsupported && native.settings ? native.settings.task?.agentCompactionThresholdOverrides ?? {} : null;
  const body = route.data;
  const rows = body?.agents ?? [];

  const saveModel = (row: HelperAgentRow, selector: string | null) => {
    // Show the choice at once; the route is re-read when the write settles, so a refusal puts the truth back.
    if (body?.agents) setSettingsRouteData<AgentsBody>(AGENTS_ROUTE, { ...body, agents: body.agents.map((candidate) => (candidate.name === row.name ? { ...candidate, setting: selector } : candidate)) });
    void track(() => writer.enqueue("settings", async () => {
      const response = await fetch(AGENTS_ROUTE, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agent: row.name, model: selector }) });
      const answer = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(answer.error ?? `Could not save (HTTP ${response.status})`);
    })).finally(() => invalidateSettingsRoutes(AGENTS_ROUTE, { exact: true }));
  };

  const saveLimit = (agent: string, choice: HelperLimit | "same" | "inherit") => {
    if (!overrides) return;
    void track(() => native.patchSection("task", { agentCompactionThresholdOverrides: withAgentLimit(overrides, agent, choice) }));
  };

  if (route.loading && !body) return <p style={noteStyle}>Loading the helper agents…</p>;
  if (route.unsupported) return <p style={noteStyle}>This engine has no helper agents.</p>;
  if (!body) {
    return (
      <p role="alert" style={{ ...noteStyle, color: "var(--status-error)" }}>
        Could not read the helper agents{route.error ? `: ${route.error}` : ""}.{" "}
        <button type="button" onClick={() => { void route.reload(); }} className="ui-focus-ring" style={{ background: "none", border: "none", padding: 0, color: "var(--accent)", cursor: "pointer", fontSize: 11 }}>Try again</button>
      </p>
    );
  }

  const builtIn = rows.filter((row) => row.builtIn);
  const yours = rows.filter((row) => !row.builtIn);
  const draw = (list: HelperAgentRow[]) => list.map((row) => (
    <HelperRow key={row.name} row={row} input={input} overrides={overrides} onModel={saveModel} onLimit={saveLimit} />
  ));

  return (
    <>
      <p style={{ ...noteStyle, margin: 0 }}>
        A change applies to helpers that start after you save it. A helper that is already running keeps its model; use <strong>Change model</strong> in its window to move it.
      </p>
      {body.bundledError && (
        <p role="status" style={{ ...noteStyle, margin: 0, color: "var(--status-warning)" }}>
          omp&apos;s built-in agents could not be listed ({body.bundledError}). Your own agents are shown below.
        </p>
      )}
      {builtIn.length > 0 && (
        <SettingsSection
          variant="rows"
          searchId="helper-agents"
          title="Built-in agents"
          description="The helpers omp starts by itself. Choosing a role keeps its fallback chain; Reset goes back to Cody's choice."
        >
          {draw(builtIn)}
        </SettingsSection>
      )}
      <SettingsSection
        variant={yours.length > 0 ? "rows" : "plain"}
        searchId={builtIn.length > 0 ? undefined : "helper-agents"}
        title="Your agents"
        description="Agent files in your own agents folder or a project's .omp/agents folder."
      >
        {yours.length > 0
          ? draw(yours)
          : <p style={{ ...noteStyle, margin: 0 }}>No agent files of your own were found. Add a .md file to your agents folder or a project&apos;s .omp/agents folder and it shows up here.</p>}
      </SettingsSection>
    </>
  );
}
