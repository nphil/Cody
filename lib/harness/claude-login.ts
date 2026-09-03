import { execFile } from "child_process";
import { homedir } from "os";
import { promisify } from "util";
import { resolveEngineBin } from "./engine-bin";
import { runCliLogin } from "./cli-login";
import { engineChildEnv } from "./provider-keys";
import type { ProviderLoginList, ProviderLoginSurface, ProviderLoginUi } from "./types";

/**
 * Claude Code's own login, behind the engine-neutral `ProviderLoginSurface`.
 *
 * The `claude` CLI (not the ACP adapter Cody drives for chat — see claude.ts)
 * has its own `auth` subcommand: `login` prints a sign-in URL and a
 * `Paste code here if prompted >` prompt with no fallback device code,
 * `status --json` reports the current credential, `logout` clears it. All
 * three are measured against a real 2.1.259 install; `login` is driven
 * through `runCliLogin` under node-pty exactly as Codex's and Hermes' are.
 *
 * `claude auth login --help` documents exactly two mutually exclusive sign-in
 * modes sharing ONE credential slot: `--claudeai` (the default, a Claude
 * Pro/Max subscription) and `--console` (an Anthropic Console account billed
 * by API usage). Both rows below are driven through the same CLI and the
 * same `status --json`, split on `apiProvider` — "firstParty" is the only
 * value actually observed (a subscription login), so it is used as the
 * pivot rather than guessing the console-mode string.
 */

const execFileAsync = promisify(execFile);

/** ~/.claude and CLAUDE_CODE_EXECUTABLE never come into it here — `claude`
 * finds its own state; this is only how CHILD SPAWNS of `claude` itself are
 * timed out. A status/logout check is a local file read and must not hang
 * Cody's server for longer than this. */
const STATUS_TIMEOUT_MS = 8_000;

const PROVIDER_ARGS: Record<string, string[]> = {
  claude: ["auth", "login", "--claudeai"],
  "anthropic-console": ["auth", "login", "--console"],
};

/** Same resolution ladder claude.ts's `claudeCliBin()` uses
 * (`resolveEngineBin("claude", "CLAUDE_CLI")` — CODY_CLAUDE_CLI_BIN, then the
 * tools prefix, then PATH). Not imported from claude.ts: that file's helper
 * is private, and this module must not add an export to it. */
function claudeCliBin(): string | null {
  return resolveEngineBin("claude", "CLAUDE_CLI");
}

/**
 * Mirrors claude.ts's own (private, unexported) `claudeEngineEnv()`: point at
 * the `claude` CLI Cody installed via `CLAUDE_CODE_EXECUTABLE`, unless an
 * operator already exported one. Reimplemented locally on purpose — claude.ts
 * must not gain an export beyond its `providerLogins` attach line — and
 * layered on here for the same reason the adapter carries it: whatever
 * `claude` a deliberate override names is the one every spawn (including this
 * login flow) must use, never a second, silently different resolution.
 */
function claudeEngineEnvEntries(): Record<string, string> {
  if (process.env.CLAUDE_CODE_EXECUTABLE) return {};
  const cli = claudeCliBin();
  return cli ? { CLAUDE_CODE_EXECUTABLE: cli } : {};
}

function claudeChildEnv(): NodeJS.ProcessEnv {
  return engineChildEnv(claudeEngineEnvEntries());
}

interface ClaudeAuthStatus {
  loggedIn?: boolean;
  apiProvider?: string;
}

/** `claude auth status --json` on stdout, exit 0, measured for both the
 * logged-in and (via `--help`) logged-out shapes. A parse failure or spawn
 * error carries the CLI's own words back rather than throwing. */
async function readClaudeAuthStatus(bin: string): Promise<{ status: ClaudeAuthStatus | null; errorText: string }> {
  try {
    const { stdout } = await execFileAsync(bin, ["auth", "status", "--json"], {
      env: claudeChildEnv(),
      timeout: STATUS_TIMEOUT_MS,
      encoding: "utf8",
    });
    const parsed = JSON.parse(stdout) as ClaudeAuthStatus;
    if (typeof parsed.loggedIn === "boolean") return { status: parsed, errorText: "" };
    return { status: null, errorText: "claude auth status --json did not report a loggedIn field." };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message?: string };
    // A clean process that printed valid JSON despite a nonzero exit is still
    // a usable answer; only fall through to the raw failure text otherwise.
    if (failure.stdout) {
      try {
        const parsed = JSON.parse(failure.stdout) as ClaudeAuthStatus;
        if (typeof parsed.loggedIn === "boolean") return { status: parsed, errorText: "" };
      } catch { /* not JSON either — report the failure below */ }
    }
    const detail = (failure.stderr || failure.stdout || failure.message || "claude auth status failed.").trim();
    return { status: null, errorText: detail };
  }
}

async function listClaudeLogins(): Promise<ProviderLoginList> {
  try {
    const bin = claudeCliBin();
    if (!bin) {
      return { providers: [], reason: "Claude CLI not found. Install Claude Code from the engine picker, or set CODY_CLAUDE_CLI_BIN." };
    }
    const { status, errorText } = await readClaudeAuthStatus(bin);
    if (!status) return { providers: [], reason: errorText || "claude auth status failed." };
    const loggedIn = status.loggedIn === true;
    const isFirstParty = status.apiProvider === "firstParty";
    return {
      providers: [
        {
          id: "claude",
          name: "Claude subscription (Pro/Max)",
          authenticated: loggedIn && isFirstParty,
          kind: "oauth",
          canLogout: true,
          hint: "Sign in with your Claude Pro or Max subscription.",
        },
        {
          id: "anthropic-console",
          name: "Anthropic Console (API billing)",
          authenticated: loggedIn && !isFirstParty,
          kind: "oauth",
          canLogout: true,
          hint: "Sign in with an Anthropic Console account billed by API usage, instead of a subscription.",
        },
      ],
    };
  } catch (error) {
    return { providers: [], reason: error instanceof Error ? error.message : String(error) };
  }
}

async function loginWithClaude(providerId: string, ui: ProviderLoginUi): Promise<void> {
  const args = PROVIDER_ARGS[providerId];
  if (!args) throw new Error(`Unknown Claude provider: ${providerId}`);
  const bin = claudeCliBin();
  if (!bin) throw new Error("Claude CLI not found. Install Claude Code from the engine picker, or set CODY_CLAUDE_CLI_BIN.");
  await runCliLogin(
    {
      bin,
      args,
      env: claudeChildEnv(),
      cwd: homedir(),
      // "If the browser didn't open, visit: <url>" — measured against a real
      // login for both --claudeai and --console (only the host differs).
      url: /If the browser didn't open, visit:\s*(\S+)/,
      // "Paste code here if prompted > " — no trailing newline; matched
      // against the tail, exactly as measured.
      prompt: /Paste code here if prompted >\s*$/,
    },
    ui,
  );
}

async function logoutClaude(providerId: string): Promise<void> {
  if (!(providerId in PROVIDER_ARGS)) throw new Error(`Unknown Claude provider: ${providerId}`);
  const bin = claudeCliBin();
  if (!bin) throw new Error("Claude CLI not found.");
  try {
    await execFileAsync(bin, ["auth", "logout"], { env: claudeChildEnv(), timeout: STATUS_TIMEOUT_MS, encoding: "utf8" });
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message?: string };
    throw new Error((failure.stderr || failure.stdout || failure.message || "claude auth logout failed.").trim());
  }
}

export const claudeProviderLogins: ProviderLoginSurface = {
  list: listClaudeLogins,
  login: loginWithClaude,
  logout: logoutClaude,
};
