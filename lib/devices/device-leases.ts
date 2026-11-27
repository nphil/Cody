/** Page-global ownership for browser-granted hardware. Browser permission is a
 * tab capability, but an attached agent session may operate a device only while
 * it owns the lease. This makes accidental cross-session access impossible
 * even if both session sockets are still alive.
 *
 * A reservation outlives its owner while the browser still owes an answer. A
 * native `open()` or `claimInterface()` cannot be cancelled: when the owner
 * stops waiting (Cancel, a deadline, a lost host) the device stays reserved —
 * quarantined — until the browser answers, so two attempts never overlap and
 * a late answer cannot land on a newer reservation. A new USB handle
 * (`generation`) supersedes whatever was reserved on the old one. */

/** What the browser is doing for a holder, or was doing when its owner stopped waiting for it. The next caller refused by that holder is told exactly this. */
export interface DeviceHoldNote {
  /** The native step in plain words: "opening the device", "claiming interface 0". */
  step?: string;
  /** When that step began (epoch ms). */
  since?: number;
  /** Set once the owner stopped waiting for the step: when, and why. */
  abandoned?: { at: number; reason: string };
}

/** Why a reservation was refused. `since` is epoch ms: when the operation took the device, or, for an unresolved claim, when the unanswered browser step began. */
export interface DeviceBusy {
  held: "operation" | "unresolved-claim";
  since?: number;
}

export type DeviceBusyError = Error & { busy: DeviceBusy };

/** The exclusive right to use one device, held by one caller at a time. */
export interface DeviceReservation {
  /** The native handle this reservation works on (see `UsbEntry.generation`); 0 for devices without one. */
  readonly generation: number;
  /** The owner is done. The device is free once the browser has also answered everything `track`ed. Calling it again does nothing. */
  release(): void;
  /** Keep the device reserved until this native call has settled, whatever its owner does meanwhile. Returns the same promise. */
  track<T>(native: Promise<T>): Promise<T>;
  /** Record what the browser is doing for this reservation. A new `step` starts a fresh note (an earlier step's `abandoned` mark does not carry over). */
  note(update: DeviceHoldNote): void;
}

export type DeviceBorrowLease = DeviceReservation;
export type DeviceRawLease = DeviceReservation;

interface Holder {
  readonly kind: "raw" | "borrow";
  readonly generation: number;
  readonly startedAt: number;
  ownerDone: boolean;
  /** Native calls the browser has not answered yet. */
  pending: number;
  note: DeviceHoldNote;
}

interface LeaseState {
  ownerSessionId: string;
  holder: Holder | null;
}

/** Use the actual browser object too: a regrant may return it under a new Cody device id. */
type NativeHandle = { generation: number; device: object };

function seconds(since: number): string {
  return `${Math.max(0, Math.round((Date.now() - since) / 1000))} s`;
}

function busyError(deviceId: string, holder: Holder): DeviceBusyError {
  if (!holder.ownerDone) {
    const activity = holder.kind === "borrow" ? "hardware operation" : "raw device request";
    return Object.assign(new Error(`Device ${deviceId} is exclusively reserved by an active ${activity}.`), {
      busy: { held: "operation", since: holder.startedAt } satisfies DeviceBusy,
    });
  }
  const { step, since, abandoned } = holder.note;
  const unanswered = step ? `the browser has not answered "${step}"` : "the browser has not finished its last USB step";
  const stopped = abandoned ? `, which Cody stopped waiting for ${seconds(abandoned.at)} ago (${abandoned.reason})` : "";
  return Object.assign(
    new Error(
      `Device ${deviceId} is exclusively reserved by an unfinished USB step: ${unanswered}${stopped} (USB handle ${holder.generation}). `
      + "Cody keeps the device reserved until the browser answers, so two attempts never overlap and a late answer cannot reach a newer connection; nothing is retried or replayed. "
      + "If it never answers, unplug and reconnect the device, or use Disconnect in Devices and grant it again.",
    ),
    { busy: { held: "unresolved-claim", since: since ?? holder.startedAt } satisfies DeviceBusy },
  );
}

export class DeviceLeaseBook {
  private readonly states = new Map<string, LeaseState>();
  private readonly handles = new WeakMap<object, Set<Holder>>();

