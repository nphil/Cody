import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  flattenHermesDefaults, getHermesSettingsSchema, humanizeKey, orderGroups,
  readHermesSettingsValues, resetHermesSetting, settingTypeOf,
} = await jiti.import("./hermes-settings.ts");

/** A stand-in `hermes` whose `config` subcommand replays a scripted exit. */
function stubHermes(script) {
  const dir = mkdtempSync(join(tmpdir(), "hermes-cli-"));
  const path = join(dir, "hermes");
  writeFileSync(path, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return path;
}

test("keys become labels without mangling acronyms", () => {
  assert.equal(humanizeKey("show_reasoning"), "Show reasoning");
  assert.equal(humanizeKey("max_turns"), "Max turns");
  // "Api key" reads as a typo; these are the acronyms Hermes actually uses.
  assert.equal(humanizeKey("api_key"), "API key");
  assert.equal(humanizeKey("base_url"), "Base URL");
  assert.equal(humanizeKey("tts"), "TTS");
  assert.equal(humanizeKey("model"), "Model");
});

test("the control follows the default's type", () => {
  assert.equal(settingTypeOf(true), "boolean");
  assert.equal(settingTypeOf(90), "number");
  assert.equal(settingTypeOf("auto"), "string");
  assert.equal(settingTypeOf([1, 2]), "array");
  // Anything unrenderable degrades to a string rather than vanishing: a
  // setting Cody drops is a setting the user cannot see exists.
  assert.equal(settingTypeOf(null), "string");
  assert.equal(settingTypeOf(undefined), "string");
});

test("nested defaults flatten to dotted paths grouped by section", () => {
  const settings = flattenHermesDefaults({
    model: "",
    max_turns: 90,
    display: { show_reasoning: true, skin: "default" },
    auxiliary: { vision: { provider: "auto", api_key: "" } },
    // Hermes' own bookkeeping is not a setting.
    _config_version: 7,
  });

  const byKey = Object.fromEntries(settings.map((s) => [s.key, s]));
  assert.ok(!("_config_version" in byKey), "private keys are skipped");
  assert.equal(byKey["display.show_reasoning"].type, "boolean");
  assert.equal(byKey["display.show_reasoning"].group, "Display");
  assert.equal(byKey["display.show_reasoning"].label, "Show reasoning");
  // Arbitrary nesting depth keeps its full path, or two settings collide.
  assert.equal(byKey["auxiliary.vision.api_key"].key, "auxiliary.vision.api_key");
  assert.equal(byKey["auxiliary.vision.api_key"].group, "Auxiliary");
  // Top-level scalars still need a home.
  assert.equal(byKey["model"].group, "General");
  assert.equal(byKey["max_turns"].default, 90);
});

test("agent sections lead; messaging platforms sort last", () => {
  const settings = flattenHermesDefaults({
    telegram: { token: "" },
    agent: { name: "" },
    slack: { token: "" },
    approvals: { mode: "ask" },
  });
  const order = orderGroups(settings);
  // Every platform section still appears — hiding an engine's real settings
  // would be a lie — but the agent's own configuration comes first.
  assert.deepEqual(order, ["Agent", "Approvals", "Slack", "Telegram"]);
});

test("the schema is re-read after a reinstall rebuilds the venv", async () => {
  // `uv tool install --force` rebuilds the venv at the SAME path, so a memo
  // keyed on the binary path alone would serve the old version's settings
  // until Cody restarted.
  const root = mkdtempSync(join(tmpdir(), "hermes-venv-"));
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(root, "pyvenv.cfg"), "home = /usr\n");
  writeFileSync(join(bin, "hermes"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const stubPython = (json) =>
    writeFileSync(join(bin, "python"), `#!/bin/sh\ncat <<'JSON'\n${json}\nJSON\n`, { mode: 0o755 });

  stubPython(JSON.stringify({ max_turns: 90 }));
  const first = getHermesSettingsSchema(join(bin, "hermes"));
  assert.equal(first.settings.find((s) => s.key === "max_turns").default, 90);

  // Same call again is served from the memo — the point of having one.
  stubPython(JSON.stringify({ max_turns: 5 }));
  assert.equal(
    getHermesSettingsSchema(join(bin, "hermes")).settings.find((s) => s.key === "max_turns").default,
    90,
  );

  // An install rewrites the venv; its mtime is what dates the installation.
  const later = new Date(Date.now() + 10_000);
  utimesSync(root, later, later);
  const after = getHermesSettingsSchema(join(bin, "hermes"));
  assert.equal(after.settings.find((s) => s.key === "max_turns").default, 5);

  rmSync(root, { recursive: true, force: true });
});

test("list settings carry a real array, not JSON text", () => {
  // The panel's list editor renders `Array.isArray(value) ? value : []`, so a
  // JSON string arrives there as an empty list — which is how all 20 of
  // Hermes 0.19.0's list settings looked.
  const settings = flattenHermesDefaults({
    toolsets: ["hermes-cli"],
    command_allowlist: [],
    approvals: { deny: [] },
    display: { runtime_footer: { fields: ["model", "cwd"] } },
    // Hermes' moa presets hold dicts. The editor has one line per entry and
    // no line form for a dict, so those stay JSON text rather than rendering
    // as a list the user could silently flatten.
    moa: { reference_models: [{ provider: "openai" }] },
  });
  const byKey = Object.fromEntries(settings.map((s) => [s.key, s]));
  assert.deepEqual(byKey["toolsets"].default, ["hermes-cli"]);
  assert.equal(byKey["toolsets"].type, "array");
  assert.deepEqual(byKey["command_allowlist"].default, []);
  assert.deepEqual(byKey["approvals.deny"].default, []);
  assert.deepEqual(byKey["display.runtime_footer.fields"].default, ["model", "cwd"]);
  assert.equal(byKey["moa.reference_models"].type, "string");
  assert.equal(byKey["moa.reference_models"].default, '[{"provider":"openai"}]');
});

test("a leaf Hermes declares as None claims no default", () => {
  // `None` carries neither a value nor a type; "" would invent both, and the
  // panel would then print a default Hermes never declared.
  const settings = flattenHermesDefaults({
    max_concurrent_sessions: null,
    cron: { max_parallel_jobs: null },
  });
  const byKey = Object.fromEntries(settings.map((s) => [s.key, s]));
  assert.equal(byKey["max_concurrent_sessions"].type, "string");
  assert.equal(byKey["max_concurrent_sessions"].default, undefined);
  assert.equal(byKey["cron.max_parallel_jobs"].default, undefined);
});

test("saved values arrive in the shape their control renders", () => {
  const home = mkdtempSync(join(tmpdir(), "hermes-home-"));
  writeFileSync(join(home, "config.yaml"), [
    "toolsets:",
    "  - hermes-cli",
    "  - web",
    // `hermes config set max_concurrent_sessions 4` stores an int, because it
    // coerces any key whose default is not a string.
    "max_concurrent_sessions: 4",
    "agent:",
    "  max_turns: 50",
    "  disabled_toolsets: []",
    "model: openai/gpt-5.5",
  ].join("\n"));
  const settings = flattenHermesDefaults({
    toolsets: ["hermes-cli"],
    max_concurrent_sessions: null,
    model: "",
    agent: { max_turns: 90, disabled_toolsets: [] },
  });
  const values = readHermesSettingsValues(home, settings);

  assert.deepEqual(values["toolsets"], ["hermes-cli", "web"]);
  assert.deepEqual(values["agent.disabled_toolsets"], []);
  assert.equal(values["agent.max_turns"], 50);
  assert.equal(values["model"], "openai/gpt-5.5");
  // A typeless leaf renders as text, and a text input shows a number as
  // nothing at all — which blanked every saved value on reload. The file
  // keeps the int; only what the panel displays is text.
  assert.equal(values["max_concurrent_sessions"], "4");

  rmSync(home, { recursive: true, force: true });
});

test("a value the control cannot show falls back to the default", () => {
  const home = mkdtempSync(join(tmpdir(), "hermes-home-"));
  // A hand-edited config can hold anything; a mistyped value must not reach a
  // control that assumes otherwise.
  writeFileSync(join(home, "config.yaml"), "agent:\n  max_turns: sixty\n");
  const values = readHermesSettingsValues(home, flattenHermesDefaults({ agent: { max_turns: 90 } }));
  assert.equal(values["agent.max_turns"], undefined);

  rmSync(home, { recursive: true, force: true });
});

test("no config file yet reads as no overrides", () => {
  const home = mkdtempSync(join(tmpdir(), "hermes-home-"));
  assert.deepEqual(readHermesSettingsValues(home, flattenHermesDefaults({ model: "" })), {});
  rmSync(home, { recursive: true, force: true });
});

test("reset unsets the key, and a key with no override is already reset", () => {
  const log = join(mkdtempSync(join(tmpdir(), "hermes-log-")), "args");
  const ok = stubHermes(`echo "$@" >> ${log}\nexit 0`);
  resetHermesSetting(ok, "agent.max_turns");
  assert.equal(readFileSync(log, "utf8").trim(), "config unset agent.max_turns");

  // `hermes config unset` exits 1 for a key that was never overridden. That
  // is the state Reset asked for, so it is done, not a failure to report.
  const absent = stubHermes('echo "Config key not set: $3" >&2\nexit 1');
  resetHermesSetting(absent, "agent.max_turns");

  // Every other refusal still surfaces, carrying the CLI's own reason.
  const managed = stubHermes('echo "Cannot set: managed by your administrator" >&2\nexit 1');
  assert.throws(() => resetHermesSetting(managed, "agent.max_turns"), /managed by your administrator/);
});

test("lists are shown but marked read-only, because Hermes cannot store one", () => {
  // `hermes config set` takes a single scalar: `hermes config set toolsets
  // 'a,b'` writes the STRING "a,b" where Hermes expects a list, corrupting the
  // key. So the panel shows the real value and refuses to offer an edit.
  const settings = flattenHermesDefaults({
    toolsets: ["hermes-cli"],
    max_turns: 90,
    display: { skin: "default" },
  });
  const byKey = Object.fromEntries(settings.map((s) => [s.key, s]));

  assert.equal(byKey.toolsets.type, "array");
  assert.deepEqual(byKey.toolsets.default, ["hermes-cli"], "the real value is still shown");
  assert.equal(byKey.toolsets.readOnly, true);
  assert.match(byKey.toolsets.readOnlyReason, /cannot be saved/i);

  // Everything Hermes CAN store stays editable; a blanket read-only panel
  // would be its own lie.
  assert.equal(byKey.max_turns.readOnly, undefined);
  assert.equal(byKey["display.skin"].readOnly, undefined);
});
