import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { beforeEach } from "node:test";
import { createJiti } from "jiti";

// The store writes `<agent dir>/cody-on-demand-mcp.json` and the user mcp.json.
// Point the agent dir at a temp dir BEFORE importing, never at the live one.
const agentDir = mkdtempSync(join(tmpdir(), "cody-ondemand-store-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.OMP_PROFILE = "";
process.env.PI_PROFILE = "";
process.on("exit", () => rmSync(agentDir, { recursive: true, force: true }));

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const store = await jiti.import("./on-demand-mcp.ts");
const { MCP_SECRET_SENTINEL, maskMcpSecrets } = await jiti.import("../mcp-secrets.ts");
const { deleteOnDemandServer, getOnDemandRegistryPath, readOnDemandServers, setServerOnDemand, writeOnDemandServer } = store;

const registryPath = join(agentDir, "cody-on-demand-mcp.json");
const mcpPath = join(agentDir, "mcp.json");
const readRegistryFile = () => JSON.parse(readFileSync(registryPath, "utf8"));
const readMcpFile = () => JSON.parse(readFileSync(mcpPath, "utf8"));
const writeMcpFile = (contents) => writeFileSync(mcpPath, `${JSON.stringify(contents, null, 2)}\n`);
const rea = { type: "stdio", command: "rea", args: ["serve"], env: { REA_KEY: "s3cret" } };

beforeEach(() => {
  for (const name of readdirSync(agentDir)) rmSync(join(agentDir, name), { recursive: true, force: true });
});

test("the registry lives beside mcp.json in the agent dir and an empty store reads as empty", () => {
  assert.equal(getOnDemandRegistryPath(), registryPath);
  assert.deepEqual(readOnDemandServers(), { path: registryPath, servers: [], problems: [] });
  writeFileSync(registryPath, "   \n");
  assert.deepEqual(readOnDemandServers().servers, []);
  assert.deepEqual(readOnDemandServers().problems, []);
});

test("write creates the file privately, sorted, with the purpose normalized; read returns the credentials as stored", () => {
  writeOnDemandServer("rea", rea, "  Reverse\n engineering ");
  writeOnDemandServer("alpha", { type: "http", url: "https://a.test/mcp", headers: { Authorization: "Bearer t" } });
  assert.equal(statSync(registryPath).mode & 0o777, 0o600);
  const file = readRegistryFile();
  assert.equal(file.version, 1);
  assert.deepEqual(Object.keys(file.servers), ["alpha", "rea"]);
  assert.equal(file.servers.rea.purpose, "Reverse engineering");
  const view = readOnDemandServers();
  assert.deepEqual(view.servers.map((server) => server.name), ["alpha", "rea"]);
  assert.deepEqual(view.servers[1], { name: "rea", config: rea, purpose: "Reverse engineering" });
  assert.deepEqual(view.problems, []);
  assert.deepEqual(readdirSync(agentDir).filter((name) => name.includes(".tmp-") || name.endsWith(".lock")), []);
});

test("write validates: bad name, sse, both command and url, non-object; nothing is written", () => {
  assert.throws(() => writeOnDemandServer("bad name", rea), /Server name may contain/);
  assert.throws(() => writeOnDemandServer("s", { type: "sse", url: "https://x.test/sse" }), /legacy sse/);
  assert.throws(() => writeOnDemandServer("s", { command: "a", url: "https://x.test" }), /exactly one of command or url/);
  assert.throws(() => writeOnDemandServer("s", "nope"), /must be an object/);
  assert.equal(existsSync(registryPath), false);
});

test("write without a purpose keeps the stored one; an empty string clears it", () => {
  writeOnDemandServer("rea", rea, "first");
  writeOnDemandServer("rea", { ...rea, args: ["serve", "--fast"] });
  assert.equal(readOnDemandServers().servers[0].purpose, "first");
  assert.deepEqual(readOnDemandServers().servers[0].config.args, ["serve", "--fast"]);
  writeOnDemandServer("rea", rea, "");
  assert.equal(readOnDemandServers().servers[0].purpose, "");
});

test("an edit form's masked credentials are merged back from the stored server, on rename too", () => {
  writeOnDemandServer("rea", { ...rea, env: { REA_KEY: "s3cret", OTHER: "o" } }, "p");
  const masked = maskMcpSecrets(readOnDemandServers().servers[0].config);
  assert.equal(masked.env.REA_KEY, MCP_SECRET_SENTINEL);
  writeOnDemandServer("rea", { ...masked, args: ["new"], env: { ...masked.env, OTHER: "changed" } });
  assert.deepEqual(readRegistryFile().servers.rea.config.env, { REA_KEY: "s3cret", OTHER: "changed" });
  writeOnDemandServer("rea2", { ...masked, args: ["new"] }, undefined, "rea");
  const file = readRegistryFile();
  assert.deepEqual(Object.keys(file.servers), ["rea2"]);
  assert.equal(file.servers.rea2.config.env.REA_KEY, "s3cret");
  assert.equal(file.servers.rea2.purpose, "p", "the rename keeps the purpose");
  assert.throws(() => writeOnDemandServer("brand-new", { command: "x", env: { K: MCP_SECRET_SENTINEL } }), /No saved value for env\.K/);
  assert.equal(Object.hasOwn(readRegistryFile().servers, "brand-new"), false);
});

test("rename with previousName removes the old entry; a missing previous entry just creates the new one", () => {
  writeOnDemandServer("one", { command: "a" }, "p1");
  writeOnDemandServer("two", { command: "b" }, "p2");
  writeOnDemandServer("uno", { command: "a2" }, undefined, "one");
  assert.deepEqual(readOnDemandServers().servers.map((server) => [server.name, server.purpose]), [["two", "p2"], ["uno", "p1"]]);
  writeOnDemandServer("fresh", { command: "c" }, "pf", "ghost");
  assert.deepEqual(readOnDemandServers().servers.map((server) => server.name), ["fresh", "two", "uno"]);
});

test("delete removes one server; an unknown (or prototype) name throws and changes nothing", () => {
  writeOnDemandServer("a", { command: "a" });
  writeOnDemandServer("b", { command: "b" });
  deleteOnDemandServer("a");
  assert.deepEqual(readOnDemandServers().servers.map((server) => server.name), ["b"]);
  assert.throws(() => deleteOnDemandServer("a"), /was not found/);
  assert.throws(() => deleteOnDemandServer("constructor"), /was not found/);
  assert.deepEqual(readOnDemandServers().servers.map((server) => server.name), ["b"]);
});

test("entries the extension cannot use stay in the file, show up as problems, and survive other writes along with unknown top-level keys", () => {
  writeFileSync(
    registryPath,
    JSON.stringify({ version: 1, note: "mine", servers: { good: { purpose: "g", config: { command: "g" } }, "bad name": { config: { command: "x" } }, sse: { config: { type: "sse", url: "https://x.test" } }, junk: 5 } }),
  );
  const view = readOnDemandServers();
  assert.deepEqual(view.servers.map((server) => server.name), ["good"]);
  assert.equal(view.problems.length, 3);
  writeOnDemandServer("other", { command: "o" });
  const file = readRegistryFile();
  assert.equal(file.note, "mine");
  assert.deepEqual(Object.keys(file.servers), ["bad name", "good", "junk", "other", "sse"]);
});

test("a corrupt registry is reported and never overwritten, by any write", () => {
  for (const content of ["{not json", "[1,2]", '{"servers":[]}', '"text"']) {
    writeFileSync(registryPath, content);
    const view = readOnDemandServers();
    assert.deepEqual(view.servers, []);
    assert.equal(view.problems.length, 1, content);
    assert.throws(() => writeOnDemandServer("x", { command: "x" }), /not valid JSON|must contain a JSON object|servers must be an object/, content);
    assert.throws(() => deleteOnDemandServer("x"), /not valid JSON|must contain a JSON object|servers must be an object/, content);
    assert.equal(readFileSync(registryPath, "utf8"), content, "the file is untouched");
  }
});

test("a registry over the 512 KiB cap is not read or edited", () => {
  const big = JSON.stringify({ servers: { a: { purpose: "x".repeat(600 * 1024), config: { command: "a" } } } });
  writeFileSync(registryPath, big);
  const view = readOnDemandServers();
  assert.deepEqual(view.servers, []);
  assert.deepEqual(view.problems, ["The on-demand list is too large to edit in Cody"]);
  assert.throws(() => writeOnDemandServer("b", { command: "b" }), /too large/);
  assert.equal(readFileSync(registryPath, "utf8"), big);
});

test("setServerOnDemand(true) moves a server from mcp.json to the registry with its credentials", () => {
  writeMcpFile({ mcpServers: { rea, keep: { command: "keep" } }, otherKey: 1 });
  setServerOnDemand("rea", true, "RE tools");
  assert.deepEqual(Object.keys(readMcpFile().mcpServers), ["keep"]);
  assert.equal(readMcpFile().otherKey, 1);
  const stored = readOnDemandServers().servers.find((server) => server.name === "rea");
  assert.deepEqual(stored, { name: "rea", config: rea, purpose: "RE tools" });
  assert.equal(readRegistryFile().servers.rea.config.env.REA_KEY, "s3cret");
  setServerOnDemand("rea", true);
  assert.equal(readOnDemandServers().servers.length, 1, "repeating the move changes nothing");
});

test("setServerOnDemand(false) moves it back, credentials intact, and the registry loses it", () => {
  writeMcpFile({ mcpServers: { keep: { command: "keep" } } });
  writeOnDemandServer("remote", { type: "http", url: "https://r.test/mcp", headers: { Authorization: "Bearer tok" } }, "remote");
  setServerOnDemand("remote", false);
  assert.deepEqual(readMcpFile().mcpServers.remote, { type: "http", url: "https://r.test/mcp", headers: { Authorization: "Bearer tok" } });
  assert.deepEqual(readOnDemandServers().servers, []);
  assert.deepEqual(readRegistryFile().servers, {});
  setServerOnDemand("remote", false);
  assert.deepEqual(Object.keys(readMcpFile().mcpServers), ["keep", "remote"], "repeating the move changes nothing");
});

test("setServerOnDemand refuses a disabled server, a legacy sse server, and an unknown one; nothing moves", () => {
  writeMcpFile({
    mcpServers: { off: { command: "off" }, flagged: { command: "f", enabled: false }, legacy: { type: "sse", url: "https://l.test/sse" } },
    disabledServers: ["off"],
  });
  assert.throws(() => setServerOnDemand("off", true), /Turn the server on/);
  assert.throws(() => setServerOnDemand("flagged", true), /Turn the server on/);
  assert.throws(() => setServerOnDemand("legacy", true), /legacy sse/);
  assert.throws(() => setServerOnDemand("ghost", true), /was not found/);
  assert.throws(() => setServerOnDemand("ghost", false), /was not found/);
  assert.deepEqual(Object.keys(readMcpFile().mcpServers), ["off", "flagged", "legacy"]);
  assert.equal(existsSync(registryPath), false);
});

test("an interrupted move (server in both places) finishes in either direction without losing anything", () => {
  const registryCopy = { command: "rea", args: ["old"], env: { REA_KEY: "old" } };
  writeMcpFile({ mcpServers: { rea } });
  writeOnDemandServer("rea", registryCopy, "p");
  // the move to on-demand was interrupted after writing the registry: finish it
  setServerOnDemand("rea", true);
  assert.equal(Object.hasOwn(readMcpFile().mcpServers ?? {}, "rea"), false);
  assert.deepEqual(readOnDemandServers().servers[0].config, rea, "the mcp.json definition wins");
  // the move back was interrupted after writing mcp.json: finish that too
  writeMcpFile({ mcpServers: { rea: { ...rea, args: ["stale"] } } });
  setServerOnDemand("rea", false);
  assert.deepEqual(readOnDemandServers().servers, []);
  assert.deepEqual(readMcpFile().mcpServers.rea, rea, "the registry definition (the move's source) wins");
});

test("a move into a corrupt registry fails before the server leaves mcp.json", () => {
  writeMcpFile({ mcpServers: { rea } });
  writeFileSync(registryPath, "{broken");
  assert.throws(() => setServerOnDemand("rea", true), /not valid JSON/);
  assert.deepEqual(readMcpFile().mcpServers.rea, rea);
  assert.equal(readFileSync(registryPath, "utf8"), "{broken");
});

test("an unreadable mcp.json blocks the move to on-demand with its own error", () => {
  writeFileSync(mcpPath, "{broken");
  writeOnDemandServer("rea", rea);
  assert.throws(() => setServerOnDemand("rea", true));
  assert.equal(readOnDemandServers().servers.length, 1);
});

// -- the lock ---------------------------------------------------------------

test("a stale lock (a writer that crashed) is broken and the write goes through", () => {
  const lock = `${registryPath}.lock`;
  writeFileSync(lock, "99999");
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old);
  writeOnDemandServer("a", { command: "a" });
  assert.equal(existsSync(lock), false);
  assert.deepEqual(readOnDemandServers().servers.map((server) => server.name), ["a"]);
});

test("a lock held by a live writer makes the write wait, then fail cleanly without touching the file", () => {
  writeOnDemandServer("a", { command: "a" });
  const before = readFileSync(registryPath, "utf8");
  const lock = `${registryPath}.lock`;
  writeFileSync(lock, String(process.pid));
  const started = Date.now();
  assert.throws(() => writeOnDemandServer("b", { command: "b" }), /Timed out waiting for .*another process holds the MCP config lock/);
  assert.ok(Date.now() - started >= 2_500, "it waited for the lock");
  assert.equal(readFileSync(registryPath, "utf8"), before);
  assert.equal(existsSync(lock), true, "a lock this writer did not take is not removed");
  rmSync(lock);
});

test("two processes writing at once lose no update and leave no lock behind", async () => {
  const root = process.cwd();
  const code = `
    import { createJiti } from "jiti";
    const jiti = createJiti(${JSON.stringify(`${root}/lib/omp/x.mjs`)});
    const { writeOnDemandServer, deleteOnDemandServer } = await jiti.import(${JSON.stringify(`${root}/lib/omp/on-demand-mcp.ts`)});
    const who = process.argv[1];
    for (let index = 0; index < 12; index += 1) {
      writeOnDemandServer(who + index, { command: who });
      if (index % 4 === 3) deleteOnDemandServer(who + (index - 3));
    }
  `;
  const run = (who) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", code, who], { cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, OMP_PROFILE: "", PI_PROFILE: "" }, stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("exit", (status) => (status === 0 ? resolve() : reject(new Error(`${who} exited ${status}: ${stderr}`))));
    });
  await Promise.all([run("p"), run("q")]);
  const names = Object.keys(readRegistryFile().servers);
  const expected = [];
  for (const who of ["p", "q"]) for (let index = 0; index < 12; index += 1) if (![0, 4, 8].includes(index)) expected.push(who + index);
  assert.deepEqual(names, expected.sort((a, b) => a.localeCompare(b)));
  assert.equal(existsSync(`${registryPath}.lock`), false);
  assert.deepEqual(readOnDemandServers().problems, []);
});
