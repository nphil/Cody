/**
 * `task.agentModelOverrides` in omp's config.yml: the per-agent model
 * selection that outranks an agent definition's own `model:` frontmatter.
 *
 * It lives here rather than going through the schema writer because the
 * setting is a RECORD with no `ui` metadata — the schema surface neither
 * renders nor accepts it — while its value is exactly what decides where
 * every subagent runs. Read and written surgically, like `modelRoles`, so
 * the rest of the user's config is untouched.
 *
 * omp accepts a selector string OR a list of them per agent. Cody's own
 * writers only ever produce strings, but a hand-written list is legal and
 * must survive: every write here keeps entries it did not set.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { type Document, isMap, parseDocument } from "yaml";
import { isAgentName, writableAgentModelSelector } from "../agent-model-selector";
import { getAgentDir } from "./paths";
import { isRecord } from "../type-guards";

const SETTING = "agentModelOverrides";

/** An override as omp stores it: one selector or a list of selectors. */
export type AgentModelOverrideValue = string | string[];

function configPath(): string {
	return join(getAgentDir(), "config.yml");
}

function loadDocument(path: string): Document {
	const doc = parseDocument(existsSync(path) ? readFileSync(path, "utf8") : "");
	if (doc.errors.length > 0) throw new Error(`${path} is not valid YAML: ${doc.errors[0].message}`);
	return doc;
}

/** The document to edit: a YAML mapping (or nothing yet) is the only shape config.yml can have. */
function loadWritableDocument(path: string): Document {
	const doc = loadDocument(path);
	if (doc.contents !== null && !isMap(doc.contents)) throw new Error(`${path} must contain a YAML mapping`);
	return doc;
}

function saveDocument(path: string, doc: Document): void {
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
	writeFileSync(temp, doc.toString(), "utf8");
	renameSync(temp, path);
}

/** Every entry, list-valued ones included. */
export function readAgentModelOverrideEntries(): Record<string, AgentModelOverrideValue> {
	const path = configPath();
	if (!existsSync(path)) return {};
	const data = loadDocument(path).toJS();
	if (!isRecord(data) || !isRecord(data.task) || !isRecord(data.task[SETTING])) return {};
	const entries: Record<string, AgentModelOverrideValue> = {};
	for (const [agent, value] of Object.entries(data.task[SETTING])) {
		if (typeof value === "string") entries[agent] = value;
		else if (Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string")) entries[agent] = value;
	}
	return entries;
}

/** The string-valued entries: what Cody's routing reconcile reads and rewrites. */
export function readAgentModelOverrides(): Record<string, string> {
	return Object.fromEntries(
		Object.entries(readAgentModelOverrideEntries()).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
	);
}

/**
 * Replace the string-valued overrides with `overrides`. A list-valued entry
 * the caller never saw (`readAgentModelOverrides` hides them) is kept unless
 * `overrides` names that agent: dropping it would silently undo a setting the
 * caller had no way to know about.
 */
export function writeAgentModelOverrides(overrides: Record<string, string>): void {
	const path = configPath();
	const doc = loadWritableDocument(path);
	const current = (doc.toJS() as { task?: { [SETTING]?: unknown } } | null)?.task?.[SETTING];
	const kept = isRecord(current)
		? Object.fromEntries(Object.entries(current).filter(([agent, value]) => typeof value !== "string" && !(agent in overrides)))
		: {};
	// `setIn` creates the `task` map when absent and leaves its siblings
	// (`task.prewalk`, `task.eager`, …) exactly as the user wrote them.
	doc.setIn(["task", SETTING], { ...overrides, ...kept });
	saveDocument(path, doc);
}

/**
 * Set one agent's model (a role alias or an exact `provider/model`), or clear
 * it with `null`. Touches that one key: the other agents' entries, a list
 * written by hand, comments and every other setting stay as they were. An
 * emptied `agentModelOverrides` (and a `task` map left empty by it) is
 * removed rather than left as a dangling `{}`.
 */
export function setAgentModelOverride(agent: string, selector: string | null): void {
	if (!isAgentName(agent)) throw new Error(`"${agent}" is not an agent name`);
	const value = selector === null ? null : writableAgentModelSelector(selector);
	if (selector !== null && value === null) throw new Error("A helper's model is a role such as @slow or one exact provider/model");
	const path = configPath();
	const doc = loadWritableDocument(path);
	if (value === null) {
		if (!doc.hasIn(["task", SETTING, agent])) return;
		doc.deleteIn(["task", SETTING, agent]);
		const overrides = doc.getIn(["task", SETTING]);
		if (isMap(overrides) && overrides.items.length === 0) {
			doc.deleteIn(["task", SETTING]);
			const task = doc.get("task");
			if (isMap(task) && task.items.length === 0) doc.delete("task");
		}
	} else {
		doc.setIn(["task", SETTING, agent], value);
	}
	saveDocument(path, doc);
}
