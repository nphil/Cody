import { readEnv } from "./env";

/**
 * Local-AI runtime discovery (docs/windows.md "Local AI runtimes").
 *
 * Probes well-known OpenAI-compatible / local model runtimes from the
 * server's own network position — Ollama, LM Studio, llama.cpp/llama-swap —
 * so Settings can show what's actually reachable instead of asking the user
 * to guess a port. Runs server-side (no CORS, honest timeouts) and benefits
 * every deployment, not just the Windows desktop shell: the same probes run
 * unchanged in the Docker container.
 *
 * When the desktop shell sets CODY_HOST_GATEWAY (its WSL2 distro's route to
 * the Windows host — an opaque host string, e.g. an IP or
 * "host.docker.internal"), the same ports are probed on that host too and
 * labeled origin "host" instead of "local". In WSL2 NAT mode a Windows-side
 * runtime bound to 127.0.0.1 (most defaults) is unreachable across that
 * boundary regardless — host-origin probes only succeed once the user has
 * made the runtime listen beyond loopback (e.g. `OLLAMA_HOST=0.0.0.0`) or
 * enabled mirrored networking. That's expected, not an error: an unreachable
 * host-origin probe fails exactly like an unreachable local one (see below).
 */

export type LocalAiRuntime = "ollama" | "lmstudio" | "llamacpp";
export type LocalAiOrigin = "local" | "host";

