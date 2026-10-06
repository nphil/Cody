import type { ScheduledErrorCode } from "./types";

/**
 * A refusal the person (or the agent) can act on: a stable code for the
 * composer to word in the person's language, an HTTP status for the routes, and
 * a plain English sentence for an agent's tool result.
 */
export class ScheduledError extends Error {
  readonly code: ScheduledErrorCode;
  readonly status: number;

  constructor(code: ScheduledErrorCode, message: string, status = 400) {
    super(message);
    this.name = "ScheduledError";
    this.code = code;
    this.status = status;
  }
}

/**
 * Why a message could not be handed to its chat. `retryable` is the whole
 * point: an engine that ANSWERED and refused will refuse the same words again
 * (retrying only repeats the refusal), while a chat that was restarting, a
 * child that died or a spawn that failed is worth another go. Read with
 * `error.retryable === false`, not `instanceof`: the server holds more than
 * one copy of this module.
 */
export class ScheduledDeliveryError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "ScheduledDeliveryError";
    this.retryable = retryable;
  }
}
