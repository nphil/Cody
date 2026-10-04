import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * An answer button's token is the only credential on an unauthenticated POST,
 * so what matters is everything that must NOT verify: a changed byte, an expired
 * one, another key's, a token spent once already.
 */
const root = mkdtempSync(join(tmpdir(), "cody-notify-tokens-"));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
process.env.CODY_ACCOUNTS_DIR = join(root, "accounts");
delete process.env.CODY_PASSWORD;

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const tokens = await jiti.import("./tokens.ts");
const paths = await jiti.import("../auth/paths.ts");

const NOW = 1_700_000_000_000;
const input = { sid: "sess-1", rid: "req-1", u: "user-1", k: "ui", d: "digest0123456789a", a: { confirmed: true } };

const decode = (token) => JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString("utf8"));
const reencode = (payload, signature) => `${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${signature}`;

test("a token verifies to exactly what it was issued for", () => {
  const verdict = tokens.verifyAnswerToken(tokens.issueAnswerToken(input, NOW), NOW + 1_000);
  assert.equal(verdict.ok, true);
  assert.deepEqual({ ...verdict.payload, n: undefined, exp: undefined }, { v: 1, ...input, n: undefined, exp: undefined });
  assert.equal(typeof verdict.payload.n, "string");
});

test("the signing key is created once, private, and survives (a second token verifies against the same key)", () => {
  const file = paths.getNotificationsSecretPath();
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const before = readFileSync(file, "utf8");
  tokens.issueAnswerToken(input, NOW);
  assert.equal(readFileSync(file, "utf8"), before, "issuing never rewrites the key");
  assert.ok(Buffer.from(before, "base64").length >= 32);
});

test("changing the payload voids the signature", () => {
  const token = tokens.issueAnswerToken(input, NOW);
  const signature = token.split(".")[1];
  for (const mutate of [
    (p) => ({ ...p, a: { confirmed: false } }),
    (p) => ({ ...p, rid: "req-2" }),
    (p) => ({ ...p, sid: "sess-2" }),
    (p) => ({ ...p, u: "user-2" }),
    (p) => ({ ...p, exp: p.exp + 10 * 24 * 3600_000 }),
    (p) => ({ ...p, k: "permission" }),
  ]) {
    const forged = reencode(mutate(decode(token)), signature);
    assert.deepEqual(tokens.verifyAnswerToken(forged, NOW), { ok: false, reason: "signature" });
  }
});

