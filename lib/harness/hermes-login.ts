import { execFile } from "child_process";
import { homedir } from "os";
import { promisify } from "util";
import { resolveEngineBin } from "./engine-bin";
import { runCliLogin, type CliLoginSpec } from "./cli-login";
import { engineChildEnv } from "./provider-keys";
import type { ProviderLoginList, ProviderLoginOption, ProviderLoginSurface, ProviderLoginUi } from "./types";

/**
 * Hermes' own login, behind the engine-neutral `ProviderLoginSurface`.
 *
 * `hermes auth add <provider> --type oauth` drives one of six OAuth-capable
 * entries in `hermes_cli/auth.py`'s `PROVIDER_REGISTRY` (measured against a
 * real 0.19.0 install, reading the installed package's own source for the
 * exact print statements rather than guessing):
 *
 *  - `anthropic` — a Claude Pro/Max subscription. A Hermes-native OAuth PKCE
 *    flow (`agent/anthropic_adapter.run_hermes_oauth_login_pure`): prints a
 *    boxed URL, then prompts `Authorization code: ` for a pasted code.
 *  - `nous`, `xai-oauth`, `minimax-oauth` — three unrelated services that
 *    happen to share ONE print shape verbatim: "1. Open: <url>" then
 *    "2. If prompted, enter code: <code>", then poll silently — nothing to
 *    paste back.
 *  - `openai-codex` — Hermes' OWN reimplementation of the ChatGPT device-auth
 *    flow (a different code path from the standalone `codex` CLI Cody also
 *    drives in codex-login.ts, though it happens to hit the same
 *    auth.openai.com endpoint): an ANSI-colored URL and code, each on their
 *    own line, then a silent poll.
 *  - `qwen-oauth` — NOT an interactive flow at all. It only reads the
 *    separate `qwen` CLI's own OAuth tokens
 *    (`resolve_qwen_runtime_credentials`) and raises if that CLI was never
 *    logged in — measured live: an UNCAUGHT `AuthError`, i.e. a raw Python
 *    traceback on stderr, exit 1. Included because the registry marks it
 *    OAuth-capable, but `login()` for it never calls `onUrl`/`onDeviceCode`;
 *    it just resolves instantly (already imported) or rejects with that
 *    message.
 *
 * `hermes auth status <id>` (plain text, always exit 0 — measured) is the
 * per-provider truth; `hermes auth list` is NOT used for this because it
 * only lists providers that already hold a pooled credential, silently
 * omitting the rest instead of reporting them as "not signed in".
 * `hermes auth logout <id>` clears one, non-interactively, always exit 0.
 */

const execFileAsync = promisify(execFile);

/** A status/logout check reads local state (mostly) synchronously inside
 * Hermes; it must not hang Cody's server for longer than this even if a
 * provider's status happens to attempt a token refresh. */
const STATUS_TIMEOUT_MS = 8_000;

/** Same resolution ladder hermes.ts uses (`resolveEngineBin("hermes",
 * "HERMES")` — CODY_HERMES_BIN, then the tools prefix, then PATH). */
function hermesCliBin(): string | null {
  return resolveEngineBin("hermes", "HERMES");
}

/** Hermes' adapter declares no `engineEnv()` of its own (hermes.ts has
 * neither a private helper nor an `engineEnv` entry) — HERMES_HOME, if an
 * operator set one, already rides through `process.env`. */
function hermesChildEnv(): NodeJS.ProcessEnv {
  return engineChildEnv();
}

// "1. Open: <url>" / "2. If prompted, enter code: <code>" — the shared shape
// nous, xai-oauth and minimax-oauth all print verbatim (hermes_cli/auth.py:
// _nous_device_code_login, _xai_oauth_device_code_login, _minimax_oauth_login),
// verified live against 0.19.0.
const SHARED_DEVICE_URL = /^\s*1\.\s*Open:\s*(\S+)/;
const SHARED_DEVICE_CODE = /^\s*2\.\s*If prompted, enter code:\s*(\S+)/;

