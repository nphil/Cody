import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * Code hosts are the one place a token for GitHub or a self-hosted Gitea is
 * stored, and the one place that decides which server an operation reaches.
 * What matters: the token never leaves the server through the read API, the
 * API base and auth scheme follow the host's kind, plain HTTP is refused for
 * anything but a private address, and an install that has configured nothing
 * still behaves exactly like Cody did before this file existed.
 */
const agentDir = mkdtempSync(join(tmpdir(), "cody-forge-config-"));
process.on("exit", () => rmSync(agentDir, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = agentDir;
delete process.env.GITHUB_TOKEN;
delete process.env.GH_TOKEN;

const jiti = createJiti(import.meta.url);
const forge = await jiti.import("./config.ts");

function reset() {
  rmSync(forge.getForgeConfigPath(), { force: true });
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
}

test("with nothing configured the roster is the built-in GitHub host, seeded from the container's token", () => {
  reset();
  assert.deepEqual(forge.listForgeHosts().map((host) => host.id), ["github"]);
  assert.equal(forge.listForgeHosts()[0].hasToken, false, "no token anywhere means no token");

  process.env.GH_TOKEN = "ghp_container_9999";
  const [seeded] = forge.listForgeHosts();
  assert.equal(seeded.hasToken, true);
  assert.equal(seeded.tokenSource, "environment");
  assert.equal(seeded.tokenPreview, "9999");
  assert.equal(seeded.builtin, true, "seeded, not saved: it cannot be removed");
  assert.equal(forge.resolveForgeHost().id, "github", "the default host with no file is GitHub");
  reset();
});

test("a saved host round-trips 0600 in the instance dir and its token never leaves the server", () => {
  reset();
  forge.upsertForgeHost({
    kind: "gitea",
    label: "Home forge",
    baseUrl: "https://git.example.net/",
    owner: "nphil",
    token: "  gitea_secret_token_abcd  ",
  });

  const file = forge.getForgeConfigPath();
  assert.ok(file.startsWith(agentDir), "lives in the instance data dir");
  assert.equal(statSync(file).mode & 0o777, 0o600);

  const stored = forge.getForgeHost("home-forge");
  assert.equal(stored.token, "gitea_secret_token_abcd", "whitespace is not part of a token");
  assert.equal(stored.baseUrl, "https://git.example.net", "the trailing slash is not part of the origin");

  const listed = forge.listForgeHosts().find((host) => host.id === "home-forge");
  assert.equal("token" in listed, false, "the redacted view carries no token field at all");
  assert.equal(listed.hasToken, true);
  assert.equal(listed.tokenPreview, "abcd");
  assert.equal(listed.tokenSource, "stored");
  assert.ok(!JSON.stringify(forge.listForgeHosts()).includes("gitea_secret_token"));
  reset();
});

test("an edit that leaves the token field out keeps the saved credential", () => {
  reset();
  forge.upsertForgeHost({ kind: "gitea", label: "Home forge", baseUrl: "https://git.example.net", owner: "nphil", token: "keep-me" });
  forge.upsertForgeHost({ id: "home-forge", kind: "gitea", label: "Home forge", baseUrl: "https://git.example.net", owner: "someone-else" });
  assert.equal(forge.getForgeHost("home-forge").token, "keep-me");
  assert.equal(forge.getForgeHost("home-forge").owner, "someone-else");

  forge.upsertForgeHost({ id: "home-forge", kind: "gitea", label: "Home forge", baseUrl: "https://git.example.net", owner: "nphil", token: "" });
  assert.equal(forge.getForgeHost("home-forge").token, undefined, "an empty token clears it");
  reset();
});

test("the API base and the auth scheme follow the host's kind", () => {
  const github = { id: "github", kind: "github", label: "GitHub", baseUrl: "https://github.com", owner: "", token: "gh-token" };
  const gitea = { id: "home", kind: "gitea", label: "Home", baseUrl: "https://git.example.net", owner: "nphil", token: "gitea-token" };

  assert.equal(forge.resolveApiUrl(github), "https://api.github.com");
  assert.equal(forge.resolveApiUrl(gitea), "https://git.example.net/api/v1");
  assert.equal(forge.resolveApiUrl({ kind: "gitea", baseUrl: "https://git.example.net/" }), "https://git.example.net/api/v1");

  // Gitea rejects a bearer; GitHub rejects Gitea's `token` scheme.
  assert.deepEqual(forge.authHeader(github), { Authorization: "Bearer gh-token" });
  assert.deepEqual(forge.authHeader(gitea), { Authorization: "token gitea-token" });
  assert.deepEqual(forge.authHeader({ ...gitea, token: undefined }), {}, "no token, no header");
});

test("the container's GitHub token is never spent on someone else's server", () => {
  reset();
  process.env.GITHUB_TOKEN = "ghp_container";
  assert.equal(forge.resolveToken({ id: "github", kind: "github", label: "GitHub", baseUrl: "https://github.com", owner: "" }), "ghp_container");
  assert.equal(forge.resolveToken({ id: "ghes", kind: "github", label: "Work", baseUrl: "https://github.acme.example", owner: "" }), undefined);
  assert.equal(forge.resolveToken({ id: "home", kind: "gitea", label: "Home", baseUrl: "https://git.example.net", owner: "" }), undefined);
  reset();
});

test("plain http is accepted for a private address and refused for a public one", () => {
  assert.equal(forge.validateBaseUrl("https://git.example.net"), null);
  assert.equal(forge.validateBaseUrl("http://192.168.1.69:3000"), null);
  assert.equal(forge.validateBaseUrl("http://10.0.0.4"), null);
  assert.equal(forge.validateBaseUrl("http://beastnas.local"), null);
  assert.equal(forge.validateBaseUrl("http://localhost:3000"), null);
  assert.match(forge.validateBaseUrl("http://git.example.net"), /https/);
  assert.match(forge.validateBaseUrl("ftp://git.example.net"), /http/);
  assert.match(forge.validateBaseUrl("git.example.net"), /full URL/);
  assert.match(forge.validateBaseUrl("   "), /required/);
});

test("a GitHub host's web origin cannot be pointed somewhere else", () => {
  reset();
  const host = forge.upsertForgeHost({ kind: "github", label: "Impostor", baseUrl: "https://evil.example", owner: "nphil" });
  assert.equal(host.baseUrl, "https://github.com", "github.com's API must not be paired with another origin");
  reset();
});

test("the default host moves when it is removed, and the last host cannot go", () => {
  reset();
  forge.upsertForgeHost({ kind: "gitea", label: "Home forge", baseUrl: "https://git.example.net", owner: "nphil" });
  forge.setDefaultForgeHost("home-forge");
  assert.equal(forge.resolveForgeHost().id, "home-forge");
  assert.equal(forge.resolveForgeHost("github").id, "github", "an explicit id wins over the default");
  assert.equal(forge.resolveForgeHost("nope"), null);

  assert.equal(forge.removeForgeHost("home-forge"), true);
  assert.equal(forge.resolveForgeHost().id, "github", "the default follows the survivors");
  assert.equal(forge.removeForgeHost("home-forge"), false, "removing it twice is not an error, just nothing");
  assert.throws(() => forge.removeForgeHost("github"), /last code host/);
  reset();
});

test("a clone URL is matched back to the host it belongs to", () => {
  reset();
  forge.upsertForgeHost({ kind: "gitea", label: "Home forge", baseUrl: "https://git.example.net", owner: "nphil" });

  assert.deepEqual(
    { ...forge.matchForgeHostUrl("https://git.example.net/nphil/Cody.git"), host: undefined },
    { host: undefined, repo: "nphil/Cody" },
  );
  assert.equal(forge.matchForgeHostUrl("https://git.example.net/nphil/Cody.git").host.id, "home-forge");
  assert.equal(forge.matchForgeHostUrl("git@git.example.net:nphil/Cody.git").host.id, "home-forge", "scp-style remotes too");
  assert.equal(forge.matchForgeHostUrl("https://github.com/nphil/Cody").host.id, "github");
  assert.equal(forge.matchForgeHostUrl("https://gitlab.com/nphil/Cody"), null, "an unconfigured host is not guessed");
  assert.equal(forge.matchForgeHostUrl("/srv/git/bare.git"), null);
  reset();
});

test("Cody's own update source defaults to the channel it ships on and survives a removed host", () => {
  reset();
  const initial = forge.resolveCodyUpdateSource();
  assert.equal(initial.isDefault, true);
  assert.equal(initial.source.repo, "nphil/Cody");
  assert.equal(initial.source.image, "ghcr.io/nphil/cody:latest");
  assert.equal(initial.host.kind, "github");

  forge.upsertForgeHost({ kind: "gitea", label: "Home forge", baseUrl: "https://git.example.net", owner: "nphil" });
  forge.setCodyUpdateSource({ hostId: "home-forge", repo: "nphil/cody", image: "git.example.net/nphil/cody:latest" });
  const configured = forge.resolveCodyUpdateSource();
  assert.equal(configured.isDefault, false);
  assert.equal(configured.host.id, "home-forge");
  assert.equal(configured.source.image, "git.example.net/nphil/cody:latest");

  assert.throws(() => forge.setCodyUpdateSource({ hostId: "home-forge", repo: "not-a-repo", image: "" }), /owner\/name/);
  assert.throws(() => forge.setCodyUpdateSource({ hostId: "ghost", repo: "a/b", image: "" }), /Unknown code host/);

  // Removing the host the source pointed at must not stop update checks.
  forge.removeForgeHost("home-forge");
  const fallback = forge.resolveCodyUpdateSource();
  assert.equal(fallback.isDefault, true);
  assert.equal(fallback.source.repo, "nphil/Cody");

  forge.setCodyUpdateSource(null);
  assert.equal(forge.resolveCodyUpdateSource().isDefault, true);
  reset();
});

test("a file rewritten on disk cannot smuggle in a host Cody would refuse to save", () => {
  reset();
  writeFileSync(forge.getForgeConfigPath(), JSON.stringify({
    version: 1,
    hosts: [
      { id: "ok", kind: "gitea", label: "Fine", baseUrl: "https://git.example.net", owner: "nphil" },
      { id: "no-kind", label: "Broken", baseUrl: "https://git.example.net" },
      { id: "no-url", kind: "gitea", label: "Broken" },
      { id: "ok", kind: "gitea", label: "Duplicate", baseUrl: "https://other.example" },
    ],
    defaultHostId: "vanished",
  }), { mode: 0o600 });

  const hosts = forge.listForgeHosts();
  assert.deepEqual(hosts.map((host) => host.id), ["ok"], "malformed and duplicate entries are dropped");
  assert.equal(hosts[0].label, "Fine", "the first entry wins a duplicate id");
  assert.equal(hosts[0].isDefault, true, "a default naming a host that is not there falls to the first");

  writeFileSync(forge.getForgeConfigPath(), "{ not json", { mode: 0o600 });
  assert.deepEqual(forge.listForgeHosts().map((host) => host.id), ["github"], "an unreadable file reads as un-configured");
  assert.equal(readFileSync(forge.getForgeConfigPath(), "utf8"), "{ not json", "reading never repairs the file behind the user's back");
  reset();
});
