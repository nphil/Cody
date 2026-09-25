/**
 * omp's provider sign-in, behind the engine-neutral `ProviderLoginSurface`.
 *
 * omp keeps subscription credentials in its own encrypted store and runs the
 * OAuth flows itself; over rpc-ui they surface as extension UI frames on a
 * dedicated `omp --mode rpc-ui` child: `open_url` carries the sign-in URL,
 * `input` asks for the pasted code or redirect URL, `notify` reports
 * progress, `cancel` withdraws an input request, and the `login` command
 * resolves once the credential is stored. The list comes from omp's own
 * `get_login_providers` (its /login list), so nothing here names a provider.
 *
 * omp's own store keeps every credential for a provider, not just one —
 * `list()` enumerates them (lib/harness/omp-credentials.ts, a Bun bridge to
 * omp's installed AuthStorage) and ranks each by the state omp itself would
 * report were it routing that provider right now (lib/usage/select.ts).
 * `logout` and `removeAccount` edit that same store directly; neither goes
 * through a running rpc-ui child.
 */
import { homedir } from "os";
import type { ProviderLoginAccount, ProviderLoginList, ProviderLoginOption, ProviderLoginSurface, ProviderLoginUi } from "../harness/types";
import { listOmpCredentials, removeOmpCredential, removeOmpProvider, sanitizeOmpCredentialReason, type OmpCredentialRemoval, type OmpCredentialRow, type OmpCredentialsSnapshot } from "../harness/omp-credentials";
import { invalidateModelsCache } from "../models-cache";
import { forgetProviderAccountName, forgetProviderAccountNames, normalizeProviderAccountName, readProviderAccountNames, resolveProviderAccountName, setProviderAccountName, type ProviderAccountNameEntry } from "../provider-account-names";
import { getUsageSnapshot } from "../usage/cache";
import { rankProviderAccounts } from "../usage/select";
import type { UsageAccount, UsageAccountService } from "../usage/types";
import { enableProvider } from "./model-roles";
import { getAgentDir } from "./paths";
import { RpcProcess, type RpcFrame } from "./rpc-process";
import { disposeUtilityRpc, type OmpLoginProvider, runUtilityCommand } from "./rpc-utility";

const LOGIN_EXTRA_ARGS = ["--no-session", "--no-extensions", "--no-skills", "--no-lsp"];
const READY_TIMEOUT_MS = 60_000;
const LOGIN_TIMEOUT_MS = 15 * 60_000;

/** The slice of RpcProcess the login flow drives; a test hands in a fake. */
export interface LoginRpcChild {
  waitReady(timeoutMs: number): Promise<unknown>;
  sendCommand(command: { type: string; [key: string]: unknown }, timeoutMs: number): Promise<unknown>;
  sendFrame(frame: RpcFrame): void;
  dispose(): Promise<void> | void;
}

export interface OmpProviderLoginDeps {
  /** Spawn the dedicated login child; `onFrame` receives its extension UI frames. */
  createChild?: (onFrame: (frame: RpcFrame) => void) => LoginRpcChild;
  /** Read omp's /login roster. */
  listProviders?: () => Promise<OmpLoginProvider[]>;
  /** What a stored credential changes on Cody's side. */
  afterLogin?: (providerId: string) => void;
  /** Every stored credential, active and disabled, across every provider. */
  listCredentials?: () => Promise<OmpCredentialsSnapshot>;
  /** Quota snapshot used to rank which stored credential is actually serving. */
  listUsage?: () => Promise<{ accounts: UsageAccount[] }>;
  /** Remove exactly one stored credential. */
  removeCredential?: (provider: string, credentialId: number) => Promise<OmpCredentialRemoval>;
  /** Remove every credential stored for a provider. */
  removeProvider?: (provider: string) => Promise<OmpCredentialRemoval>;
}

const defaultDeps: Required<OmpProviderLoginDeps> = {
  createChild: (onFrame) => new RpcProcess({ cwd: homedir(), extraArgs: LOGIN_EXTRA_ARGS, onFrame }),
  listProviders: async () => (await runUtilityCommand<{ providers: OmpLoginProvider[] }>({ type: "get_login_providers" }, 30_000)).providers,
  afterLogin: (providerId) => {
    // The new credential changes which models resolve: drop every cached
    // answer that predates it, and make sure the provider is not disabled in
    // config.yml, or the sign-in would change nothing visible.
    enableProvider(providerId);
    invalidateModelsCache();
    disposeUtilityRpc();
  },
  listCredentials: () => listOmpCredentials(),
  listUsage: () => getUsageSnapshot(),
  removeCredential: (provider, credentialId) => removeOmpCredential(provider, credentialId),
  removeProvider: (provider) => removeOmpProvider(provider),
};

