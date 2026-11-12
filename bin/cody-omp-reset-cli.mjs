/**
 * Spending a saved reset through omp's own `omp usage reset <provider>/<id>`.
 *
 * omp 18.9.0 added that command and, with it, a cross-process lock
 * (`<agent.db>.reset-<hash>`, src/session/reset-fence.ts). A running omp
 * session's automatic spend and the command both take it, so two processes
 * cannot spend the same account's reset at once. AuthStorage's own `redeem`
 * does NOT take it, so the Bun helper's direct call could race a session.
 *
 * The command prints a sentence, not JSON, for a spend (`--json` only changes
 * the listing): exit 0 means a reset was applied, exit 1 means nothing was
 * (or could not be confirmed) and stderr says why. The sentences are
 * `describeRedeemOutcome` (src/slash-commands/helpers/reset-usage.ts) plus the
 * command's own refusals (src/cli/usage-cli.ts). This module maps them onto
 * the outcomes Cody's UI already knows; anything it does not recognise is
 * reported as inconclusive, never as a spend or a clean failure.
 */
import { spawn } from "node:child_process";

/** omp waits up to 30 s for the lock, then lists (10 s), then redeems (15 s). */
export const USAGE_RESET_TIMEOUT_MS = 80_000;
const MAX_CAPTURE_BYTES = 64 * 1024;

export const OUTCOME_MESSAGES = {
  ineligible: "This account cannot spend a saved reset right now.",
  offer_changed: "The saved reset on offer changed. Refresh and confirm again.",
  reset_in_progress: "Another reset for this account is still being applied.",
  reset_unconfirmed: "The last reset for this account is still unconfirmed. Refresh before trying again.",
  cooldown: "Saved resets for this account are cooling down.",
  unsupported_provider: "This OMP build cannot redeem resets for that provider.",
};
export const INCONCLUSIVE_MESSAGE = "The redemption result is inconclusive; refresh before trying again.";

