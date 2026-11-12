import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createJiti } from "jiti";
import { ompTestPackageBin, ompTestPackageSkip } from "./omp-test-package.mjs";

const FAKE_BIN = ompTestPackageBin();
const skip = ompTestPackageSkip();

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });

/**
 * A rule naming a setting the installed engine does not declare is ambiguous:
 * either upstream renamed it away (the failure this test exists for) or the
 * rule targets a NEWER engine than the one installed here. The audited version
 * marker tells them apart, so the unmatched-rule check only judges an engine
 * at least as new as what this build was audited against.
 */
async function rulesAreJudgeable() {
  if (FAKE_BIN === null) return false;
  const { ompPackageVersion, findOmpPackageRoot } = await jiti.import("./package-source.ts");
  process.env.CODY_OMP_BIN = FAKE_BIN;
  (await jiti.import("./omp-cli.ts")).invalidateOmpCliCache();
  const root = findOmpPackageRoot() ?? path.resolve(path.dirname(FAKE_BIN), "..");
  const installed = ompPackageVersion(root);
  const { ompHarness } = await jiti.import("../harness/omp.ts");
  const audited = ompHarness.verifiedVersion;
  if (!installed || !audited) return false;
  const rank = (version) => version.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const [a, b] = [rank(installed), rank(audited)];
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

async function loadSchema() {
  process.env.CODY_OMP_BIN = FAKE_BIN;
  const { getOmpSettingsSchema, clearOmpSettingsSchemaCache } = await jiti.import("./settings-schema.ts");
  (await jiti.import("./omp-cli.ts")).invalidateOmpCliCache();
  clearOmpSettingsSchemaCache();
  return getOmpSettingsSchema();
}

test("every terminal-only rule still matches the installed schema", { skip }, async (t) => {
  if (!(await rulesAreJudgeable())) {
    t.diagnostic("installed omp predates the audited version — rules may name settings it does not declare yet");
    return;
  }
  const schema = await loadSchema();
  const keys = new Set(schema.settings.map((setting) => setting.key));
  const { TERMINAL_ONLY_RULES } = await jiti.import("./settings-surface.ts");

  // A rule that matches nothing is a rule the harness renamed out from under
  // us — the badge would silently stop appearing for a setting that still does
  // nothing in the browser.
  for (const key of TERMINAL_ONLY_RULES.keys) {
    assert.ok(keys.has(key), `terminal-only key "${key}" is no longer in the schema`);
  }
  for (const prefix of TERMINAL_ONLY_RULES.prefixes) {
    assert.ok(
      [...keys].some((key) => key.startsWith(prefix)),
      `terminal-only prefix "${prefix}" no longer matches any setting`,
    );
  }
});

test("every Cody-behaviour note still names a setting the engine declares", { skip }, async () => {
  const schema = await loadSchema();
  const keys = new Set(schema.settings.map((setting) => setting.key));
  const { SETTING_NOTE_KEYS, settingNoteFor } = await jiti.import("./settings-surface.ts");
  const { ompPackageVersion, findOmpPackageRoot } = await jiti.import("./package-source.ts");
  const installed = ompPackageVersion(findOmpPackageRoot() ?? path.resolve(path.dirname(FAKE_BIN), ".."));
  const rank = (version) => String(version).split(".").map((part) => Number.parseInt(part, 10) || 0);
  const atLeast = (have, want) => {
    const [a, b] = [rank(have), rank(want)];
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
    return true;
  };
  // Notes for settings an older engine does not have yet are written for the
  // newer engines Cody also runs on; they cannot be judged against a schema
  // that predates the setting.
  const NOTE_SINCE = {
    "providers.cacheWarming": "18.3.5",
    "task.speculativeLaunch": "18.4.3",
    "task.completionProbe": "18.5.0",
    "task.autoParallel": "18.19.0",
    "task.perCallModel": "18.14.2",
    "prewalk.auto": "18.11.3",
    "async.widgets": "18.12.3",
    "tools.xdevNotices": "18.13.3",
    "out.enabled": "18.14.0",
    "providers.openai-codex.daybreak": "18.14.1",
    "hindsight.globalScope": "18.16.0",
    "display.shellVisualization": "18.17.0",
    "claudeResets.autoRedeem5h": "18.18.7",
    "claudeResets.autoRedeemWeekly": "18.18.7",
    "claudeResets.autoRedeemFable": "18.18.7",
    // First seen somewhere in 18.8.4-18.18.9; judged from the end of that range.
    "spotlight.experiment.enabled": "18.18.9",
  };

  // A note whose key was renamed upstream is worse than no note: the caveat
  // silently stops being shown for a setting that still behaves that way.
  for (const key of SETTING_NOTE_KEYS) {
    if (NOTE_SINCE[key] && !(installed && atLeast(installed, NOTE_SINCE[key]))) continue;
    assert.ok(keys.has(key), `noted key "${key}" is no longer in the schema`);
  }
  assert.equal(settingNoteFor("prewalk.enabled"), undefined);
  // The note must reach the panel through the schema, not just the lookup.
  const noted = schema.settings.find((setting) => setting.key === "retry.usageAwareFallback");
  assert.match(noted?.codyNote ?? "", /Auto-fallback/);
  const warming = schema.settings.find((setting) => setting.key === "providers.cacheWarming");
  if (warming) assert.match(warming.codyNote ?? "", /spends quota or money/);
  const probe = schema.settings.find((setting) => setting.key === "task.completionProbe");
  if (probe) assert.match(probe.codyNote ?? "", /never when driven over RPC/);
  // Every note added for omp 18.19 reaches the panel too, on the engines that declare the key.
  for (const [key, pattern] of [
    ["providers.openaiLiveSteering", /next tool call/],
    ["out.enabled", /Off in Cody until you turn it on/],
    ["async.widgets", /widget" model role/],
    ["prewalk.auto", /"judge" model/],
    ["spotlight.experiment.enabled", /cloud\.stencil\.so/],
    ["providers.openai-codex.daybreak", /improve its models/],
    ["tools.xdevNotices", /MCP tools updated/],
    ["mnemopi.proactiveLinking", /grows|number of memories/],
    ["hindsight.globalScope", /per-project-tagged/],
    ["ask.timeout", /older engines pick the recommended answer/],
    ["display.shellVisualization", /Cody starts every chat with this off/],
    ["claudeResets.autoRedeem5h", /Fable is a separate consent/],
    ["claudeResets.autoRedeemWeekly", /Fable is a separate consent/],
    ["claudeResets.autoRedeemFable", /Fable is a separate consent/],
  ]) {
    const row = schema.settings.find((setting) => setting.key === key);
    if (row) assert.match(row.codyNote ?? "", pattern, `${key} note reaches the panel`);
  }
  // `out.enabled` is switched on by the engine only in its own terminal: a Cody chat
  // keeps it off until the key is written, so the panel must not claim On.
  const out = schema.settings.find((setting) => setting.key === "out.enabled");
  if (out) assert.equal(out.default, false, "out.enabled reads Off while unset in Cody");
  const visualization = schema.settings.find((setting) => setting.key === "display.shellVisualization");
  if (visualization) assert.equal(visualization.default, false, "display.shellVisualization reads Off while unset in Cody");
});

test("classifies terminal chrome without catching settings the browser uses", { skip }, async () => {
  const { isTerminalOnlySetting } = await jiti.import("./settings-surface.ts");

  for (const key of ["theme.dark", "statusLine.preset", "tui.tight", "display.shimmer", "startup.showSplash", "symbolPreset", "input.bareExitOnEmptySession", "input.bareSlashCommands", "browser.tern", "expandThinkingBlocks"]) {
    assert.equal(isTerminalOnlySetting(key), true, `${key} should be terminal-only`);
  }
  // omp 18.8.6-18.17 terminal-only switches (nothing under src/modes/rpc reads them).
  for (const key of ["update.auto", "session.worktreeScope", "composer.predictions", "composer.predictionAlternatives", "terminal.programStatus", "worktree.onStart", "worktree.onExit", "extensionHandlers.modeControl", "extensionRenderers.assistantText", "extensionRenderers.transcriptPresenters", "btw.inject", "async.printWake", "title.refreshAfterPrompts"]) {
    assert.equal(isTerminalOnlySetting(key), true, `${key} should be terminal-only`);
  }
  // The engine core reads these for rpc-ui sessions and Cody drives the live values, so they are NOT terminal-only.
  for (const key of ["steeringMode", "followUpMode", "interruptMode", "title.refreshOnReplan", "title.generator", "title.icons"]) {
    assert.equal(isTerminalOnlySetting(key), false, `${key} must not be marked terminal-only`);
  }

  // These drive the agent itself and reach Cody's UI, so they must stay unmarked.
  for (const key of ["prewalk.enabled", "task.eager", "compaction.enabled", "memory.backend", "tools.approvalMode", "defaultThinkingLevel", "providers.cacheWarming", "task.speculativeLaunch", "task.completionProbe", "browser.headless"]) {
    assert.equal(isTerminalOnlySetting(key), false, `${key} must not be marked terminal-only`);
  }
  // Prefixes match on the dotted path, not a bare substring.
  assert.equal(isTerminalOnlySetting("mytui.thing"), false);
  // Word completion is the one spelling setting Cody's composer honours.
  assert.equal(isTerminalOnlySetting("spelling.autocomplete"), false);
  assert.equal(isTerminalOnlySetting("spelling.typoDetection"), true);
});