/** Every credential stored for one provider, with the state omp reports for
 * it. With no conversation in scope, "in use" is the account that most
 * recently served a live request. `position` is the index in omp's own
 * id-ascending order (disabled credentials included), so removing one account
 * never renumbers the ones left behind. */
function buildProviderAccounts(
  credentials: readonly OmpCredentialRow[],
  usageAccounts: readonly UsageAccount[],
  providerId: string,
  providerName: string,
  names: Readonly<Record<string, ProviderAccountNameEntry>>,
): ProviderLoginAccount[] {
  const rows = credentials.filter((row) => row.provider === providerId);
  const ranks = rankProviderAccounts([...usageAccounts], providerId, undefined, { recent: true });
  return rows.map((row, position) => {
    // Match the credential store's stable id first; identity is a fallback
    // for usage snapshots read before the credential store was refreshed.
    const rank = ranks.find((entry) => entry.account.credentialId === row.id)
      ?? (row.identity !== null
        ? ranks.find((entry) => entry.account.id === row.identity || entry.account.identity === row.identity)
        : undefined);
    // AuthStorage's own disabled/blocked state is authoritative — it is the
    // source lib/usage's snapshot itself was built from — and only falls
    // through to the ranked quota state when neither applies.
    const state: UsageAccountService = row.disabledCause !== null ? "disabled" : row.blockedUntil !== null ? "limited" : (rank?.state ?? "standby");
    return {
      id: String(row.id),
      label: resolveProviderAccountName(names, row.provider, String(row.id), row.identity) ?? row.identity ?? providerName,
      position,
      state,
      planType: rank?.account.planType ?? null,
      resetsAt: state === "limited" ? (row.blockedUntil ?? rank?.binding?.resetsAt ?? null) : null,
      canRemove: true,
    };
  });
}

