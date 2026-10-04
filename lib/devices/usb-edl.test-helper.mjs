/**
 * A WebUSB device in Qualcomm emergency download (05c6:9008): one vendor-class
 * interface with a bulk IN and a bulk OUT endpoint, in front of `fakeEdlDevice()`'s
 * boot ROM and programmer, for tests that drive the REAL page code
 * (`DeviceBridgeConnection`, its quiet-read gate, lease book and lifecycle
 * listeners) with `fakeBrowser()` from usb-adb.test-helper.mjs.
 *
 * `transferIn` asks the emulator for one bulk-IN request in its packet-accurate
 * model (short packets and zero-length packets end it, a request smaller than a
 * packet is a babble error), and closing the device fails every transfer still
 * waiting, as WebUSB does. A real re-enumeration is a NEW object with the same
 * vendor, product and serial.
 */
export function fakeUsbEdlDevice({ edl, serial = "edl-1", vendorId = 0x05c6, productId = 0x9008 }) {
  const alternate = {
    alternateSetting: 0,
    interfaceClass: 0xff,
    interfaceSubclass: 0xff,
    interfaceProtocol: 0xff,
    endpoints: [
      { endpointNumber: 1, direction: "in", type: "bulk", packetSize: 512 },
      { endpointNumber: 1, direction: "out", type: "bulk", packetSize: 512 },
    ],
  };
  const iface = { interfaceNumber: 0, claimed: false, alternate, alternates: [alternate] };
  const configuration = { configurationValue: 1, interfaces: [iface] };
  const pending = new Set();
  const gone = () => new DOMException("The device was disconnected.", "NotFoundError");
  const device = {
    vendorId,
    productId,
    serialNumber: serial,
    productName: "QUSB__BULK",
    manufacturerName: "Qualcomm",
    opened: false,
    onBus: true,
    configuration,
    configurations: [configuration],
    opens: 0,
    edl,
    async open() {
      if (!device.onBus) throw gone();
      device.opened = true;
      device.opens += 1;
    },
    async close() {
      device.opened = false;
      iface.claimed = false;
      for (const controller of pending) controller.abort(new DOMException("The device was closed.", "AbortError"));
    },
    async forget() {},
    async selectConfiguration() {},
    async selectAlternateInterface() {},
    async claimInterface() {
      if (!device.onBus) throw gone();
      iface.claimed = true;
    },
    async releaseInterface() { iface.claimed = false; },
    async transferIn(_endpoint, length) {
      if (!device.onBus) throw gone();
      const controller = new AbortController();
      pending.add(controller);
      try {
        const chunk = await edl.bulkIn(length, controller.signal);
        if (!device.onBus) throw gone();
        return { status: "ok", data: new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength) };
      } catch (error) {
        throw device.onBus ? error : gone();
      } finally {
        pending.delete(controller);
      }
    },
    async transferOut(_endpoint, bytes) {
      if (!device.onBus) throw gone();
      await edl.bulkOut(Uint8Array.from(bytes));
      return { status: "ok", bytesWritten: bytes.byteLength };
    },
    joinBus() { device.onBus = true; },
    leaveBus() {
      device.onBus = false;
      device.opened = false;
      iface.claimed = false;
      for (const controller of pending) controller.abort(gone());
      edl.leave();
    },
  };
  return device;
}
