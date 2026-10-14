import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * The saved machine list decides which addresses this server connects to with
 * its own ssh keys, so what matters is who can put what in it: a destination is
 * an alias or user@host and nothing else (it ends up in an ssh command line and
 * in `ProxyCommand %h`), a hand-edited file can never smuggle one past that,
 * and a fresh install shows only "This server".
 */
const agentDir = mkdtempSync(join(tmpdir(), "cody-machines-store-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const jiti = createJiti(import.meta.url);
const store = await jiti.import("./store.ts");
const types = await jiti.import("./types.ts");

function reset() {
  rmSync(store.getMachinesConfigPath(), { force: true });
}

function ssh(list) {
  return list.filter((machine) => machine.kind === "ssh");
}

test("a fresh install lists only this server, called This server", () => {
  reset();
  assert.deepEqual(store.listMachineConfigs(), [{ id: "local", kind: "local", name: "This server" }]);
});

test("destinations are an alias or user@host; everything else is refused", () => {
  for (const good of ["proxmox", "pve-1", "my_box", "pve.local", "root@192.168.1.138", "nitin@pve.example.net", "fe80::1", "root@2001:db8::1", "_work"]) {
    assert.equal(types.checkMachineDestination(good).ok, true, `${good} should pass`);
  }
  const bad = [
    "", "   ", "-oProxyCommand=touch /tmp/x", "-v", "a b", "host;reboot", "host&&id", "$(id)", "`id`", "host|cat", "host\nid", "host'x", 'host"x',
    "user@", "@host", "a@b@c", "user name@host", "ssh://host", "host/path", "host%eth0", "host\\x", "a".repeat(97), ".host", "-host", "user@-host",
  ];
  for (const value of bad) {
    assert.equal(types.checkMachineDestination(value).ok, false, `${JSON.stringify(value)} must be refused`);
  }
  assert.equal(types.checkMachineDestination(42).ok, false);
  assert.equal(types.checkMachineDestination(null).ok, false);
});

test("names are one line of printable text, trimmed, at most 24 characters", () => {
  assert.deepEqual(types.checkMachineName("  Home   box "), { ok: true, value: "Home box" });
  assert.deepEqual(types.checkMachineName("プロキシモックス"), { ok: true, value: "プロキシモックス" });
  assert.equal(types.checkMachineName("x".repeat(24)).ok, true);
  assert.deepEqual(types.checkMachineName("x".repeat(25)), { ok: false, code: "machine_name_too_long" });
  assert.deepEqual(types.checkMachineName("   "), { ok: false, code: "machine_name_required" });
  assert.deepEqual(types.checkMachineName(7), { ok: false, code: "machine_name_required" });
  assert.deepEqual(types.checkMachineName("a\u0007b"), { ok: false, code: "machine_name_invalid" });
  assert.deepEqual(types.checkMachineName("a\u202eb"), { ok: false, code: "machine_name_invalid" }, "bidi override is a format character");
  assert.deepEqual(types.checkMachineName("a\u2028b\nc\td"), { ok: true, value: "a b c d" }, "line breaks and tabs collapse to one space");
});

test("this server can be renamed, and the list lives 0600 in the instance data dir", () => {
  reset();
  const list = store.updateMachinesConfig({ localName: "  Unraid  " });
  assert.deepEqual(list, [{ id: "local", kind: "local", name: "Unraid" }]);
  const file = store.getMachinesConfigPath();
  assert.ok(file.startsWith(agentDir), "next to the other Cody-level state");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).localName, "Unraid");
});

test("an ssh machine is added with a minted id and keeps it when renamed or reordered", () => {
  reset();
  const added = store.updateMachinesConfig({ machines: [{ name: "Proxmox", destination: "proxmox" }, { name: "Pi", destination: "pi@raspberrypi.local" }] });
  const [proxmox, pi] = ssh(added);
  assert.match(proxmox.id, /^m-[0-9a-f]{6}$/);
  assert.equal(proxmox.destination, "proxmox");
  assert.notEqual(proxmox.id, pi.id);

  const renamed = store.updateMachinesConfig({
    machines: [{ id: pi.id, name: "Raspberry", destination: pi.destination }, { id: proxmox.id, name: "PVE", destination: "proxmox" }],
  });
  assert.deepEqual(ssh(renamed).map((machine) => [machine.id, machine.name]), [[pi.id, "Raspberry"], [proxmox.id, "PVE"]]);
});

