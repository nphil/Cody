/**
 * A USB DFU device at the control-transfer boundary. It runs the DFU 1.1 state
 * machine (DNLOAD blocks must arrive in order, UPLOAD needs dfuIDLE, a
 * zero-length DNLOAD starts manifestation, GETSTATUS advances the busy states)
 * and, for bcdDFU 0x011a, the DfuSe set-address and leave sequence. Cody's real
 * DFU flasher talks to it, so wire order and what the device ends up holding
 * are both observable.
 */
const STATE = { IDLE: 2, DNLOAD_SYNC: 3, DNBUSY: 4, DNLOAD_IDLE: 5, MANIFEST_SYNC: 6, MANIFEST: 7, WAIT_RESET: 8, UPLOAD_IDLE: 9, ERROR: 10 };

/**
 * `leaveReply` is what a DfuSe device answers the GETSTATUS that follows the leave download:
 * undefined (it answers, then leaves), "vanishes" (it left before it could answer), or, with
 * the device still attached, "error" (dfuERROR/errTARGET), "malformed" (not a DFU status) and
 * "stalls" (the read fails). `resetLeaves` makes a successful reset re-enumerate the device.
 * `onDeparture` runs at the moment the device leaves the bus, for tests that tell a browser.
 */
export function fakeDfuDevice({
  version = 0x0110,
  attributes = 0x07,
  transferSize = 64,
  firmware = Buffer.alloc(0),
  manifestation = "tolerant",
  uploadStalls = false,
  rejectImage = false,
  corruptStored = false,
  resetFails = false,
  resetLeaves = false,
  leaveReply,
  onDeparture = () => {},
  alternateName = "firmware",
} = {}) {
  let state = STATE.IDLE;
  let status = 0;
  let nextBlock = 0;
  let stored = [];
  let held = Buffer.from(firmware);
  let manifestStep = 0;
  let gone = false;
  let pointer;
  let left = false;
  const log = [];
  const resets = [];

  const statusReply = () => Uint8Array.from([status, 1, 0, 0, state, 0]);
  const commit = () => {
    held = Buffer.concat(stored);
    if (corruptStored) held[0] ^= 1;
  };

  const getStatus = () => {
    if (state === STATE.DNLOAD_SYNC) state = STATE.DNBUSY;
    else if (state === STATE.DNBUSY) state = STATE.DNLOAD_IDLE;
    else if (state === STATE.MANIFEST_SYNC && manifestStep === 0) {
      if (version === 0x011a) {
        if (leaveReply === "error") {
          status = 0x01;
          state = STATE.ERROR;
        } else if (leaveReply === "malformed") {
          return Uint8Array.from([0, 0, 0]);
        } else if (leaveReply === "stalls") {
          throw new Error("USB control read failed: stall");
        } else {
          left = true;
          gone = true;
          onDeparture();
          if (leaveReply === "vanishes") throw new Error("NetworkError: the device was disconnected");
          state = STATE.MANIFEST;
        }
      } else if (rejectImage) {
        status = 0x0a;
        state = STATE.ERROR;
      } else if (manifestation === "vanish") {
        commit();
        gone = true;
        onDeparture();
        throw new Error("NetworkError: the device was disconnected");
      } else if (manifestation === "wait-reset") {
        commit();
        state = STATE.WAIT_RESET;
      } else {
        commit();
        manifestStep = 1;
        state = STATE.MANIFEST;
      }
    } else if (state === STATE.MANIFEST && manifestStep === 1) {
      manifestStep = 2;
      state = STATE.MANIFEST_SYNC;
    } else if (state === STATE.MANIFEST_SYNC && manifestStep === 2) {
      state = STATE.IDLE;
      manifestStep = 0;
    }
    return statusReply();
  };

  const transport = {
    kind: "usb",
    interfaceNumber: 2,
    alternateSetting: 0,
    dfu: { interfaceNumber: 2, alternateSetting: 0, alternateName },
    async read() { return null; },
    async write() { throw new Error("bulk transfer forbidden on a DFU interface"); },
    async controlIn(setup, length) {
      if (setup.requestType === "standard") {
        return Uint8Array.from([9, 0x21, attributes, 0, 0, transferSize & 0xff, transferSize >> 8, version & 0xff, version >> 8]);
      }
      if (gone && !left) throw new Error("NetworkError: the device was disconnected");
      if (setup.request === 3) {
        log.push({ op: "GETSTATUS" });
        if (state === STATE.IDLE) manifestStep = 0;
        return getStatus();
      }
      if (setup.request === 5) return Uint8Array.from([state]);
      if (setup.request === 2) {
        log.push({ op: "UPLOAD", block: setup.value });
        if (state !== STATE.IDLE && state !== STATE.UPLOAD_IDLE) {
          status = 0x0f;
          state = STATE.ERROR;
          return new Uint8Array(0);
        }
        if (uploadStalls) {
          status = 0x0f;
          state = STATE.ERROR;
          return new Uint8Array(0);
        }
        const data = held.subarray(setup.value * transferSize, setup.value * transferSize + Math.min(length, transferSize));
        state = data.length < transferSize ? STATE.IDLE : STATE.UPLOAD_IDLE;
        return Uint8Array.from(data);
      }
      throw new Error(`unexpected control IN ${setup.request}`);
    },
    async controlOut(setup, bytes) {
      if (gone && !left) throw new Error("NetworkError: the device was disconnected");
      if (setup.request === 4) {
        log.push({ op: "CLRSTATUS" });
        if (state === STATE.ERROR) {
          state = STATE.IDLE;
          status = 0;
        }
        return;
      }
      if (setup.request === 6) {
        log.push({ op: "ABORT" });
        if (state !== STATE.ERROR) state = STATE.IDLE;
        return;
      }
      if (setup.request !== 1) throw new Error(`unexpected control OUT ${setup.request}`);
      log.push({ op: "DNLOAD", block: setup.value, length: bytes.length, data: Uint8Array.from(bytes) });
      if (version === 0x011a) {
        if (bytes.length === 0) {
          state = STATE.MANIFEST_SYNC;
          return;
        }
        if (setup.value === 0 && bytes[0] === 0x21) pointer = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(1, true);
        state = STATE.DNLOAD_SYNC;
        return;
      }
      if (bytes.length === 0) {
        if (state !== STATE.DNLOAD_IDLE) {
          status = 0x0f;
          state = STATE.ERROR;
          return;
        }
        state = STATE.MANIFEST_SYNC;
        return;
      }
      if ((state !== STATE.IDLE && state !== STATE.DNLOAD_IDLE) || setup.value !== nextBlock) {
        status = 0x0f;
        state = STATE.ERROR;
        return;
      }
      stored.push(Buffer.from(bytes));
      nextBlock += 1;
      state = STATE.DNLOAD_SYNC;
    },
    async reset() {
      resets.push(true);
      // `true`: the device left the bus while resetting (the usual DFU result).
      // "stays": the browser rejected the reset and the device is still attached
      // (Chromium on Windows reports a failure for every reset).
      if (resetFails === "stays") throw new Error("NetworkError: Unable to reset the device.");
      if (resetFails) {
        gone = true;
        onDeparture();
        throw new Error("NetworkError: the device was disconnected");
      }
      if (resetLeaves) {
        // The reset completed, and the device re-enumerates right after it.
        gone = true;
        onDeparture();
      }
    },
    /** What the browser bridge observes after a failed reset: false proves the device left. */
    connected() { return !gone; },
  };

  return {
    transport,
    log,
    resets,
    alternateName,
    get firmware() { return held; },
    get pointer() { return pointer; },
    get left() { return left; },
    get state() { return state; },
  };
}
