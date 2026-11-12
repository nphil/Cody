import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * A stand-in omp installation, just big enough for the code that only needs to FIND omp:
 * `findOmpPackageRoot()` walks up from the binary to a `pi-coding-agent` package.json, and
 * `readBundledCatalog()` / `readClaudePlanModels()` read the `@oh-my-pi/pi-catalog` package
 * that sits in that package's dependencies. Point `CODY_OMP_BIN` at the returned `bin` and both
 * resolve here, so the tests that merely need a model list do not depend on whichever omp the
 * machine has.
 *
 * The catalog carries three Claude models (one with no display name, which Cody must fall
 * back to the id for) and a Codex model that must never reach the credits' provider block.
 *
 * Two layouts, because Cody supports engines on either side of the catalog's move:
 *  - `compact` (the default, omp 18.14 and later): `src/models.json` is the table-encoded file
 *    and `src/model-catalog-format.ts` the decoder the package ships next to it. THIS decoder
 *    is a stand-in over a trivial encoding (a real one needs omp's own source): what it pins
 *    is Cody's contract with the package, that is "a catalog whose `version`, `nodes` and
 *    `providers` are tables is decoded by the package's openModelCatalog/getCatalogProviders/
 *    getCatalogProvider". The real format is exercised against the installed omp by
 *    claude-credits-omp.test.mjs and the "really installed omp" test in claude-credits.test.mjs.
 *  - `plain` (omp up to 18.13): `src/models.json` IS `provider -> modelId -> model`, exported
 *    as `./models.json`.
 */
export const FAKE_PLAN_MODELS = [
  { id: "claude-opus-5-5", name: "Claude Opus 5.5" },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
  { id: "claude-haiku-5-5", name: null },
];

/** The reasoning ladder omp's catalog gives a current Claude: `prefixBinding` is a catalog-only
 *  field a models.yml model does not accept, so Cody must not copy it into a twin. */
export const FAKE_ADAPTIVE_THINKING = {
  mode: "anthropic-adaptive",
  efforts: ["low", "medium", "high", "xhigh", "max"],
  supportsDisplay: true,
  prefixBinding: true,
};

const FAKE_DECODER = `// Stand-in for @oh-my-pi/pi-catalog's model-catalog-format.ts (see fake-omp-package.mjs).
export function openModelCatalog(value) {
  return { data: value };
}
export function getCatalogProviders(catalog) {
  return catalog.data.providers.map((row) => row[0]);
}
export function getCatalogProvider(catalog, provider) {
  const row = catalog.data.providers.find((candidate) => candidate[0] === provider);
  return row ? Object.fromEntries(row[2].map(([id, json]) => [id, JSON.parse(json)])) : undefined;
}
`;

function modelRow(model) {
  const row = { id: model.id };
  if (model.name !== null && model.name !== undefined) row.name = model.name;
  if (model.reasoning !== undefined) row.reasoning = model.reasoning;
  if (model.thinking !== undefined) row.thinking = model.thinking;
  return row;
}

function catalogText(layout, anthropic) {
  const providers = {
    anthropic: Object.fromEntries(anthropic.map((model) => [model.id, modelRow(model)])),
    "openai-codex": { "gpt-6-astra": { id: "gpt-6-astra", name: "GPT-6 Astra" } },
  };
  if (layout === "plain") return JSON.stringify(providers);
  return JSON.stringify({
    version: 1,
    keys: [],
    booleanShapes: [],
    nodes: [],
    compat: [],
    providers: Object.entries(providers).map(([id, models]) => [id, null, Object.entries(models).map(([modelId, model]) => [modelId, JSON.stringify(model)])]),
  });
}

/** `rewrite(rows)` replaces the catalog's Claude models in the same layout. */
export function createFakeOmpPackage(parent, { anthropic = FAKE_PLAN_MODELS, layout = "compact" } = {}) {
  const root = path.join(parent, "omp-fake");
  const catalog = path.join(root, "node_modules", "@oh-my-pi", "pi-catalog");
  mkdirSync(path.join(root, "bin"), { recursive: true });
  mkdirSync(path.join(catalog, "src"), { recursive: true });
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-coding-agent", version: "0.0.0-test" }));
  const bin = path.join(root, "bin", "omp");
  writeFileSync(bin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const exports = { ".": { import: "./src/index.ts" } };
  if (layout === "plain") exports["./models.json"] = { import: "./src/models.json" };
  writeFileSync(path.join(catalog, "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-catalog", main: "./src/index.ts", exports }));
  writeFileSync(path.join(catalog, "src", "index.ts"), "export {};\n");
  if (layout === "compact") writeFileSync(path.join(catalog, "src", "model-catalog-format.ts"), FAKE_DECODER);
  const models = path.join(catalog, "src", "models.json");
  writeFileSync(models, catalogText(layout, anthropic));
  return { root, bin, models, layout, rewrite: (rows) => writeFileSync(models, catalogText(layout, rows)) };
}
