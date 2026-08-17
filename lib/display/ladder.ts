import type { DisplayCandidate } from "./types";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** Loopback names the machine the CLIENT runs on, whoever that client is. */
export function isLoopbackHost(host: string | undefined): boolean {
  return !!host && LOOPBACK_HOSTS.has(host.toLowerCase());
}

/**
 * One client's view of the server's fidelity ladder.
 *
 * The server ranks by fidelity, but three facts belong to the document alone:
 *
 *  - **Mixed content.** An `http:` candidate inside an `https:` page is
 *    hard-blocked by the browser, so it is dropped rather than probed.
 *  - **Loopback is same-machine only.** A loopback candidate IS the dev server
 *    when Cody runs beside its browser (desktop shell, on-device Android,
 *    plain `npm run dev`) — the best rung there is: real origin, no hops, no
 *    re-encode, and nothing to configure. From a REMOTE browser the identical
 *    URL means the user's own device, where a no-cors probe can succeed against
 *    an unrelated local port and frame a stranger's app. Reachability cannot
 *    distinguish those, so this is gated structurally and never probed.
 *  - **Our own hostname provably routes here**, since it is how the page
 *    loaded, so a candidate on that host outranks the rest of the direct group
 *    (LAN and Tailscale clients reach Cody under different names).
 *
 * The stream floor carries no URL and always works, so it survives every filter
 * and stays last.
 */
export function orderDisplayCandidates(
  candidates: readonly DisplayCandidate[],
  pageProtocol: string,
  pageHostname: string,
): DisplayCandidate[] {
  const localPage = isLoopbackHost(pageHostname);
  const usable = candidates.filter((candidate) => {
    if (candidate.kind === "stream") return true;
    if (!candidate.url) return false;
    if (pageProtocol === "https:" && /^http:\/\//i.test(candidate.url)) return false;
    if (isLoopbackHost(candidate.host) && !localPage) return false;
    return true;
  });
  const routable = (candidate: DisplayCandidate): boolean =>
    candidate.kind === "direct"
    && (candidate.host === pageHostname || (localPage && isLoopbackHost(candidate.host)));
  return usable.some(routable)
    ? [...usable.filter(routable), ...usable.filter((candidate) => !routable(candidate))]
    : usable;
}