  /** Claim an unowned device, or prove that this session already owns it. */
  claim(sessionId: string, deviceId: string): void {
    const state = this.states.get(deviceId);
    if (!state) {
      this.states.set(deviceId, { ownerSessionId: sessionId, holder: null });
      return;
    }
    if (state.ownerSessionId !== sessionId) {
      throw new Error(`Device ${deviceId} is in use by another session. Return to its owning session or disconnect it before using it here.`);
    }
  }

  /** Reserve a raw frame synchronously, rejecting instead of queuing behind
   * native transfers. A late native read must never cross into a new lease. */
  claimForRawOperation(sessionId: string, deviceId: string, handle?: NativeHandle): DeviceRawLease {
    return this.reserve(sessionId, deviceId, "raw", handle, false);
  }

  borrow(sessionId: string, deviceId: string, handle?: NativeHandle): DeviceBorrowLease {
    return this.reserve(sessionId, deviceId, "borrow", handle, false);
  }

  /** The panel's Disconnect. Forgetting a device ends every question about its
   * handle, so browser work an earlier attempt abandoned no longer blocks it;
   * a live operation still does. */
  claimToForget(sessionId: string, deviceId: string, handle?: NativeHandle): DeviceRawLease {
    return this.reserve(sessionId, deviceId, "raw", handle, true);
  }

  private reserve(sessionId: string, deviceId: string, kind: "raw" | "borrow", handle: NativeHandle | undefined, displaceAbandoned: boolean): DeviceReservation {
    this.claim(sessionId, deviceId);
    const state = this.states.get(deviceId);
    if (!state) throw new Error(`Device ${deviceId} has no lease state.`);
    const generation = handle?.generation ?? 0;
    const held = state.holder;
    // A holder on an older handle can only ever touch that dead handle, so a
    // reservation on the current one takes over; the old holder's late end
    // then changes nothing (it frees only itself).
    if (held && held.generation === generation && !(displaceAbandoned && held.ownerDone)) throw busyError(deviceId, held);
    let nativeHolders = handle && this.handles.get(handle.device);
    if (nativeHolders) {
      for (const earlier of nativeHolders) {
        if (!(displaceAbandoned && earlier.ownerDone)) throw busyError(deviceId, earlier);
      }
    } else if (handle) {
      nativeHolders = new Set();
      this.handles.set(handle.device, nativeHolders);
    }
    const holder: Holder = { kind, generation, startedAt: Date.now(), ownerDone: false, pending: 0, note: {} };
    state.holder = holder;
    nativeHolders?.add(holder);
    const free = () => {
      if (!holder.ownerDone || holder.pending !== 0) return;
      if (state.holder === holder) state.holder = null;
      nativeHolders?.delete(holder);
    };
    return {
      generation,
      release: () => {
        if (holder.ownerDone) return;
        holder.ownerDone = true;
        free();
      },
      track: (native) => {
        holder.pending += 1;
        const answered = () => {
          holder.pending -= 1;
          free();
        };
        native.then(answered, answered);
        return native;
      },
      note: (update) => {
        holder.note = update.step === undefined ? { ...holder.note, ...update } : { ...update };
      },
    };
  }

  release(sessionId: string, deviceId: string): void {
    const state = this.states.get(deviceId);
    if (!state || state.ownerSessionId !== sessionId) return;
    if (state.holder) {
      throw new Error(`Device ${deviceId} cannot be released while its ${state.holder.kind === "borrow" ? "hardware operation" : "raw device request"} is still active.`);
    }
    this.states.delete(deviceId);
  }

  releaseGoneDevice(deviceId: string): void {
    this.states.delete(deviceId);
  }

  owns(sessionId: string, deviceId: string): boolean {
    return this.states.get(deviceId)?.ownerSessionId === sessionId;
  }

  isBorrowed(deviceId: string): boolean {
    return this.states.get(deviceId)?.holder?.kind === "borrow";
  }

  sessionOwnsDevices(sessionId: string): boolean {
    for (const state of this.states.values()) {
      if (state.ownerSessionId === sessionId) return true;
    }
    return false;
  }
}
