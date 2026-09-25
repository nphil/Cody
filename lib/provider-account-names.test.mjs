import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const names = await jiti.import("./provider-account-names.ts");
const fixtureDir = await mkdtemp(path.join(os.tmpdir(), "cody-provider-account-names-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = fixtureDir;

test.after(async () => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  await rm(fixtureDir, { recursive: true, force: true });
});

test("names reuse an OAuth identity even when OMP creates a new row id", async () => {
  names.setProviderAccountName("anthropic", "1", "person@example.com", "Work account");
  const stored = names.readProviderAccountNames();
  assert.equal(names.resolveProviderAccountName(stored, "anthropic", "99", "person@example.com"), "Work account");
  const text = await readFile(names.getProviderAccountNamesPath(), "utf8");
  assert.doesNotMatch(text, /accessToken|refreshToken|apiKey|secret/i);
});

test("credentials without an identity stay tied to their OMP row id", () => {
  names.setProviderAccountName("anthropic", "2", null, "Unidentified account");
  const stored = names.readProviderAccountNames();
  assert.equal(names.resolveProviderAccountName(stored, "anthropic", "2", null), "Unidentified account");
  assert.equal(names.resolveProviderAccountName(stored, "anthropic", "3", null), null);
});

test("renaming replaces the old row alias and clearing removes it", () => {
  names.setProviderAccountName("anthropic", "1", "person@example.com", "Personal");
  names.setProviderAccountName("anthropic", "1", "person@example.com", "Personal account");
  assert.equal(Object.keys(names.readProviderAccountNames()).length, 2);
  names.setProviderAccountName("anthropic", "1", "person@example.com", "");
  const stored = names.readProviderAccountNames();
  assert.equal(names.resolveProviderAccountName(stored, "anthropic", "1", "person@example.com"), null);
  assert.equal(Object.keys(stored).length, 1);
});

test("names normalize whitespace and reject oversized labels", () => {
  names.setProviderAccountName("anthropic", "4", null, "  Team   account ");
  const stored = names.readProviderAccountNames();
  assert.equal(names.resolveProviderAccountName(stored, "anthropic", "4", null), "Team account");
  assert.throws(() => names.setProviderAccountName("anthropic", "4", null, "x".repeat(81)), /80 characters/);
});

test("provider cleanup removes only that provider's labels", () => {
  names.setProviderAccountName("openai-codex", "7", null, "Codex");
  names.forgetProviderAccountName("anthropic", "2");
  names.forgetProviderAccountNames("openai-codex");
  const stored = names.readProviderAccountNames();
  assert.equal(names.resolveProviderAccountName(stored, "anthropic", "4", null), "Team account");
  assert.equal(names.resolveProviderAccountName(stored, "openai-codex", "7", null), null);
});
