#!/usr/bin/env node
/**
 * Pi's own OAuth login, run OUT of Cody's server process.
 *
 * Pi has no `login` command: its RPC mode never grew one, and the only place
 * the flow exists is the TUI, which drives `AuthStorage.login(providerId,
 * callbacks)` out of the INSTALLED `@mariozechner/pi-coding-agent` package.
 * So Cody runs that same code — pi's, not a reimplementation of it — and the
 * credential lands in pi's own `auth.json`, written by pi's own writer, under
 * pi's own file lock.
 *
 * It runs as a child rather than an import for three reasons. Pi's OAuth
 * modules bind a local callback server on a fixed port and hold it open for
 * the length of a browser round trip; the flow has no cancel of its own for
 * the callback-server providers (pi-ai forwards `signal` for the device flow
 * only), so the only reliable cancel is killing the process; and loading a
 * whole engine's runtime into the Next server to read one JSON file is a
 * memory and failure surface Cody does not need.
 *
 * ## Protocol (one JSON object per line)
 *
 * argv `list`   → `{"type":"providers","providers":[{id,name,authenticated,
 *                  usesCallbackServer,hint?}]}`
 * argv `login <id>` → any number of
 *                  `{"type":"auth","url","instructions"}`
 *                  `{"type":"prompt","message","placeholder"}`
 *                  `{"type":"progress","message"}`
 *                  then exactly one of `{"type":"done"}` /
 *                  `{"type":"error","message"}`
 * argv `logout <id>` → `{"type":"done"}` or `{"type":"error","message"}`
 *
 * stdin carries `{"type":"input","value":"…"}` lines. ONE line answers
 * whichever waiter is outstanding: an open `prompt` first, then pi's
 * `onManualCodeInput` (the unprompted paste the callback-server providers
 * race their local server against). With neither waiting the value is held
 * for the next asker — a redirect URL usually arrives before pi asks for it.
 * That routing lives here, on purpose: the parent has two UI callbacks
 * feeding one paste box and cannot know which of them pi is waiting on.
 *
 * The pi package root arrives as CODY_PI_PACKAGE_ROOT, and pi's agent dir as
 * PI_CODING_AGENT_DIR — both resolved by the adapter, never guessed here.
 */

import { createInterface } from "node:readline";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** stdout is the protocol. Anything pi's modules log goes to stderr instead,
 * where the parent keeps it for diagnostics, so one stray console.log cannot
 * corrupt a frame. */
console.log = (...args) => console.error(...args);
console.info = console.log;
console.debug = console.log;

