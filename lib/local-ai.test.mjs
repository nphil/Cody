import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  scanLocalAiRuntimes,
  scanLocalAiRuntimesCached,
  invalidateLocalAiScanCache,
  sanitizeHostGateway,
} = await jiti.import("./local-ai.ts");

const OLLAMA_LOCAL = "http://127.0.0.1:11434/api/tags";
const LMSTUDIO_LOCAL = "http://127.0.0.1:1234/v1/models";
const LLAMACPP_LOCAL = "http://127.0.0.1:8080/v1/models";
const LLAMASWAP_LOCAL = "http://127.0.0.1:9292/v1/models";

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A fetcher built from a { url: outcome } map, recording every URL it was
 * asked for (`.calls`) so tests can assert what was — and was not —
 * attempted, not just what came back. `outcome` is a Response, the string
 * "reject" for a network-level failure, or a function for dynamic replies. */
function makeFetcher(responses) {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push(url);
    if (init && !(init.signal instanceof AbortSignal)) {
      throw new Error(`probe for ${url} did not pass an AbortSignal`);
    }
    const outcome = responses[url];
    if (outcome === undefined) throw new Error(`no mock configured for ${url}`);
    if (outcome === "reject") throw new Error("simulated network failure");
    return typeof outcome === "function" ? outcome() : outcome;
  };
  fetcher.calls = calls;
  return fetcher;
}

test("scans the well-known local ports and parses each runtime's model list", async () => {
  const fetcher = makeFetcher({
    [OLLAMA_LOCAL]: jsonResponse({ models: [{ name: "llama3:8b" }, { name: "phi3" }] }),
    [LMSTUDIO_LOCAL]: jsonResponse({ data: [{ id: "qwen2.5-7b" }] }),
    [LLAMACPP_LOCAL]: jsonResponse({ data: [] }),
    [LLAMASWAP_LOCAL]: "reject",
  });

  const results = await scanLocalAiRuntimes({ fetcher, hostGateway: null });

  assert.deepEqual(fetcher.calls.slice().sort(), [OLLAMA_LOCAL, LMSTUDIO_LOCAL, LLAMACPP_LOCAL, LLAMASWAP_LOCAL].sort());

  const ollama = results.find((r) => r.baseUrl === "http://127.0.0.1:11434");
  assert.deepEqual(ollama, { runtime: "ollama", origin: "local", baseUrl: "http://127.0.0.1:11434", models: ["llama3:8b", "phi3"] });

  const lmstudio = results.find((r) => r.baseUrl === "http://127.0.0.1:1234");
  assert.deepEqual(lmstudio, { runtime: "lmstudio", origin: "local", baseUrl: "http://127.0.0.1:1234", models: ["qwen2.5-7b"] });

  const llamacpp = results.find((r) => r.baseUrl === "http://127.0.0.1:8080");
  assert.deepEqual(llamacpp, { runtime: "llamacpp", origin: "local", baseUrl: "http://127.0.0.1:8080", models: [] });
  assert.equal("error" in llamacpp, false, "a real, empty model list is not an error");

  // The unreachable llama-swap port is left out entirely, not reported.
  assert.equal(results.some((r) => r.baseUrl === "http://127.0.0.1:9292"), false);
  assert.equal(results.length, 3);
});

test("silently drops connection failures and non-OK responses — no entry, no error", async () => {
  const fetcher = makeFetcher({
    [OLLAMA_LOCAL]: "reject",
    [LMSTUDIO_LOCAL]: jsonResponse({ error: "internal" }, 500),
    [LLAMACPP_LOCAL]: jsonResponse({ data: [{ id: "local-model" }] }),
    [LLAMASWAP_LOCAL]: "reject",
  });

  const results = await scanLocalAiRuntimes({ fetcher, hostGateway: null });

  assert.equal(results.length, 1);
  assert.equal(results[0].runtime, "llamacpp");
  assert.equal(results[0].baseUrl, "http://127.0.0.1:8080");
  assert.deepEqual(results[0].models, ["local-model"]);
});