test("a machine missing from the list is removed, and an unknown id is treated as a new machine", () => {
  reset();
  const [first] = ssh(store.updateMachinesConfig({ machines: [{ name: "A", destination: "alpha" }] }));
  const next = store.updateMachinesConfig({ machines: [{ id: "m-forged", name: "B", destination: "beta" }] });
  assert.equal(ssh(next).length, 1);
  assert.notEqual(ssh(next)[0].id, "m-forged", "an id the file never held is not trusted");
  assert.notEqual(ssh(next)[0].id, first.id, "a removed machine's id is not reused");
  assert.deepEqual(ssh(store.updateMachinesConfig({ machines: [] })), []);
});

test("leaving a field out leaves it alone", () => {
  reset();
  store.updateMachinesConfig({ localName: "Box", machines: [{ name: "A", destination: "alpha" }] });
  const renamed = store.updateMachinesConfig({ localName: "Server" });
  assert.equal(renamed[0].name, "Server");
  assert.equal(ssh(renamed).length, 1, "the ssh list was not mentioned, so it stays");
  const kept = store.updateMachinesConfig({ machines: [] });
  assert.equal(kept[0].name, "Server");
});

test("nothing is written unless every field is valid", () => {
  reset();
  store.updateMachinesConfig({ machines: [{ name: "A", destination: "alpha" }] });
  const before = readFileSync(store.getMachinesConfigPath(), "utf8");
  const rejected = [
    [{ localName: "ok", machines: [{ name: "B", destination: "-oProxyCommand=x" }] }, "machine_destination_invalid"],
    [{ machines: [{ name: "", destination: "beta" }] }, "machine_name_required"],
    [{ machines: [{ name: "x".repeat(30), destination: "beta" }] }, "machine_name_too_long"],
    [{ machines: [{ name: "B", destination: "" }] }, "machine_destination_required"],
    [{ machines: [{ name: "B", destination: "a b" }] }, "machine_destination_invalid"],
    [{ machines: [{ name: "A", destination: "alpha" }, { name: "a", destination: "gamma" }] }, "machine_duplicate_name"],
    [{ machines: [{ name: "A", destination: "alpha" }, { name: "B", destination: "ALPHA" }] }, "machine_duplicate_destination"],
    [{ localName: "Dup", machines: [{ name: "dup", destination: "delta" }] }, "machine_duplicate_name"],
    [{ machines: "alpha" }, "invalid_request"],
    [{ machines: [null] }, "invalid_request"],
    [{ machines: Array.from({ length: 12 }, (_, i) => ({ name: `M${i}`, destination: `host${i}` })) }, "too_many_machines"],
  ];
  for (const [update, code] of rejected) {
    assert.throws(() => store.updateMachinesConfig(update), (error) => error instanceof store.MachinesConfigError && error.code === code, `${JSON.stringify(update).slice(0, 80)} → ${code}`);
  }
  assert.equal(readFileSync(store.getMachinesConfigPath(), "utf8"), before, "the saved list is untouched");
});

test("eleven ssh machines fit next to this server, the twelfth does not", () => {
  reset();
  const eleven = Array.from({ length: 11 }, (_, i) => ({ name: `M${i}`, destination: `host${i}` }));
  assert.equal(store.updateMachinesConfig({ machines: eleven }).length, 12);
});

test("a hand-edited or damaged file never reaches ssh", () => {
  reset();
  const file = store.getMachinesConfigPath();
  writeFileSync(file, "{ not json");
  assert.deepEqual(store.listMachineConfigs().map((machine) => machine.id), ["local"]);

  writeFileSync(file, JSON.stringify({
    version: 1,
    localName: "x".repeat(60),
    machines: [
      { id: "m-aaaaaa", name: "Good", destination: "good-host" },
      { id: "m-bbbbbb", name: "Evil", destination: "-oProxyCommand=touch /tmp/pwned" },
      { id: "m-cccccc", name: "Spaced", destination: "a b" },
      { id: "local", name: "Impostor", destination: "other" },
      { id: "m-aaaaaa", name: "Twin", destination: "twin-host" },
      { id: "../../etc", name: "Path", destination: "path-host" },
      { name: "No id", destination: "no-id-host" },
    ],
  }));
  const list = store.listMachineConfigs();
  assert.equal(list[0].name, "This server", "an invalid saved name falls back to the default");
  assert.deepEqual(ssh(list).map((machine) => machine.destination), ["good-host"]);
});
