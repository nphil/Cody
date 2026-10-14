import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * `invalidateProviderLoginsCache` (lib/provider-directory-server.ts) had zero
 * callers: `/api/providers?cached=1` (the rail's status line) kept serving
 * the pre-sign-in/sign-out roster for at least the cached read's 15s peek
 * window after a real sign-in or sign-out. A behavioral test would need a
 * working `providerLogins` harness stub for both routes' SSE/POST flows;
 * this pins the cheaper, still-real regression: that the success path of
 * each route actually reaches the invalidation. Login calls it itself;
 * sign-out (all of a provider, or one account) goes through
 * `settleProviderChange` (lib/provider-state.ts), which drops the models
 * cache and the roster together and restarts idle engines.
 */
const loginRoute = await readFile(new URL("../app/api/auth/login/[provider]/route.ts", import.meta.url), "utf8");
const logoutRoute = await readFile(new URL("../app/api/auth/logout/[provider]/route.ts", import.meta.url), "utf8");
const providerState = await readFile(new URL("./provider-state.ts", import.meta.url), "utf8");

test("login imports the invalidation; logout reaches it through settleProviderChange, which imports it", () => {
  assert.match(loginRoute, /import \{ invalidateProviderLoginsCache \} from "@\/lib\/provider-directory-server";/);
  assert.match(logoutRoute, /import \{ settleProviderChange \} from "@\/lib\/provider-state";/);
  assert.match(providerState, /import \{ invalidateProviderLoginsCache \} from "\.\/provider-directory-server";/);
});

test("login calls it on the SAME success path as invalidateModelsCache, after the engine's own login resolves", () => {
  const success = loginRoute.slice(loginRoute.indexOf("await surface.login(provider, ui);"), loginRoute.indexOf('send({ type: "success" });') + 1);
  assert.match(success, /invalidateModelsCache\(\);/);
  assert.match(success, /invalidateProviderLoginsCache\(engine\.id\);/);
});

/** The route's source from `start` to the first `end` AFTER it. */
function between(source, start, end) {
  const from = source.indexOf(start);
  assert.ok(from >= 0, `route has ${start}`);
  const to = source.indexOf(end, from);
  assert.ok(to > from, `${end} follows ${start}`);
  return source.slice(from, to + end.length);
}

test("logout settles the change after the engine's own logout resolves, before answering ok", () => {
  const success = between(logoutRoute, "await surface.logout(provider);", "return NextResponse.json({ ok: true, provider");
  assert.match(success, /await settleProviderChange\(\{ engineId: engine\.id, removedProviders: \[provider\] \}\);/);
});

test("removing one account settles the change too, after the engine's own removal resolves", () => {
  const success = between(logoutRoute, "await surface.removeAccount(provider, accountId);", "return NextResponse.json({ ok: true, provider, accountId");
  assert.match(success, /await settleProviderChange\(\{/);
});

test("settleProviderChange drops the models cache and the sign-in roster together", () => {
  assert.match(providerState, /invalidateModelsCache\(\);\s*\n\s*invalidateProviderLoginsCache\(change\.engineId\);/);
});
