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
 * each route actually calls the invalidation.
 */
const loginRoute = await readFile(new URL("../app/api/auth/login/[provider]/route.ts", import.meta.url), "utf8");
const logoutRoute = await readFile(new URL("../app/api/auth/logout/[provider]/route.ts", import.meta.url), "utf8");

test("both routes import the invalidation from the provider-directory server module", () => {
  assert.match(loginRoute, /import \{ invalidateProviderLoginsCache \} from "@\/lib\/provider-directory-server";/);
  assert.match(logoutRoute, /import \{ invalidateProviderLoginsCache \} from "@\/lib\/provider-directory-server";/);
});

test("login calls it on the SAME success path as invalidateModelsCache, after the engine's own login resolves", () => {
  const success = loginRoute.slice(loginRoute.indexOf("await surface.login(provider, ui);"), loginRoute.indexOf('send({ type: "success" });') + 1);
  assert.match(success, /invalidateModelsCache\(\);/);
  assert.match(success, /invalidateProviderLoginsCache\(engine\.id\);/);
});

test("logout calls it after the engine's own logout resolves, before answering ok", () => {
  const success = logoutRoute.slice(logoutRoute.indexOf("await surface.logout(provider);"), logoutRoute.indexOf("return NextResponse.json({ ok: true, provider });") + 1);
  assert.match(success, /invalidateModelsCache\(\);/);
  assert.match(success, /invalidateProviderLoginsCache\(engine\.id\);/);
});
