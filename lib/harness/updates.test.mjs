import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });

test("isBeyondVerifiedMajor flags only a provable jump past the marker", async () => {
  const { isBeyondVerifiedMajor, majorVersionOf } = await jiti.import("./updates.ts");
  assert.equal(majorVersionOf("18.0.0"), 18);
  assert.equal(majorVersionOf("v19.2.1-rc.1"), 19);
  assert.equal(majorVersionOf("not-a-version"), null);
  assert.equal(majorVersionOf(null), null);
  assert.equal(isBeyondVerifiedMajor("19.0.0", 18), true);
  assert.equal(isBeyondVerifiedMajor("18.4.2", 18), false);
  assert.equal(isBeyondVerifiedMajor("17.4.2", 18), false);
  // Unknown version or unmarked adapter: never warn.
  assert.equal(isBeyondVerifiedMajor(null, 18), false);
  assert.equal(isBeyondVerifiedMajor("garbage", 18), false);
  assert.equal(isBeyondVerifiedMajor("99.0.0", undefined), false);
});

test("packageNameFromSpec strips the version tag, scoped or not", async () => {
  const { packageNameFromSpec } = await jiti.import("./updates.ts");
  assert.equal(packageNameFromSpec("@oh-my-pi/pi-coding-agent@latest"), "@oh-my-pi/pi-coding-agent");
  assert.equal(packageNameFromSpec("@openai/codex@latest"), "@openai/codex");
  assert.equal(packageNameFromSpec("some-package@1.2.3"), "some-package");
  assert.equal(packageNameFromSpec("bare-package"), "bare-package");
  assert.equal(packageNameFromSpec("@scope/untagged"), "@scope/untagged");
});

test("pypiNameFromSpec drops the extras marker and any pin", async () => {
  const { pypiNameFromSpec } = await jiti.import("./updates.ts");
  // The extras marker is install syntax, not part of the project name: PyPI
  // answers 404 for "hermes-agent[acp]", which the update check would read as
  // "no newer version" forever.
  assert.equal(pypiNameFromSpec("hermes-agent[acp]"), "hermes-agent");
  assert.equal(pypiNameFromSpec("hermes-agent[acp]==0.19.0"), "hermes-agent");
  assert.equal(pypiNameFromSpec("hermes-agent>=0.18"), "hermes-agent");
  assert.equal(pypiNameFromSpec("hermes-agent"), "hermes-agent");
});

/**
 * Every engine spec Cody ships, against the registry its ecosystem actually
 * publishes to. Verified live against registry.npmjs.org and pypi.org while
 * this was written — all five return a real version — and pinned here as the
 * URL each spec resolves to, because a lookup that 404s does not fail loudly:
 * it reports "no update available", forever.
 */
test("each engine's spec resolves to its own registry's URL and version field", async () => {
  const { fetchLatestPackageVersion } = await jiti.import("./updates.ts");
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return {
      ok: true,
      // npm answers the manifest directly, PyPI nests it under `info`. Both
      // shapes are returned every time, so a reader that looked at the wrong
      // one would still get a version — and the assertions below would not
      // catch it. Hence the distinct numbers.
      json: async () => ({ version: "9.9.9-npm", info: { version: "9.9.9-pypi" } }),
    };
  };
  try {
    const cases = [
      // Scoped npm names must be fully encoded; the registry accepts that form.
      ["@oh-my-pi/pi-coding-agent", "npm", "https://registry.npmjs.org/%40oh-my-pi%2Fpi-coding-agent/latest", "9.9.9-npm"],
      ["@mariozechner/pi-coding-agent", "npm", "https://registry.npmjs.org/%40mariozechner%2Fpi-coding-agent/latest", "9.9.9-npm"],
      ["@agentclientprotocol/claude-agent-acp", "npm", "https://registry.npmjs.org/%40agentclientprotocol%2Fclaude-agent-acp/latest", "9.9.9-npm"],
      ["@agentclientprotocol/codex-acp", "npm", "https://registry.npmjs.org/%40agentclientprotocol%2Fcodex-acp/latest", "9.9.9-npm"],
      // The two companion CLIs, which the check now asks about in their own right.
      ["@anthropic-ai/claude-code", "npm", "https://registry.npmjs.org/%40anthropic-ai%2Fclaude-code/latest", "9.9.9-npm"],
      ["@openai/codex", "npm", "https://registry.npmjs.org/%40openai%2Fcodex/latest", "9.9.9-npm"],
      // Hermes is a Python package: PyPI, extras stripped, version under `info`.
      ["hermes-agent[acp]", "uv", "https://pypi.org/pypi/hermes-agent/json", "9.9.9-pypi"],
    ];
    for (const [spec, via, url, expected] of cases) {
      calls.length = 0;
      // force=true: the module caches by `${via}:${name}`, and this suite must
      // read the registry it names rather than a neighbour's cached answer.
      assert.equal(await fetchLatestPackageVersion(spec, true, via), expected, spec);
      assert.deepEqual(calls, [url], spec);
    }
  } finally {
    globalThis.fetch = original;
  }
});

