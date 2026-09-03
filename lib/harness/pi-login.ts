import { spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { isRecord } from "../type-guards";
import { findPiPackageRoot } from "./pi-settings";
import { engineChildEnv } from "./provider-keys";
import type { ProviderLoginList, ProviderLoginOption, ProviderLoginSurface, ProviderLoginUi } from "./types";

/**
 * Provider sign-in for the pi engine.
 *
 * Pi has no login command — the flow exists only inside its TUI, which calls
 * `AuthStorage.login(providerId, callbacks)` out of the installed
 * `@mariozechner/pi-coding-agent` package. Cody therefore runs pi's OWN code
 * in a child process (`bin/cody-pi-login.mjs`, which is where the callback
 * contract is documented) and bridges its JSON lines to `ProviderLoginUi`.
 * The credential is written by pi's writer into pi's `auth.json`; Cody never
 * sees a token.
 *
 * A child rather than an import: pi's OAuth modules raise a local callback
 * server on a fixed port and, for the callback-server providers, have no
 * cancel of their own — pi-ai forwards `signal` to the device flow only. So
 * `ui.signal` is honoured the only way it can be, by killing the child.
 *
 * Everything here fails soft in the one place the UI asks a question it can
 * live without an answer to: `list()` never throws — no pi, no package,
 * a helper that died — it answers `{providers: [], reason}` in pi's own
 * terms. `login()` and `logout()` reject, because a sign-in that silently
 * did nothing is worse than an error.
 */

/** How the surface finds the two moving parts. The adapter supplies them so
 * pi installed (or moved) after boot is picked up without a restart, and so
 * the agent dir is the one lib/harness/pi.ts resolves rather than a second
 * guess at it. */
export interface PiLoginDeps {
  /** Absolute path of the installed `pi` binary, or null when there is none. */
  resolveBinary(): string | null;
  /** Pi's agent dir — where its auth.json lives. */
  agentDir(): string;
  /** The helper script; defaults to Cody's own `bin/cody-pi-login.mjs`. */
  scriptPath?(): string;
  /** Walk from the binary to the installed package; defaults to the pi one. */
  findPackageRoot?(binaryPath: string): string | null;
}

/** Reading a provider list is a local file read plus a module load. */
const LIST_TIMEOUT_MS = 30_000;
/** A sign-out is a file write. */
const LOGOUT_TIMEOUT_MS = 30_000;
/** A login sits idle while the user is in a browser; this is the ceiling
 * before Cody stops holding a child open for a flow nobody finished. */
const LOGIN_TIMEOUT_MS = 15 * 60_000;
/** SIGTERM, then SIGKILL for a child that ignored it. */
const KILL_GRACE_MS = 2_000;
/** How much of a failed helper's stderr rides into the error message. */
const STDERR_LIMIT = 400;
/**
 * Ceiling on how many times the driver renews its watch for an unprompted
 * paste. One flow needs one or two; the cap is only so a UI whose channel
 * resolves instantly cannot spin.
 */
const MAX_MANUAL_VALUES = 20;

/** "Enter code: ABCD-1234" — how pi-ai's device flow (GitHub Copilot) smuggles
 * a user code through `onAuth`'s free-text instructions. The URL flows on
 * regardless; this only decides whether a device-code panel is shown too. */
const DEVICE_CODE_RE = /(?:^|\s)code:?\s+([A-Za-z0-9][A-Za-z0-9_-]{3,})/i;

function defaultScriptPath(): string {
  // Same resolution as the display MCP bridge (lib/display/engine-tools.ts):
  // the packaged app sets CODY_PACKAGE_DIR, a source checkout runs from its
  // own root.
  return path.join(process.env.CODY_PACKAGE_DIR || process.cwd(), "bin", "cody-pi-login.mjs");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The tail of a helper's stderr, which is where a Node crash puts its cause. */
function stderrTail(stderr: string): string {
  const text = stderr.trim();
  if (!text) return "";
  return text.length <= STDERR_LIMIT ? text : `…${text.slice(-STDERR_LIMIT)}`;
}

function parseFrame(line: string): Record<string, unknown> | null {
  const text = line.trim();
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    // Not a protocol line: something under pi wrote to stdout. Ignored rather
    // than fatal — the helper's own frames are still coming.
    return null;
  }
}

function frameString(frame: Record<string, unknown>, key: string): string | null {
  const value = frame[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * One provider row, from the facts the helper read out of pi.
 *
 * `kind` comes from pi-ai's own `usesCallbackServer`: the providers that
 * raise a local callback server are the ones whose fallback is pasting the
 * redirect URL ("oauth"); the one that does not is the device-code flow
 * ("device"). Cody does not second-guess that per provider id.
 */
function toOption(raw: unknown): ProviderLoginOption | null {
  if (!isRecord(raw)) return null;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!id) return null;
  const hint = typeof raw.hint === "string" && raw.hint ? raw.hint : null;
  return {
    id,
    name: typeof raw.name === "string" && raw.name ? raw.name : id,
    authenticated: raw.authenticated === true,
    kind: raw.usesCallbackServer === false ? "device" : "oauth",
    // Pi stores every credential as one key of auth.json and removes it with
    // one call, so a sign-out is always available.
    canLogout: true,
    ...(hint ? { hint } : {}),
  };
}

interface ResolvedHelper {
  packageRoot: string;
  script: string;
  env: NodeJS.ProcessEnv;
}

/** Why the helper cannot run, in pi's terms, or the pieces needed to run it. */
function resolveHelper(deps: PiLoginDeps): ResolvedHelper | { reason: string } {
  const binary = deps.resolveBinary();
  if (!binary) {
    return { reason: "Pi is not installed, so Cody cannot sign in to a provider with it." };
  }
  const packageRoot = (deps.findPackageRoot ?? findPiPackageRoot)(binary);
  if (!packageRoot) {
    return { reason: `Cody could not find the installed @mariozechner/pi-coding-agent package above ${binary}.` };
  }
  return {
    packageRoot,
    script: (deps.scriptPath ?? defaultScriptPath)(),
    // The same environment a pi chat session runs with (Cody's stored
    // provider keys included), plus the two facts the helper must not guess:
    // which package to load pi from, and which agent dir holds its auth.json.
    env: engineChildEnv({
      CODY_PI_PACKAGE_ROOT: packageRoot,
      PI_CODING_AGENT_DIR: deps.agentDir(),
    }),
  };
}

function spawnHelper(helper: ResolvedHelper, args: string[]): ChildProcess {
  return spawn(process.execPath, [helper.script, ...args], {
    env: helper.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/** SIGTERM now, SIGKILL if the child is still there after the grace period. */
function killChild(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill();
  } catch {
    // Already gone.
  }
  const timer = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }, KILL_GRACE_MS);
  timer.unref();
}

interface CollectedRun {
  frames: Array<Record<string, unknown>>;
  stderr: string;
  code: number | null;
}

/** Run the helper to completion and hand back everything it said. Used for
 * the two one-shot commands; the login flow streams instead. */
function collect(helper: ResolvedHelper, args: string[], timeoutMs: number): Promise<CollectedRun> {
  return new Promise<CollectedRun>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawnHelper(helper, args);
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    const frames: Array<Record<string, unknown>> = [];
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killChild(child);
      reject(new Error(`Pi's sign-in helper did not answer within ${Math.round(timeoutMs / 1000)}s.`));
    }, timeoutMs);

    if (child.stdout) {
      const reader = createInterface({ input: child.stdout });
      reader.on("line", (line) => {
        const frame = parseFrame(line);
        if (frame) frames.push(frame);
      });
    }
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += String(chunk);
      if (stderr.length > 8_000) stderr = stderr.slice(-8_000);
    });
    // Nothing to say to a one-shot command; closing stdin also tells the
    // helper that no input is coming.
    child.stdin?.end();

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ frames, stderr, code });
    });
  });
}