// Hermes' own reimplementation of the OpenAI device-auth flow
// (`_codex_device_code_login`), ANSI-colored in the CLI but stripped before
// matching; verified live.
const CODEX_DEVICE_URL = /(https:\/\/auth\.openai\.com\/codex\/device\S*)/;
// A bare "XXXX-XXXXX"-shaped line — nothing else in either device flow's
// output takes that shape, so matching the whole trimmed line is safe.
const CODE_ONLY_LINE = /^\s*([A-Z0-9]{2,8}-[A-Z0-9]{2,8})\s*$/;

// Hermes (Python) can raise an UNCAUGHT exception instead of a clean
// SystemExit — measured live for qwen-oauth with no separate `qwen` login.
// The final line of such a traceback always has this shape, unindented; it
// turns a multi-frame tail into the one line that actually says why.
const PY_EXCEPTION_LINE = /^[\w.]*Error: /;

interface HermesProviderSpec {
  id: string;
  name: string;
  kind: "oauth" | "device";
  hint: string;
  /** Everything `login()` needs beyond bin/env/cwd, which are the same for
   * all six. */
  login: Pick<CliLoginSpec, "args" | "url" | "deviceCode" | "prompt" | "failure">;
}

const HERMES_PROVIDERS: readonly HermesProviderSpec[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    kind: "oauth",
    hint: "Claude Pro/Max subscription, via Hermes' own sign-in flow.",
    login: {
      args: ["auth", "add", "anthropic", "--type", "oauth", "--no-browser"],
      // "  https://claude.ai/oauth/authorize?..." on its own line.
      url: /(https:\/\/claude\.ai\/oauth\/authorize\?\S*)/,
      // "Authorization code: " — no trailing newline.
      prompt: /Authorization code:\s*$/,
      failure: PY_EXCEPTION_LINE,
    },
  },
  {
    id: "nous",
    name: "Nous Portal",
    kind: "device",
    hint: "Nous Research's own inference subscription.",
    login: {
      args: ["auth", "add", "nous", "--type", "oauth", "--no-browser"],
      url: SHARED_DEVICE_URL,
      deviceCode: SHARED_DEVICE_CODE,
      failure: PY_EXCEPTION_LINE,
    },
  },
  {
    id: "openai-codex",
    name: "OpenAI Codex",
    kind: "device",
    hint: "ChatGPT Plus/Pro/Team subscription, via Hermes' own device-code flow.",
    login: {
      args: ["auth", "add", "openai-codex", "--type", "oauth", "--no-browser"],
      url: CODEX_DEVICE_URL,
      deviceCode: CODE_ONLY_LINE,
      failure: PY_EXCEPTION_LINE,
    },
  },
  {
    id: "xai-oauth",
    name: "xAI Grok OAuth (SuperGrok / Premium+)",
    kind: "device",
    hint: "xAI SuperGrok or Premium+ subscription.",
    login: {
      args: ["auth", "add", "xai-oauth", "--type", "oauth", "--no-browser"],
      url: SHARED_DEVICE_URL,
      deviceCode: SHARED_DEVICE_CODE,
      failure: PY_EXCEPTION_LINE,
    },
  },
  {
    id: "qwen-oauth",
    name: "Qwen OAuth",
    kind: "oauth",
    hint: "Reuses the separate `qwen` CLI's own sign-in — run `qwen auth qwen-oauth` in a terminal first.",
    login: {
      args: ["auth", "add", "qwen-oauth", "--type", "oauth"],
      // No URL of its own ever prints (see the module doc) — this can never
      // match, and the add either succeeds or fails immediately.
      url: /(https?:\/\/\S+)/,
      failure: PY_EXCEPTION_LINE,
    },
  },
  {
    id: "minimax-oauth",
    name: "MiniMax (OAuth · minimax.io)",
    kind: "device",
    hint: "MiniMax subscription via minimax.io.",
    login: {
      args: ["auth", "add", "minimax-oauth", "--type", "oauth", "--no-browser"],
      url: SHARED_DEVICE_URL,
      deviceCode: SHARED_DEVICE_CODE,
      failure: PY_EXCEPTION_LINE,
    },
  },
];

