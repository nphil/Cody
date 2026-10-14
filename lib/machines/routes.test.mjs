import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, beforeEach } from "node:test";
import { createJiti } from "jiti";

/**
 * The HTTP surface of the machine meters, through the real route handlers: who
 * may see an ssh address and who may change the list, what a bad request looks
 * like, that a change reaches a page that is already watching, and that the
 * live stream says how every machine is doing without ever saying how to reach
 * one. The sampler, the parsing and the ssh wrapper have their own files.
 */
const root = mkdtempSync(join(tmpdir(), "cody-machines-routes-"));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
process.env.CODY_ACCOUNTS_DIR = join(root, "accounts");
delete process.env.CODY_PASSWORD;
delete process.env.OMP_WEB_PASSWORD;

// A stand-in `ssh` first on PATH: it runs the command it is given the way a
// remote login shell would, so a machine added by these tests samples THIS
// machine's own /proc and nothing leaves it.
const binDir = join(root, "bin");
mkdirSync(binDir, { recursive: true });
writeFileSync(join(binDir, "ssh"), `#!/bin/sh
while [ "$1" != "--" ]; do shift; done
shift; shift
exec sh -c "$1"
`, { mode: 0o755 });
process.env.PATH = `${binDir}:${process.env.PATH}`;

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const list = await jiti.import("../../app/api/machines/route.ts");
const stream = await jiti.import("../../app/api/machines/stream/route.ts");
const testRoute = await jiti.import("../../app/api/machines/test/route.ts");
const sampler = await jiti.import("./sampler.ts");
const users = await jiti.import("../auth/users.ts");
const { issueSessionToken, SESSION_COOKIE_NAME } = await jiti.import("../auth/session.ts");

const onLinux = process.platform === "linux";
const admin = users.createUser({ username: "admin", fullName: "Admin", passwordHash: "x", role: "admin" });
const alice = users.createUser({ username: "alice", fullName: "Alice", passwordHash: "x", role: "member" });

const cookieFor = (user) => (user ? { Cookie: `${SESSION_COOKIE_NAME}=${issueSessionToken(user)}` } : {});

