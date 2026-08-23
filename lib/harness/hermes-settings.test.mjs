import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  flattenHermesDefaults, getHermesSettingsSchema, humanizeKey, orderGroups, settingTypeOf,
} = await jiti.import("./hermes-settings.ts");

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