/**
 * One provider's `hermes auth status <id>` verdict. Text is plain
 * (`"<id>: logged in"` / `"<id>: logged out"` / `"<id>: logged out
 * (<reason>)"`), always exit 0 (measured for all six) — but read from
 * combined stdout+stderr and treat a spawn failure as "unrecognized" rather
 * than exit code, matching the caution the Codex module needed for the same
 * reason.
 */
async function readHermesProviderStatus(bin: string, id: string): Promise<{ authenticated: boolean; recognized: boolean; text: string }> {
  let stdout = "";
  let stderr = "";
  try {
    ({ stdout, stderr } = await execFileAsync(bin, ["auth", "status", id], {
      env: hermesChildEnv(),
      timeout: STATUS_TIMEOUT_MS,
      encoding: "utf8",
    }));
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message?: string };
    stdout = failure.stdout ?? "";
    stderr = failure.stderr ?? "";
    if (!stdout && !stderr) return { authenticated: false, recognized: false, text: failure.message || `hermes auth status ${id} failed.` };
  }
  const text = `${stdout}\n${stderr}`;
  const line = text.split("\n").map((entry) => entry.trim()).find((entry) => entry.startsWith(`${id}:`));
  if (!line) return { authenticated: false, recognized: false, text: text.trim() };
  return { authenticated: /:\s*logged in\b/.test(line), recognized: true, text };
}

async function listHermesLogins(): Promise<ProviderLoginList> {
  try {
    const bin = hermesCliBin();
    if (!bin) {
      return { providers: [], reason: "Hermes binary not found. Install Hermes from the engine picker, or set CODY_HERMES_BIN." };
    }
    const results = await Promise.all(
      HERMES_PROVIDERS.map(async (spec) => ({ spec, ...(await readHermesProviderStatus(bin, spec.id)) })),
    );
    // Every probe failing the same way means Hermes itself is broken (a
    // corrupt install, a crashed interpreter) — report that once rather than
    // six identical unauthenticated rows with no explanation. Any provider
    // that came back readable is shown even if others did not.
    if (results.every((result) => !result.recognized)) {
      return { providers: [], reason: results[0]?.text || "hermes auth status failed." };
    }
    const providers: ProviderLoginOption[] = results.map(({ spec, authenticated }) => ({
      id: spec.id,
      name: spec.name,
      authenticated,
      kind: spec.kind,
      canLogout: true,
      hint: spec.hint,
    }));
    return { providers };
  } catch (error) {
    return { providers: [], reason: error instanceof Error ? error.message : String(error) };
  }
}

async function loginWithHermes(providerId: string, ui: ProviderLoginUi): Promise<void> {
  const spec = HERMES_PROVIDERS.find((entry) => entry.id === providerId);
  if (!spec) throw new Error(`Unknown Hermes provider: ${providerId}`);
  const bin = hermesCliBin();
  if (!bin) throw new Error("Hermes binary not found. Install Hermes from the engine picker, or set CODY_HERMES_BIN.");
  await runCliLogin({ bin, env: hermesChildEnv(), cwd: homedir(), ...spec.login }, ui);
}

async function logoutHermes(providerId: string): Promise<void> {
  const spec = HERMES_PROVIDERS.find((entry) => entry.id === providerId);
  if (!spec) throw new Error(`Unknown Hermes provider: ${providerId}`);
  const bin = hermesCliBin();
  if (!bin) throw new Error("Hermes binary not found.");
  try {
    await execFileAsync(bin, ["auth", "logout", providerId], { env: hermesChildEnv(), timeout: STATUS_TIMEOUT_MS, encoding: "utf8" });
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message?: string };
    throw new Error((failure.stderr || failure.stdout || failure.message || `hermes auth logout ${providerId} failed.`).trim());
  }
}

export const hermesProviderLogins: ProviderLoginSurface = {
  list: listHermesLogins,
  login: loginWithHermes,
  logout: logoutHermes,
};