async function call(handler, { user, method = "GET", path = "/api/machines", body, raw } = {}) {
  const response = await handler(new Request(`http://cody.test${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...cookieFor(user) },
    ...(method === "GET" || (body === undefined && raw === undefined) ? {} : { body: raw ?? JSON.stringify(body) }),
  }));
  return { status: response.status, body: await response.json(), headers: response.headers };
}

const put = (user, body) => call(list.PUT, { user, method: "PUT", body });

// Each test starts from a fresh install's list, whatever the one before did.
beforeEach(() => put(admin, { localName: "This server", machines: [] }));

// The stream's timers and the sampler's are unref'd; a test waiting on a frame
// needs something that is not.
const keepAlive = setInterval(() => {}, 1_000);
after(() => {
  clearInterval(keepAlive);
  sampler.stopMachineSampler();
});

/** Read SSE frames off a stream response. */
function frames(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    async next(timeoutMs = 10_000) {
      for (;;) {
        const end = buffer.indexOf("\n\n");
        if (end !== -1) {
          const data = buffer.slice(0, end).split("\n").find((line) => line.startsWith("data: "));
          buffer = buffer.slice(end + 2);
          if (data) return JSON.parse(data.slice(6));
          continue;
        }
        let timer;
        const chunk = await Promise.race([
          reader.read(),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("no frame arrived")), timeoutMs); }),
        ]).finally(() => clearTimeout(timer));
        if (chunk.done) throw new Error("the stream ended");
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    },
    /** The next frame that satisfies `wanted`. */
    async until(wanted, timeoutMs = 12_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const frame = await this.next(Math.max(500, deadline - Date.now()));
        if (frame.type === "machines" && wanted(frame.machines)) return frame;
        if (Date.now() > deadline) throw new Error("the stream never reached the state asked for");
      }
    },
    cancel: () => reader.cancel(),
  };
}

test("signed out, every machines route refuses", async () => {
  assert.equal((await call(list.GET)).status, 401);
  assert.equal((await call(list.PUT, { method: "PUT", body: {} })).status, 401);
  assert.equal((await call(testRoute.POST, { method: "POST", path: "/api/machines/test", body: { destination: "proxmox" } })).status, 401);
  const response = await stream.GET(new Request("http://cody.test/api/machines/stream"));
  assert.equal(response.status, 401);
});

test("a fresh install lists only this server, to a member and to an admin", async () => {
  const asAdmin = await call(list.GET, { user: admin });
  assert.equal(asAdmin.status, 200);
  assert.deepEqual(asAdmin.body.machines, [{ id: "local", kind: "local", name: "This server" }]);
  assert.equal(asAdmin.body.canEdit, true);
  assert.equal(asAdmin.headers.get("cache-control"), "no-store");
  const asMember = await call(list.GET, { user: alice });
  assert.deepEqual(asMember.body.machines, asAdmin.body.machines);
  assert.equal(asMember.body.canEdit, false);
});

test("only an admin changes the list, and a member never sees an address", async () => {
  const forbidden = await put(alice, { machines: [{ name: "Proxmox", destination: "proxmox" }] });
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.body.code, "admin_required");

  const added = await put(admin, { localName: "Unraid", machines: [{ name: "Proxmox", destination: "proxmox" }] });
  assert.equal(added.status, 200);
  assert.equal(added.body.canEdit, true);
  assert.equal(added.body.machines[0].name, "Unraid");
  assert.equal(added.body.machines[1].destination, "proxmox", "the admin sees how to reach it");
  assert.match(added.body.machines[1].id, /^m-[0-9a-f]{6}$/);

  const asMember = await call(list.GET, { user: alice });
  assert.deepEqual(asMember.body.machines.map((m) => [m.name, m.kind, "destination" in m]), [["Unraid", "local", false], ["Proxmox", "ssh", false]]);
  assert.equal(JSON.stringify(asMember.body).includes("proxmox"), false, "not even in a field nobody looks at");
  await put(admin, { machines: [] });
});

test("a bad request gets a stable code and saves nothing", async () => {
  await put(admin, { machines: [{ name: "Keep", destination: "keeper" }] });
  const cases = [
    [{ machines: [{ name: "Evil", destination: "-oProxyCommand=touch /tmp/pwned" }] }, 400, "machine_destination_invalid"],
    [{ machines: [{ name: "", destination: "ok" }] }, 400, "machine_name_required"],
    [{ machines: "nope" }, 400, "invalid_request"],
    [{ machines: [{ name: "A", destination: "dup" }, { name: "B", destination: "DUP" }] }, 400, "machine_duplicate_destination"],
  ];
  for (const [body, status, code] of cases) {
    const result = await put(admin, body);
    assert.equal(result.status, status, JSON.stringify(body));
    assert.equal(result.body.code, code);
  }
  assert.equal((await call(list.PUT, { user: admin, method: "PUT", raw: "{not json" })).body.code, "invalid_request");
  assert.equal((await call(list.PUT, { user: admin, method: "PUT", body: [] })).body.code, "invalid_request");
  const after = await call(list.GET, { user: admin });
  assert.deepEqual(after.body.machines.map((m) => m.name), ["This server", "Keep"], "the saved list is untouched");
  await put(admin, { machines: [] });
});

test("the test route checks the destination before anything is spawned, and only for an admin", async () => {
  const post = (user, body) => call(testRoute.POST, { user, method: "POST", path: "/api/machines/test", body });
  assert.equal((await post(alice, { destination: "proxmox" })).status, 403);
  const invalid = await post(admin, { destination: "-oProxyCommand=x" });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.code, "machine_destination_invalid");
  assert.equal((await post(admin, {})).body.code, "machine_destination_required");
  assert.equal((await post(admin, { destination: "a b" })).body.code, "machine_destination_invalid");
});

test("a test takes one real reading through ssh and reports it", { skip: !onLinux }, async () => {
  const result = await call(testRoute.POST, { user: admin, method: "POST", path: "/api/machines/test", body: { destination: "fake-box" } });
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.ok(result.body.cores >= 1);
  assert.ok(result.body.memPercent > 0 && result.body.memPercent <= 100);
  assert.ok(result.body.memTotalBytes > 0);
  assert.ok(result.body.cpuPercent === null || (result.body.cpuPercent >= 0 && result.body.cpuPercent <= 100));
});

test("the stream opens on every machine, says nothing of how to reach one, and a change reaches the page watching", { skip: !onLinux }, async () => {
  const response = await stream.GET(new Request("http://cody.test/api/machines/stream", { headers: cookieFor(alice) }));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  const watching = frames(response);
  try {
    const first = await watching.next();
    assert.equal(first.type, "machines");
    assert.deepEqual(first.machines.map((m) => m.id), ["local"]);

    await put(admin, { machines: [{ name: "Far box", destination: "far-box.example" }] });
    const grown = await watching.until((machines) => machines.length === 2);
    assert.equal(grown.machines[1].name, "Far box");
    assert.equal(JSON.stringify(grown).includes("far-box.example"), false, "a frame never carries an address");
    assert.ok(Object.keys(grown.machines[1]).every((key) => ["id", "name", "kind", "status", "reason", "metrics"].includes(key)));

    // The stand-in ssh samples this very machine, so it comes online with real numbers.
    const online = await watching.until((machines) => machines[1]?.status === "online" && machines[1].metrics?.cpuPercent !== null);
    assert.ok(online.machines[1].metrics.cores >= 1);

    await put(admin, { machines: [] });
    await watching.until((machines) => machines.length === 1);
  } finally {
    await watching.cancel();
  }
});
