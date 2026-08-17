"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Check, Copy, Cpu, Loader2, RefreshCw } from "lucide-react";
import { useCopyFeedback } from "@/hooks/useCopyFeedback";
import { chipStyle } from "./primitives";

/**
 * The "Local AI" settings tab. Triggers lib/local-ai.ts's server-side scan
 * (GET /api/local-ai) for well-known local/OpenAI-compatible runtimes —
 * Ollama, LM Studio, llama.cpp/llama-swap — and lists whatever answered.
 * Always visible, including on a headless Docker install; on the desktop
 * shell the same scan additionally probes the Windows host across the WSL2
 * boundary (docs/windows.md "Local AI runtimes"), labeled origin
 * "Windows host" below instead of "local".
 *
 * This tab does not configure a provider itself — that flow already exists
 * (Settings → API Keys & Providers → + Add provider → OpenAI / Anthropic
 * compatible, see ModelsConfig.tsx / setup-wizard-providers.tsx) — it only
 * helps find the base URL to paste there.
 */

type LocalAiRuntime = "ollama" | "lmstudio" | "llamacpp";
type LocalAiOrigin = "local" | "host";

interface LocalAiScanResult {
  runtime: LocalAiRuntime;
  origin: LocalAiOrigin;
  baseUrl: string;
  models: string[];
  error?: string;
}

// Structural copy of InfoResponse["platformInfo"] (app/api/info/route.ts) —
// same reasoning as EngineCapabilities in SettingsTabs.tsx: no client
// component should have to import server code just for a shape.
interface PlatformInfo {
  desktop: boolean;
}

const RUNTIME_LABELS: Record<LocalAiRuntime, string> = {
  ollama: "Ollama",
  lmstudio: "LM Studio",
  llamacpp: "llama.cpp",
};

/** llama.cpp's own server and llama-swap (a proxy in front of it) share the
 * "llamacpp" runtime id and are only told apart by their default port. */
function runtimeLabel(result: LocalAiScanResult): string {
  if (result.runtime === "llamacpp" && result.baseUrl.endsWith(":9292")) return "llama-swap";
  return RUNTIME_LABELS[result.runtime];
}

function ResultRow({ result }: { result: LocalAiScanResult }) {
  const { copied, copy } = useCopyFeedback();
  return (
    <div style={{ padding: "12px 14px", border: "1px solid var(--border)", borderRadius: "var(--radius-card)", background: "var(--bg-panel)", display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)" }}>{runtimeLabel(result)}</span>
          {/* origin is "local" or "host" — kept generic rather than saying
              "Windows host": CODY_HOST_GATEWAY isn't exclusive to the desktop
              shell (e.g. a Docker operator can point it at host.docker.internal
              too), so the badge shouldn't presume which host it is. */}
          <span style={chipStyle}>{result.origin}</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <code style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>{result.baseUrl}</code>
          <button
            type="button"
            onClick={() => copy(result.baseUrl)}
            aria-label={`Copy base URL ${result.baseUrl}`}
            style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 7px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-subtle)", color: "var(--text)", cursor: "pointer", fontSize: 11 }}
          >
            {copied ? <Check size={11} aria-hidden="true" /> : <Copy size={11} aria-hidden="true" />}
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </div>
      {result.error ? (
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--status-warning)" }}>
          <AlertTriangle size={12} aria-hidden="true" /> {result.error}
        </div>
      ) : result.models.length > 0 ? (
        <div style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5 }}>{result.models.join(", ")}</div>
      ) : (
        <div style={{ fontSize: 11, color: "var(--text-dim)" }}>Running, but no models are loaded yet.</div>
      )}
    </div>
  );
}

