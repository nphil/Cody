import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  clearPiSettingsSchemaCache, enumValuesFromDescription, findPiPackageRoot, getPiSettingsSchema,
  humanizeKey, parsePiSettingsDocs, piSettingsPath, readPiSettings, readPiSettingsValues,
  writePiSettings, PI_TERMINAL_ONLY_KEYS,
} = await jiti.import("./pi-settings.ts");

/**
 * An excerpt of pi 0.73.1's own docs/settings.md, verbatim — the leading
 * Location/Scope table that is NOT a settings table, the `###` section
 * headings that become groups, a `####` sub-heading that must not, and one
 * row of every shape the parser has to survive: closed enums, open sets
 * ("e.g.", "or custom"), a default that is not a value (`-`, "SDK default"),
 * a significant-whitespace string default, dotted keys, and the two
 * documented types Cody has no control for.
 */
const DOCS_EXCERPT = `# Settings

Pi uses JSON settings files with project settings overriding global settings.

| Location | Scope |
|----------|-------|
| \`~/.pi/agent/settings.json\` | Global (all projects) |
| \`.pi/settings.json\` | Project (current directory) |

## All Settings

### Model & Thinking

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| \`defaultProvider\` | string | - | Default provider (e.g., \`"anthropic"\`, \`"openai"\`) |
| \`defaultThinkingLevel\` | string | - | \`"off"\`, \`"minimal"\`, \`"low"\`, \`"medium"\`, \`"high"\`, \`"xhigh"\` |
| \`hideThinkingBlock\` | boolean | \`false\` | Hide thinking blocks in output |
| \`thinkingBudgets\` | object | - | Custom token budgets per thinking level |

#### thinkingBudgets

\`\`\`json
{ "thinkingBudgets": { "minimal": 1024 } }
\`\`\`

### UI & Display

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| \`theme\` | string | \`"dark"\` | Theme name (\`"dark"\`, \`"light"\`, or custom) |
| \`autocompleteMaxVisible\` | number | \`5\` | Max visible items in autocomplete dropdown (3-20) |

### Compaction

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| \`compaction.enabled\` | boolean | \`true\` | Enable auto-compaction |
| \`compaction.reserveTokens\` | number | \`16384\` | Tokens reserved for LLM response |

### Retry

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| \`retry.provider.timeoutMs\` | number | SDK default | Provider/SDK request timeout in milliseconds |

### Message Delivery

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| \`steeringMode\` | string | \`"one-at-a-time"\` | How steering messages are sent: \`"all"\` or \`"one-at-a-time"\` |

### Markdown

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| \`markdown.codeBlockIndent\` | string | \`"  "\` | Indentation for code blocks |

### Resources

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| \`packages\` | array | \`[]\` | npm/git packages to load resources from |
| \`skills\` | string[] | \`[]\` | Local skill file paths or directories |
`;

/** A stand-in installed pi: the package layout findPiPackageRoot walks, with
 * whatever docs the test wants (or none). */
function stubPiPackage(docs) {
  const root = mkdtempSync(join(tmpdir(), "pi-pkg-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@mariozechner/pi-coding-agent", version: "0.73.1" }));
  mkdirSync(join(root, "dist"), { recursive: true });
  const binary = join(root, "dist", "cli.js");
  writeFileSync(binary, "#!/usr/bin/env node\n");
  if (docs !== null) {
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "docs", "settings.md"), docs);
  }
  clearPiSettingsSchemaCache();
  return { root, binary };
}

function agentDir(initial) {
  const dir = mkdtempSync(join(tmpdir(), "pi-agent-"));
  if (initial !== undefined) writeFileSync(join(dir, "settings.json"), initial);
  return dir;
}

const byKey = (settings) => Object.fromEntries(settings.map((setting) => [setting.key, setting]));

