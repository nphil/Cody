import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createJiti } from "jiti";
import { ompTestPackageBin, ompTestPackageSkip } from "./omp-test-package.mjs";

const FAKE_BIN = ompTestPackageBin();
const skip = ompTestPackageSkip();

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });

async function loadRoleIds(bin) {
  process.env.CODY_OMP_BIN = bin;
  const loaded = await jiti.import("./model-roles.ts");
  (await jiti.import("./omp-cli.ts")).invalidateOmpCliCache();
  loaded.clearOmpModelRoleIdsCache();
  return { loaded, ids: loaded.getOmpModelRoleIds() };
}

/** MODEL_ROLE_IDS read straight out of the package's text, so the assertion
 * below is not just the loader agreeing with itself.
 *
 * 18.2.5 moved the declaration into @oh-my-pi/pi-tui and left a re-export in
 * `src/config/model-roles.ts`, so the literal is found by searching the engine
 * package and its dependencies rather than by resolving the specifier the way
 * the loader does — which would make this check circular. */
function declaredRoleIds() {
  const root = packageRootOf(FAKE_BIN);
  const declaration = /export const MODEL_ROLE_IDS[^=]*=\s*\[([^\]]*)\]/;
  // The engine's own src first, then every @oh-my-pi dependency tree above it:
  // npm hoists, so 18.2.5's pi-tui can sit beside the engine rather than under
  // it, and that is where the literal moved to.
  const roots = [path.join(root, "src"), ...scopeRootsAbove(root)];
  for (const dir of roots) {
    const hit = findDeclaration(dir, declaration, 0);
    if (hit) return [...hit.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  }
  throw new Error(`no MODEL_ROLE_IDS declaration found from ${root}`);
}

/** `node_modules/@oh-my-pi` directories from the package root upwards. */
function scopeRootsAbove(root) {
  const found = [];
  let current = root;
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = path.join(current, "node_modules", "@oh-my-pi");
    if (fs.existsSync(candidate)) found.push(candidate);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return found;
}

function packageRootOf(bin) {
  let current = path.dirname(fs.realpathSync(bin));
  for (let depth = 0; depth < 8; depth += 1) {
    if (fs.existsSync(path.join(current, "package.json")) && fs.existsSync(path.join(current, "src"))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`no package root above ${bin}`);
}

/** First capture of `pattern` in any .ts file under `dir`, breadth-bounded so
 * a deep dependency tree cannot turn this into a full-disk scan. */
function findDeclaration(dir, pattern, depth) {
  if (depth > 4) return null;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name.endsWith(".ts")) {
      try {
        const match = pattern.exec(fs.readFileSync(full, "utf8"));
        if (match) return match[1];
      } catch {
        // Unreadable file: keep looking.
      }
    } else if (entry.isDirectory() && entry.name !== "node_modules" && entry.name !== "dist") {
      const nested = findDeclaration(full, pattern, depth + 1);
      if (nested) return nested;
    }
  }
  return null;
}

test("takes the role list from the installed engine, not a frozen copy", { skip }, async () => {
  const { ids } = await loadRoleIds(FAKE_BIN);
  assert.deepEqual([...ids], declaredRoleIds());
});

test("falls back to the audited list when omp cannot be read", async () => {
  const { loaded, ids } = await loadRoleIds("/nonexistent/omp");
  assert.deepEqual([...ids], [...loaded.FALLBACK_MODEL_ROLE_IDS]);
  delete process.env.CODY_OMP_BIN;
  (await jiti.import("./omp-cli.ts")).invalidateOmpCliCache();
  loaded.clearOmpModelRoleIdsCache();
});

test("the fallback list carries no role the engine has dropped", async () => {
  // omp removed `designer` in 18.1.5. A stale fallback would put it back the
  // moment omp is missing, which is exactly when nothing can correct it.
  const { loaded } = await loadRoleIds("/nonexistent/omp");
  assert.equal(loaded.FALLBACK_MODEL_ROLE_IDS.includes("designer"), false);
  delete process.env.CODY_OMP_BIN;
  (await jiti.import("./omp-cli.ts")).invalidateOmpCliCache();
  loaded.clearOmpModelRoleIdsCache();
});

test("Cody offers widget exactly when the installed engine declares it", { skip }, async () => {
  const { ids } = await loadRoleIds(FAKE_BIN);
  const { planRoleNames, ROLE_NAMES } = await jiti.import("../model-plan/derive.ts");
  const engineHasWidget = declaredRoleIds().includes("widget");
  assert.equal(ids.includes("widget"), engineHasWidget);
  assert.equal(planRoleNames(ids).includes("widget"), engineHasWidget);
  assert.deepEqual(planRoleNames(ids), ROLE_NAMES.filter((role) => ids.includes(role)));
});
