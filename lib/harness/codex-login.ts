import { execFile } from "child_process";
import { homedir } from "os";
import { promisify } from "util";
import { resolveEngineBin } from "./engine-bin";
import { runCliLogin } from "./cli-login";
import { engineChildEnv } from "./provider-keys";
import type { ProviderLoginList, ProviderLoginSurface, ProviderLoginUi } from "./types";

/**
 * Codex's own login, behind the engine-neutral `ProviderLoginSurface`.
 *
 * The `codex` CLI (not the ACP adapter Cody drives for chat — see codex.ts)
 * has its own `login` subcommand: `--device-auth` prints a URL and a
 * one-time code, then polls silently until the browser step completes;
 * `login status` reports the current credential; `logout` clears it. All
 * three are measured against a real 0.153.0 install.
 *
 * Two quirks measured that a naive implementation would get wrong:
 *  - `login status` prints its verdict to STDERR, not stdout, and exits 1
 *    for "Not logged in" — an exit code alone cannot tell "not signed in"
 *    apart from "the command itself broke", so status is read from the
 *    combined output text, never from the exit code.
 *  - With `CODEX_HOME` under `/tmp` the CLI also warns on stderr that it
 *    could not create PATH aliases. Harmless (Cody's container runs
 *    `CODEX_HOME` under the persistent data dir, not `/tmp`); the status
 *    regexes below match on the actual verdict line and ignore the rest.
 */

const execFileAsync = promisify(execFile);

/** A status/logout check is a local file read; it must not hang Cody's
 * server for longer than this. */
const STATUS_TIMEOUT_MS = 8_000;

const CHATGPT_PROVIDER_ID = "chatgpt";

/** Same resolution ladder codex.ts's `codexEngineEnv()` uses for the CLI half
 * (`resolveEngineBin("codex", "CODEX_CLI")`). Not imported from codex.ts:
 * that file's helper is private, and this module must not add an export to
 * it. */
function codexCliBin(): string | null {
  return resolveEngineBin("codex", "CODEX_CLI");
}

/**
 * Mirrors the CODEX_PATH half of codex.ts's own (private, unexported)
 * `codexEngineEnv()` — reimplemented locally for the same reason
 * `claudeEngineEnvEntries()` is in claude-login.ts. The other half of that
 * function (`DEFAULT_AUTH_REQUEST`) is ACP-session-only and irrelevant to a
 * direct `codex` CLI spawn, so it is deliberately not reproduced here.
 */
function codexEngineEnvEntries(): Record<string, string> {
  if (process.env.CODEX_PATH?.trim()) return {};
  const cli = codexCliBin();
  return cli ? { CODEX_PATH: cli } : {};
}

function codexChildEnv(): NodeJS.ProcessEnv {
  return engineChildEnv(codexEngineEnvEntries());
}

const LOGGED_IN_CHATGPT = /Logged in using ChatGPT/;
const LOGGED_IN_OTHER = /Logged in using/;
const NOT_LOGGED_IN = /Not logged in/;

/**
 * `codex login status`'s verdict, read from combined stdout+stderr regardless
 * of exit code (see the module doc for why). `recognized` is false only when
 * neither shape appears at all — a genuinely broken invocation, which is the
 * one case `list()` reports as a whole-surface failure rather than "not
 * signed in".
 */
async function readCodexLoginStatus(bin: string): Promise<{ authenticated: boolean; recognized: boolean; text: string }> {
  let stdout = "";
  let stderr = "";
  try {
    ({ stdout, stderr } = await execFileAsync(bin, ["login", "status"], {
      env: codexChildEnv(),
      timeout: STATUS_TIMEOUT_MS,
      encoding: "utf8",
    }));
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message?: string };
    stdout = failure.stdout ?? "";
    stderr = failure.stderr ?? "";
    if (!stdout && !stderr) return { authenticated: false, recognized: false, text: failure.message || "codex login status failed." };
  }
  const text = `${stdout}\n${stderr}`;
  if (LOGGED_IN_CHATGPT.test(text)) return { authenticated: true, recognized: true, text };
  if (NOT_LOGGED_IN.test(text)) return { authenticated: false, recognized: true, text };
  // A real credential (an API key, a personal access token, …) but not THIS
  // row's ChatGPT subscription — Cody's separate API Keys panel covers that
  // path, so the row for a subscription sign-in stays honestly unauthenticated.
  if (LOGGED_IN_OTHER.test(text)) return { authenticated: false, recognized: true, text };
  return { authenticated: false, recognized: false, text: text.trim() };
}

async function listCodexLogins(): Promise<ProviderLoginList> {
  try {
    const bin = codexCliBin();
    if (!bin) {
      return { providers: [], reason: "Codex CLI not found. Install Codex from the engine picker, or set CODY_CODEX_CLI_BIN." };
    }
    const { authenticated, recognized, text } = await readCodexLoginStatus(bin);
    if (!recognized) return { providers: [], reason: text || "codex login status failed." };
    return {
      providers: [
        {
          id: CHATGPT_PROVIDER_ID,
          name: "ChatGPT (Plus/Pro/Team)",
          authenticated,
          kind: "device",
          canLogout: true,
          hint: "Sign in with your ChatGPT Plus, Pro, or Team subscription.",
        },
      ],
    };
  } catch (error) {
    return { providers: [], reason: error instanceof Error ? error.message : String(error) };
  }
}

async function loginWithCodex(providerId: string, ui: ProviderLoginUi): Promise<void> {
  if (providerId !== CHATGPT_PROVIDER_ID) throw new Error(`Unknown Codex provider: ${providerId}`);
  const bin = codexCliBin();
  if (!bin) throw new Error("Codex CLI not found. Install Codex from the engine picker, or set CODY_CODEX_CLI_BIN.");
  await runCliLogin(
    {
      bin,
      args: ["login", "--device-auth"],
      env: codexChildEnv(),
      cwd: homedir(),
      // "   https://auth.openai.com/codex/device" on its own line.
      url: /(https:\/\/auth\.openai\.com\/codex\/device\S*)/,
      // "   T5T7-18VUQ" on its own line, indented, nothing else on it.
      deviceCode: /^\s*([A-Z0-9]{2,8}-[A-Z0-9]{2,8})\s*$/,
    },
    ui,
  );
}

async function logoutCodex(providerId: string): Promise<void> {
  if (providerId !== CHATGPT_PROVIDER_ID) throw new Error(`Unknown Codex provider: ${providerId}`);
  const bin = codexCliBin();
  if (!bin) throw new Error("Codex CLI not found.");
  try {
    await execFileAsync(bin, ["logout"], { env: codexChildEnv(), timeout: STATUS_TIMEOUT_MS, encoding: "utf8" });
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message?: string };
    throw new Error((failure.stderr || failure.stdout || failure.message || "codex logout failed.").trim());
  }
}

export const codexProviderLogins: ProviderLoginSurface = {
  list: listCodexLogins,
  login: loginWithCodex,
  logout: logoutCodex,
};