test("the docs' settings tables become a renderable schema", () => {
  const settings = parsePiSettingsDocs(DOCS_EXCERPT);
  const keys = byKey(settings);

  // The Location/Scope table at the top of the file is not a settings table,
  // and its rows must not become settings named `~/.pi/agent/settings.json`.
  assert.ok(!Object.keys(keys).some((key) => key.includes("/")), "a non-settings table leaked into the schema");

  assert.equal(keys["hideThinkingBlock"].type, "boolean");
  assert.equal(keys["hideThinkingBlock"].default, false);
  assert.equal(keys["compaction.reserveTokens"].type, "number");
  assert.equal(keys["compaction.reserveTokens"].default, 16384);
  assert.equal(keys["skills"].type, "array");
  assert.deepEqual(keys["skills"].default, []);
  // Significant whitespace survives: pi's code-block indent IS two spaces.
  assert.equal(keys["markdown.codeBlockIndent"].default, "  ");
  // "-" and "SDK default" are not values. Inventing one ("", 0) would tell
  // the user pi is configured with something it is not.
  assert.equal("default" in keys["defaultProvider"], false);
  assert.equal("default" in keys["retry.provider.timeoutMs"], false);

  // Groups are pi's own `###` headings, in document order; a `####`
  // sub-heading expands on the setting above it and opens no new group.
  assert.deepEqual(
    [...new Set(settings.map((setting) => setting.group))],
    ["Model & Thinking", "UI & Display", "Compaction", "Retry", "Message Delivery", "Markdown", "Resources"],
  );
  assert.equal(settings.every((setting) => setting.tab === "pi"), true);
});

test("a documented type Cody has no control for is left out, not guessed at", () => {
  const keys = byKey(parsePiSettingsDocs(DOCS_EXCERPT));
  // `thinkingBudgets` is a nested map and `packages` accepts object entries.
  // Rendering either through the list editor would show [object Object] and
  // destroy the entries on save, so the panel never offers them.
  assert.equal("thinkingBudgets" in keys, false);
  assert.equal("packages" in keys, false);
  // …and the ones it CAN render are all still there.
  assert.equal("skills" in keys, true);
});

test("a closed value list becomes a dropdown; an open one stays free text", () => {
  const keys = byKey(parsePiSettingsDocs(DOCS_EXCERPT));

  assert.equal(keys["defaultThinkingLevel"].type, "enum");
  assert.deepEqual(keys["defaultThinkingLevel"].values, ["off", "minimal", "low", "medium", "high", "xhigh"]);
  assert.equal(keys["steeringMode"].type, "enum");
  assert.deepEqual(keys["steeringMode"].values, ["all", "one-at-a-time"]);

  // The trap this guards: both of these list quoted values too, and a closed
  // dropdown over an open set makes valid values unreachable. pi supports a
  // dozen providers and any package can add a theme.
  assert.equal(keys["defaultProvider"].type, "string");
  assert.equal(keys["theme"].type, "string");

  assert.equal(enumValuesFromDescription('Sent as `"all"` or `"one-at-a-time"`').length, 2);
  assert.equal(enumValuesFromDescription('Provider (e.g., `"anthropic"`, `"openai"`)'), undefined);
  assert.equal(enumValuesFromDescription('Theme name (`"dark"`, `"light"`, or custom)'), undefined);
  // One value is a mention, not a menu.
  assert.equal(enumValuesFromDescription('Prefix (`"shopt -s expand_aliases"`)'), undefined);
});

test("settings that only dress pi's terminal are labelled, never hidden", () => {
  const keys = byKey(parsePiSettingsDocs(DOCS_EXCERPT));
  // Labelled rather than hidden: the same file drives the `pi` a user runs in
  // a Cody terminal, so the row belongs in the panel — with a chip saying it
  // does nothing here.
  assert.equal(keys["theme"].terminalOnly, true);
  assert.equal(keys["autocompleteMaxVisible"].terminalOnly, true);
  assert.equal(keys["steeringMode"].terminalOnly, true);
  assert.equal(keys["markdown.codeBlockIndent"].terminalOnly, true);
  // Anything that reaches the model or the account is left unmarked.
  assert.equal(keys["compaction.reserveTokens"].terminalOnly, undefined);
  assert.equal(keys["defaultProvider"].terminalOnly, undefined);
  // The rule list is the one hand-maintained thing in this pipeline, so it is
  // held to the same standard as the settings themselves: no duplicates, and
  // nothing marked in the schema that the list does not actually name.
  assert.equal(new Set(PI_TERMINAL_ONLY_KEYS).size, PI_TERMINAL_ONLY_KEYS.length);
  const marked = Object.values(keys).filter((setting) => setting.terminalOnly).map((setting) => setting.key);
  assert.deepEqual(marked.filter((key) => !PI_TERMINAL_ONLY_KEYS.includes(key)), []);
});

