/**
 * omp's provider sign-in, behind the engine-neutral `ProviderLoginSurface`.
 *
 * omp keeps subscription credentials in its own encrypted store and runs the
 * OAuth flows itself; over rpc-ui they surface as extension UI frames on a
 * dedicated `omp --mode rpc-ui` child: `open_url` carries the sign-in URL,
 * `input` asks for the pasted code or redirect URL, `notify` reports
 * progress, and the `login` command resolves once the credential is stored.
 * The list comes from omp's own `get_login_providers` (its /login list), so
 * nothing here names a provider.
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

async function listOmpLoginProviders(): Promise<ProviderLoginList> {
  try {
    const { providers } = await runUtilityCommand<{ providers: OmpLoginProvider[] }>({ type: "get_login_providers" }, 30_000);
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

async function loginWithOmp(providerId: string, ui: ProviderLoginUi): Promise<void> {
  // A value pasted before omp asks for it (the paste box is on screen from
  // the first URL) answers the first input request the moment it arrives.
  let bufferedValue: string | null = null;
  let proc: RpcProcess | null = null;

  const handleFrame = (frame: RpcFrame) => {
    if (frame.type !== "extension_ui_request") return;
    const method = frame.method;
    if (method === "open_url") {
      ui.onUrl(String(frame.url ?? ""), typeof frame.instructions === "string" ? frame.instructions : null);
      void ui.onManualInput().then((value) => { bufferedValue = value; }).catch(() => {});
    } else if (method === "input") {
      const id = String(frame.id);
      if (bufferedValue !== null) {
        const value = bufferedValue;
        bufferedValue = null;
        proc?.sendFrame({ type: "extension_ui_response", id, value });
        return;
      }
      void ui.onPrompt(
        typeof frame.title === "string" ? frame.title : "Enter the authorization code",
        typeof frame.placeholder === "string" ? frame.placeholder : null,
      ).then((value) => { proc?.sendFrame({ type: "extension_ui_response", id, value }); }).catch(() => {});
    } else if (method === "notify") {
      if (typeof frame.message === "string") ui.onProgress(frame.message);
    }
  };

  proc = new RpcProcess({ cwd: homedir(), extraArgs: LOGIN_EXTRA_ARGS, onFrame: handleFrame });
  const child = proc;
  const onAbort = () => { void child.dispose(); };
  ui.signal.addEventListener("abort", onAbort);
  try {
    await child.waitReady(READY_TIMEOUT_MS);
    await child.sendCommand({ type: "login", providerId }, LOGIN_TIMEOUT_MS);
    // The new credential changes which models resolve: drop every cached
    // answer that predates it, and make sure the provider is not disabled in
    // config.yml, or the sign-in would change nothing visible.
    enableProvider(providerId);
    invalidateModelsCache();
    disposeUtilityRpc();
  } finally {
    ui.signal.removeEventListener("abort", onAbort);
    void child.dispose();
  }
}

export const ompProviderLogins: ProviderLoginSurface = {
  list: listOmpLoginProviders,
  login: loginWithOmp,
};