/** The helper's own words for a run that produced no usable answer. */
function failureReason(run: CollectedRun, fallback: string): string {
  const failure = run.frames.find((frame) => frame.type === "error");
  const message = failure ? frameString(failure, "message") : null;
  if (message) return message;
  const tail = stderrTail(run.stderr);
  return tail ? `${fallback} ${tail}` : fallback;
}

/**
 * The login itself: stream the helper's frames into the UI, and every value
 * the UI produces back down as an `input` line.
 *
 * The driver holds TWO sources of user values at once — the standing watch
 * for an unprompted paste and, once pi asks, an explicit prompt — because the
 * panel has one paste box and either may be the one it resolves. Which waiter
 * a value was meant for is not decided here: every value is forwarded, and
 * the helper hands it to whichever of pi's callbacks is actually waiting.
 */
function runLogin(helper: ResolvedHelper, providerId: string, ui: ProviderLoginUi): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawnHelper(helper, ["login", providerId]);
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    let settled = false;
    let stderr = "";
    let manualValues = 0;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ui.signal.removeEventListener("abort", onAbort);
      killChild(child);
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => finish(new Error("Login cancelled"));
    const timer = setTimeout(
      () => finish(new Error("The Pi sign-in did not complete in time.")),
      LOGIN_TIMEOUT_MS,
    );
    ui.signal.addEventListener("abort", onAbort);

    const send = (value: string) => {
      if (settled) return;
      try {
        child.stdin?.write(`${JSON.stringify({ type: "input", value })}\n`);
      } catch {
        // The child is gone; its exit is what settles this flow.
      }
    };

    // The paste box is on screen from the first URL, so a redirect URL
    // usually arrives before pi asks for anything. Renewed after each value
    // so a second paste is not dropped; a rejection means the flow was
    // cancelled, which the abort handler already covers.
    const watchManualInput = () => {
      if (settled || manualValues >= MAX_MANUAL_VALUES) return;
      manualValues += 1;
      void ui
        .onManualInput()
        .then((value) => {
          send(value);
          watchManualInput();
        })
        .catch(() => {});
    };

    const handleFrame = (frame: Record<string, unknown>) => {
      switch (frame.type) {
        case "auth": {
          const url = frameString(frame, "url");
          if (!url) return;
          const instructions = frameString(frame, "instructions");
          ui.onUrl(url, instructions);
          // pi-ai's device flow has no device-code callback of its own: it
          // puts the user code in `onAuth`'s instructions. Read it out so the
          // panel can show a code panel rather than a sentence.
          const code = instructions ? DEVICE_CODE_RE.exec(instructions) : null;
          if (code) ui.onDeviceCode({ userCode: code[1], verificationUri: url });
          return;
        }
        case "prompt": {
          const message = frameString(frame, "message") ?? "Enter the authorization code";
          const placeholder = frameString(frame, "placeholder");
          void ui
            .onPrompt(message, placeholder)
            .then(send)
            .catch((error: unknown) => finish(error instanceof Error ? error : new Error(String(error))));
          return;
        }
        case "progress": {
          const message = frameString(frame, "message");
          if (message) ui.onProgress(message);
          return;
        }
        case "done":
          finish();
          return;
        case "error":
          finish(new Error(frameString(frame, "message") ?? "Pi could not complete the sign-in."));
          return;
        default:
      }
    };

    if (child.stdout) {
      const reader = createInterface({ input: child.stdout });
      reader.on("line", (line) => {
        const frame = parseFrame(line);
        if (frame) handleFrame(frame);
      });
    }
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += String(chunk);
      if (stderr.length > 8_000) stderr = stderr.slice(-8_000);
    });

    child.on("error", (error) => finish(error instanceof Error ? error : new Error(String(error))));
    child.on("close", (code) => {
      // A clean exit that never said `done` still failed: the credential was
      // not written, and silence would report success.
      const tail = stderrTail(stderr);
      const detail = tail ? ` ${tail}` : "";
      finish(new Error(`Pi's sign-in helper exited (code ${code ?? "unknown"}) before finishing.${detail}`));
    });

    if (ui.signal.aborted) {
      onAbort();
      return;
    }
    watchManualInput();
  });
}