test("labels read as English without mangling pi's initialisms", () => {
  assert.equal(humanizeKey("compaction.reserveTokens"), "Reserve tokens");
  assert.equal(humanizeKey("quietStartup"), "Quiet startup");
  assert.equal(humanizeKey("npmCommand"), "NPM command");
  // "Base delay MS" reads as a unit nobody meant; ms is milliseconds.
  assert.equal(humanizeKey("retry.baseDelayMs"), "Base delay ms");
  // A lone capital is an axis, not a word.
  assert.equal(humanizeKey("editorPaddingX"), "Editor padding X");
});

test("the package that owns the pi binary is found by NAME", () => {
  const { root, binary } = stubPiPackage(DOCS_EXCERPT);
  assert.equal(findPiPackageRoot(binary), root);

  // omp is a FORK of this package and installs into a sibling directory of
  // the same tools prefix, so "the first package.json above the binary" is
  // not good enough — the name is what tells them apart.
  const notPi = mkdtempSync(join(tmpdir(), "omp-pkg-"));
  writeFileSync(join(notPi, "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-coding-agent", version: "18.0.11" }));
  mkdirSync(join(notPi, "dist"), { recursive: true });
  const ompBin = join(notPi, "dist", "cli.js");
  writeFileSync(ompBin, "");
  assert.equal(findPiPackageRoot(ompBin), null);
});

test("values come from pi's own global settings.json, defaults fill the rest", () => {
  const { binary } = stubPiPackage(DOCS_EXCERPT);
  const dir = agentDir(JSON.stringify({
    defaultProvider: "anthropic",
    compaction: { reserveTokens: 8192 },
    // A stored value the control cannot show is dropped rather than rendered
    // as an empty box that misreports what pi is running with.
    hideThinkingBlock: "yes please",
  }));

  const read = readPiSettings(binary, dir);
  assert.equal(read.path, piSettingsPath(dir));
  assert.equal(read.reason, undefined);
  assert.deepEqual(read.values, { defaultProvider: "anthropic", "compaction.reserveTokens": 8192 });

  // No file at all is the normal state of a fresh install, not an error.
  assert.deepEqual(readPiSettingsValues(agentDir(), read.schema.settings), {});
});

test("a write preserves everything Cody does not list, and resets prune", () => {
  const { binary } = stubPiPackage(DOCS_EXCERPT);
  const dir = agentDir(`${JSON.stringify({
    thinkingBudgets: { minimal: 1024, high: 32768 },
    packages: [{ source: "pi-skills", skills: ["brave-search"] }],
    compaction: { enabled: true, reserveTokens: 16384 },
  }, null, 4)}\n`);
  const file = piSettingsPath(dir);
  chmodSync(file, 0o640);

  const result = writePiSettings(binary, dir, {
    "compaction.reserveTokens": 8192,
    "skills": ["./my-skills"],
    "notASetting": true,
    "hideThinkingBlock": "not a boolean",
  });

  assert.deepEqual(result.written.sort(), ["compaction.reserveTokens", "skills"]);
  // A key that could not be written is NAMED, never silently dropped and
  // never counted as a save.
  assert.deepEqual(result.rejected.map((entry) => entry.key).sort(), ["hideThinkingBlock", "notASetting"]);
  assert.match(result.rejected.find((entry) => entry.key === "notASetting").reason, /does not document|not a setting/i);

  const after = JSON.parse(readFileSync(file, "utf8"));
  // The whole object is read, mutated and written back, so keys the panel
  // never lists survive a save. A writer that rebuilt the file from the
  // schema would delete every one of them.
  assert.deepEqual(after.thinkingBudgets, { minimal: 1024, high: 32768 });
  assert.deepEqual(after.packages, [{ source: "pi-skills", skills: ["brave-search"] }]);
  // Dotted keys persist NESTED, which is the shape pi's own loader reads.
  assert.deepEqual(after.compaction, { enabled: true, reserveTokens: 8192 });
  assert.deepEqual(after.skills, ["./my-skills"]);
  assert.equal(statSync(file).mode & 0o777, 0o640, "the file's existing mode survives the write");
  assert.equal(readFileSync(file, "utf8").endsWith("\n"), true);

  // Reset (a null patch entry) drops the override so pi's own default wins,
  // and takes the parent object with it when nothing is left in it.
  writePiSettings(binary, dir, { "compaction.reserveTokens": null, "compaction.enabled": null });
  const reset = JSON.parse(readFileSync(file, "utf8"));
  assert.equal("compaction" in reset, false, "an emptied parent is pruned, not left as {}");
  assert.deepEqual(reset.thinkingBudgets, { minimal: 1024, high: 32768 });
});

