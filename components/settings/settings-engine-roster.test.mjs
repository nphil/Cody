import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { EngineRoster, buildEngineRows } = await jiti.import("./EngineRoster.tsx");
const { resetSettingsRouteCache } = await jiti.import("../../hooks/useSettingsData.ts");
const { ALL_CAPABILITIES } = await jiti.import("../SettingsTabs.tsx");

/**
 * The engine roster from a fixture: what GET /api/engines and GET
 * /api/engines/updates answer on a server with one engine of every shape —
 * active and verified, installed with a revert target, a two-package engine
 * running ahead of the audited major, one Cody can install, one it cannot.
 * `buildEngineRows` is the pure derivation every row renders from; the
 * rendered markup pins the chips and actions in both modes. Static markup
 * reads the route cache's SERVER snapshot (always empty), so the fixture
 * reaches the component through `initial` / `initialStatuses`, the seam the
 * onboarding picker hands its pre-fetched roster through.
 */

function engine(overrides) {
  return {
    id: "x", name: "X", shortName: "X", tagline: "An engine.", experimental: false, installed: true, installing: false,
    version: "1.0.0", adapterVersion: null, verifiedVersion: null, adapterLabel: null, engineCliLabel: null,
    installable: true, managed: true, authHint: null, binaryName: "x",
    ...overrides,
  };
}

const ROSTER = {
  active: "omp",
  onboarded: true,
  setupDone: true,
  canManage: true,
  engines: [
    engine({ id: "omp", name: "OMP", shortName: "OMP", tagline: "The founding engine.", version: "18.1.10", verifiedVersion: "18.1.10", binaryName: "omp" }),
    engine({ id: "pi", name: "Pi", shortName: "Pi", tagline: "Pi coding agent.", version: "0.61.0", binaryName: "pi" }),
    engine({ id: "claude", name: "Claude Code", shortName: "Claude", tagline: "Anthropic's CLI over an ACP adapter.", version: "2.1.5", adapterVersion: "0.70.0", verifiedVersion: "0.60.0", adapterLabel: "Claude Code ACP adapter", engineCliLabel: "Claude Code CLI", authHint: "Sign in with claude login.", binaryName: "claude-agent-acp" }),
    engine({ id: "codex", name: "Codex", shortName: "Codex", tagline: "OpenAI Codex.", installed: false, version: null, managed: false, experimental: true, binaryName: "codex-acp" }),
    engine({ id: "hermes", name: "Hermes", shortName: "Hermes", tagline: "Hermes agent.", installed: false, version: null, installable: false, managed: false, binaryName: "hermes" }),
  ],
};

const STATUSES = {
  updates: [
    { id: "omp", installedVersion: "18.1.10", latestVersion: "18.1.10", updateAvailable: false, engineVersion: "18.1.10", components: [], adapterLabel: null, previousVersion: null, previousEngineVersion: null, probeError: null, latestBeyondVerified: false, installedBeyondVerified: false, verifiedVersion: "18.1.10" },
    { id: "pi", installedVersion: "0.61.0", latestVersion: "0.62.0", updateAvailable: true, engineVersion: "0.61.0", components: [], adapterLabel: null, previousVersion: "0.60.0", previousEngineVersion: null, probeError: null, latestBeyondVerified: false, installedBeyondVerified: false, verifiedVersion: null },
    {
      id: "claude", installedVersion: "0.70.0", latestVersion: "1.2.0", updateAvailable: true, engineVersion: "2.1.5",
      components: [
        { packageName: "@zed-industries/claude-agent-acp", label: "Claude Code ACP adapter", installedVersion: "0.70.0", latestVersion: "1.2.0", updateAvailable: true },
        { packageName: "@anthropic-ai/claude-code", label: "Claude Code CLI", installedVersion: "2.1.5", latestVersion: "2.1.9", updateAvailable: true },
      ],
      adapterLabel: "Claude Code ACP adapter", previousVersion: "0.69.0", previousEngineVersion: "2.1.4", probeError: null, latestBeyondVerified: true, installedBeyondVerified: true, verifiedVersion: "0.60.0",
    },
  ],
};

const statusMap = Object.fromEntries(STATUSES.updates.map((status) => [status.id, status]));

