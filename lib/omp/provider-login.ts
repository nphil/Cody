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
 */
import { homedir } from "os";
import type { ProviderLoginList, ProviderLoginSurface, ProviderLoginUi } from "../harness/types";
import { invalidateModelsCache } from "../models-cache";
import { enableProvider } from "./model-roles";
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
};

export function createOmpProviderLogins(overrides: OmpProviderLoginDeps = {}): ProviderLoginSurface {
  const deps = { ...defaultDeps, ...overrides };

  async function list(): Promise<ProviderLoginList> {
    try {
      const providers = await deps.listProviders();
      return {
        providers: providers
          .filter((provider) => provider.available !== false)
          .map((provider) => ({
            id: provider.id,
            name: provider.name,
            authenticated: provider.authenticated,
            kind: "oauth" as const,
            // omp has no logout command outside its own TUI (/logout), and its
            // credential store is not Cody's to edit.
            canLogout: false,
          })),
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

  return { list, login };
}

export const ompProviderLogins: ProviderLoginSurface = createOmpProviderLogins();
