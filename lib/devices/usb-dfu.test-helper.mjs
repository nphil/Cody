/**
 * A WebUSB device with one DFU-mode interface (class fe/01/02, no endpoints: DFU talks on
 * the control pipe) in front of a `fakeDfuDevice()` state machine, for tests that drive the
 * REAL page code (`DeviceBridgeConnection`, its lifecycle listeners, registry and lease
 * book) with `fakeBrowser()` from usb-adb.test-helper.mjs. Once the device has left the
 * bus every transfer fails the way WebUSB's do. A real re-enumeration is a NEW object with
 * the same vendor, product and serial.
 */
export function fakeUsbDfuDevice({ dfu, serial = "dfu-1", vendorId = 0x0483, productId = 0xdf11 }) {
  const alternate = {
    alternateSetting: 0,
    interfaceClass: 0xfe,
    interfaceSubclass: 0x01,
    interfaceProtocol: 0x02,
    interfaceName: dfu.alternateName,
    endpoints: [],
  };
  const iface = { interfaceNumber: 0, claimed: false, alternate, alternates: [alternate] };
  const configuration = { configurationValue: 1, interfaces: [iface] };
  const gone = () => new DOMException("The device was disconnected.", "NotFoundError");
  const device = {
    vendorId,
    productId,
    serialNumber: serial,
    productName: "DFU bootloader",
    manufacturerName: "Cody",
    opened: false,
    onBus: true,
    configuration,
    configurations: [configuration],
    dfu,
    async open() {
      if (!device.onBus) throw gone();
      device.opened = true;
    },
    async close() {
      device.opened = false;
      iface.claimed = false;
    },
    async forget() {},
    async selectConfiguration() {},
    async selectAlternateInterface() {},
    async claimInterface() {
      if (!device.onBus) throw gone();
      iface.claimed = true;
    },
    async releaseInterface() { iface.claimed = false; },
    async controlTransferIn(setup, length) {
      if (!device.onBus) throw gone();
      const bytes = await dfu.transport.controlIn(setup, length);
      return { status: "ok", data: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength) };
    },
    async controlTransferOut(setup, bytes) {
      if (!device.onBus) throw gone();
      await dfu.transport.controlOut(setup, Uint8Array.from(bytes));
      return { status: "ok", bytesWritten: bytes.byteLength };
    },
    async reset() {
      if (!device.onBus) throw gone();
      await dfu.transport.reset();
    },
    joinBus() { device.onBus = true; },
    leaveBus() {
      device.onBus = false;
      device.opened = false;
      iface.claimed = false;
    },
  };
  return device;
}
