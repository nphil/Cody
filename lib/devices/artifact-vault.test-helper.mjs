import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

/**
 * A `fetch` that talks to the real artifact-vault handlers in this process, so the page's uploader, the store and the
 * server's routes are exercised together, with faults the network can really produce: a dropped connection, a body
 * that arrives damaged, an answer that is lost after the server acted on the request.
 *
 * Call `await setupFakeServer()` once per test file (it points the accounts directory at a scratch directory so every
 * chat is open to the caller) and `fakeServer(options)` for each scenario.
 */
export async function setupFakeServer() {
  const scratch = mkdtempSync(join(tmpdir(), "cody-fake-server-"));
  process.env.PI_CODING_AGENT_DIR = join(scratch, "agent");
  process.env.CODY_ACCOUNTS_DIR = join(scratch, "accounts");
  delete process.env.CODY_PASSWORD;
  delete process.env.CODY_REQUIRE_ACCOUNTS;
  delete process.env.OMP_WEB_PASSWORD;
  const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
  const http = await jiti.import("./artifact-vault-http.ts");
  const vault = await jiti.import("./artifact-vault.ts");
  let counter = 0;
  return {
    scratch,
    http,
    vault,
    fakeServer(limits = {}) {
      counter += 1;
      const config = { root: join(scratch, `vault-${counter}`), limits: { ...vault.DEFAULT_VAULT_LIMITS, minFreeBytes: 0, ...limits } };
      const log = [];
      const faults = { network: 0, lostAnswers: 0, corrupt: 0, status: [] };
      const route = async (request, method, path) => {
        const saveId = /^\/api\/devices\/artifacts\/saves\/([^/]+)$/.exec(path)?.[1];
        if (path === "/api/devices/artifacts/saves") return method === "POST" ? http.handleBegin(request, config) : http.handleList(request, config);
        if (saveId === undefined) return new Response("not found", { status: 404 });
        if (method === "GET") return http.handleStatus(request, saveId, config);
        if (method === "PUT") return http.handleSlice(request, saveId, config);
        if (method === "DELETE") return http.handleDelete(request, saveId, config);
        return http.handleAction(request, saveId, config);
      };
      const fetch = async (input, init = {}) => {
        const url = new URL(typeof input === "string" ? input : input.url, "http://cody.test");
        const method = init.method ?? "GET";
        if (init.signal?.aborted) throw new DOMException("This operation was aborted", "AbortError");
        log.push({ method, path: url.pathname, search: url.search });
        if (faults.network > 0) {
          faults.network -= 1;
          throw new TypeError("fetch failed");
        }
        const forced = faults.status.shift();
        if (forced) return Response.json({ error: forced.error ?? "refused", ...(forced.code ? { code: forced.code } : {}) }, { status: forced.status });
        const headers = new Headers(init.headers);
        let body = init.body;
        if (body instanceof Blob) {
          let bytes = Buffer.from(await body.arrayBuffer());
          if (method === "PUT" && faults.corrupt > 0) {
            faults.corrupt -= 1;
            bytes = Buffer.from(bytes);
            bytes[0] ^= 0xff;
          }
          headers.set("content-length", String(bytes.length));
          body = bytes;
        }
        const request = new Request(url, { method, headers, ...(body === undefined ? {} : { body }) });
        const response = await route(request, method, url.pathname);
        if (faults.lostAnswers > 0 && method !== "GET") {
          faults.lostAnswers -= 1;
          throw new TypeError("fetch failed: the answer never arrived");
        }
        return response;
      };
      return { fetch, config, log, faults };
    },
  };
}