test("an unreachable registry reports unknown, never 'up to date'", async () => {
  const { fetchLatestPackageVersion } = await jiti.import("./updates.ts");
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("offline"); };
  try {
    assert.equal(await fetchLatestPackageVersion("whatever-offline", true, "npm"), null);
  } finally {
    globalThis.fetch = original;
  }
  // A 404 — the shape a wrong-registry lookup takes — must read the same way.
  globalThis.fetch = async () => ({ ok: false, json: async () => ({}) });
  try {
    assert.equal(await fetchLatestPackageVersion("whatever-missing", true, "npm"), null);
  } finally {
    globalThis.fetch = original;
  }
});

/** A stub adapter shaped like an ACP engine installed as two packages. */
function splitAdapter(overrides = {}) {
  return {
    id: "claude",
    displayName: "Claude Code",
    installSpec: "@agentclientprotocol/claude-agent-acp@latest",
    installAlso: ["@anthropic-ai/claude-code@latest"],
    verifiedMajor: 0,
    versionArgs: undefined,
    resolveBinary: () => "/tools/bin/claude-agent-acp",
    getVersion: async () => "0.70.0",
    engineCli: {
      adapterLabel: "Claude Code ACP adapter",
      label: "Claude Code CLI",
      packageName: "@anthropic-ai/claude-code",
      getVersion: async () => "2.1.238",
    },
    ...overrides,
  };
}

/** Registry answers keyed by package name, for engineUpdateStatus. */
function registry(versions) {
  return async (url) => {
    const name = decodeURIComponent(String(url).replace("https://registry.npmjs.org/", "").replace("/latest", ""));
    const version = versions[name];
    return version === undefined
      ? { ok: false, json: async () => ({}) }
      : { ok: true, json: async () => ({ version }) };
  };
}

test("a stale companion CLI is an engine update, even with the adapter current", async (t) => {
  const { engineUpdateStatus } = await jiti.import("./updates.ts");
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = registry({
    "@agentclientprotocol/claude-agent-acp": "0.70.0",
    "@anthropic-ai/claude-code": "2.1.241",
  });

  const status = await engineUpdateStatus(splitAdapter(), {}, true);
  // The whole point: the adapter is current, so an adapter-only comparison
  // said "up to date" while the CLI sat three releases behind.
  assert.equal(status.updateAvailable, true);
  // The number under the engine's name is the ENGINE's, not the adapter's.
  assert.equal(status.engineVersion, "2.1.238");
  assert.equal(status.installedVersion, "0.70.0", "installedVersion stays the package a revert pins");
  assert.deepEqual(status.components.map((part) => [part.label, part.installedVersion, part.latestVersion, part.updateAvailable]), [
    ["Claude Code ACP adapter", "0.70.0", "0.70.0", false],
    ["Claude Code CLI", "2.1.238", "2.1.241", true],
  ]);
  assert.equal(status.adapterLabel, "Claude Code ACP adapter");
});