test("a settings.json Cody cannot parse is refused, never overwritten", () => {
  const { binary } = stubPiPackage(DOCS_EXCERPT);
  // A hand-edited file with a trailing comma. Reading it falls back to "no
  // overrides", which is harmless — but a WRITE is read → mutate → write the
  // whole object, so overwriting here would replace everything the user put
  // in the file with the one key Cody understood.
  const broken = '{ "defaultProvider": "anthropic", }';
  const dir = agentDir(broken);
  assert.throws(() => writePiSettings(binary, dir, { theme: "light" }), /could not parse/i);
  assert.equal(readFileSync(piSettingsPath(dir), "utf8"), broken, "the unparseable file must survive untouched");

  const listy = agentDir("[1, 2, 3]");
  assert.throws(() => writePiSettings(binary, listy, { theme: "light" }), /JSON object/);
  assert.equal(readFileSync(piSettingsPath(listy), "utf8"), "[1, 2, 3]");
});

test("no docs is an honest reason, never a throw or an invented schema", () => {
  // A pi whose package layout has no docs/settings.md — an older or repacked
  // build. The panel must say why rather than offering settings that write
  // nowhere.
  const { binary } = stubPiPackage(null);
  const dir = agentDir();
  const read = readPiSettings(binary, dir);
  assert.equal(read.schema, null);
  assert.match(read.reason, /settings\.md/);
  assert.deepEqual(read.values, {});
  // The path is still reported: it is where the user would go to edit by hand.
  assert.equal(read.path, piSettingsPath(dir));

  // Not installed at all is the other half, and answers the same way.
  clearPiSettingsSchemaCache();
  const missing = readPiSettings(null, dir);
  assert.equal(missing.schema, null);
  assert.match(missing.reason, /not installed/i);

  // And a write with no schema refuses loudly instead of writing a file pi
  // never validated.
  clearPiSettingsSchemaCache();
  assert.throws(() => writePiSettings(binary, dir, { theme: "light" }), /settings\.md/);
});

test("a docs file with no settings tables reports that, rather than an empty panel", () => {
  const { binary } = stubPiPackage("# Settings\n\nSee the website.\n");
  const { schema, reason } = getPiSettingsSchema(binary);
  assert.equal(schema, null);
  assert.match(reason, /no settings tables/i);
});

test("a documented string setting named like a credential is flagged secret", async () => {
  const { isPiSecretKey } = await jiti.import("./pi-settings.ts");
  const docs = `# Settings

### Providers

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| \`providerApiKey\` | string | - | API key for the default provider |
| \`auth.token\` | string | - | Bearer token |
| \`webhookSecret\` | string | - | Shared secret |
| \`proxyPassword\` | string | - | Proxy password |
| \`retry.maxTokens\` | number | \`5\` | Not a credential, a budget |
| \`tokenizer\` | string | \`"tiktoken"\` | Contains the word, is not one |
`;
  const keys = byKey(parsePiSettingsDocs(docs));
  for (const key of ["providerApiKey", "auth.token", "webhookSecret", "proxyPassword"]) {
    assert.equal(keys[key].secret, true, `${key} is a secret leaf`);
  }
  assert.equal(keys["retry.maxTokens"].secret, undefined);
  assert.equal(keys["tokenizer"].secret, undefined);
  assert.equal(isPiSecretKey("providerApiKey", "number"), false, "name AND type: a number is never a credential");

  // pi 0.73 documents no such key, so the shipped excerpt flags nothing —
  // the rule must not misfire on the real vocabulary.
  assert.equal(Object.values(byKey(parsePiSettingsDocs(DOCS_EXCERPT))).some((setting) => setting.secret), false);

  // The adapter writes and reads it like any string; the schema route is
  // what withholds the value from the browser.
  const { binary } = stubPiPackage(docs);
  const dir = agentDir();
  const result = writePiSettings(binary, dir, { providerApiKey: "sk-test-1" });
  assert.deepEqual(result.written, ["providerApiKey"]);
  assert.equal(readPiSettings(binary, dir).values.providerApiKey, "sk-test-1");
});