function clean(text) {
  // eslint-disable-next-line no-control-regex
  return String(text ?? "").replace(/\u001b\[[0-9;]*[A-Za-z]/g, "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim();
}
/** The provider's own explanation after the " — " in describeRedeemOutcome. */
function dashReason(text) {
  const at = text.indexOf(" — ");
  if (at < 0) return null;
  const reason = text.slice(at + 3).replace(/\.\s*$/, "").trim();
  return reason || null;
}
function frame(outcome, code, message) {
  return { type: "redeem", outcome, ...(code ? { code } : {}), ...(message ? { message } : {}) };
}
function failure(code, message) { return frame("error", code, message ?? OUTCOME_MESSAGES[code]); }

/**
 * Map one finished `omp usage reset <provider>/<id>` run onto a redeem frame.
 * @param {{ exitCode: number | null, stdout?: string, stderr?: string, timedOut?: boolean }} run
 */
export function parseUsageResetResult(run) {
  if (run.timedOut) return failure("inconclusive", INCONCLUSIVE_MESSAGE);
  const text = clean(`${run.stderr ?? ""}\n${run.stdout ?? ""}`);
  if (run.exitCode === 0) {
    // Exit 0 with a spend target only follows an applied reset. An engine that
    // does not know the subcommand would list usage and exit 0 as well, so the
    // sentence must agree before Cody says a credit was spent.
    return /Reset applied for/i.test(text) ? frame("reset", "reset") : failure("inconclusive", INCONCLUSIVE_MESSAGE);
  }
  // Contention first: another omp process holds or just used the lock.
  if (/another omp process spent a saved reset on this account/i.test(text)) return frame("already_redeemed", "already_redeemed", "Another omp process just spent a saved reset on this account.");
  if (/another omp process started spending a saved reset on this account/i.test(text)) return failure("reset_in_progress");
  // The lock never came free within omp's retry window: nothing was spent.
  if (/Failed to acquire lock for .* after \d+ attempts/i.test(text)) return failure("reset_in_progress");
  // The command's own refusals, all before any spend.
  if (/fence the spend against other omp processes/i.test(text)) return failure("account_unavailable", "This sign-in stores no account id or email, so a reset cannot be spent safely. Sign in to it again.");
  if (/No stored account matches/i.test(text)) return failure("no_account", "The selected reset-credit account no longer exists.");
  const unavailable = /saved resets unavailable \((.*)\), so nothing was spent/i.exec(text);
  if (unavailable) return failure("account_unavailable", unavailable[1].trim() || "The selected account cannot redeem reset credits.");
  const unusable = /no saved resets usable right now(?: \((.*)\))?\.?\s*$/i.exec(text);
  if (unusable) return frame("no_credit", "ineligible", unusable[1]?.trim() || OUTCOME_MESSAGES.ineligible);
  // describeRedeemOutcome sentences.
  if (/that reset was already redeemed/i.test(text)) return frame("already_redeemed", "already_redeemed");
  if (/no saved resets available to spend/i.test(text)) { const reason = dashReason(text); return frame("no_credit", "no_credit", reason ?? undefined); }
  if (/couldn't load this account's saved resets/i.test(text)) return failure("credit_list_failed", "Could not load this account's saved resets, so nothing was spent. Try again.");
  if (/nothing to reset right now/i.test(text)) return frame("nothing_to_reset", "nothing_to_reset");
  if (/Could not find the stored account/i.test(text)) return failure("no_account", "The selected reset-credit account no longer exists.");
  if (/could not authenticate this account/i.test(text)) return failure("account_unavailable", "Could not sign in to this account. Sign in to it again and retry.");
  if (/the reset offer changed/i.test(text)) return failure("offer_changed");
  if (/a reset is already in progress/i.test(text)) return failure("reset_in_progress");
  if (/couldn't confirm whether the reset applied/i.test(text)) return failure("reset_unconfirmed", /before trying again(?: — (.*?))?\.?\s*$/i.exec(text)?.[1] ?? OUTCOME_MESSAGES.reset_unconfirmed);
  const unconfirmed = /reset was not confirmed \(([A-Za-z0-9_]+)\)/i.exec(text);
  if (unconfirmed) {
    const code = unconfirmed[1];
    const reason = dashReason(text);
    if (code === "ineligible") return frame("no_credit", "ineligible", reason ?? OUTCOME_MESSAGES.ineligible);
    return failure(code, reason ?? OUTCOME_MESSAGES[code] ?? INCONCLUSIVE_MESSAGE);
  }
  return failure("inconclusive", INCONCLUSIVE_MESSAGE);
}

/** Fixed argv, never a shell: the account is named only by omp's own credential id. */
export function usageResetArgs(provider, credentialId) {
  return ["usage", "reset", `${provider}/${credentialId}`];
}

/**
 * Run the command. Resolves `{ started: false }` when the binary could not be
 * launched at all (nothing ran, so the caller may use its fallback), otherwise
 * `{ started: true, frame }`.
 * @param {{ ompBin: string, provider: string, credentialId: number, agentDir: string, timeoutMs?: number }} options
 */
export function runUsageReset({ ompBin, provider, credentialId, agentDir, timeoutMs = USAGE_RESET_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(ompBin, usageResetArgs(provider, credentialId), {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, NO_COLOR: "1", FORCE_COLOR: "0" },
      });
    } catch { resolve({ started: false }); return; }
    let spawned = false; let settled = false; let timedOut = false;
    let stdout = ""; let stderr = "";
    const finish = (value) => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); };
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    const collect = (current, chunk) => current.length >= MAX_CAPTURE_BYTES ? current : current + chunk.toString("utf8");
    child.stdout?.on("data", (chunk) => { stdout = collect(stdout, chunk); });
    child.stderr?.on("data", (chunk) => { stderr = collect(stderr, chunk); });
    child.once("spawn", () => { spawned = true; });
    child.once("error", () => { if (!spawned) finish({ started: false }); });
    child.once("close", (code) => finish({ started: true, frame: parseUsageResetResult({ exitCode: code, stdout, stderr, timedOut }) }));
  });
}