export function LocalAiConfig() {
  const [results, setResults] = useState<LocalAiScanResult[]>([]);
  const [scanning, setScanning] = useState(true);
  const [hasScanned, setHasScanned] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [platform, setPlatform] = useState<PlatformInfo>({ desktop: false });

  const scan = useCallback(async () => {
    setScanning(true);
    setScanError(null);
    try {
      const response = await fetch("/api/local-ai", { cache: "no-store" });
      const data = (await response.json()) as { results?: LocalAiScanResult[]; error?: string };
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      setResults(Array.isArray(data.results) ? data.results : []);
      if (data.error) setScanError(data.error);
    } catch (error) {
      setScanError(error instanceof Error ? error.message : String(error));
    } finally {
      setScanning(false);
      setHasScanned(true);
    }
  }, []);

  // Auto-scan the first time this tab is opened. The component only mounts
  // once the tab is visited (SettingsConfig.tsx's visitedTabs gate keeps it
  // mounted afterward), so a plain mount effect is "on open," not "on every
  // render."
  useEffect(() => { void scan(); }, [scan]);

  // Platform facts aren't threaded down as a prop (this tab is the only
  // settings surface that needs them so far), so fetch the same read-only
  // /api/info the rest of the app uses. Cosmetic only: a failed fetch just
  // leaves this tab looking like a web/Docker deployment.
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/info", { cache: "no-store", signal: controller.signal })
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { platformInfo?: { desktop?: boolean } } | null) => {
        if (data?.platformInfo?.desktop === true) setPlatform({ desktop: true });
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);

  return (
    <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>Local AI</h3>
        <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--text-muted)" }}>
          Scans well-known ports for Ollama, LM Studio, and llama.cpp / llama-swap right where Cody itself is running
          {platform.desktop ? ", plus the same ports on the Windows host" : ""}.
        </p>
      </div>

      {platform.desktop && (
        <p style={{ margin: 0, fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5 }}>
          Windows-side runtimes must be configured to listen beyond localhost to be reachable here — e.g. Ollama: set{" "}
          <code style={{ fontFamily: "var(--font-mono)" }}>OLLAMA_HOST=0.0.0.0</code>.
        </p>
      )}

      <p style={{ margin: 0, fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5 }}>
        To use a runtime found below as a model provider, copy its base URL into{" "}
        <strong style={{ color: "var(--text)", fontWeight: 600 }}>Settings → API Keys & Providers → + Add provider → OpenAI / Anthropic compatible</strong>
        {" "}(append <code style={{ fontFamily: "var(--font-mono)" }}>/v1</code> to the URL).
      </p>

      {platform.desktop && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", border: "1px solid var(--border)", borderRadius: "var(--radius-card)", background: "var(--bg-panel)", fontSize: 11, color: "var(--text-dim)" }}>
          <Cpu size={13} aria-hidden="true" style={{ flexShrink: 0 }} />
          {/* EXTENSION POINT: once the desktop shell's `desktop_info` IPC
              command is wired up client-side (docs/windows.md IPC surface —
              { gpu: { vendor, name } | null }), replace this placeholder
              with the real GPU line. Deliberately out of scope here. */}
          <span>GPU: not reported yet — wires up once the desktop shell&apos;s GPU bridge lands.</span>
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <button
          type="button"
          onClick={() => void scan()}
          disabled={scanning}
          style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 12px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-subtle)", color: "var(--text)", cursor: scanning ? "wait" : "pointer", fontSize: 12 }}
        >
          {scanning ? <Loader2 size={13} aria-hidden="true" style={{ animation: "spin 0.8s linear infinite" }} /> : <RefreshCw size={13} aria-hidden="true" />}
          {scanning ? "Scanning…" : "Scan"}
        </button>
        {scanError && <span role="alert" style={{ fontSize: 11, color: "var(--status-error)" }}>{scanError}</span>}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {results.length === 0 && hasScanned && !scanning && !scanError && (
          <p style={{ margin: 0, fontSize: 12, color: "var(--text-dim)" }}>
            Nothing detected. Make sure Ollama, LM Studio, or llama.cpp is running, then scan again.
          </p>
        )}
        {results.map((result) => (
          <ResultRow key={`${result.origin}-${result.baseUrl}`} result={result} />
        ))}
      </div>
    </div>
  );
}