export function createOmpProviderLogins(overrides: OmpProviderLoginDeps = {}): ProviderLoginSurface {
  const deps = { ...defaultDeps, ...overrides };

  async function list(): Promise<ProviderLoginList> {
    try {
      const providers = await deps.listProviders();
      let credentials: OmpCredentialRow[] | null = null;
      let accountDetailsReason: string | undefined;
      try {
        const snapshot = await deps.listCredentials();
        if (snapshot.available) credentials = snapshot.credentials;
        else if (snapshot.reason) accountDetailsReason = sanitizeOmpCredentialReason(snapshot.reason);
      } catch (error) {
        accountDetailsReason = sanitizeOmpCredentialReason(error);
      }
      let usageAccounts: UsageAccount[] = [];
      if (credentials) {
        try { usageAccounts = (await deps.listUsage()).accounts; } catch {
          // Every stored credential still lists; without quota it just ranks
          // as "standby" instead of naming which one is actually serving.
        }
      }
      return {
        providers: providers
          .filter((provider) => provider.available !== false)
          .map((provider): ProviderLoginOption & { accountDetailsReason?: string } => {
            const names = credentials ? readProviderAccountNames(getAgentDir()) : {};
            const accounts = credentials ? buildProviderAccounts(credentials, usageAccounts, provider.id, provider.name, names) : undefined;
            const activeAccounts = accounts?.filter((account) => account.state !== "disabled") ?? [];
            return {
              id: provider.id,
              name: provider.name,
              authenticated: provider.authenticated,
              kind: "oauth" as const,
              // omp's AuthStorage is Cody's own to edit (lib/harness/omp-credentials.ts);
              // logout only offers itself when there is a stored credential to remove.
              canLogout: accounts !== undefined && activeAccounts.length > 0,
              ...(accounts ? { accounts, multiAccount: activeAccounts.length > 1, canRenameAccount: activeAccounts.length > 0 } : {}),
              ...(accountDetailsReason ? { accountDetailsReason } : {}),
            };
          }),
      };
    } catch (error) {
      return { providers: [], reason: error instanceof Error ? error.message : String(error) };
    }
  }

  async function login(providerId: string, ui: ProviderLoginUi): Promise<void> {
    // The user has ONE paste box, and two things can be waiting on it: omp's
    // input request, and the watch for a value pasted before omp asks. The
    // route's channel is first-come-first-served, so a value can land on the
    // watch while an input request is outstanding — it must answer that
    // request, not sit in a buffer while omp waits fifteen minutes.
    let pendingInputId: string | null = null;
    let bufferedValue: string | null = null;
    let child: LoginRpcChild | null = null;

    const answer = (id: string, value: string) => {
      child?.sendFrame({ type: "extension_ui_response", id, value });
    };
    const deliver = (value: string) => {
      if (pendingInputId !== null) {
        const id = pendingInputId;
        pendingInputId = null;
        answer(id, value);
      } else {
        bufferedValue = value;
      }
    };
    const watchForPaste = () => {
      ui.onManualInput().then((value) => { deliver(value); watchForPaste(); }).catch(() => {});
    };

    const handleFrame = (frame: RpcFrame) => {
      if (frame.type !== "extension_ui_request") return;
      const method = frame.method;
      if (method === "open_url") {
        ui.onUrl(String(frame.url ?? ""), typeof frame.instructions === "string" ? frame.instructions : null);
        watchForPaste();
      } else if (method === "input") {
        const id = String(frame.id);
        if (bufferedValue !== null) {
          const value = bufferedValue;
          bufferedValue = null;
          answer(id, value);
          return;
        }
        pendingInputId = id;
        void ui.onPrompt(
          typeof frame.title === "string" ? frame.title : "Enter the authorization code",
          typeof frame.placeholder === "string" ? frame.placeholder : null,
        ).then((value) => {
          // The prompt's own answer, unless the paste watch already answered.
          if (pendingInputId === id) { pendingInputId = null; answer(id, value); }
          else bufferedValue = value;
        }).catch(() => {});
      } else if (method === "notify") {
        if (typeof frame.message === "string") ui.onProgress(frame.message);
      } else if (method === "cancel") {
        // omp withdrew its request (it got the code another way); a value
        // typed for it later is kept for the next request.
        if (pendingInputId !== null && String(frame.targetId) === pendingInputId) pendingInputId = null;
      }
    };

    child = deps.createChild(handleFrame);
    const running = child;
    const onAbort = () => { void running.dispose(); };
    ui.signal.addEventListener("abort", onAbort);
    try {
      await running.waitReady(READY_TIMEOUT_MS);
      await running.sendCommand({ type: "login", providerId }, LOGIN_TIMEOUT_MS);
      deps.afterLogin(providerId);
    } finally {
      ui.signal.removeEventListener("abort", onAbort);
      void running.dispose();
    }
  }

  async function logout(providerId: string): Promise<void> {
    const outcome = await deps.removeProvider(providerId);
    if (outcome.code) throw new Error(outcome.message ?? `Cody could not disconnect "${providerId}".`);
    forgetProviderAccountNames(providerId, getAgentDir());
    disposeUtilityRpc();
  }

  async function removeAccount(providerId: string, accountId: string): Promise<{ removed: boolean; providerRemoved: boolean }> {
    const credentialId = Number(accountId);
    if (!Number.isSafeInteger(credentialId)) throw new Error(`"${accountId}" is not a valid account id.`);
    const outcome = await deps.removeCredential(providerId, credentialId);
    if (outcome.code) throw new Error(outcome.message ?? `Cody could not remove that ${providerId} account.`);
    if (outcome.removed) forgetProviderAccountName(providerId, accountId, outcome.identity, getAgentDir());
    disposeUtilityRpc();
    return { removed: outcome.removed, providerRemoved: outcome.providerRemoved };
  }

  async function renameAccount(providerId: string, accountId: string, name: string): Promise<{ accountId: string; label: string }> {
    const credentialId = Number(accountId);
    if (!Number.isSafeInteger(credentialId)) throw new Error(`"${accountId}" is not a valid account id.`);
    const normalizedName = normalizeProviderAccountName(name);
    const snapshot = await deps.listCredentials();
    if (!snapshot.available) throw new Error(snapshot.reason ?? "OMP account details are unavailable.");
    const account = snapshot.credentials.find((row) => row.provider === providerId && row.id === credentialId);
    if (!account) throw new Error(`Cody found no "${providerId}" account matching that id.`);
    if (account.disabledCause !== null) throw new Error("Disabled account history cannot be renamed.");
    const label = setProviderAccountName(providerId, accountId, account.identity, normalizedName ?? "", getAgentDir()) ?? account.identity ?? providerId;
    return { accountId, label };
  }

  return { list, login, logout, removeAccount, renameAccount };
}

export const ompProviderLogins: ProviderLoginSurface = createOmpProviderLogins();
