// Engine-seam boundary ratchet.
//
// Cody's core invariant: the UI shell is engine-agnostic, and everything
// omp-specific lives behind `lib/harness/` (the adapter seam) or inside
// `lib/omp/` (omp's own plumbing). See docs/harnesses.md. The seam only stays
// real if crossing it is a deliberate act, so this test freezes today's set
// of files that import `lib/omp/*` from outside the seam and fails on ANY
// change to that set:
//
//   - a NEW importer fails — either route the code through the harness
//     (capabilities, adapter methods, engine dispatch like
//     app/api/sessions/route.ts) or, if the file is a genuinely omp-only
//     surface, add it here WITH a reason;
//   - a REMOVED importer fails too — delete its entry, so the list only ever
//     ratchets downward and never carries dead weight.
//
// It also keeps engine adapters private: outside `lib/harness/`, nothing may
// import the adapter/translator modules directly — engine access goes through
// `@/lib/harness` (getHarness) or the engine-neutral submodules.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Files outside lib/omp + lib/harness that import lib/omp/*, with the reason
 * each crossing is intentional. Keys are posix paths relative to the repo
 * root. Shrink freely; grow only with a written justification. */
const OMP_IMPORT_ALLOWLIST = {
  // --- omp-only API surfaces, hidden by capability flags client-side ---
  "app/api/auth/all-providers/route.ts": "omp utility RPC: provider/model catalog",
  "app/api/mcp/route.ts": "omp project mcp.json conventions",
  "app/api/model-plan/route.ts": "omp model roles + native settings writer",
  "app/api/model-roles/route.ts": "omp model-roles config",
  "app/api/engines/select/route.ts": "engine switch tears down the shared utility RPC child so the old engine never answers for the new one",
  "app/api/provider-keys/route.ts": "a saved provider key changes which providers the utility RPC child can see, so it is torn down to respawn with the new environment",
  "app/api/models/route.ts": "rpc-dialect utility RPC: available models (dispatches on the active harness; utilityRpcLaunchFor refuses a non-rpc engine)",
  "app/api/models-config/route.ts": "omp models.yml editor",
  "app/api/models-config/test/route.ts": "omp models.yml probe",
  "app/api/omp-settings/route.ts": "omp native config.yml settings",
  "app/api/omp-settings/schema/route.ts": "engine-neutral now (schema + writes come from HarnessAdapter.settings); still drops the shared omp utility RPC child after a settings write",
  "app/api/omp-update/route.ts": "explicitly omp-scoped update check",
  "app/api/plugins/route.ts": "shells out to `omp plugin` CLI",
  "app/api/plugins/marketplace/route.ts": "shells out to `omp plugin marketplace`/`omp plugin install` CLI",
  "app/api/providers/enable/route.ts": "omp model-roles provider toggle",
  "components/settings/OmpSchemaSettings.tsx": "renders omp's settings schema (types only)",

  // --- session storage: omp owns the on-disk transcript format ---
  // Turn engines keep metadata in cody-engine-sessions.json instead; these
  // routes serve the omp .jsonl format and are the next candidates for the
  // engine dispatch pattern used by app/api/sessions/route.ts.
  "app/api/sessions/import/route.ts": "writes into omp's sessions dir layout",
  "app/api/sessions/[id]/route.ts": "omp .jsonl read/patch/delete",
  "app/api/sessions/[id]/archive/route.ts": "omp .jsonl archive + artifacts",
  "app/api/sessions/[id]/auto-name/route.ts": "omp title slot rewrite",
  "app/api/sessions/[id]/context/route.ts": "omp entry-tree context walk",
  "app/api/sessions/[id]/export/route.ts": "shells out to `omp --export`",
  "app/api/sessions/[id]/media/route.ts": "omp .jsonl deferred image extraction",
  "lib/session-reader.ts": "IS the omp session-file reader",
  "lib/subagent-history.ts": "omp subagent .jsonl sibling layout",

  // --- engine lifecycle: omp is one of the engines ---
  "app/api/agent/new/route.ts": "maps omp RpcCommandError to HTTP",
  "app/api/agent/[id]/route.ts": "maps omp RpcCommandError to HTTP",
  "app/api/engines/changelog/route.ts": "omp changelog path (id === 'omp' gated)",
  "app/api/engines/install/route.ts": "invalidates omp CLI cache after omp install",
  "lib/rpc-manager.ts": "hosts the omp RPC wrapper beside the neutral registry",

  // --- Cody-level state in the instance data dir (paths.ts only) ---
  // getAgentDir() is the documented home for engine-independent state.
  "lib/checkpoints.ts": "instance data dir via omp/paths",
  "lib/project-registry.ts": "instance data dir via omp/paths",
  "lib/auth/paths.ts": "instance data dir via omp/paths (accounts store)",

  // --- omp-only features behind their own surfaces ---
  "lib/model-plan/planner.ts": "omp model-roles planning (omp CLI probe)",
  "lib/model-plan/roster.ts": "omp utility RPC: model roster",
  "lib/session-namer.ts": "reads omp's `tiny` model role, and only when omp is the active engine",
  "lib/skills-service.ts": "reads omp's foreign-user-source opt-ins to mirror which skill roots it loads, and only when omp is the active engine",
  "lib/usage/omp-usage.ts": "omp usage/stats reader (explicitly omp-scoped)",

  // --- types only ---
  "lib/fast-mode.ts": "OmpModel type for tier matching",
};

