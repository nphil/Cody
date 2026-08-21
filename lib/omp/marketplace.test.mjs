import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  isValidNameSegment,
  parsePluginId,
  readMarketplaces,
  readMarketplaceCatalog,
  expandHome,
} = await jiti.import("./marketplace.ts");

function withFixtureDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "cody-marketplace-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function withHome(home, run) {
  const previous = process.env.HOME;
  process.env.HOME = home;
  try {
    run();
  } finally {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
  }
}

test("isValidNameSegment mirrors omp's name-segment rule", () => {
  assert.equal(isValidNameSegment("anthropics"), true);
  assert.equal(isValidNameSegment("my-plugin.v2"), true);
  assert.equal(isValidNameSegment(""), false);
  assert.equal(isValidNameSegment("-leading-hyphen"), false);
  assert.equal(isValidNameSegment("Uppercase"), false);
  assert.equal(isValidNameSegment("has space"), false);
  assert.equal(isValidNameSegment("a".repeat(65)), false);
});

test("parsePluginId splits name@marketplace and validates both segments", () => {
  assert.deepEqual(parsePluginId("exa@anthropics"), { name: "exa", marketplace: "anthropics" });
  assert.equal(parsePluginId("no-at-sign"), null);
  assert.equal(parsePluginId("@leading-at"), null);
  assert.equal(parsePluginId("trailing-at@"), null);
  assert.equal(parsePluginId("Bad Name@marketplace"), null);
});

test("expandHome expands a leading ~ against $HOME, leaves other paths alone", () => {
  withHome("/home/fixture-user", () => {
    assert.equal(expandHome("~"), "/home/fixture-user");
    assert.equal(expandHome("~/marketplaces/foo/marketplace.json"), "/home/fixture-user/marketplaces/foo/marketplace.json");
    assert.equal(expandHome("/absolute/path.json"), "/absolute/path.json");
    assert.equal(expandHome("relative/path.json"), "relative/path.json");
  });
});

test("readMarketplaces: missing registry file returns []", () => {
  withFixtureDir((dir) => {
    assert.deepEqual(readMarketplaces(join(dir, "marketplaces.json")), []);
  });
});

test("readMarketplaces: parses a well-formed registry", () => {
  withFixtureDir((dir) => {
    const registryPath = join(dir, "marketplaces.json");
    writeFileSync(registryPath, JSON.stringify({
      version: 1,
      marketplaces: [
        {
          name: "anthropics",
          sourceType: "github",
          sourceUri: "anthropics/claude-plugins-official",
          catalogPath: join(dir, "cache", "anthropics", "marketplace.json"),
          addedAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-02T00:00:00.000Z",
        },
      ],
    }), "utf8");

    const marketplaces = readMarketplaces(registryPath);
    assert.equal(marketplaces.length, 1);
    assert.equal(marketplaces[0].name, "anthropics");
    assert.equal(marketplaces[0].sourceType, "github");
    assert.equal(marketplaces[0].sourceUri, "anthropics/claude-plugins-official");
    assert.equal(marketplaces[0].updatedAt, "2026-01-02T00:00:00.000Z");
  });
});

test("readMarketplaces: skips malformed entries but keeps valid ones", () => {
  withFixtureDir((dir) => {
    const registryPath = join(dir, "marketplaces.json");
    writeFileSync(registryPath, JSON.stringify({
      version: 1,
      marketplaces: [
        { name: "no-catalog-path", sourceType: "git", sourceUri: "https://example.com/repo.git" },
        { name: "Bad Name!", sourceType: "git", sourceUri: "x", catalogPath: "/x", addedAt: "", updatedAt: "" },
        "not-an-object",
        { name: "good", sourceType: "url", sourceUri: "https://example.com/marketplace.json", catalogPath: "/tmp/good.json", addedAt: "", updatedAt: "" },
      ],
    }), "utf8");

    const marketplaces = readMarketplaces(registryPath);
    assert.deepEqual(marketplaces.map((m) => m.name), ["good"]);
  });
});

test("readMarketplaces: falls back to sourceType 'git' for an unrecognized value", () => {
  withFixtureDir((dir) => {
    const registryPath = join(dir, "marketplaces.json");
    writeFileSync(registryPath, JSON.stringify({
      version: 1,
      marketplaces: [
        { name: "weird", sourceType: "ftp", sourceUri: "x", catalogPath: "/tmp/x.json", addedAt: "", updatedAt: "" },
      ],
    }), "utf8");
    assert.equal(readMarketplaces(registryPath)[0].sourceType, "git");
  });
});

