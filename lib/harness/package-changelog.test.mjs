import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });

/** Minimal ustar entry: enough header for the reader (name, size, type,
 * checksum) plus 512-aligned data, so tests need no fixture files. */
function tarEntry(name, content, type = "0") {
  const data = Buffer.from(content, "utf8");
  const header = Buffer.alloc(512);
  header.write(name, 0, "utf8");
  header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124, "ascii");
  header[156] = type.charCodeAt(0);
  header.fill(" ", 148, 156);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512);
  data.copy(padded);
  return Buffer.concat([header, padded]);
}

function tarStream(entries) {
  return Buffer.concat([...entries, Buffer.alloc(1024)]);
}

const CHANGELOG = [
  "# Changelog",
  "",
  "## [18.0.0] - 2026-08-22",
  "",
  "big release",
  "",
  "## [17.4.4] - 2026-08-22",
  "",
  "fixes",
  "",
  "## [17.4.2] - 2026-08-21",
  "",
  "more fixes",
  "",
  "## [17.3.5] - 2026-08-16",
  "",
  "old",
  "",
  "## [17.3.4] - 2026-08-14",
  "",
  "older",
  "",
  "## [17.3.3] - 2026-08-14",
  "",
  "oldest shown",
  "",
  "## [17.3.2] - 2026-08-13",
  "",
  "beyond the cap",
].join("\n");

test("extractTarEntry finds a file and ignores the rest", async () => {
  const { extractTarEntry } = await jiti.import("./package-changelog.ts");
  const tar = tarStream([
    tarEntry("package/README.md", "readme"),
    tarEntry("package/CHANGELOG.md", "the changelog"),
    tarEntry("package/src/index.ts", "code"),
  ]);
  assert.equal(extractTarEntry(tar, "package/CHANGELOG.md"), "the changelog");
  assert.equal(extractTarEntry(tar, "package/missing.md"), null);
});

test("extractTarEntry honors GNU long-name records", async () => {
  const { extractTarEntry } = await jiti.import("./package-changelog.ts");
  const longName = `package/${"deep/".repeat(25)}CHANGELOG.md`;
  const tar = tarStream([
    tarEntry("././@LongLink", `${longName}\0`, "L"),
    tarEntry(longName.slice(0, 99), "found via long name"),
  ]);
  assert.equal(extractTarEntry(tar, longName), "found via long name");
});

test("parseChangelogEntries marks entries newer than the installed version", async () => {
  const { parseChangelogEntries } = await jiti.import("./package-changelog.ts");
  const entries = parseChangelogEntries(CHANGELOG, "17.4.2");
  assert.deepEqual(
    entries.map((entry) => [entry.heading.split(" ")[0], entry.isNew]),
    [
      ["[18.0.0]", true],
      ["[17.4.4]", true],
      ["[17.4.2]", false],
      ["[17.3.5]", false],
      ["[17.3.4]", false],
    ],
  );
});

test("parseChangelogEntries extends past the baseline while sections are new", async () => {
  const { parseChangelogEntries } = await jiti.import("./package-changelog.ts");
  // Installed far behind: every listed release is "new", so the list keeps
  // going past the 5-entry baseline instead of hiding what the update applies.
  const entries = parseChangelogEntries(CHANGELOG, "17.3.1");
  assert.equal(entries.length, 7);
  assert.ok(entries.every((entry) => entry.isNew));
  // Unknown installed version: nothing can honestly be called new.
  assert.ok(parseChangelogEntries(CHANGELOG, null).every((entry) => !entry.isNew));
});

test("buildChangelogPayload serves the published changelog while an update is pending", async () => {
  const { buildChangelogPayload } = await jiti.import("./package-changelog.ts");
  const calls = [];
  const payload = await buildChangelogPayload({
    packageName: "@scope/pkg",
    installedVersion: "17.4.2",
    latestVersion: "18.0.0",
    readInstalledChangelog: () => "## [17.4.2] - 2026-08-21\ninstalled-only",
    fetchPublished: async (name, version) => {
      calls.push(`${name}@${version}`);
      return CHANGELOG;
    },
  });
  assert.deepEqual(calls, ["@scope/pkg@18.0.0"]);
  assert.equal(payload.source, "latest");
  assert.equal(payload.updatePending, true);
  assert.equal(payload.entries[0].heading.startsWith("[18.0.0]"), true);
  assert.equal(payload.entries[0].isNew, true);
  assert.equal(payload.installedVersion, "17.4.2");
  assert.equal(payload.latestVersion, "18.0.0");
});

test("buildChangelogPayload falls back to the installed file when the fetch fails", async () => {
  const { buildChangelogPayload } = await jiti.import("./package-changelog.ts");
  const payload = await buildChangelogPayload({
    packageName: "@scope/pkg",
    installedVersion: "17.4.2",
    latestVersion: "18.0.0",
    readInstalledChangelog: () => "## [17.4.2] - 2026-08-21\ninstalled-only",
    fetchPublished: async () => null,
  });
  assert.equal(payload.source, "installed");
  // The payload admits the pending release's notes are missing, so the UI can
  // say so without consulting its own (possibly newer) update state.
  assert.equal(payload.updatePending, true);
  assert.equal(payload.entries.length, 1);
  assert.equal(payload.entries[0].isNew, false);
});

