import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * The "seen" ledger behind the "new models" notice. Curation hides models
 * by exact id, so a model released after the user curated is invisible and
 * nothing says the catalog grew; this ledger records what the user was SHOWN
 * so the diff against the catalog can say what is genuinely new.
 */
const agentDir = mkdtempSync(join(tmpdir(), "cody-catalog-seen-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const ledger = await jiti.import("./model-catalog-seen.ts");

const ledgerPath = join(agentDir, "cody-model-catalog-seen.json");

test("an engine with no ledger reads as never seeded, and the file lives in the instance data dir", () => {
  assert.equal(existsSync(ledgerPath), false);
  assert.deepEqual(ledger.readSeenLedger("omp"), { seenKeys: [], seenAt: null });
  assert.equal(ledger.getSeenLedgerPath(), ledgerPath, "instance data dir via getAgentDir(), never an engine's own dir");
});

test("marking the catalog seen round-trips through the on-disk shape", () => {
  const before = Date.now();
  const written = ledger.markCatalogSeen("omp", ["acme/alpha", "acme/beta"]);
  assert.deepEqual(written.seenKeys, ["acme/alpha", "acme/beta"]);
  assert.ok(Date.parse(written.seenAt) >= before - 1_000, "seenAt is an ISO timestamp of the write");

  assert.deepEqual(ledger.readSeenLedger("omp"), written);

  const file = JSON.parse(readFileSync(ledgerPath, "utf8"));
  assert.equal(file.version, 1);
  assert.deepEqual(file.engines.omp, written, "shape: {version, engines: {<id>: {seenKeys, seenAt}}}");
  assert.equal(existsSync(`${ledgerPath}.tmp`), false, "the temp file of the atomic write is renamed away");
});

test("a later mark REPLACES the engine's list — it records a display, not a union", () => {
  ledger.markCatalogSeen("omp", ["acme/alpha", "acme/beta"]);
  const replaced = ledger.markCatalogSeen("omp", ["acme/beta", "zeta/gamma"]);
  assert.deepEqual(replaced.seenKeys, ["acme/beta", "zeta/gamma"]);
  assert.deepEqual(ledger.readSeenLedger("omp").seenKeys, ["acme/beta", "zeta/gamma"]);
});

test("keys are deduplicated and sorted on write, and only non-empty strings survive", () => {
  const written = ledger.markCatalogSeen("omp", ["b/2", "a/1", "b/2", " a/1 ", "", "c/3"]);
  assert.deepEqual(written.seenKeys, ["a/1", "b/2", "c/3"]);
  const file = JSON.parse(readFileSync(ledgerPath, "utf8"));
  assert.deepEqual(file.engines.omp.seenKeys, ["a/1", "b/2", "c/3"]);
});

test("engines keep separate ledgers, and writing one leaves the other intact", () => {
  ledger.markCatalogSeen("omp", ["acme/alpha"]);
  ledger.markCatalogSeen("pi", ["acme/beta"]);
  assert.deepEqual(ledger.readSeenLedger("omp").seenKeys, ["acme/alpha"]);
  assert.deepEqual(ledger.readSeenLedger("pi").seenKeys, ["acme/beta"]);
  assert.deepEqual(ledger.readSeenLedger("hermes"), { seenKeys: [], seenAt: null });

  ledger.markCatalogSeen("pi", []);
  assert.deepEqual(ledger.readSeenLedger("omp").seenKeys, ["acme/alpha"], "another engine's write must not disturb this one");
  const pi = ledger.readSeenLedger("pi");
  assert.deepEqual(pi.seenKeys, []);
  assert.equal(typeof pi.seenAt, "string", "an empty display is still a display: seeded, with nothing seen");
});

test("a corrupt ledger reads as empty and the next write repairs it", () => {
  writeFileSync(ledgerPath, "{ not json", "utf8");
  assert.deepEqual(ledger.readSeenLedger("omp"), { seenKeys: [], seenAt: null });

  writeFileSync(ledgerPath, JSON.stringify({ version: 1, engines: { omp: { seenKeys: "nope", seenAt: 5 }, pi: { seenKeys: ["x/1"], seenAt: "2026-01-01T00:00:00.000Z" } } }), "utf8");
  assert.deepEqual(ledger.readSeenLedger("omp"), { seenKeys: [], seenAt: null }, "a malformed engine entry is dropped, not thrown");
  assert.deepEqual(ledger.readSeenLedger("pi").seenKeys, ["x/1"], "a well-formed sibling entry survives");

  writeFileSync(ledgerPath, "{ not json", "utf8");
  const written = ledger.markCatalogSeen("omp", ["a/1"]);
  assert.deepEqual(JSON.parse(readFileSync(ledgerPath, "utf8")), { version: 1, engines: { omp: written } });
});

test("diffNewModels: nothing is new on first run, and only unseen keys are new afterwards", () => {
  const catalog = ["acme/alpha", "acme/beta", "zeta/gamma"];

  // Never seeded: the client seeds the ledger when it first displays the
  // catalog; announcing the whole registry as "new" before that would be noise.
  assert.deepEqual(ledger.diffNewModels(catalog, { seenKeys: [], seenAt: null }), { newKeys: [], firstRun: true });

  const seeded = { seenKeys: ["acme/alpha"], seenAt: "2026-01-01T00:00:00.000Z" };
  assert.deepEqual(ledger.diffNewModels(catalog, seeded), { newKeys: ["acme/beta", "zeta/gamma"], firstRun: false });

  // An empty seeded ledger is a real display (of an empty catalog): everything is new.
  assert.deepEqual(ledger.diffNewModels(catalog, { seenKeys: [], seenAt: seeded.seenAt }), { newKeys: catalog, firstRun: false });

  // Everything seen: nothing new. A seen key that left the catalog is not "new" either.
  assert.deepEqual(ledger.diffNewModels(["acme/beta"], { seenKeys: [...catalog, "gone/model"], seenAt: seeded.seenAt }), { newKeys: [], firstRun: false });

  // Catalog order is preserved and a duplicate catalog key is reported once.
  assert.deepEqual(ledger.diffNewModels(["b/2", "a/1", "b/2"], { seenKeys: [], seenAt: seeded.seenAt }).newKeys, ["b/2", "a/1"]);
});

test("seeding from the CURATED (effective) catalog on first run reports every curated-out model as new forever", () => {
  // The exact defect: on omp, `/api/models/new` always diffs against the
  // UNRESTRICTED catalog (app/api/models/new/route.ts), never the curated
  // one. A client that seeds the first-run ledger from the effective list
  // instead of the full one is seeding the WRONG set — every model omp's own
  // `enabledModels` curates away then reads as "new since today" and stays
  // that way, since a later diff never re-seeds.
  const fullCatalog = ["anthropic/opus", "anthropic/sonnet", "openrouter/a", "openrouter/b"];
  const effectiveCatalog = ["anthropic/opus", "openrouter/a"]; // curated down to 2 of 4

  const seeded = ledger.markCatalogSeen("omp", effectiveCatalog);
  const diff = ledger.diffNewModels(fullCatalog, seeded);
  assert.deepEqual(diff.newKeys.sort(), ["anthropic/sonnet", "openrouter/b"], "curated-out models are wrongly reported as new");
});

test("seeding from the FULL (unrestricted) catalog on first run reports nothing as new", () => {
  // The fix: `useModelCatalog`'s seeding effect waits for the unrestricted
  // read (`fullList`) before POSTing on omp, so the seed and the diff always
  // agree on which catalog they mean.
  const fullCatalog = ["anthropic/opus", "anthropic/sonnet", "openrouter/a", "openrouter/b"];

  const seeded = ledger.markCatalogSeen("omp", fullCatalog);
  const diff = ledger.diffNewModels(fullCatalog, seeded);
  assert.deepEqual(diff.newKeys, [], "nothing is new retroactively when the seed and the diff use the same catalog");

  // A model curated away is still SEEN, so hiding it does not make it "new".
  const effectiveCatalog = ["anthropic/opus", "openrouter/a"];
  assert.deepEqual(ledger.diffNewModels(effectiveCatalog, seeded).newKeys, []);
});
