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
        // An entry that declares NO endpoint and NO models is not a provider
        // the user configured — it is an override-only entry (a `cost` or
        // `modelOverrides` block against a provider the engine already
        // knows, e.g. Cody's own pay-as-you-go price seed). Reporting it as
        // a custom endpoint invented a "connected" provider row on installs
        // that had never signed into it.
        const hasEndpoint = typeof provider?.api === "string" || typeof provider?.baseUrl === "string";
        const models = Array.isArray(provider?.models) ? provider.models.length : 0;
        if (!hasEndpoint && models === 0) continue;
        info.modelsYmlProviders.push({
          name,
          ...(typeof provider?.api === "string" ? { api: provider.api } : {}),
          ...(typeof provider?.baseUrl === "string" ? { baseUrl: provider.baseUrl } : {}),
          modelCount: models,
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
  // Audited against OMP 18.4.9's changelog and installed source, including the
  // registry-based settings schema and RPC prompt lifecycle. OMP 18.3.x
  // stays supported: every 18.4 RPC command Cody adds degrades to today's
  // behavior when the engine answers "Unknown command". 18.2 remains
  // supported through its legacy schema and prompt_result behavior.
  // Exercised through Cody's RPC bring-up checks and the Settings schema tests.
  //
  // 18.2.5 moved the terminal UI into @oh-my-pi/pi-tui and left re-exports
  // behind, which is why lib/omp/package-source follows a symbol into the
  // package that declares it: pi-tui is Bun-only and cannot be imported under
  // Node, so the source file is read the same stubbed way omp's own is.
  // `login` now REFUSES a provider whose flow needs secret input (an API key
  // typed at a prompt) instead of asking for it over RPC — the command fails
  // with the engine's own message, which Cody already surfaces in the sign-in
  // panel, and such a provider is reachable through a Cody terminal.
  //
  // 18.2.9 added Claude saved resets beside Codex's and moved the redeem
  // target's provider and grant INSIDE `target`; the reset-credit bridge
  // (bin/cody-omp-reset-credits.mjs) sends both spellings so older engines
  // still redeem. Its `claudeResets.*` settings reach the panel through the
  // schema like any other, and the auto-redeem consent prompt arrives as an
  // ordinary rpc-ui select. It also needs Bun >= 1.3.14, which the image's
  // `oven/bun:1` satisfies.
  verifiedVersion: "18.7.0",
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