test("surfaces an error only when something answered but couldn't be read as a model list", async () => {
  const fetcher = makeFetcher({
    [OLLAMA_LOCAL]: new Response("not json", { status: 200 }),
    [LMSTUDIO_LOCAL]: jsonResponse({ unexpectedShape: true }),
    [LLAMACPP_LOCAL]: "reject",
    [LLAMASWAP_LOCAL]: "reject",
  });

  const results = await scanLocalAiRuntimes({ fetcher, hostGateway: null });
  assert.equal(results.length, 2);

  const ollama = results.find((r) => r.runtime === "ollama");
  assert.equal(ollama.models.length, 0);
  assert.equal(ollama.error, "Response was not valid JSON");

  const lmstudio = results.find((r) => r.runtime === "lmstudio");
  assert.deepEqual(lmstudio.models, []);
  assert.equal(lmstudio.error, "Unexpected response shape");
});

test("ignores malformed individual entries without discarding the rest of the list", async () => {
  const fetcher = makeFetcher({
    [OLLAMA_LOCAL]: jsonResponse({ models: [{ name: "good" }, { noName: true }, "oops", { name: 42 }] }),
    [LMSTUDIO_LOCAL]: jsonResponse({ data: [{ id: "good" }, {}, { id: 7 }, null] }),
    [LLAMACPP_LOCAL]: "reject",
    [LLAMASWAP_LOCAL]: "reject",
  });

  const results = await scanLocalAiRuntimes({ fetcher, hostGateway: null });
  assert.deepEqual(results.find((r) => r.runtime === "ollama").models, ["good"]);
  assert.deepEqual(results.find((r) => r.runtime === "lmstudio").models, ["good"]);
});

test("probes the same ports on the host gateway, labeled origin \"host\", alongside local", async () => {
  const gateway = "203.0.113.5";
  const fetcher = makeFetcher({
    [OLLAMA_LOCAL]: jsonResponse({ models: [{ name: "local-model" }] }),
    [LMSTUDIO_LOCAL]: "reject",
    [LLAMACPP_LOCAL]: "reject",
    [LLAMASWAP_LOCAL]: "reject",
    [`http://${gateway}:11434/api/tags`]: jsonResponse({ models: [{ name: "windows-model" }] }),
    [`http://${gateway}:1234/v1/models`]: "reject",
    [`http://${gateway}:8080/v1/models`]: "reject",
    [`http://${gateway}:9292/v1/models`]: "reject",
  });

  const results = await scanLocalAiRuntimes({ fetcher, hostGateway: gateway });

  assert.equal(fetcher.calls.length, 8, "both local and host ports are probed");
  assert.equal(results.length, 2);
  assert.deepEqual(
    results.find((r) => r.origin === "local"),
    { runtime: "ollama", origin: "local", baseUrl: "http://127.0.0.1:11434", models: ["local-model"] },
  );
  assert.deepEqual(
    results.find((r) => r.origin === "host"),
    { runtime: "ollama", origin: "host", baseUrl: `http://${gateway}:11434`, models: ["windows-model"] },
  );
});

test("a host probe that fails is silent, exactly like a local one", async () => {
  const gateway = "203.0.113.5";
  const fetcher = makeFetcher({
    [OLLAMA_LOCAL]: "reject",
    [LMSTUDIO_LOCAL]: "reject",
    [LLAMACPP_LOCAL]: "reject",
    [LLAMASWAP_LOCAL]: "reject",
    [`http://${gateway}:11434/api/tags`]: "reject",
    [`http://${gateway}:1234/v1/models`]: "reject",
    [`http://${gateway}:8080/v1/models`]: "reject",
    [`http://${gateway}:9292/v1/models`]: "reject",
  });

  const results = await scanLocalAiRuntimes({ fetcher, hostGateway: gateway });
  assert.deepEqual(results, []);
});

