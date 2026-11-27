/**
 * Browser USB calls that cannot be cancelled, made cancellable for whoever is
 * waiting on them without pretending they stopped.
 *
 * `USBDevice.open()`, `selectConfiguration()`, `claimInterface()` and
 * `close()` have no abort primitive: once started they end only when the
 * browser answers, which can take very long (or, with another program holding
 * the device, never). So a step here is run for its caller, who may stop
 * waiting at any time and is then told at once, while the device stays
 * reserved — quarantined — until the browser answers. Whatever the late
 * answer produced (an opened device) is then closed by whoever started it, on
 * the exact native handle it started with.
 */
import type { DeviceReservation } from "./device-leases";
import { pause } from "./pause";

/** Reported on entering each browser step of an acquisition. */
export interface AcquisitionProgress {
  /** The step in plain words: "opening the device", "claiming interface 0". */
  step: string;
  /** The native handle the step runs on (`HardwareTransportLease.generation`). */
  generation?: number;
}

/** One browser call: named, abortable by its caller, tracked by the reservation. */
export type NativeCall = <T>(step: string, call: () => Promise<T>) => Promise<T>;

export function cancelledError(message = "The device operation was cancelled."): DOMException {
  return new DOMException(message, "AbortError");
}

/** What a rejection caused by `signal` is: an `AbortError` that carries the reason. */
export function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error && reason.name === "AbortError") return reason;
  const text = typeof reason === "string" ? reason : reason instanceof Error ? reason.message : "";
  return Object.assign(cancelledError(text ? `The device operation was cancelled: ${text}` : undefined), { cause: reason });
}

function reasonText(reason: unknown): string {
  if (typeof reason === "string" && reason) return reason;
  if (reason instanceof Error && reason.message) return reason.message;
  return "cancelled";
}

/** Rejects as soon as `signal` aborts, whatever `promise` is still doing; `promise` itself is left to settle (it is never left unhandled). */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined, onAbort?: () => void): Promise<T> {
  if (!signal) return promise;
  const { promise: outcome, resolve, reject } = Promise.withResolvers<T>();
  const abort = () => {
    onAbort?.();
    reject(abortError(signal));
  };
  if (signal.aborted) {
    promise.catch(() => {});
    abort();
    return outcome;
  }
  signal.addEventListener("abort", abort, { once: true });
  promise.then(
    (value) => {
      signal.removeEventListener("abort", abort);
      resolve(value);
    },
    (error: unknown) => {
      signal.removeEventListener("abort", abort);
      reject(error);
    },
  );
  return outcome;
}

export const usbAcquisitionLimits = { rawOpenMs: 15_000, closeGraceMs: 2_000 };

/** Waits for `promise` to settle, but no longer than `ms`. Never rejects. */
export async function settleWithin(promise: Promise<unknown>, ms: number): Promise<void> {
  const stop = new AbortController();
  try {
    await Promise.race([promise.then(() => undefined, () => undefined), pause(ms, stop.signal).catch(() => undefined)]);
  } finally {
    stop.abort();
  }
}

/**
 * The browser steps of one reservation. `run` starts a step only while the
 * reservation is still wanted (`stillWanted` throws when it is not), hands the
 * promise to the reservation so the device stays reserved until the browser
 * answers, and lets the caller stop waiting through its own signal.
 */
export class NativeSteps {
  private readonly inFlight = new Set<Promise<void>>();
  private latest: string | undefined;

  constructor(
    private readonly reservation: DeviceReservation,
    /** Throws when the reservation ended or its native handle was replaced: no new step may start then. */
    private readonly stillWanted: () => void,
    private readonly onProgress?: (progress: AcquisitionProgress) => void,
  ) {}

  /** `run` for one caller's signal. */
  within(signal: AbortSignal | undefined): NativeCall {
    return (step, call) => this.run(step, call, signal);
  }

  /** The step started last, for messages about a step the browser has not answered. */
  get step(): string | undefined {
    return this.latest;
  }

  run<T>(step: string, call: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(abortError(signal));
    try {
      this.stillWanted();
    } catch (error) {
      return Promise.reject(error);
    }
    this.latest = step;
    this.reservation.note({ step, since: Date.now() });
    let native: Promise<T>;
    try {
      native = call();
    } catch (error) {
      native = Promise.reject(error);
    }
    this.reservation.track(native);
    const answered = native.then(() => undefined, () => undefined);
    this.inFlight.add(answered);
    void answered.then(() => this.inFlight.delete(answered));
    try {
      this.onProgress?.({ step, generation: this.reservation.generation });
    } catch {
      // A progress listener must not be able to fail the step it observes.
    }
    return abortable(native, signal, () => this.reservation.note({ abandoned: { at: Date.now(), reason: reasonText(signal?.reason) } }));
  }

  /** Settles once every step started so far has been answered by the browser, successfully or not. Never rejects. */
  settled(): Promise<void> {
    return Promise.all(this.inFlight).then(() => undefined);
  }
}

/** What a browser rejection looked like, kept so nothing about it is lost. */
function describeRejection(cause: unknown): { name: string; message: string } {
  if (cause instanceof Error) return { name: cause.name, message: cause.message };
  return { name: "Error", message: String(cause) };
}

const CLAIM_GUIDANCE = "Cody made one attempt and will not retry on its own. "
  + "Another program or driver may hold this interface, or the operating system may refuse access to it: "
  + "another Cody tab or window, a program using the device (`adb kill-server` stops the local ADB server), or, on Windows, a driver other than WinUSB. "
  + "Close what holds it, then start the operation again. "
  + "If it still fails, unplug and reconnect the device, or use Disconnect in Devices and grant it again.";

/** Where a refused claim happened. */
export interface UsbClaimTarget {
  interfaceNumber: number;
  /** The alternate setting asked for, else the one the descriptor shows. */
  alternateSetting?: number;
  classCode?: number;
  subclassCode?: number;
  protocolCode?: number;
}

const hex = (value: number) => value.toString(16).padStart(2, "0");

/**
 * `claimInterface()` was refused. It keeps the browser's own exception — its
 * `name` (`NetworkError`, `SecurityError`, …) and original message, with the
 * exception itself as `cause` — and adds which interface, alternate and class
 * were being claimed and what to do next.
 */
export class UsbInterfaceClaimError extends Error {
  readonly interfaceNumber: number;
  readonly alternateSetting: number | undefined;
  /** The browser's exception name, also this error's `name`. */
  readonly originalName: string;
  /** The browser's own message. */
  readonly originalMessage: string;

  constructor(target: UsbClaimTarget, cause: unknown) {
    const original = describeRejection(cause);
    const details = [
      target.alternateSetting === undefined ? "" : `alternate ${target.alternateSetting}`,
      target.classCode === undefined ? "" : `class ${hex(target.classCode)}/${hex(target.subclassCode ?? 0)}/${hex(target.protocolCode ?? 0)}`,
    ].filter(Boolean).join(", ");
    super(
      `${original.message.replace(/[.\s]+$/, "") || original.name}. `
      + `Cody could not claim USB interface ${target.interfaceNumber}${details ? ` (${details})` : ""}; the browser reported ${original.name}. ${CLAIM_GUIDANCE}`,
      { cause },
    );
    this.name = original.name;
    this.interfaceNumber = target.interfaceNumber;
    this.alternateSetting = target.alternateSetting;
    this.originalName = original.name;
    this.originalMessage = original.message;
  }
}
