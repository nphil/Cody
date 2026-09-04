"use client";

/**
 * Settings › Providers: how the engine reaches a model vendor. STUB: today's
 * "API Keys & Providers" content moved here verbatim (the engine's own
 * provider sign-in, the engine-neutral provider keys, omp's models.yml
 * editor) with the old "Local AI" tab appended below, since discovered local
 * runtimes are providers too. The Providers slice replaces this with the
 * `Directory`-based Connected / Discovered lists and `ProviderDetail`.
 */
import dynamic from "next/dynamic";
import { LocalAiConfig } from "../LocalAiConfig";
import { ProviderKeysPanel } from "../ProviderKeysPanel";
import { ProviderSignInPanel } from "../ProviderSignInPanel";
import { useSettingsShell } from "../shell-context";

const PanelLoading = () => <div role="status" style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 12, padding: 20 }}>Loading settings…</div>;
const ModelsConfig = dynamic(() => import("../../ModelsConfig").then((module) => module.ModelsConfig), { loading: PanelLoading });

export function ProvidersPanel() {
  const { capabilities, engine, callbacks } = useSettingsShell();
  return (
    <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
      {/* Three parts: the engine's own provider SIGN-IN (a subscription or
          device code, kept in the engine's own store, gated on
          capabilities.providerLogin so it disappears for an engine with no
          login surface), the engine-neutral provider keys (every engine
          reads its credentials from the environment, so this exists for all
          five), and omp's own OAuth/registry editor, which only omp's file
          format serves. */}
      <div style={{ padding: 20, borderBottom: "1px solid var(--border)", display: "flex", flexDirection: "column", gap: 24 }}>
        {capabilities.providerLogin && <ProviderSignInPanel />}
        <ProviderKeysPanel />
      </div>
      {capabilities.models && (
        // A box of its own: ModelsConfig lays its body out as `flex: 1`
        // inside a column, and inside the shell's scroll column that would
        // resolve to ZERO height under ~15 key cards. A fixed tall box gives
        // it room and scrolls as one unit.
        <div style={{ flex: "0 0 auto", height: 720, display: "flex", flexDirection: "column", minHeight: 0, borderBottom: "1px solid var(--border)" }}>
          <ModelsConfig embedded engineId={engine?.id ?? null} onClose={callbacks.onClose} onSaved={callbacks.onModelsSaved} />
        </div>
      )}
      {/* Scans the network Cody itself runs on, not anything the active
          engine serves, so it stays visible on every engine. */}
      <LocalAiConfig />
    </div>
  );
}