function emit(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

/** Values the user sent, and who is waiting for one. */
const held = [];
let pendingPrompt = null;
let pendingManual = null;

function deliver(value) {
  // A prompt is pi asking a question right now; the manual watch is the
  // standing offer to paste. The question wins.
  if (pendingPrompt) {
    const resolve = pendingPrompt;
    pendingPrompt = null;
    resolve(value);
    return;
  }
  if (pendingManual) {
    const resolve = pendingManual;
    pendingManual = null;
    resolve(value);
    return;
  }
  held.push(value);
}

/** Ask, unless a value the user already pasted is waiting — then answer with
 * that and never show the question. */
function askPrompt(prompt) {
  if (held.length > 0) return Promise.resolve(held.shift());
  emit({
    type: "prompt",
    message: typeof prompt?.message === "string" ? prompt.message : "Enter the authorization code",
    placeholder: typeof prompt?.placeholder === "string" ? prompt.placeholder : null,
  });
  return new Promise((resolve) => {
    pendingPrompt = resolve;
  });
}

/** pi's `onManualCodeInput`: resolves with the next value pasted WITHOUT a
 * question, which the callback-server providers race their local server
 * against. Never rejects — a cancel is the parent killing this process, and
 * a rejection here would surface as a login error instead. */
function awaitManualInput() {
  if (held.length > 0) return Promise.resolve(held.shift());
  return new Promise((resolve) => {
    pendingManual = resolve;
  });
}

function readStdin(onClose) {
  const reader = createInterface({ input: process.stdin });
  reader.on("line", (line) => {
    const text = line.trim();
    if (!text) return;
    let frame;
    try {
      frame = JSON.parse(text);
    } catch {
      return;
    }
    if (frame && frame.type === "input" && typeof frame.value === "string") deliver(frame.value);
  });
  reader.on("close", () => onClose?.());
  return reader;
}

/**
 * Pi's credential store, opened exactly the way pi opens it: its own
 * AuthStorage over its own `getAuthPath()`, which resolves
 * `<PI_CODING_AGENT_DIR>/auth.json`. Mirroring the construction is the whole
 * point — a credential written anywhere else is one pi will never read.
 */
async function openAuthStorage(packageRoot) {
  const fileUrl = (...segments) => pathToFileURL(join(packageRoot, ...segments)).href;
  let authStorageModule;
  try {
    authStorageModule = await import(fileUrl("dist", "core", "auth-storage.js"));
  } catch (error) {
    throw new Error(
      `Cody could not load Pi's credential store from ${packageRoot}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const AuthStorage = authStorageModule.AuthStorage;
  if (!AuthStorage || typeof AuthStorage.create !== "function") {
    throw new Error("This version of Pi does not expose the AuthStorage that Cody signs in through.");
  }
  // Pi's own path helper, so a rename upstream moves Cody's write with it.
  let authPath;
  try {
    const config = await import(fileUrl("dist", "config.js"));
    if (typeof config.getAuthPath === "function") authPath = config.getAuthPath();
  } catch {
    // Older or reshaped layout: AuthStorage.create() falls back to the same
    // <agent dir>/auth.json itself.
  }
  return AuthStorage.create(authPath);
}

/**
 * The OAuth providers pi itself would offer, from the registry pi's own
 * AuthStorage holds.
 *
 * Deliberately NOT `import("@mariozechner/pi-ai/oauth")` from here: that
 * specifier resolves against THIS file, and a second copy of the module would
 * be a second registry — one that pi never consulted and that any provider pi
 * registered at runtime would be missing from.
 */
function listOAuthProviders(storage) {
  if (typeof storage.getOAuthProviders !== "function") {
    throw new Error("This version of Pi does not expose its OAuth provider list.");
  }
  return storage.getOAuthProviders().map((provider) => {
    const id = String(provider.id);
    // `has` is the stored credential — what login writes and logout removes.
    // `hasAuth` would also answer true for an API key in the environment,
    // which no sign-out could take away.
    const stored = typeof storage.has === "function" ? storage.has(id) : false;
    const status = typeof storage.getAuthStatus === "function" ? storage.getAuthStatus(id) : null;
    const envLabel = !stored && status?.source === "environment" && status.label ? String(status.label) : null;
    return {
      id,
      name: typeof provider.name === "string" && provider.name ? provider.name : id,
      authenticated: stored,
      // True for the browser flows that raise a local callback server (and so
      // accept a pasted redirect URL); false for the device-code flow.
      usesCallbackServer: provider.usesCallbackServer === true,
      ...(envLabel ? { hint: `${envLabel} is already set, so Pi can use this provider without signing in.` } : {}),
    };
  });
}

async function runLogin(storage, providerId) {
  const controller = new AbortController();
  // The parent closing stdin is a cancel; pi-ai honours the signal in the
  // device flow, and the parent kills this process for the rest.
  const reader = readStdin(() => controller.abort());
  try {
    await storage.login(providerId, {
      onAuth: (info) => emit({
        type: "auth",
        url: String(info?.url ?? ""),
        instructions: typeof info?.instructions === "string" ? info.instructions : null,
      }),
      onPrompt: (prompt) => askPrompt(prompt),
      onProgress: (message) => emit({ type: "progress", message: String(message) }),
      onManualCodeInput: () => awaitManualInput(),
      // No engine-neutral selector exists, so a provider that needs one asks
      // through the ordinary prompt with its option ids spelled out. None of
      // pi's built-in three uses this; a future one would otherwise crash on
      // a missing callback.
      onSelect: async (prompt) => {
        const options = Array.isArray(prompt?.options) ? prompt.options : [];
        const labels = options.map((option) => `${option.id} (${option.label})`).join(", ");
        const answer = await askPrompt({
          message: labels ? `${prompt.message} — ${labels}` : prompt.message,
          placeholder: options[0]?.id ?? null,
        });
        const trimmed = answer.trim();
        return options.some((option) => option.id === trimmed) ? trimmed : undefined;
      },
      signal: controller.signal,
    });
    emit({ type: "done" });
  } finally {
    // Release stdin as well as the reader: a still-flowing stdin keeps the
    // event loop alive, and a helper that has printed its result but never
    // exits reads to the parent as a login that never finished.
    reader.close();
    try {
      process.stdin.pause();
      process.stdin.unref();
    } catch {
      // Not a stream that can be released; the parent kills us anyway.
    }
  }
}

async function main() {
  const [command, providerId] = process.argv.slice(2);
  const packageRoot = process.env.CODY_PI_PACKAGE_ROOT;
  if (!packageRoot) throw new Error("CODY_PI_PACKAGE_ROOT is not set, so Cody cannot find Pi's own modules.");
  if (!command) throw new Error("Usage: cody-pi-login.mjs list | login <provider> | logout <provider>");

  const storage = await openAuthStorage(packageRoot);

  if (command === "list") {
    emit({ type: "providers", providers: listOAuthProviders(storage) });
    return;
  }
  if (!providerId) throw new Error(`Usage: cody-pi-login.mjs ${command} <provider>`);
  if (command === "login") {
    await runLogin(storage, providerId);
    return;
  }
  if (command === "logout") {
    storage.logout(providerId);
    emit({ type: "done" });
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

main().then(
  () => {
    process.exitCode = 0;
  },
  (error) => {
    emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  },
);