test("readMarketplaces: throws on malformed JSON", () => {
  withFixtureDir((dir) => {
    const registryPath = join(dir, "marketplaces.json");
    writeFileSync(registryPath, "{ not json", "utf8");
    assert.throws(() => readMarketplaces(registryPath), /not valid JSON/);
  });
});

test("readMarketplaces: throws when the top-level shape is wrong", () => {
  withFixtureDir((dir) => {
    const registryPath = join(dir, "marketplaces.json");
    writeFileSync(registryPath, JSON.stringify({ marketplaces: "not-an-array" }), "utf8");
    assert.throws(() => readMarketplaces(registryPath), /unexpected shape/);

    const registryPath2 = join(dir, "marketplaces2.json");
    writeFileSync(registryPath2, JSON.stringify([1, 2, 3]), "utf8");
    assert.throws(() => readMarketplaces(registryPath2), /unexpected shape/);
  });
});

test("readMarketplaceCatalog: missing catalog file returns null", () => {
  withFixtureDir((dir) => {
    const result = readMarketplaceCatalog({ name: "anthropics", catalogPath: join(dir, "missing.json") });
    assert.equal(result, null);
  });
});

test("readMarketplaceCatalog: parses plugins and tags each with the marketplace name", () => {
  withFixtureDir((dir) => {
    const catalogPath = join(dir, "marketplace.json");
    writeFileSync(catalogPath, JSON.stringify({
      name: "anthropics",
      owner: { name: "Anthropic" },
      metadata: { description: "Official plugins" },
      plugins: [
        {
          name: "exa",
          source: { source: "npm", package: "@oh-my-pi/exa" },
          description: "Exa web search",
          version: "1.2.0",
          author: { name: "Anthropic", email: "plugins@anthropic.com" },
          homepage: "https://example.com/exa",
          repository: "https://github.com/anthropics/exa",
          license: "MIT",
          keywords: ["search", "web"],
          category: "search",
          tags: ["featured"],
        },
        {
          name: "no-op",
          source: "./plugins/no-op",
        },
      ],
    }), "utf8");

    const plugins = readMarketplaceCatalog({ name: "anthropics", catalogPath });
    assert.equal(plugins.length, 2);
    const exa = plugins.find((p) => p.name === "exa");
    assert.ok(exa);
    assert.equal(exa.marketplace, "anthropics");
    assert.equal(exa.description, "Exa web search");
    assert.equal(exa.version, "1.2.0");
    assert.deepEqual(exa.author, { name: "Anthropic", email: "plugins@anthropic.com" });
    assert.equal(exa.homepage, "https://example.com/exa");
    assert.deepEqual(exa.keywords, ["search", "web"]);
    assert.equal(exa.category, "search");

    const noOp = plugins.find((p) => p.name === "no-op");
    assert.ok(noOp);
    assert.equal(noOp.description, undefined);
    assert.equal(noOp.author, undefined);
  });
});

test("readMarketplaceCatalog: expands ~ in catalogPath before reading", () => {
  withFixtureDir((dir) => {
    withHome(dir, () => {
      mkdirSync(join(dir, "cache"), { recursive: true });
      writeFileSync(join(dir, "cache", "marketplace.json"), JSON.stringify({
        name: "anthropics",
        owner: { name: "Anthropic" },
        plugins: [{ name: "exa", source: "./exa" }],
      }), "utf8");

      const plugins = readMarketplaceCatalog({ name: "anthropics", catalogPath: "~/cache/marketplace.json" });
      assert.equal(plugins.length, 1);
      assert.equal(plugins[0].name, "exa");
    });
  });
});

test("readMarketplaceCatalog: skips malformed plugin entries but keeps valid ones", () => {
  withFixtureDir((dir) => {
    const catalogPath = join(dir, "marketplace.json");
    writeFileSync(catalogPath, JSON.stringify({
      name: "anthropics",
      owner: { name: "Anthropic" },
      plugins: [
        { name: "Bad Name!", source: "./bad" },
        { source: "./no-name" },
        "not-an-object",
        { name: "good", source: "./good" },
      ],
    }), "utf8");

    const plugins = readMarketplaceCatalog({ name: "anthropics", catalogPath });
    assert.deepEqual(plugins.map((p) => p.name), ["good"]);
  });
});

test("readMarketplaceCatalog: throws when the top-level shape is wrong", () => {
  withFixtureDir((dir) => {
    const catalogPath = join(dir, "marketplace.json");
    writeFileSync(catalogPath, JSON.stringify({ name: "anthropics", owner: { name: "Anthropic" } }), "utf8");
    assert.throws(() => readMarketplaceCatalog({ name: "anthropics", catalogPath }), /unexpected shape/);
  });
});