test("treats an unset, empty, or blank host gateway as \"no gateway\" — never probes it", async () => {
  for (const hostGateway of [undefined, null, "", "   "]) {
    const fetcher = makeFetcher({
      [OLLAMA_LOCAL]: jsonResponse({ models: [] }),
      [LMSTUDIO_LOCAL]: jsonResponse({ data: [] }),
      [LLAMACPP_LOCAL]: jsonResponse({ data: [] }),
      [LLAMASWAP_LOCAL]: jsonResponse({ data: [] }),
    });
    await scanLocalAiRuntimes({ fetcher, hostGateway });
    assert.equal(fetcher.calls.length, 4, `hostGateway=${JSON.stringify(hostGateway)} should only probe local ports`);
  }
});

test("reads CODY_HOST_GATEWAY from the environment when no override is passed", async () => {
  const previous = process.env.CODY_HOST_GATEWAY;
  process.env.CODY_HOST_GATEWAY = "198.51.100.9";
  try {
    const fetcher = makeFetcher({
      [OLLAMA_LOCAL]: "reject",
      [LMSTUDIO_LOCAL]: "reject",
      [LLAMACPP_LOCAL]: "reject",
      [LLAMASWAP_LOCAL]: "reject",
      "http://198.51.100.9:11434/api/tags": "reject",
      "http://198.51.100.9:1234/v1/models": "reject",
      "http://198.51.100.9:8080/v1/models": "reject",
      "http://198.51.100.9:9292/v1/models": "reject",
    });
    await scanLocalAiRuntimes({ fetcher });
    assert.equal(fetcher.calls.length, 8);
  } finally {
    if (previous === undefined) delete process.env.CODY_HOST_GATEWAY;
    else process.env.CODY_HOST_GATEWAY = previous;
  }
});

test("runs every probe concurrently rather than one at a time", async () => {
  let active = 0;
  let maxActive = 0;
  const fetcher = async (url) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 15));
    active -= 1;
    return url.includes("/api/tags") ? jsonResponse({ models: [] }) : jsonResponse({ data: [] });
  };

  await scanLocalAiRuntimes({ fetcher, hostGateway: null });
  assert.equal(maxActive, 4, "all four local probes should be in flight at once");
});

test("scanLocalAiRuntimesCached coalesces rapid repeat calls behind the short-lived cache", async () => {
  invalidateLocalAiScanCache();
  let calls = 0;
  const fetcher = async (url) => {
    calls += 1;
    return url.includes("/api/tags") ? jsonResponse({ models: [] }) : jsonResponse({ data: [] });
  };

  const [first, second] = await Promise.all([
    scanLocalAiRuntimesCached({ fetcher, hostGateway: null }),
    scanLocalAiRuntimesCached({ fetcher, hostGateway: null }),
  ]);
  assert.deepEqual(first, second);
  assert.equal(calls, 4, "two overlapping callers share one probe round");

  const third = await scanLocalAiRuntimesCached({ fetcher, hostGateway: null });
  assert.deepEqual(third, first);
  assert.equal(calls, 4, "a call within the cache window does not re-probe");
});

test("invalidateLocalAiScanCache forces the next call to probe again", async () => {
  invalidateLocalAiScanCache();
  let calls = 0;
  const fetcher = async (url) => {
    calls += 1;
    return url.includes("/api/tags") ? jsonResponse({ models: [] }) : jsonResponse({ data: [] });
  };

  await scanLocalAiRuntimesCached({ fetcher, hostGateway: null });
  assert.equal(calls, 4);
  invalidateLocalAiScanCache();
  await scanLocalAiRuntimesCached({ fetcher, hostGateway: null });
  assert.equal(calls, 8, "invalidation makes the next call probe fresh instead of serving the cached result");
});

// --- sanitizeHostGateway: CODY_HOST_GATEWAY must be a bare hostname/IP ---
// (see lib/local-ai.ts for the "127.0.0.1:9999/x" port-injection this guards).

test("sanitizeHostGateway accepts bare hostnames and IPs unchanged", () => {
  for (const value of ["127.0.0.1", "203.0.113.5", "host.docker.internal", "windows-host"]) {
    assert.equal(sanitizeHostGateway(value), value);
  }
});

