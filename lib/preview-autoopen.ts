import { normalizePreviewUrl } from "./preview-url";

/**
 * Decides when a loopback URL mentioned by the assistant should auto-open the
 * Preview panel. Pure orchestration — the probe, the panel, and time itself
 * are injected so the policy is unit-testable:
 *
 * - A URL only opens the panel once something actually answers there
 *   (a merely-mentioned "you could run npm run dev" URL stays quiet), with a
 *   short retry ladder so a dev server that is still booting when the
 *   assistant prints its URL is not missed.
 * - Each (session, url) pair auto-opens at most once; an explicit
 *   open_preview host-tool call marks the pair handled so the model's
 *   follow-up prose does not re-open a panel the user closed.
 * - A session switch abandons pending probes instead of popping another
 *   session's app over the current one.
 */

export interface PreviewAutoOpenerOptions {
  /** True when something answers at the URL (see probeLoopbackUrl). */
  probe: (url: string) => Promise<boolean>;
  /** Open the Preview panel at the URL. Only called for reachable URLs. */
  open: (url: string, sessionId: string | null) => void;
  /** False once the user has moved to a different session. */
  isSessionActive: (sessionId: string | null) => boolean;
  /** Injectable clock for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Delay before each probe attempt; length = number of attempts. */
  retryDelaysMs?: readonly number[];
  /** Bound on remembered (session, url) pairs; oldest forgotten first. */
  maxTrackedKeys?: number;
}

export interface PreviewAutoOpener {
  /** Consider assistant-mentioned URLs (already or not yet normalized). */
  offer(urls: readonly string[], sessionId: string | null): void;
  /** Record an explicit open so later mentions of the URL stay quiet. */
  markHandled(url: string, sessionId: string | null): void;
}

const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [0, 2_000, 5_000, 10_000];
const DEFAULT_MAX_TRACKED_KEYS = 256;

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function pairKey(sessionId: string | null, url: string): string {
  return `${sessionId ?? "new"}\u0000${url}`;
}

export function createPreviewAutoOpener(options: PreviewAutoOpenerOptions): PreviewAutoOpener {
  const sleep = options.sleep ?? defaultSleep;
  const retryDelays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const maxTracked = options.maxTrackedKeys ?? DEFAULT_MAX_TRACKED_KEYS;
  // Insertion-ordered so the oldest pair can be evicted; a Set iterates in
  // insertion order, which is all the FIFO bound needs.
  const handled = new Set<string>();
  const inFlight = new Set<string>();

  const remember = (key: string): void => {
    handled.add(key);
    while (handled.size > maxTracked) {
      const oldest = handled.values().next().value;
      if (oldest === undefined) break;
      handled.delete(oldest);
    }
  };

  const attempt = async (key: string, url: string, sessionId: string | null): Promise<void> => {
    try {
      for (const delay of retryDelays) {
        if (delay > 0) await sleep(delay);
        // Abandon quietly: the pair stays un-handled so a fresh mention in a
        // later turn (or after switching back) gets a fresh chance.
        if (!options.isSessionActive(sessionId)) return;
        // Opened meanwhile by an explicit host-tool call.
        if (handled.has(key)) return;
        if (await options.probe(url)) {
          if (!options.isSessionActive(sessionId) || handled.has(key)) return;
          remember(key);
          options.open(url, sessionId);
          return;
        }
      }
    } finally {
      inFlight.delete(key);
    }
  };

  return {
    offer(urls, sessionId) {
      for (const raw of urls) {
        const url = normalizePreviewUrl(raw);
        if (!url) continue;
        const key = pairKey(sessionId, url);
        if (handled.has(key) || inFlight.has(key)) continue;
        inFlight.add(key);
        void attempt(key, url, sessionId);
      }
    },
    markHandled(url, sessionId) {
      const normalized = normalizePreviewUrl(url);
      if (!normalized) return;
      remember(pairKey(sessionId, normalized));
    },
  };
}