test("buildEngineRows derives the number, the chips and the actions each row shows", () => {
  const rows = buildEngineRows(ROSTER, statusMap, { ompSelf: null, capabilities: ALL_CAPABILITIES });
  const byId = Object.fromEntries(rows.map((row) => [row.engine.id, row]));

  assert.equal(byId.omp.active, true);
  assert.equal(byId.omp.updateAvailable, false);
  assert.equal(byId.omp.selfUpdate, true, "the active omp runtime updates through /api/omp-update");
  assert.equal(byId.omp.canUninstall, false, "the active engine is never offered for uninstall");
  assert.equal(byId.omp.canUse, false);

  assert.equal(byId.pi.canUse, true);
  assert.equal(byId.pi.canUninstall, true, "a managed, installed, non-active engine can be uninstalled");
  assert.equal(byId.pi.latestVersion, "0.62.0");
  assert.equal(byId.pi.previousVersion, "0.60.0", "the revert target comes from the registry status");

  // A two-package engine: the CLI's number under the engine's name, the
  // LAST stale package's version on the Update button, the adapter named
  // as the subject of the compatibility warning.
  assert.equal(byId.claude.installedVersion, "2.1.5");
  assert.equal(byId.claude.latestVersion, "2.1.9");
  assert.equal(byId.claude.components.length, 2);
  assert.deepEqual(byId.claude.compat, { subject: "Claude Code ACP adapter", version: "1.2.0" });
  assert.equal(byId.claude.installedAhead, true);
  assert.equal(byId.claude.previousEngineVersion, "2.1.4");

  assert.equal(byId.codex.canInstall, true);
  assert.equal(byId.codex.canUse, false);
  assert.equal(byId.codex.updateAvailable, null);
  assert.equal(byId.hermes.needsManualInstall, true, "an engine Cody cannot install says so");
  assert.equal(byId.hermes.canInstall, false);

  // Members: no registry statuses, no install/switch/uninstall, only omp's
  // self check answers, and only while the engine supports it.
  const memberRoster = { ...ROSTER, canManage: false };
  const self = { currentVersion: "18.1.10", availableVersion: "18.2.0", updateAvailable: true, updateCommand: "omp update" };
  const member = Object.fromEntries(buildEngineRows(memberRoster, statusMap, { ompSelf: self, capabilities: ALL_CAPABILITIES }).map((row) => [row.engine.id, row]));
  assert.equal(member.omp.updateAvailable, true);
  assert.equal(member.omp.latestVersion, "18.2.0");
  assert.equal(member.omp.self, self);
  assert.equal(member.omp.selfUpdate, false);
  assert.equal(member.pi.updateAvailable, null);
  assert.equal(member.pi.canUninstall, false);
  assert.equal(member.codex.canInstall, false);
  assert.equal(member.claude.compat, null, "members never see registry-only data");
  const noUpdates = Object.fromEntries(buildEngineRows(memberRoster, statusMap, { ompSelf: self, capabilities: { ...ALL_CAPABILITIES, updates: false } }).map((row) => [row.engine.id, row]));
  assert.equal(noUpdates.omp.self, null);
  assert.equal(noUpdates.omp.statusExpected, false);
});

test("manage mode renders every engine with its chips, actions and the Danger zone, and no dialog while nothing is pending", () => {
  resetSettingsRouteCache();
  const html = renderToStaticMarkup(React.createElement(EngineRoster, { mode: "manage", capabilities: ALL_CAPABILITIES, initial: ROSTER, initialStatuses: STATUSES.updates }));

  for (const id of ["omp", "pi", "claude", "codex", "hermes"]) {
    assert.match(html, new RegExp(`data-search-id="engine-${id}"`), `${id} is a search target`);
  }
  assert.match(html, />Active</, "the active chip");
  assert.match(html, /Built to v18\.1\.10/, "the verified chip");
  assert.match(html, /Ahead of Cody/, "the ahead chip for the engine past its audited major");
  assert.match(html, /Not installed/);
  assert.match(html, /Claude Code ACP adapter/, "two-package parts break out");
  assert.match(html, /Claude Code CLI/);
  assert.match(html, /Use Pi/, "an installed non-active engine offers Use");
  assert.match(html, /Update to v0\.62\.0/);
  assert.match(html, /Update to v2\.1\.9/, "the CLI's version on a two-package Update button");
  assert.match(html, /Revert to v0\.60\.0/);
  assert.match(html, /Revert to v2\.1\.4/, "the revert names the CLI version the user recognises");
  assert.match(html, /Reinstall/);
  assert.match(html, /View changelog/);
  assert.match(html, />Install</, "an installable engine offers Install");
  assert.match(html, /Install the hermes CLI on the host/, "an engine Cody cannot install says so");
  assert.match(html, /aria-label="Danger zone"/, "the Danger zone section renders");
  assert.match(html, /Uninstall/);
  assert.match(html, /Restart sessions/);
  assert.match(html, /data-search-id="engine-danger-zone"/);
  assert.doesNotMatch(html, /role="dialog"/, "no confirmation or drawer is open");
  assert.doesNotMatch(html, /Uninstall OMP/, "the active engine is not in the Danger zone");
  resetSettingsRouteCache();
});

test("pick mode renders the onboarding cards with Install, Use and Continue and the decide-later footer", () => {
  resetSettingsRouteCache();
  const html = renderToStaticMarkup(React.createElement(EngineRoster, { mode: "pick", initial: ROSTER, onSelected: () => {} }));
  assert.match(html, /class="engine-grid"/);
  assert.equal(html.split('class="engine-card"').length - 1, 5, "one card per engine");
  assert.match(html, /data-active="true"/);
  assert.match(html, /Continue with OMP/);
  assert.match(html, /Use Pi/);
  assert.match(html, /Use Claude/);
  assert.match(html, /Installed · v18\.1\.10/);
  assert.match(html, />Install</);
  assert.match(html, /Install the hermes CLI on the host/);
  assert.match(html, /Decide later and keep using OMP/);
  assert.doesNotMatch(html, /aria-label="Danger zone"/, "the picker never offers uninstall or restart");
  assert.doesNotMatch(html, /role="dialog"/);
  resetSettingsRouteCache();
});

test("a member sees the roster read-only with the admin note and omp's copyable update command", () => {
  resetSettingsRouteCache();
  const html = renderToStaticMarkup(React.createElement(EngineRoster, { mode: "manage", capabilities: ALL_CAPABILITIES, initial: { ...ROSTER, canManage: false } }));
  assert.match(html, /Engine updates are applied by an administrator/);
  assert.doesNotMatch(html, /aria-label="Danger zone"/, "members get no Danger zone");
  assert.doesNotMatch(html, /data-search-id="engine-danger-zone"/);
  assert.doesNotMatch(html, /Use Pi/);
  assert.doesNotMatch(html, /Reinstall/);
  resetSettingsRouteCache();
});
