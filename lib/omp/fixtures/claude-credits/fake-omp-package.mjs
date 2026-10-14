import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * A stand-in omp installation, just big enough for the code that only needs to FIND omp:
 * `findOmpPackageRoot()` walks up from the binary to a `pi-coding-agent` package.json, and
 * `readClaudePlanModels()` reads `@oh-my-pi/pi-catalog/models.json` from that package's
 * dependencies. Point `CODY_OMP_BIN` at the returned `bin` and both resolve here, so the
 * tests that merely need a model list do not depend on whichever omp the machine has.
 *
 * The catalog carries three Claude models (one with no display name, which Cody must fall
 * back to the id for) and a Codex model that must never reach the credits' provider block.
 */
export const FAKE_PLAN_MODELS = [
  { id: "claude-opus-5-5", name: "Claude Opus 5.5" },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
  { id: "claude-haiku-5-5", name: null },
];

export function createFakeOmpPackage(parent, { anthropic = FAKE_PLAN_MODELS } = {}) {
  const root = path.join(parent, "omp-fake");
  const catalog = path.join(root, "node_modules", "@oh-my-pi", "pi-catalog");
  mkdirSync(path.join(root, "bin"), { recursive: true });
  mkdirSync(catalog, { recursive: true });
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-coding-agent", version: "0.0.0-test" }));
  const bin = path.join(root, "bin", "omp");
  writeFileSync(bin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFileSync(path.join(catalog, "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-catalog", exports: { "./models.json": "./models.json" } }));
  const models = path.join(catalog, "models.json");
  writeFileSync(models, JSON.stringify({
    anthropic: Object.fromEntries(anthropic.map((model) => [model.id, model.name === null ? { id: model.id } : { id: model.id, name: model.name }])),
    "openai-codex": { "gpt-6-astra": { id: "gpt-6-astra", name: "GPT-6 Astra" } },
  }));
  return { root, bin, models };
}
