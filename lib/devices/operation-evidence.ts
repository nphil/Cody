/**
 * What an operation can say about itself while it is stuck and after it stopped: who asked it to stop and when, what it is
 * waiting for, which attempt to take the device it belongs to, and what it handed to the device. The page builds these
 * (./operations.ts) and every reader words them here - the agent's status text and the Devices panel - so they say the same
 * thing and none of them says more than the evidence shows.
 *
 * The rule for the wording: a count is only ever a count of what the transport was asked to carry. "Nothing was sent" is
 * said only when the connection was held and nothing was started on it, or when it was never held; a write that was still
 * running when the operation stopped, or that failed without proof, is "unknown", never zero and never "sent".
 */

/** Who asked an operation to stop. A stop the system made (anything but the person or the agent) also becomes the operation's `error`. */
export type CancellationSource = "user" | "agent" | "device-left" | "device-forgotten" | "trust-withdrawn" | "host-authority";

export interface OperationCancelCause {
  source: CancellationSource;
  /** What the person reads. The words for the person and the agent are filled in when none is given. */
  reason?: string;
}

export interface OperationCancellation {
  /** When the stop was asked for, on the page's clock. The first request is the one kept. */
  at: number;
  source: CancellationSource;
  reason: string;
  /** What the operation was doing at that moment. */
  stage?: OperationStageName;
}

export type OperationStageName = "waiting-for-trust" | "preparing" | "acquiring" | "approval" | "countdown" | "running";

export interface OperationStage {
  name: OperationStageName;
  /** When the operation entered the stage, on the page's clock. */
  since: number;
  /** What it is waiting for, when it waits instead of working. */
  waitingFor?: "person" | "browser" | "operation" | "device" | "time";
  /** The operation it is queued behind (`waitingFor` "operation"). */
  operationId?: string;
}

/**
 * "quarantined": the operation stopped waiting, but the browser has not reported that the native open or claim ended.
 * "failed": the browser's attempt to open the device ended with an error.
 */
export type OperationLeaseState = "acquiring" | "held" | "quarantined" | "released" | "failed";

/** What the transport was asked to carry over the connections an operation held. */
export interface OperationSent {
  /** Requests the transport confirmed (writes, control-out transfers, resets, line settings) and the data bytes in them. Raw transfer bytes: commands and headers count; the size of a file does not. */
  confirmed: { requests: number; bytes: number };
  /** Requests that were still running, or failed without proof they were not sent: whether the device received them is unknown. */
  unconfirmed: { requests: number; bytes: number };
  /** The protocol also reaches the device by a route that cannot be counted (it writes to the serial port itself), so the totals are a minimum. */
  incomplete?: true;
  /** The connection is shared with other operations, so the totals cover all of them. */
  shared?: true;
}

export interface OperationLease {
  /** This page's count of attempts to take a device's connection; it only grows, and a new page starts again from 1. */
  generation: number;
  /** The page (its operation manager) that made the attempt. It changes when the page reloads. */
  host: string;
  state: OperationLeaseState;
  /** When the state last changed. */
  since: number;
  /** When this evidence was read, so a copy kept elsewhere says how old it is. */
  at: number;
  /** The step the browser last reported while opening the device ("claiming interface 0"). Only a provider that reports its steps gives one. */
  step?: string;
  /** The browser's own number for the native handle, when the provider reports it. */
  nativeGeneration?: number;
  /** The browser had not finished opening the device when the stall time passed. */
  stalled?: true;
  /** Absent while the operation has never held a connection. */
  sent?: OperationSent;
}

/** The part of a snapshot the evidence lives in. */
export interface EvidenceSource {
  state: string;
  cancellation?: OperationCancellation;
  stage?: OperationStage;
  lease?: OperationLease;
}

/** A person or an agent asked; everything else is the system cancelling for a reason of its own. */
export function isSystemCancel(source: CancellationSource): boolean {
  return source !== "user" && source !== "agent";
}

export function defaultCancelReason(source: CancellationSource): string {
  switch (source) {
    case "user": return "Cancelled by the person in the Devices panel.";
    case "agent": return "Cancelled by the agent.";
    case "device-left": return "The device left the USB bus, so this operation was cancelled.";
    case "device-forgotten": return "The device was disconnected, so this operation was cancelled.";
    case "trust-withdrawn": return "The agent's control of this device was withdrawn, so this operation was cancelled.";
    case "host-authority": return "This browser page no longer owns the session hardware authority.";
  }
}

export const STUCK_CLAIM_RECOVERY =
  "To recover: cancel the operation if it is still waiting. Unplug the USB cable and plug it back in, or disconnect the device in Cody's Devices panel and grant it again. Close any other app or tab holding the device. If it still cannot connect, reload the Cody page. Verify what reached the device before starting a new write; Cody does not replay one.";

const SOURCE_TEXT: Record<CancellationSource, string> = {
  user: "the person (Cancel in the Devices panel)",
  agent: "the agent (device_operation_cancel or a port-rule removal)",
  "device-left": "the browser reporting that the device left the USB bus",
  "device-forgotten": "the person disconnecting the device in the Devices panel",
  "trust-withdrawn": "the person withdrawing the agent's control of the device",
  "host-authority": "this browser page losing its hardware authority (another page took over, or this page closed its device connection)",
};

