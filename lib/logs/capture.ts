import type { CDPSession, Page, Protocol } from "puppeteer-core";
import { MAX_STACK_FRAMES, recordAppLog } from "./ring";
import type { AppLogLevel } from "./types";

/**
 * CDP capture of the previewed app's console and failed requests, feeding the
 * bounded ring in ./ring.
 *
 * Attached once per preview Chromium, from the providers in lib/display: both
 * the raster and the H.264 rung drive a real browser, and the capture lives
 * here rather than in either of them so there is exactly one copy of the
 * protocol handling to keep correct.
 *
 * It runs on its OWN CDPSession. Domain state is per-session, so enabling
 * Runtime/Log/Network here cannot disturb the screencast session next door, and
 * detaching cannot switch off a domain the stream depends on.
 */

/** A capture's teardown. Idempotent; safe to call after the page is gone. */
export type AppLogDetach = () => void;

/**
 * console API method -> severity. Methods absent from this table (group
 * bookkeeping, profiling, clear) are structural noise and are dropped outright.
 */
const CONSOLE_LEVEL: Record<string, AppLogLevel> = {
  error: "error",
  assert: "error",
  warning: "warning",
  log: "info",
  info: "info",
  dir: "info",
  dirxml: "info",
  table: "info",
  count: "info",
  timeEnd: "info",
  debug: "debug",
  trace: "debug",
};

const LOG_LEVEL: Record<string, AppLogLevel> = { verbose: "debug", info: "info", warning: "warning", error: "error" };

/** Object-preview properties rendered before giving up and saying "…". */
const MAX_PREVIEW_PROPS = 6;
/**
 * In-flight requests tracked so Network.loadingFailed — which carries a
 * requestId and no URL — can name the thing that failed. Entries are deleted
 * the moment a request resolves either way, so this only ever holds requests
 * still on the wire; the cap covers the pathological case of a page that opens
 * hundreds of streams and never closes them.
 */
const MAX_TRACKED_REQUESTS = 256;
/**
 * V8 retains every console argument so a late-attaching DevTools could inspect
 * it. We copy what we need synchronously and never look at a RemoteObject
 * again, so the stored entries are pure renderer memory — discard them
 * periodically rather than letting a render loop pin thousands of objects.
 */
const DISCARD_CONSOLE_EVERY = 200;

function frames(trace: Protocol.Runtime.StackTrace | undefined): string[] {
  if (!trace) return [];
  return trace.callFrames.slice(0, MAX_STACK_FRAMES).map((frame) => {
    const where = frame.url ? `${frame.url}:${frame.lineNumber + 1}:${frame.columnNumber + 1}` : "<anonymous>";
    return frame.functionName ? `at ${frame.functionName} (${where})` : `at ${where}`;
  });
}

/**
 * An Error's `description` is its message AND its whole stack. Keep the message
 * and the same few frames a structured stack would have given.
 */
function clipStack(description: string): string {
  const lines = description.split("\n");
  const head = lines[0] ?? "";
  const stack = lines.slice(1).filter((line) => line.trimStart().startsWith("at ")).slice(0, MAX_STACK_FRAMES);
  return [head, ...stack.map((line) => line.trim())].join("\n");
}

function preview(object: Protocol.Runtime.ObjectPreview): string {
  const shown = object.properties.slice(0, MAX_PREVIEW_PROPS);
  const overflow = object.overflow || object.properties.length > shown.length ? ", …" : "";
  if (object.subtype === "array") return `[${shown.map((property) => property.value ?? property.type).join(", ")}${overflow}]`;
  const body = shown.map((property) => `${property.name}: ${property.value ?? property.type}`).join(", ");
  const name = object.description && object.description !== "Object" ? `${object.description} ` : "";
  return `${name}{${body}${overflow}}`;
}

/** One console argument as text. Objects arrive by reference, so use their preview. */
function describe(argument: Protocol.Runtime.RemoteObject): string {
  if (argument.type === "string") return typeof argument.value === "string" ? argument.value : "";
  if (argument.type === "undefined") return "undefined";
  if (argument.unserializableValue !== undefined) return argument.unserializableValue;
  if (argument.subtype === "error" && argument.description) return clipStack(argument.description);
  if (argument.value !== undefined) {
    try {
      return JSON.stringify(argument.value) ?? String(argument.value);
    } catch {
      return String(argument.value);
    }
  }
  if (argument.preview) return preview(argument.preview);
  return argument.description ?? argument.className ?? argument.subtype ?? argument.type;
}

/**
 * Starts capture for `page` and returns its teardown. Never rejects: a browser
 * that refuses a domain costs the model its logs, never the user their preview.
 */