test("buildChangelogPayload treats a sectionless changelog as unavailable", async () => {
  const { buildChangelogPayload } = await jiti.import("./package-changelog.ts");
  const payload = await buildChangelogPayload({
    packageName: "@scope/pkg",
    installedVersion: "18.0.0",
    latestVersion: "18.0.0",
    readInstalledChangelog: () => "# Changelog\n\nProse only — no release headings here.",
  });
  // An empty entries array would render as a blank panel; null carries a reason.
  assert.equal(payload.entries, null);
  assert.equal(typeof payload.reason, "string");
  assert.equal(payload.source, null);
});

test("buildChangelogPayload reads only the installed file when already current", async () => {
  const { buildChangelogPayload } = await jiti.import("./package-changelog.ts");
  const payload = await buildChangelogPayload({
    packageName: "@scope/pkg",
    installedVersion: "18.0.0",
    latestVersion: "18.0.0",
    readInstalledChangelog: () => CHANGELOG,
    fetchPublished: async () => {
      throw new Error("must not fetch when no update is pending");
    },
  });
  assert.equal(payload.source, "installed");
  assert.equal(payload.updatePending, false);
  assert.ok(payload.entries.length > 0);
});

test("buildChangelogPayload reports a reason when no changelog exists anywhere", async () => {
  const { buildChangelogPayload } = await jiti.import("./package-changelog.ts");
  const payload = await buildChangelogPayload({
    packageName: null,
    installedVersion: null,
    latestVersion: null,
    readInstalledChangelog: () => null,
  });
  assert.equal(payload.entries, null);
  assert.equal(typeof payload.reason, "string");
  assert.equal(payload.source, null);
});

test("fetchPublishedChangelog downloads the registry tarball and pulls the changelog", async (t) => {
  const { fetchPublishedChangelog } = await jiti.import("./package-changelog.ts");
  const tarball = gzipSync(tarStream([tarEntry("package/CHANGELOG.md", CHANGELOG)]));
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    assert.ok(init?.signal instanceof AbortSignal, "fetch must keep its timeout signal");
    if (String(url).endsWith(".tgz")) {
      return new Response(tarball, { status: 200 });
    }
    return new Response(
      JSON.stringify({ dist: { tarball: "https://registry.npmjs.org/@scope/pkg/-/pkg-18.0.0.tgz" } }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  const text = await fetchPublishedChangelog("@scope/pkg", "18.0.0");
  assert.equal(text, CHANGELOG);
  assert.deepEqual(calls, [
    "https://registry.npmjs.org/%40scope%2Fpkg/18.0.0",
    "https://registry.npmjs.org/@scope/pkg/-/pkg-18.0.0.tgz",
  ]);
  // Cached per exact version: a second call answers without the network.
  globalThis.fetch = async () => {
    throw new Error("cache miss");
  };
  assert.equal(await fetchPublishedChangelog("@scope/pkg", "18.0.0"), CHANGELOG);
});

test("fetchPublishedChangelog deduplicates concurrent downloads of one version", async (t) => {
  const { fetchPublishedChangelog } = await jiti.import("./package-changelog.ts");
  const tarball = gzipSync(tarStream([tarEntry("package/CHANGELOG.md", CHANGELOG)]));
  let fetches = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    fetches += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    if (String(url).endsWith(".tgz")) return new Response(tarball, { status: 200 });
    return new Response(
      JSON.stringify({ dist: { tarball: "https://registry.npmjs.org/@scope/pkg2/-/pkg2-2.0.0.tgz" } }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  const [first, second, third] = await Promise.all([
    fetchPublishedChangelog("@scope/pkg2", "2.0.0"),
    fetchPublishedChangelog("@scope/pkg2", "2.0.0"),
    fetchPublishedChangelog("@scope/pkg2", "2.0.0"),
  ]);
  assert.equal(first, CHANGELOG);
  assert.equal(second, CHANGELOG);
  assert.equal(third, CHANGELOG);
  assert.equal(fetches, 2, "concurrent callers must share one metadata + one tarball request");
});

test("fetchPublishedChangelog refuses oversized tarballs before buffering them", async (t) => {
  const { fetchPublishedChangelog } = await jiti.import("./package-changelog.ts");
  let bodyRead = false;
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith(".tgz")) {
      const response = new Response("x", {
        status: 200,
        headers: { "content-length": String(200 * 1024 * 1024) },
      });
      const originalArrayBuffer = response.arrayBuffer.bind(response);
      response.arrayBuffer = async () => {
        bodyRead = true;
        return originalArrayBuffer();
      };
      return response;
    }
    return new Response(
      JSON.stringify({ dist: { tarball: "https://registry.npmjs.org/@scope/pkg3/-/pkg3-3.0.0.tgz" } }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  assert.equal(await fetchPublishedChangelog("@scope/pkg3", "3.0.0"), null);
  assert.equal(bodyRead, false, "a body declared over the cap must never be buffered");
});

test("fetchPublishedChangelog refuses tarball hosts other than the registry", async (t) => {
  const { fetchPublishedChangelog } = await jiti.import("./package-changelog.ts");
  const original = globalThis.fetch;
  const fetched = [];
  globalThis.fetch = async (url) => {
    fetched.push(String(url));
    return new Response(
      JSON.stringify({ dist: { tarball: "https://evil.example.com/pkg-1.0.0.tgz" } }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  assert.equal(await fetchPublishedChangelog("@scope/other-pkg", "1.0.0"), null);
  assert.equal(fetched.length, 1, "the off-registry tarball URL must never be fetched");
});
