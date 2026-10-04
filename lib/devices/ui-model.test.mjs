import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const model = await jiti.import("./ui-model.ts");
const { ACTIONS_BY_PROTOCOL, ALL_PROTOCOLS, GROUP_ORDER, TERMINAL_COVERED, adbBannerState, availableGroups, deviceMode, formActions, groupActions, offeredProtocols } = model;

const usb = (...protocols) => ({
  kind: "usb",
  protocolCandidates: protocols.map((protocol, index) => ({ protocol, interfaceNumber: index, alternateSetting: 0 })),
});

test("every action a shipped flasher declares is reachable from exactly one group", () => {
  for (const protocol of ALL_PROTOCOLS) {
    for (const action of ACTIONS_BY_PROTOCOL[protocol]) {
      const homes = GROUP_ORDER.filter((group) => groupActions(group, protocol).includes(action));
      assert.equal(homes.length, 1, `${protocol}.${action} is in ${homes.length} groups: ${homes.join(", ")}`);
    }
  }
});

test("an action is either a generic form field set or covered by a terminal, never lost", () => {
  for (const protocol of ALL_PROTOCOLS) {
    for (const group of GROUP_ORDER) {
      const all = groupActions(group, protocol);
      const shown = formActions(group, protocol);
      const covered = TERMINAL_COVERED[protocol] ?? [];
      for (const action of all) {
        assert.ok(shown.includes(action) || covered.includes(action), `${protocol}.${action} has no form and no terminal`);
      }
    }
  }
});

test("an ADB device offers terminal, files, backup and port forwarding but no flash or fastboot commands", () => {
  const mode = deviceMode(usb("adb"));
  assert.equal(mode.id, "adb");
  assert.deepEqual(availableGroups(offeredProtocols(mode, false)), ["overview", "terminal", "files", "backup", "ports"]);
});

test("a fastboot device offers commands, flash and backup but no ADB files or ports", () => {
  const mode = deviceMode(usb("fastboot"));
  assert.equal(mode.id, "fastboot");
  assert.deepEqual(availableGroups(offeredProtocols(mode, false)), ["overview", "commands", "flash", "backup"]);
});

test("a serial port offers the monitor, bootloader flashers and dumps", () => {
  const mode = deviceMode({ kind: "serial" });
  assert.equal(mode.id, "serial");
  assert.deepEqual(availableGroups(offeredProtocols(mode, false)), ["overview", "commands", "serial", "flash", "backup"]);
  assert.deepEqual([...mode.protocols].sort(), ["esp", "gecko", "serial", "stk500", "stm32"]);
});

test("a USB CDC data interface is a serial device that can also run the serial bootloaders", () => {
  const mode = deviceMode(usb("serial"));
  assert.equal(mode.id, "serial");
  assert.ok(mode.protocols.includes("esp") && mode.protocols.includes("serial"));
});

test("a DFU device offers commands, flash and backup", () => {
  const mode = deviceMode(usb("dfu"));
  assert.equal(mode.id, "dfu");
  assert.deepEqual(availableGroups(offeredProtocols(mode, false)), ["overview", "commands", "flash", "backup"]);
});

test("Bluetooth has only the overview, and an unrecognised USB device shows every group", () => {
  const ble = deviceMode({ kind: "ble" });
  assert.deepEqual(availableGroups(offeredProtocols(ble, false)), ["overview"]);
  const unknown = deviceMode({ kind: "usb" });
  assert.equal(unknown.id, "unknown-usb");
  assert.deepEqual(availableGroups(offeredProtocols(unknown, false)), [...GROUP_ORDER]);
});

test("showing all protocols exposes every group even for a known mode", () => {
  const mode = deviceMode(usb("fastboot"));
  assert.deepEqual(availableGroups(offeredProtocols(mode, true)), [...GROUP_ORDER]);
});

test("the ADB banner prefix names the mode the daemon reports", () => {
  assert.equal(adbBannerState("recovery::ro.product.name=twrp;"), "recovery");
  assert.equal(adbBannerState("sideload::"), "sideload");
  assert.equal(adbBannerState("device::features=shell_v2"), "device");
  assert.equal(adbBannerState("surprise::"), null);
  assert.equal(adbBannerState(undefined), null);
});