export async function attachAppLogCapture(sessionId: string, page: Page): Promise<AppLogDetach> {
  let cdp: CDPSession;
  try {
    cdp = await page.createCDPSession();
  } catch {
    return () => { /* nothing was attached */ };
  }
  /** requestId -> URL, for the failure events that carry only the id. */
  const inFlight = new Map<string, string>();
  let consoleEvents = 0;
  let detached = false;

  const discardIfDue = (): void => {
    consoleEvents += 1;
    if (consoleEvents % DISCARD_CONSOLE_EVERY !== 0) return;
    void cdp.send("Runtime.discardConsoleEntries").catch(() => { /* best-effort hygiene */ });
  };

  cdp.on("Runtime.exceptionThrown", (event) => {
    const details = event.exceptionDetails;
    const description = details.exception?.description ?? (details.exception?.value !== undefined ? String(details.exception.value) : "");
    // `text` is the wrapper Chromium puts on it ("Uncaught", "Uncaught (in
    // promise)"); the description carries the class and message.
    const head = [details.text, description.split("\n")[0]].filter(Boolean).join(" ");
    const stack = frames(details.stackTrace);
    recordAppLog(sessionId, {
      level: "error",
      source: "exception",
      text: [head, ...stack].join("\n"),
      url: details.url ?? "",
    });
    discardIfDue();
  });

  cdp.on("Runtime.consoleAPICalled", (event) => {
    const level = CONSOLE_LEVEL[event.type];
    if (!level) return;
    const message = event.args.map(describe).filter((part) => part !== "").join(" ");
    // Only errors carry a stack. It is what turns "cannot read length of
    // undefined", logged 5000 times, into a callsite — and dedupe keys on the
    // text, so the identical stack collapses with the identical message.
    const stack = level === "error" && !message.includes("\n    at ") ? frames(event.stackTrace) : [];
    recordAppLog(sessionId, {
      level,
      source: "console",
      text: [message, ...stack].join("\n"),
      url: event.stackTrace?.callFrames[0]?.url ?? "",
    });
    discardIfDue();
  });

  cdp.on("Log.entryAdded", (event) => {
    const entry = event.entry;
    // Network problems arrive with a status code and a URL on the Network
    // domain below; the Log domain's prose version of the same 404 would be a
    // second entry saying less.
    if (entry.source === "network") return;
    const level = LOG_LEVEL[entry.level];
    if (!level) return;
    const stack = level === "error" ? frames(entry.stackTrace) : [];
    recordAppLog(sessionId, {
      level,
      source: "browser",
      text: [`${entry.source}: ${entry.text}`, ...stack].join("\n"),
      url: entry.url ?? "",
    });
  });

  cdp.on("Network.requestWillBeSent", (event) => {
    inFlight.set(event.requestId, event.request.url);
    while (inFlight.size > MAX_TRACKED_REQUESTS) inFlight.delete(inFlight.keys().next().value as string);
  });

  cdp.on("Network.responseReceived", (event) => {
    inFlight.delete(event.requestId);
    const status = event.response.status;
    if (status < 400) return;
    const detail = event.response.statusText ? ` ${event.response.statusText}` : "";
    recordAppLog(sessionId, {
      // A 4xx is usually a missing asset or a bad call the app survives; a 5xx
      // is the dev server itself failing, which is what the model is here for.
      level: status >= 500 ? "error" : "warning",
      source: "network",
      text: `HTTP ${status}${detail} (${event.type})`,
      url: event.response.url,
      // No `at`: the ring stamps arrival. CDP mixes units across these domains
      // — Runtime timestamps are epoch ms while Network ones are MonotonicTime
      // seconds from an arbitrary origin — and an event handled synchronously
      // over a local pipe is already within a millisecond of now.
    });
  });

  cdp.on("Network.loadingFailed", (event) => {
    const url = inFlight.get(event.requestId) ?? "";
    inFlight.delete(event.requestId);
    // An aborted request is routine — a navigation away, an AbortController, a
    // cancelled preload. Only genuine failures are worth a line.
    if (event.canceled) return;
    // A request the client itself refused (CSP, mixed content, an extension)
    // arrives with an EMPTY errorText and the reason in `blockedReason`, so
    // reading only errorText yields "Request failed:  (Image)" — measured, not
    // hypothetical.
    const reason = event.errorText || (event.blockedReason ? `blocked by ${event.blockedReason}` : "blocked by the browser");
    recordAppLog(sessionId, {
      level: "error",
      source: "network",
      text: `Request failed: ${reason} (${event.type})`,
      url,
    });
  });

  try {
    await Promise.all([
      cdp.send("Runtime.enable"),
      cdp.send("Log.enable"),
      // We never read a response body, so ask Chromium to keep none: the
      // buffers exist only to serve Network.getResponseBody later.
      cdp.send("Network.enable", { maxTotalBufferSize: 0, maxResourceBufferSize: 0 }),
    ]);
  } catch {
    // Partial enable is still useful — whichever domains came up keep feeding
    // the ring — so fall through to the detach handle either way.
  }

  return () => {
    if (detached) return;
    detached = true;
    inFlight.clear();
    cdp.removeAllListeners();
    void cdp.detach().catch(() => { /* the page usually went first */ });
  };
}