/**
 * Pi's provider sign-in, as the engine-neutral surface. Attached by
 * lib/harness/pi.ts, which owns the binary and agent-dir resolution the
 * child is handed.
 */
export function createPiProviderLogins(deps: PiLoginDeps): ProviderLoginSurface {
  return {
    async list(): Promise<ProviderLoginList> {
      const helper = resolveHelper(deps);
      if ("reason" in helper) return { providers: [], reason: helper.reason };
      let run: CollectedRun;
      try {
        run = await collect(helper, ["list"], LIST_TIMEOUT_MS);
      } catch (error) {
        return { providers: [], reason: `Cody could not read Pi's sign-in providers: ${errorText(error)}` };
      }
      const listed = run.frames.find((frame) => frame.type === "providers");
      const raw = listed && Array.isArray(listed.providers) ? listed.providers : null;
      if (!raw) {
        return { providers: [], reason: failureReason(run, "Pi listed no sign-in providers.") };
      }
      const providers = raw.map(toOption).filter((option): option is ProviderLoginOption => option !== null);
      return providers.length > 0
        ? { providers }
        : { providers, reason: "This version of Pi registers no OAuth providers." };
    },

    async login(providerId: string, ui: ProviderLoginUi): Promise<void> {
      const helper = resolveHelper(deps);
      if ("reason" in helper) throw new Error(helper.reason);
      await runLogin(helper, providerId, ui);
    },

    async logout(providerId: string): Promise<void> {
      const helper = resolveHelper(deps);
      if ("reason" in helper) throw new Error(helper.reason);
      const run = await collect(helper, ["logout", providerId], LOGOUT_TIMEOUT_MS);
      if (!run.frames.some((frame) => frame.type === "done")) {
        throw new Error(failureReason(run, `Pi did not confirm signing out of ${providerId}.`));
      }
    },
  };
}