test("sanitizeHostGateway accepts bracketed IPv6 literals", () => {
  assert.equal(sanitizeHostGateway("[::1]"), "[::1]");
  assert.equal(sanitizeHostGateway("[fe80::1]"), "[fe80::1]");
  assert.equal(sanitizeHostGateway("[2001:db8::1]"), "[2001:db8::1]");
});

test("sanitizeHostGateway normalizes case", () => {
  assert.equal(sanitizeHostGateway("Windows-Host.LOCAL"), "windows-host.local");
});

test("sanitizeHostGateway drops values carrying an embedded port", () => {
  assert.equal(sanitizeHostGateway("127.0.0.1:9999"), null);
  assert.equal(sanitizeHostGateway("127.0.0.1:9999/x"), null, "the exact hostile value from the finding");
});

test("sanitizeHostGateway drops values carrying a path", () => {
  assert.equal(sanitizeHostGateway("evil.com/x"), null);
  assert.equal(sanitizeHostGateway("evil.com/"), null);
});

test("sanitizeHostGateway drops values carrying credentials", () => {
  assert.equal(sanitizeHostGateway("user@evil.com"), null);
  assert.equal(sanitizeHostGateway("user:pass@evil.com"), null);
});

test("sanitizeHostGateway drops values carrying a query or fragment", () => {
  assert.equal(sanitizeHostGateway("127.0.0.1?x=1"), null);
  assert.equal(sanitizeHostGateway("127.0.0.1#frag"), null);
});

test("sanitizeHostGateway drops values containing whitespace", () => {
  assert.equal(sanitizeHostGateway("127.0.0.1 evil.com"), null);
  assert.equal(sanitizeHostGateway("127.0.0.1\tevil.com"), null);
});

test("sanitizeHostGateway drops values carrying a scheme prefix", () => {
  assert.equal(sanitizeHostGateway("http://127.0.0.1"), null);
  assert.equal(sanitizeHostGateway("https://evil.com"), null);
});

test("sanitizeHostGateway drops unbracketed IPv6 and unparseable input", () => {
  assert.equal(sanitizeHostGateway("::1"), null);
  assert.equal(sanitizeHostGateway("2001:db8::1"), null);
  assert.equal(sanitizeHostGateway(""), null);
});

test("a hostile CODY_HOST_GATEWAY value performs zero host-origin fetches", async () => {
  const fetcher = makeFetcher({
    [OLLAMA_LOCAL]: jsonResponse({ models: [] }),
    [LMSTUDIO_LOCAL]: jsonResponse({ data: [] }),
    [LLAMACPP_LOCAL]: jsonResponse({ data: [] }),
    [LLAMASWAP_LOCAL]: jsonResponse({ data: [] }),
  });

  const results = await scanLocalAiRuntimes({ fetcher, hostGateway: "127.0.0.1:9999/x" });

  // Only the four local probes ran — no request was ever made against the
  // attacker-chosen port 9999, or anywhere derived from the hostile value.
  assert.equal(fetcher.calls.length, 4);
  for (const call of fetcher.calls) {
    assert.ok(!call.includes("9999"), `${call} must not touch the injected port`);
  }
  assert.equal(results.every((r) => r.origin === "local"), true, "no \"host\"-origin result should appear");
});

test("an invalid CODY_HOST_GATEWAY is dropped like an absent one — same result either way", async () => {
  const makeLocalOnlyFetcher = () => makeFetcher({
    [OLLAMA_LOCAL]: jsonResponse({ models: [{ name: "m" }] }),
    [LMSTUDIO_LOCAL]: "reject",
    [LLAMACPP_LOCAL]: "reject",
    [LLAMASWAP_LOCAL]: "reject",
  });

  const withHostileValue = await scanLocalAiRuntimes({ fetcher: makeLocalOnlyFetcher(), hostGateway: "user@evil.com:1/x" });
  const withNoGateway = await scanLocalAiRuntimes({ fetcher: makeLocalOnlyFetcher(), hostGateway: null });
  assert.deepEqual(withHostileValue, withNoGateway);
});