test("changing the signature voids it too, whatever the damage", () => {
  const token = tokens.issueAnswerToken(input, NOW);
  const [payload, signature] = token.split(".");
  const flipped = `${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
  for (const bad of [`${payload}.${flipped}`, `${payload}.${signature.slice(0, -2)}`, `${payload}.${signature}AA`, `${payload}.`, `.${signature}`, payload, `${payload}.${signature}.extra`]) {
    assert.equal(tokens.verifyAnswerToken(bad, NOW).ok, false, bad.slice(-20));
  }
});

test("non-tokens are malformed, never an exception", () => {
  for (const bad of [undefined, null, 5, {}, [], "", "x", "a.b", "..", "a".repeat(5000), "%%%.%%%"]) {
    assert.equal(tokens.verifyAnswerToken(bad, NOW).ok, false);
  }
});

test("a token signed by another key does not verify (rotating the secret kills every outstanding button)", async () => {
  const token = tokens.issueAnswerToken(input, NOW);
  assert.equal(tokens.verifyAnswerToken(token, NOW).ok, true);
  const foreign = join(root, "other-accounts");
  const previous = process.env.CODY_ACCOUNTS_DIR;
  process.env.CODY_ACCOUNTS_DIR = foreign;
  try {
    assert.deepEqual(tokens.verifyAnswerToken(token, NOW), { ok: false, reason: "signature" });
    const own = tokens.issueAnswerToken(input, NOW);
    assert.equal(tokens.verifyAnswerToken(own, NOW).ok, true, "a second directory gets its own key");
  } finally {
    process.env.CODY_ACCOUNTS_DIR = previous;
  }
  assert.equal(tokens.verifyAnswerToken(token, NOW).ok, true);
});

test("a token lasts until its request does, and never more than 24 hours", () => {
  const withDeadline = tokens.issueAnswerToken({ ...input, expiresAt: NOW + 60_000 }, NOW);
  assert.equal(decode(withDeadline).exp, NOW + 60_000);
  assert.equal(tokens.verifyAnswerToken(withDeadline, NOW + 59_999).ok, true);
  assert.deepEqual(tokens.verifyAnswerToken(withDeadline, NOW + 60_000), { ok: false, reason: "expired" });

  const noDeadline = tokens.issueAnswerToken(input, NOW);
  assert.equal(decode(noDeadline).exp, NOW + 24 * 3600_000);
  assert.equal(tokens.verifyAnswerToken(noDeadline, NOW + 24 * 3600_000 - 1).ok, true);
  assert.equal(tokens.verifyAnswerToken(noDeadline, NOW + 24 * 3600_000).reason, "expired");

  const farFuture = tokens.issueAnswerToken({ ...input, expiresAt: NOW + 30 * 24 * 3600_000 }, NOW);
  assert.equal(decode(farFuture).exp, NOW + 24 * 3600_000, "a request with a very long deadline is still capped");
});

test("a payload that is correctly signed but the wrong shape is still refused", () => {
  // Signed with the real key, so only the shape check can stop these.
  const secret = Buffer.from(readFileSync(paths.getNotificationsSecretPath(), "utf8").trim(), "base64");
  const signed = (payload) => {
    const encoded = Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload)).toString("base64url");
    return `${encoded}.${createHmac("sha256", secret).update(encoded).digest("base64url")}`;
  };
  const good = decode(tokens.issueAnswerToken(input, NOW));
  assert.equal(tokens.verifyAnswerToken(signed(good), NOW).ok, true, "the signing helper itself is right");
  for (const field of ["sid", "rid", "u", "d", "n", "a", "k", "exp"]) {
    const missing = { ...good };
    delete missing[field];
    assert.deepEqual(tokens.verifyAnswerToken(signed(missing), NOW), { ok: false, reason: "malformed" }, `missing ${field}`);
  }
  for (const broken of [{ ...good, v: 2 }, { ...good, k: "other" }, { ...good, a: "confirmed" }, { ...good, a: [] }, { ...good, exp: "soon" }, { ...good, sid: "" }, { ...good, sid: "x".repeat(600) }, [], null, "not json", "{"]) {
    assert.equal(tokens.verifyAnswerToken(signed(broken), NOW).ok, false, JSON.stringify(broken)?.slice(0, 60));
  }
});

test("a token is single-use: the second claim fails, even for one already in flight", () => {
  const verdict = tokens.verifyAnswerToken(tokens.issueAnswerToken(input, NOW), NOW);
  assert.equal(tokens.claimAnswerToken(verdict.payload, NOW), true);
  assert.equal(tokens.claimAnswerToken(verdict.payload, NOW), false, "a concurrent duplicate loses");
  assert.equal(tokens.claimAnswerToken(verdict.payload, NOW + 1_000), false);
  tokens.releaseAnswerToken(verdict.payload);
  assert.equal(tokens.claimAnswerToken(verdict.payload, NOW + 2_000), true, "a claim handed back can be made again");
});

test("two different tokens for the same request are separate spends", () => {
  const a = tokens.verifyAnswerToken(tokens.issueAnswerToken(input, NOW), NOW).payload;
  const b = tokens.verifyAnswerToken(tokens.issueAnswerToken({ ...input, a: { confirmed: false } }, NOW), NOW).payload;
  assert.notEqual(a.n, b.n);
  assert.equal(tokens.claimAnswerToken(a, NOW), true);
  assert.equal(tokens.claimAnswerToken(b, NOW), true);
});

test("the spent set forgets a token once it would have expired anyway, and is capped", () => {
  const spent = globalThis.__codyAnswerNonces;
  spent.clear();
  tokens.claimAnswerToken({ n: "short", exp: NOW + 1_000 }, NOW);
  tokens.claimAnswerToken({ n: "long", exp: NOW + 100_000 }, NOW);
  tokens.claimAnswerToken({ n: "trigger", exp: NOW + 200_000 }, NOW + 50_000);
  assert.deepEqual([...spent.keys()].sort(), ["long", "trigger"], "'short' expired and was dropped");

  spent.clear();
  const exp = NOW + 10 * 24 * 3600_000;
  for (let index = 0; index < 10_050; index += 1) tokens.claimAnswerToken({ n: `n${index}`, exp }, NOW);
  assert.equal(spent.size, 10_000, "a flood cannot grow the set without bound");
  assert.equal(spent.has("n10049"), true, "the newest claims are kept");
  assert.equal(spent.has("n0"), false, "the oldest are evicted");
});
