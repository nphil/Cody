import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

/**
 * The theme follows the ACCOUNT, not the browser.
 *
 * It used to live only in localStorage, which is per browser and per origin:
 * a theme picked on the desktop never reached the phone, and Safari and the
 * home-screen app on the same phone did not even share it with each other.
 * The owner's phone kept opening on the light default while they believed the
 * dark theme was active.
 */
process.env.CODY_ACCOUNTS_DIR = mkdtempSync(join(tmpdir(), "cody-theme-pref-"));
delete process.env.CODY_PASSWORD;
delete process.env.OMP_WEB_PASSWORD;

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const users = await jiti.import("./users.ts");
const { issueSessionToken, SESSION_COOKIE_NAME } = await jiti.import("./session.ts");
const { hashPassword } = await jiti.import("./password.ts");
const meRoute = await jiti.import("../../app/api/accounts/me/route.ts");

const user = users.createUser({ username: "nate", fullName: "Nate", passwordHash: await hashPassword("long enough"), role: "admin" });
const cookie = `${SESSION_COOKIE_NAME}=${issueSessionToken(user)}`;

const patch = (body) => meRoute.PATCH(new Request("http://cody.test/api/accounts/me", {
  method: "PATCH",
  headers: { "Content-Type": "application/json", Cookie: cookie },
  body: JSON.stringify(body),
}));

test("a theme pick is saved to the account and read back", async () => {
  const response = await patch({ theme: "nord-dark" });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).user.theme, "nord-dark");
  // Persisted, not merely echoed: a fresh read of the store sees it.
  assert.equal(users.findUserById(user.id).preferences.theme, "nord-dark");
  const me = await meRoute.GET(new Request("http://cody.test/api/accounts/me", { headers: { Cookie: cookie } }));
  assert.equal((await me.json()).user.theme, "nord-dark");
});

test("only a theme the catalog knows is stored", async () => {
  const response = await patch({ theme: "not-a-theme" });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, "unknown_theme");
  assert.equal(users.findUserById(user.id).preferences.theme, "nord-dark", "the previous choice survives a bad request");
});

test("the profile form's fullName-only save still works, and leaves the theme alone", async () => {
  const response = await patch({ fullName: "Nate P" });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.user.fullName, "Nate P");
  assert.equal(body.user.theme, "nord-dark");
  // An empty patch is a client bug, not a no-op success.
  assert.equal((await patch({})).status, 400);
});

test("a signed-out pick is refused rather than stored against nobody", async () => {
  const response = await meRoute.PATCH(new Request("http://cody.test/api/accounts/me", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ theme: "nord-dark" }),
  }));
  assert.equal(response.status, 401);
});

test("an account with no saved theme reports null, never a default", async () => {
  // Null lets the page fall through to the browser's choice and then the
  // device's colour scheme; a default here would override both.
  const other = users.createUser({ username: "guest", fullName: "Guest", passwordHash: await hashPassword("long enough"), role: "member" });
  assert.equal(users.toPublicUser(other).theme, null);
});
