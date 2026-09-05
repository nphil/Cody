"use client";

/**
 * Discovered local AI runtimes for the Providers hub: lib/local-ai.ts's
 * server-side scan (GET /api/local-ai) for Ollama, LM Studio and
 * llama.cpp / llama-swap on the machine Cody runs on — plus the Windows host
 * across the WSL2 boundary on the desktop shell, labelled origin "host".
 *
 * Read through the settings route cache, so opening the hub scans once
 * (the panel mounts on first visit) and Rescan forces a fresh probe; the
 * dialog itself opening never triggers it. Engine-neutral: the scan is
 * about Cody's own network position, not anything the engine serves.
 */
import { useCallback } from "react";
import { useSettingsRoute } from "./useSettingsData";

export type LocalAiRuntime = "ollama" | "lmstudio" | "llamacpp";
export type LocalAiOrigin = "local" | "host";

/** Structural copy of lib/local-ai.ts's LocalAiScanResult (server code). */
export interface LocalAiScanResult {
  runtime: LocalAiRuntime;
  origin: LocalAiOrigin;
  baseUrl: string;
  models: string[];
  /** Something answered but could not be read as a model list. */
  error?: string;
}

export const LOCAL_AI_ROUTE = "/api/local-ai";

const RUNTIME_LABELS: Record<LocalAiRuntime, string> = {
  ollama: "Ollama",
  lmstudio: "LM Studio",
  llamacpp: "llama.cpp",
};

/** llama.cpp's own server and llama-swap (a proxy in front of it) share the
 * "llamacpp" runtime id and are only told apart by their default port. */
export function runtimeLabel(result: Pick<LocalAiScanResult, "runtime" | "baseUrl">): string {
  if (result.runtime === "llamacpp" && result.baseUrl.endsWith(":9292")) return "llama-swap";
  return RUNTIME_LABELS[result.runtime];
}

/** The OpenAI-compatible base URL an engine wants for a discovered runtime:
 * every runtime here serves the OpenAI API under `/v1`. */
export function runtimeEndpointUrl(result: Pick<LocalAiScanResult, "baseUrl">): string {
  return `${result.baseUrl.replace(/\/+$/, "")}/v1`;
}

/** A models.yml-safe provider name for a discovered runtime. */
export function runtimeProviderName(result: Pick<LocalAiScanResult, "runtime" | "baseUrl">): string {
  return runtimeLabel(result).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
}

interface ScanBody {
  results?: LocalAiScanResult[];
  error?: string;
}

export interface LocalAiScan {
  results: LocalAiScanResult[];
  scanning: boolean;
  /** At least one scan has answered. */
  scanned: boolean;
  error: string | null;
  rescan: () => void;
}

export function useLocalAiScan(enabled = true): LocalAiScan {
  const route = useSettingsRoute<ScanBody>(LOCAL_AI_ROUTE, { enabled });
  const rescan = useCallback(() => { void route.reload(); }, [route]);
  return {
    results: Array.isArray(route.data?.results) ? route.data.results : [],
    scanning: route.loading,
    scanned: route.data !== null || route.error !== null,
    error: route.error ?? route.data?.error ?? null,
    rescan,
  };
}