export interface LocalAiScanResult {
  runtime: LocalAiRuntime;
  origin: LocalAiOrigin;
  baseUrl: string;
  models: string[];
  /** Set only when something answered but couldn't be read as a model list
   * (bad JSON, unexpected shape). A probe that simply found nothing there —
   * connection refused, timed out, non-2xx — is not an error: it's the
   * expected shape of "not installed" and is left out of the results
   * entirely rather than reported. */
  error?: string;
}

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export interface LocalAiScanOptions {
  /** Injectable for tests; defaults to the global fetch. */
  fetcher?: Fetcher;
  /** Overrides the CODY_HOST_GATEWAY env lookup; pass null to force
   * local-only scanning regardless of the environment. */
  hostGateway?: string | null;
  /** Per-probe timeout in milliseconds. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 1_500;
const LOCAL_HOST = "127.0.0.1";

/**
 * Validates that a CODY_HOST_GATEWAY candidate is a bare hostname or IP —
 * exactly the shape `probeEndpoint` assumes when it interpolates `host` into
 * `http://${host}:${port}`. Without this, a value like "127.0.0.1:9999/x"
 * silently wins the port: `http://127.0.0.1:9999/x:11434/api/tags` resolves
 * to host 127.0.0.1 port 9999 (the embedded port), with the module's own
 * ":11434" reduced to part of the path — every host-origin probe would
 * redirect to an attacker- or misconfiguration-chosen host:port instead of
 * the well-known runtime ports this module intends to check.
 *
 * Round-trips the candidate through the URL parser and requires the parsed
 * hostname to reproduce the candidate exactly (case-insensitively) with no
 * port, path, credentials, query, or fragment smuggled in. Bracketed IPv6
 * literals (`[::1]`) are accepted; Node's URL keeps the brackets in
 * `hostname` for those, but the bracket-wrapped comparison is also checked
 * in case a URL implementation strips them, so this holds either way.
 *
 * Invalid input returns null and is treated exactly like "no gateway" by the
 * caller: dropped silently, without logging — the same policy an
 * unreachable probe already gets.
 */
export function sanitizeHostGateway(candidate: string): string | null {
  let url: URL;
  try {
    url = new URL(`http://${candidate}`);
  } catch {
    return null;
  }
  const lower = candidate.toLowerCase();
  const hostnameRoundTrips = url.hostname === lower || `[${url.hostname}]` === lower;
  if (!hostnameRoundTrips) return null;
  if (url.port !== "" || url.pathname !== "/" || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    return null;
  }
  return url.hostname;
}

interface EndpointSpec {
  runtime: LocalAiRuntime;
  port: number;
  path: string;
  parseModels: (data: unknown) => string[] | null;
}

/** Ollama's native "list local models" endpoint: `{ models: [{ name }] }`. */
function parseOllamaModels(data: unknown): string[] | null {
  if (!data || typeof data !== "object" || !Array.isArray((data as { models?: unknown }).models)) return null;
  const names: string[] = [];
  for (const entry of (data as { models: unknown[] }).models) {
    const name = entry && typeof entry === "object" ? (entry as { name?: unknown }).name : undefined;
    if (typeof name === "string" && name.length > 0) names.push(name);
  }
  return names;
}

/** The OpenAI-compatible `/v1/models` shape LM Studio, llama.cpp, and
 * llama-swap all answer with: `{ data: [{ id }] }`. */
function parseOpenAiModels(data: unknown): string[] | null {
  if (!data || typeof data !== "object" || !Array.isArray((data as { data?: unknown }).data)) return null;
  const ids: string[] = [];
  for (const entry of (data as { data: unknown[] }).data) {
    const id = entry && typeof entry === "object" ? (entry as { id?: unknown }).id : undefined;
    if (typeof id === "string" && id.length > 0) ids.push(id);
  }
  return ids;
}

// Well-known local endpoints, per docs/windows.md. llama.cpp's own server and
// llama-swap (a proxy in front of it) default to different ports but speak
// the same OpenAI-compatible /v1/models, so both are probed under the same
// "llamacpp" runtime id, distinguished by baseUrl.
const RUNTIME_ENDPOINTS: readonly EndpointSpec[] = [
  { runtime: "ollama", port: 11434, path: "/api/tags", parseModels: parseOllamaModels },
  { runtime: "lmstudio", port: 1234, path: "/v1/models", parseModels: parseOpenAiModels },
  { runtime: "llamacpp", port: 8080, path: "/v1/models", parseModels: parseOpenAiModels },
  { runtime: "llamacpp", port: 9292, path: "/v1/models", parseModels: parseOpenAiModels },
];

async function probeEndpoint(
  spec: EndpointSpec,
  origin: LocalAiOrigin,
  host: string,
  fetcher: Fetcher,
  timeoutMs: number,
): Promise<LocalAiScanResult | null> {
  const baseUrl = `http://${host}:${spec.port}`;
  let response: Response;
  try {
    response = await fetcher(`${baseUrl}${spec.path}`, { cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    // Connection refused, timed out, DNS failure, unreachable across the WSL
    // NAT boundary, ... — nothing answered. Expected-absent, not an error.
    return null;
  }
  if (!response.ok) return null;

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return { runtime: spec.runtime, origin, baseUrl, models: [], error: "Response was not valid JSON" };
  }

  const models = spec.parseModels(parsed);
  if (models === null) {
    return { runtime: spec.runtime, origin, baseUrl, models: [], error: "Unexpected response shape" };
  }
  return { runtime: spec.runtime, origin, baseUrl, models };
}

/**
 * Probes every well-known runtime on the server's own localhost, plus the
 * desktop shell's Windows host when a gateway is configured. All probes run
 * concurrently with a short per-probe timeout; a probe that finds nothing
 * (or something unreachable) is silently omitted rather than reported as an
 * error, so one dead port never fails the whole scan.
 */
export async function scanLocalAiRuntimes(options: LocalAiScanOptions = {}): Promise<LocalAiScanResult[]> {
  const fetcher = options.fetcher ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // undefined => not overridden by the caller, read the environment; an
  // explicit null (tests forcing local-only) skips the env lookup entirely.
  // An empty string, from either source, is a deliberate "no gateway" (same
  // ?? vs || reasoning as readEnv itself) rather than a request to probe
  // "http://:port".
  const rawGateway = options.hostGateway === undefined ? readEnv("HOST_GATEWAY") : options.hostGateway;
  const trimmedGateway = rawGateway?.trim() || undefined;
  // A value that isn't a bare hostname/IP (an embedded port, path,
  // credentials, ...) is dropped exactly like "no gateway" rather than used
  // as-is — see sanitizeHostGateway for why that matters.
  const hostGateway = trimmedGateway ? (sanitizeHostGateway(trimmedGateway) ?? undefined) : undefined;

  const probes = RUNTIME_ENDPOINTS.map((spec) => probeEndpoint(spec, "local", LOCAL_HOST, fetcher, timeoutMs));
  if (hostGateway) {
    probes.push(...RUNTIME_ENDPOINTS.map((spec) => probeEndpoint(spec, "host", hostGateway, fetcher, timeoutMs)));
  }

  const settled = await Promise.all(probes);
  return settled.filter((entry): entry is LocalAiScanResult => entry !== null);
}

interface ScanCacheState {
  entry: { data: LocalAiScanResult[]; expiresAt: number } | null;
  inFlight: Promise<LocalAiScanResult[]> | null;
}

declare global {
  var __codyLocalAiScanCache: ScanCacheState | undefined;
}

// A few seconds, not the minutes-scale TTL lib/models-cache.ts uses — this is
// throttling rapid repeats (auto-scan-on-open immediately followed by a
// manual click, several browser tabs open at once), not a real cache. Kept on
// globalThis for the same reason as rpc-manager's session registry: it must
// survive dev hot-reload.
const SCAN_CACHE_TTL_MS = 3_000;

function getScanCacheState(): ScanCacheState {
  if (!globalThis.__codyLocalAiScanCache) {
    globalThis.__codyLocalAiScanCache = { entry: null, inFlight: null };
  }
  return globalThis.__codyLocalAiScanCache;
}

/** Clears the short-lived scan cache. Exported for tests. */
export function invalidateLocalAiScanCache(): void {
  const state = getScanCacheState();
  state.entry = null;
  state.inFlight = null;
}

/**
 * The API route's front door: the same scan as {@link scanLocalAiRuntimes},
 * throttled so repeat calls within a few seconds share one probe instead of
 * re-hitting local processes every time.
 */
export function scanLocalAiRuntimesCached(options: LocalAiScanOptions = {}): Promise<LocalAiScanResult[]> {
  const state = getScanCacheState();
  if (state.entry && state.entry.expiresAt > Date.now()) return Promise.resolve(state.entry.data);
  if (state.inFlight) return state.inFlight;

  const load = scanLocalAiRuntimes(options)
    .then((data) => {
      state.entry = { data, expiresAt: Date.now() + SCAN_CACHE_TTL_MS };
      return data;
    })
    .finally(() => {
      if (state.inFlight === load) state.inFlight = null;
    });
  state.inFlight = load;
  return load;
}