/** Adapter/translator modules that are private to the seam. `types`,
 * `state`, `engine-bin`, `engine-sessions`, `errors`, `install`, `updates`, and
 * the `@/lib/harness` index are the public engine-neutral surface; these are
 * not. */
const PRIVATE_HARNESS_MODULES = new Set(["omp", "pi", "claude", "codex", "hermes", "acp-session"]);

const SCAN_DIRS = ["app", "components", "hooks", "lib", "bin"];
const SOURCE_RE = /\.(ts|tsx)$/;

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      yield* walk(full);
    } else if (SOURCE_RE.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      yield full;
    }
  }
}

function posixRel(file) {
  return relative(ROOT, file).replaceAll("\\", "/");
}

/** Every module specifier a file imports/re-exports/requires. */
function importSpecs(file) {
  const text = readFileSync(file, "utf8");
  const specs = [];
  const re = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/g;
  for (let m; (m = re.exec(text)); ) specs.push(m[1]);
  return specs;
}

/** Resolves a specifier to a repo-relative posix path, or null for packages. */
function resolveSpec(file, spec) {
  if (spec.startsWith("@/")) return spec.slice(2);
  if (spec.startsWith(".")) return posixRel(resolve(dirname(file), spec));
  return null;
}

function collect() {
  const ompImporters = new Map();
  const harnessViolations = [];
  for (const dir of SCAN_DIRS) {
    for (const file of walk(join(ROOT, dir))) {
      const rel = posixRel(file);
      const insideSeam = rel.startsWith("lib/omp/") || rel.startsWith("lib/harness/");
      for (const spec of importSpecs(file)) {
        const target = resolveSpec(file, spec);
        if (!target) continue;
        if (!insideSeam && (target === "lib/omp" || target.startsWith("lib/omp/"))) {
          if (!ompImporters.has(rel)) ompImporters.set(rel, []);
          ompImporters.get(rel).push(target);
        }
        if (!rel.startsWith("lib/harness/")) {
          const sub = /^lib\/harness\/([a-z-]+)$/.exec(target)?.[1];
          if (sub && PRIVATE_HARNESS_MODULES.has(sub)) harnessViolations.push(`${rel} -> ${target}`);
        }
      }
    }
  }
  return { ompImporters, harnessViolations };
}

const { ompImporters, harnessViolations } = collect();

test("no new lib/omp importers outside the harness seam", () => {
  const unlisted = [...ompImporters.keys()].filter((f) => !(f in OMP_IMPORT_ALLOWLIST)).sort();
  assert.deepEqual(
    unlisted,
    [],
    `These files import lib/omp/* but are not on the seam allowlist:\n  ${unlisted
      .map((f) => `${f} (imports ${[...new Set(ompImporters.get(f))].join(", ")})`)
      .join("\n  ")}\n\nRoute the code through lib/harness (capabilities, adapter methods, engine\ndispatch) instead — see docs/harnesses.md. If the file is a genuinely\nomp-only surface, add it to OMP_IMPORT_ALLOWLIST in ${posixRel(fileURLToPath(import.meta.url))} with a reason.`,
  );
});

test("the omp-importer allowlist carries no dead entries", () => {
  const stale = Object.keys(OMP_IMPORT_ALLOWLIST).filter((f) => !ompImporters.has(f)).sort();
  assert.deepEqual(
    stale,
    [],
    `These allowlist entries no longer import lib/omp/* — delete them so the\nboundary only ever ratchets down:\n  ${stale.join("\n  ")}`,
  );
});

test("engine adapters stay private to lib/harness", () => {
  assert.deepEqual(
    harnessViolations.sort(),
    [],
    `Adapter/translator modules are seam-internal; import from "@/lib/harness"\nor an engine-neutral submodule instead:\n  ${harnessViolations.join("\n  ")}`,
  );
});

test("the scan itself sees the tree", () => {
  // Guards against a silent no-op (renamed dirs, broken glob): the scan must
  // keep finding both a healthy population of files and the known seam users.
  assert.ok(ompImporters.size >= 10, `scan found only ${ompImporters.size} lib/omp importers — walker broken?`);
  assert.ok(ompImporters.has("lib/rpc-manager.ts"), "rpc-manager should always be an omp importer while the omp wrapper lives there");
});
