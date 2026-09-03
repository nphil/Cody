/**
 * Drive an engine's OWN login command inside a pseudo-terminal.
 *
 * Claude Code (`claude auth login`), Codex (`codex login --device-auth`) and
 * Hermes (`hermes auth add <provider> --type oauth`) each print a URL, then
 * either wait for a pasted code ("Paste code here if prompted >",
 * "Authorization code:") or poll for a device code the user types on the
 * provider's site. None of them has a machine interface for it, and none of
 * them will run the flow without a TTY — the prompts are TUI prompts. So the
 * command runs under node-pty, its output is stripped of escape sequences and
 * matched line by line against the small vocabulary each CLI actually uses,
 * and the user's pasted value goes back in as keystrokes.
 *
 * Only the CLI stores the credential. Cody never sees the token: it relays a
 * URL out and a code in, and reads the exit status.
 */
import * as pty from "node-pty";
import type { IPty } from "node-pty";
import type { ProviderLoginUi } from "./types";

export interface CliLoginSpec {
  bin: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** The sign-in URL. The first capture group (or the whole match) is what the user opens. */
  url: RegExp;
  /**
   * A prompt for the pasted code or redirect URL. Matched against the TAIL of
   * the output, because a prompt has no newline after it. When it matches,
   * the user's value (pasted unprompted earlier, or asked for now) is typed
   * in followed by Enter.
   */
  prompt?: RegExp;
  /** A device code line; the first capture group is the code shown to the user. */
  deviceCode?: RegExp;
  /** Output that means the login succeeded even before the process exits. */
  success?: RegExp;
  /** Output that names a failure; the match becomes the error. */
  failure?: RegExp;
  /** Instructions shown next to the URL. */
  instructions?: string | null;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15 * 60_000;
// Wide enough that no OAuth URL wraps: a wrapped URL is two lines, and half a
// URL is no URL. node-pty accepts this width; the CLIs do not care.
const PTY_COLUMNS = 400;

/** Terminal output as text: CSI sequences, OSC titles/hyperlinks and carriage returns removed. */
export function stripTerminalControl(text: string): string {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[()][A-Z0-9]/g, "")
    .replace(/\r/g, "");
}

export function runCliLogin(spec: CliLoginSpec, ui: ProviderLoginUi): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let child: IPty;
    try {
      child = pty.spawn(spec.bin, spec.args, {
        name: "xterm-256color",
        cols: PTY_COLUMNS,
        rows: 40,
        cwd: spec.cwd,
        env: spec.env as Record<string, string>,
      });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    let settled = false;
    let unread = "";
    let urlSent = false;
    let lastUrl: string | null = null;
    let codeSent = false;
    let prompted = false;
    let manualValue: string | null = null;
    let awaitingPrompt = false;
    const tail: string[] = [];

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ui.signal.removeEventListener("abort", onAbort);
      try { child.kill(); } catch { /* already gone */ }
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => finish(new Error("Login cancelled"));
    const timer = setTimeout(() => finish(new Error("The login did not complete in time")), spec.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    ui.signal.addEventListener("abort", onAbort);
    if (ui.signal.aborted) { onAbort(); return; }

    const typeValue = (value: string) => {
      child.write(`${value.trim()}\r`);
    };

    // A value pasted before the CLI asks for it: keep it, and type it the
    // moment the prompt shows. The promise rejects on cancel, which finish()
    // already handles, so the rejection itself is ignored.
    void ui.onManualInput().then((value) => {
      manualValue = value;
      if (awaitingPrompt) { awaitingPrompt = false; typeValue(value); }
    }).catch(() => {});

    const scanLine = (line: string) => {
      tail.push(line);
      if (tail.length > 12) tail.shift();
      if (!urlSent) {
        const match = spec.url.exec(line);
        if (match) {
          urlSent = true;
          lastUrl = match[1] ?? match[0];
          ui.onUrl(lastUrl, spec.instructions ?? null);
        }
      }
      if (spec.deviceCode && !codeSent) {
        const match = spec.deviceCode.exec(line);
        if (match?.[1] && urlSent) {
          codeSent = true;
          ui.onDeviceCode({ userCode: match[1], verificationUri: lastUrl ?? "", expiresInSeconds: null, intervalSeconds: null });
        }
      }
      if (spec.failure?.test(line)) finish(new Error(line.trim()));
      else if (spec.success?.test(line)) finish();
    };
    child.onData((chunk: string) => {
      if (settled) return;
      const text = stripTerminalControl(chunk);
      unread += text;
      let index: number;
      while ((index = unread.indexOf("\n")) !== -1) {
        const line = unread.slice(0, index);
        unread = unread.slice(index + 1);
        if (line.trim()) scanLine(line);
      }
      // The prompt has no newline after it: match the unread tail.
      if (spec.prompt && !prompted && spec.prompt.test(unread)) {
        prompted = true;
        unread = "";
        if (manualValue !== null) {
          typeValue(manualValue);
        } else {
          awaitingPrompt = true;
          void ui.onPrompt("Paste the authorization code, or the full redirect URL, from the browser", null)
            .then((value) => { if (awaitingPrompt) { awaitingPrompt = false; typeValue(value); } })
            .catch(() => {});
        }
      }
    });

    child.onExit(({ exitCode }) => {
      if (settled) return;
      if (exitCode === 0) finish();
      else {
        const detail = tail.filter((line) => !/^\s*$/.test(line)).slice(-4).join(" · ").trim();
        finish(new Error(detail || `${spec.bin} exited with code ${exitCode}`));
      }
    });
  });
}