const STAGE_TEXT: Record<OperationStageName, string> = {
  "waiting-for-trust": "waiting for the person to answer the trust question",
  preparing: "preparing",
  acquiring: "taking the device connection",
  approval: "waiting for the person's approval of the exact write",
  countdown: "counting down before it sends",
  running: "working with the device",
};

const WAIT_TEXT: Record<NonNullable<OperationStage["waitingFor"]>, string> = {
  person: "the person",
  browser: "the browser to open the device",
  operation: "another operation",
  device: "the device to appear on the USB bus",
  time: "the countdown to end",
};

export function isoTime(at: number): string {
  return new Date(at).toISOString().replace(/\.\d{3}Z$/, "Z");
}

const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** What the operation is doing or waiting for, in one sentence: "waiting" and "working" are told apart, and a queue behind another operation is not a stuck claim. */
export function describeStage(stage: OperationStage): string {
  const what = STAGE_TEXT[stage.name];
  if (!stage.waitingFor) return `${what}; it is working, not waiting on anything`;
  if (stage.waitingFor === "operation") {
    return stage.operationId
      ? `${what}; waiting behind operation ${stage.operationId}, which is opening or using this device's connection`
      : `${what}; waiting behind another operation that is opening or using this device's connection`;
  }
  return `${what}; waiting for ${WAIT_TEXT[stage.waitingFor]}`;
}

function describeLease(lease: OperationLease, format: (at: number) => string): string {
  const native = lease.nativeGeneration === undefined ? "" : `, browser handle generation ${lease.nativeGeneration}`;
  const who = `attempt ${lease.generation} on page ${lease.host}${native}`;
  const step = lease.step ? ` (the last step the browser reported: ${lease.step})` : "";
  switch (lease.state) {
    case "acquiring":
      return `Device connection, ${who}: being opened since ${format(lease.since)}${step}${lease.stalled ? ". The browser has not finished opening it, which looks stuck" : ""}.`;
    case "held":
      return `Device connection, ${who}: held since ${format(lease.since)}.`;
    case "quarantined":
      return `Device connection, ${who}: given up on at ${format(lease.since)}${step}. The browser has not confirmed that it finished opening or releasing this connection. Cody will not use it; late cleanup applies only to that connection.`;
    case "released":
      return `Device connection, ${who}: given back to the browser at ${format(lease.since)}.`;
    case "failed":
      return `Device connection, ${who}: the browser could not open it${step} (ended ${format(lease.since)}).`;
  }
}

function describeSent(lease: OperationLease, format: (at: number) => string): string {
  const { sent } = lease;
  const asOf = ` (as last reported by the browser at ${format(lease.at)})`;
  if (!sent) return `This operation sent nothing: it never took the device connection${asOf}.`;
  const { confirmed, unconfirmed } = sent;
  if (confirmed.requests === 0 && unconfirmed.requests === 0 && !sent.incomplete) {
    return `No outgoing requests were recorded${sent.shared ? " on the shared connection" : " for this operation"}${asOf}.`;
  }
  const parts = [`Transport${asOf}: ${count(confirmed.requests, "successful outgoing request")} (${count(confirmed.bytes, "byte")} submitted, including commands and headers; not a file size or proof of what changed on the device).`];
  if (unconfirmed.requests > 0) parts.push(`${count(unconfirmed.requests, "further request")} (${count(unconfirmed.bytes, "byte")}) started but not confirmed: whether the device received them is unknown.`);
  if (sent.incomplete) parts.push("This protocol also writes to the device in a way Cody cannot count, so these totals are a minimum.");
  if (sent.shared) parts.push("The connection is shared with other operations, so the totals cover all of them.");
  return parts.join(" ");
}

/**
 * The evidence lines for a snapshot: the stop request with its source and time, the stage, the device connection and what
 * went over it, and - when the browser's open or claim is stuck - how to recover. Empty when the snapshot carries none.
 * `format` words a time (the panel passes its own; the default is UTC).
 */
export function describeEvidence(snapshot: EvidenceSource, format: (at: number) => string = isoTime): string[] {
  const lines: string[] = [];
  const { cancellation, stage, lease } = snapshot;
  const finished = snapshot.state === "succeeded" || snapshot.state === "failed" || snapshot.state === "cancelled";
  if (cancellation) {
    const doing = cancellation.stage ? ` while it was ${STAGE_TEXT[cancellation.stage]}` : "";
    lines.push(`Stop requested at ${format(cancellation.at)} by ${SOURCE_TEXT[cancellation.source]}${doing}: ${cancellation.reason}`);
  }
  if (stage && !finished) lines.push(`Stage since ${format(stage.since)}: ${describeStage(stage)}.`);
  if (lease) {
    lines.push(describeLease(lease, format), describeSent(lease, format));
    if (lease.state === "quarantined" || (lease.state === "acquiring" && lease.stalled)) lines.push(STUCK_CLAIM_RECOVERY);
  }
  return lines;
}
