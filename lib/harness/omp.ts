import path from "path";
import { readModelsConfigFile } from "../omp/models-config";
import { getOmpVersion, resolveOmpBin } from "../omp/omp-cli";
import { getAgentDir } from "../omp/paths";
import { readNativeSettings } from "../omp/settings-config";
import { readSchemaSettings, writeSchemaSettings } from "../omp/settings-values";
import type { HarnessAdapter, ProviderDirectoryInfo } from "./types";
import { ompProviderLogins } from "../omp/provider-login";

/**
 * omp's own provider registry for the Providers hub: the custom endpoints in
 * models.yml and the registry keys of config.yml. Both reads fail soft — an
 * unparseable models.yml contributes no custom rows (the editor route
 * reports the parse error itself), and an unreadable config.yml contributes
 * no registry state — because this feeds a directory, not an editor: a
 * broken file must not take the sign-in and key rows down with it.
 */
function readOmpProviderDirectory(): ProviderDirectoryInfo {
  const info: ProviderDirectoryInfo = { modelsYmlProviders: [], disabledProviders: [], providerOrder: [] };
  try {
    const file = readModelsConfigFile();
    if (!file.parseError) {
      for (const [name, provider] of Object.entries(file.config.providers ?? {})) {
        info.modelsYmlProviders.push({
          name,
          ...(typeof provider?.api === "string" ? { api: provider.api } : {}),
          ...(typeof provider?.baseUrl === "string" ? { baseUrl: provider.baseUrl } : {}),
          modelCount: Array.isArray(provider?.models) ? provider.models.length : 0,
        });
      }
    }
  } catch {
    // A models.yml that cannot be read at all is the editor's problem to report.
  }
  try {
    const { settings } = readNativeSettings();
    info.disabledProviders = settings.disabledProviders ?? [];
    info.providerOrder = settings.modelProviderOrder ?? [];
    if (settings.registryHasScopedEntries) {
      info.readOnlyReason = "config.yml holds path-scoped registry entries that Cody cannot rewrite without losing their path rules. Edit enabledModels, disabledProviders and modelProviderOrder in the file itself.";
    }
  } catch {
    // Same policy: an invalid config.yml is reported by the Behavior hub.
  }
  return info;
}

/** The founding harness: every capability is on because the surrounding app
 * was built against omp's feature set. */
export const ompHarness: HarnessAdapter = {
  id: "omp",
  displayName: "OMP runtime",
  shortName: "OMP",
  binaryName: "omp",
  tagline: "The oh-my-pi coding agent. Cody's founding engine, every surface enabled.",
  installSpec: "@oh-my-pi/pi-coding-agent@latest",
  // Audited against the 18.1.6 changelog + full test suite with 18.1.6
  // installed: the RPC command/message types are unchanged, `usage --json`
  // still parses (its new `capacity`/`disabledCredentials` keys are ignored),
  // the settings schema picks up the new keys on its own, the removed
  // `designer` model role is gone from every surface, and the skills walk now
  // follows omp's opt-in for foreign user-level directories.
  verifiedVersion: "18.1.10",
  capabilities: {
    liveSessions: true,
    models: true,
    skills: true,
    plugins: true,
    mcp: true,
    nativeSettings: true,
    configEditor: true,
    updates: true,
    chatExtras: true,
    fastMode: true,
    advisor: true,
    subagents: true,
    // omp has memory (mnemopi, hindsight) but exposes no read-back Cody
    // can call, so the surface stays hidden rather than empty.
    memory: false,
    // Provider sign-in with the engine's own login: omp's own OAuth flows (Claude Pro/Max, ChatGPT, GitHub Copilot, …), driven over rpc-ui.
    providerLogin: true,
  },
  resolveBinary: () => resolveOmpBin(),
  getVersion: () => getOmpVersion(),
  getAgentDir: () => getAgentDir(),
  // omp's own OAuth flows, driven over a dedicated rpc-ui child
  // (lib/omp/provider-login.ts) and listed from its own /login roster.
  providerLogins: ompProviderLogins,
  providerDirectory: readOmpProviderDirectory,
  settings: {
    // omp's own settings pipeline (lib/omp/settings-schema + settings-values),
    // reached through the adapter so the route never has to know which engine
    // it is answering for. This adapter is the one place the seam allows to
    // import lib/omp directly.
    readSchema: () => readSchemaSettings(),
    write: (patch) => {
      // A whole-patch failure (no schema, an unknown path) throws out of
      // writeSchemaSettings and becomes the route's 400; per-key refusals do
      // not exist for omp, which validates the entire patch before writing.
      const written = writeSchemaSettings(patch);
      return { written, rejected: [], values: readSchemaSettings().values };
    },
  },
  getSessionsDir: () => path.join(getAgentDir(), "sessions"),
  rpcUi: {
    mode: "rpc-ui",
    resumeFlag: "--resume",
    supportsCwdFlag: true,
    supportsAdvisor: true,
    hostTools: true,
    subagentEvents: true,
    readiness: "ready-frame",
  },
};
