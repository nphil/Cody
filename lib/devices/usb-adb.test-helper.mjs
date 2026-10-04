/**
 * The browser side of an ADB device, for tests that drive the REAL page code
 * (`DeviceBridgeConnection`, its lifecycle listeners, its registry and lease
 * book) instead of a hand-written provider: `navigator.usb` is an EventTarget
 * whose `getDevices()` lists what is plugged in, and a plugged-in device is a
 * WebUSB object whose bulk endpoints carry the ADB packets of an emulated adbd
 * (`sandboxDevice()`).
 */

/** Installs `window`, `navigator.usb` and `sessionStorage` as globals; `restore()` puts the previous ones back. */
export function fakeBrowser() {
  const names = ["window", "navigator", "sessionStorage"];
  const prior = Object.fromEntries(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const attached = new Set();
  const storage = new Map();
  const usb = Object.assign(new EventTarget(), {
    async getDevices() { return [...attached]; },
    async requestDevice() {
      const [device] = attached;
      if (!device) throw new DOMException("No device selected.", "NotFoundError");
      return device;
    },
  });
  const define = (name, value) => Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  define("window", { isSecureContext: true });
  define("navigator", { usb });
  define("sessionStorage", { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => { storage.set(key, String(value)); } });
  const announce = (type, device) => usb.dispatchEvent(Object.assign(new Event(type), { device }));
  return {
    usb,
    /** The device appears on the bus. */
    plug(device) {
      attached.add(device);
      device.joinBus();
      announce("connect", device);
    },
    /** The device leaves the bus; the browser tells every disconnect listener. */
    unplug(device) {
      attached.delete(device);
      device.leaveBus();
      announce("disconnect", device);
    },
    restore() {
      for (const name of names) {
        if (prior[name]) Object.defineProperty(globalThis, name, prior[name]);
        else delete globalThis[name];
      }
    },
  };
}

/**
 * A WebUSB device with one ADB interface (class ff/42/01, one bulk IN and one
 * bulk OUT endpoint) in front of `adbd`. Each re-enumeration of a real device
 * is a NEW object with the same vendor, product and serial, which is what a
 * second `fakeUsbAdbDevice` with the same `serial` stands for.
 */
export function fakeUsbAdbDevice({ adbd, serial = "cronos-7", vendorId = 0x18d1, productId = 0x4ee7 }) {
  const never = new AbortController().signal;
  const alternate = {
    alternateSetting: 0,
    interfaceClass: 0xff,
    interfaceSubclass: 0x42,
    interfaceProtocol: 0x01,
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
    productName: "Cronos tablet",
    manufacturerName: "Cody",
    opened: false,
    onBus: true,
    configuration,
    configurations: [configuration],
    adbd,
    async open() {
      if (!device.onBus) throw gone();
      device.opened = true;
    },
    /** Like WebUSB, closing fails every transfer still waiting. */
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
        const chunk = await adbd.transport.read(length, 0, controller.signal);
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
      await adbd.transport.write(Uint8Array.from(bytes), never);
      return { status: "ok", bytesWritten: bytes.byteLength };
    },
    joinBus() { device.onBus = true; },
    leaveBus() {
      device.onBus = false;
      device.opened = false;
      iface.claimed = false;
      for (const controller of pending) controller.abort(gone());
      adbd.transport.close();
    },
  };
  return device;
}