test("both halves current is the only 'up to date'; an unknown half is unknown", async (t) => {
  const { engineUpdateStatus } = await jiti.import("./updates.ts");
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });

  globalThis.fetch = registry({
    "@agentclientprotocol/claude-agent-acp": "0.70.0",
    "@anthropic-ai/claude-code": "2.1.238",
  });
  assert.equal((await engineUpdateStatus(splitAdapter(), {}, true)).updateAvailable, false);

  // The CLI's registry entry is unreachable. Claiming "up to date" on half an
  // answer is the failure this module exists to avoid, so it reports unknown.
  globalThis.fetch = registry({ "@agentclientprotocol/claude-agent-acp": "0.70.0" });
  assert.equal((await engineUpdateStatus(splitAdapter(), {}, true)).updateAvailable, null);

  // …but a KNOWN newer half still wins: there really is something to install.
  globalThis.fetch = registry({ "@agentclientprotocol/claude-agent-acp": "1.0.0" });
  const ahead = await engineUpdateStatus(splitAdapter(), {}, true);
  assert.equal(ahead.updateAvailable, true);
  // The major that crossed belongs to the adapter, and so does the notice.
  assert.equal(ahead.latestBeyondVerified, true);
  assert.equal(ahead.adapterLabel, "Claude Code ACP adapter");
});

test("a single-package engine reports one version and no breakdown", async (t) => {
  const { engineUpdateStatus } = await jiti.import("./updates.ts");
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = registry({ "@oh-my-pi/pi-coding-agent": "18.1.0" });

  const status = await engineUpdateStatus({
    id: "omp",
    displayName: "OMP runtime",
    installSpec: "@oh-my-pi/pi-coding-agent@latest",
    verifiedMajor: 18,
    resolveBinary: () => "/tools/bin/omp",
    getVersion: async () => "18.0.1",
  }, {}, true);

  assert.equal(status.updateAvailable, true);
  assert.equal(status.engineVersion, "18.0.1", "with one package the engine version IS the package version");
  assert.deepEqual(status.components, []);
  assert.equal(status.adapterLabel, null, "no adapter to name, so the notice keeps using the engine's own name");
  assert.equal(status.previousEngineVersion, null);
});

test("the revert offer survives an update that moved only the CLI", async (t) => {
  const { engineUpdateStatus } = await jiti.import("./updates.ts");
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = registry({
    "@agentclientprotocol/claude-agent-acp": "0.70.0",
    "@anthropic-ai/claude-code": "2.1.241",
  });

  // The common case: the CLI ships most days, the adapter goes months. The
  // update that just ran left the adapter version untouched, so comparing
  // that half alone would hide the revert for exactly the update that made it.
  const history = { claude: { previousVersion: "0.70.0", previousEngineVersion: "2.1.230", updatedAt: "" } };
  const moved = await engineUpdateStatus(splitAdapter(), history, true);
  assert.equal(moved.previousVersion, "0.70.0");
  assert.equal(moved.previousEngineVersion, "2.1.230");

  // Nothing actually changed: both halves match the record, so there is
  // nothing to revert TO and the button stays away.
  const unchanged = await engineUpdateStatus(
    splitAdapter(),
    { claude: { previousVersion: "0.70.0", previousEngineVersion: "2.1.238", updatedAt: "" } },
    true,
  );
  assert.equal(unchanged.previousVersion, null);
  assert.equal(unchanged.previousEngineVersion, null);
});

test("an unreadable CLI half leaves the engine version unknown, not wrong", async (t) => {
  const { engineUpdateStatus } = await jiti.import("./updates.ts");
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = registry({
    "@agentclientprotocol/claude-agent-acp": "0.70.0",
    "@anthropic-ai/claude-code": "2.1.241",
  });

  // The state a half-failed install leaves behind: the adapter answers, the
  // CLI it drives does not. The adapter's number must NOT stand in for it.
  const adapter = splitAdapter();
  const status = await engineUpdateStatus(
    { ...adapter, engineCli: { ...adapter.engineCli, getVersion: async () => null } },
    {},
    true,
  );
  assert.equal(status.engineVersion, null);
  assert.equal(status.updateAvailable, null, "half the comparison is missing, so the answer is unknown");
  assert.equal(status.components[1].installedVersion, null);
});
