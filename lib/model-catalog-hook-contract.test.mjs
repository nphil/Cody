import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * Source-contract tests for `hooks/useModelCatalog.ts` (the house style of
 * `hooks/useAgentSession.test.mjs` and `lib/api-contract.test.mjs`): the
 * wiring below cannot be exercised without a DOM/React render harness, which
 * this suite does not have, but a regression that removes it is exactly the
 * kind of silent revert these fixes were written to close. The underlying
 * per-provider computation itself IS behaviorally tested, pure, in
 * lib/model-allow-list.test.mjs (`applyInstanceHide`, `keepAllowListActive`).
 */
const hook = await readFile(new URL("../hooks/useModelCatalog.ts", import.meta.url), "utf8");

test("the first-run seed waits for the unrestricted catalog on omp before posting", () => {
  // Without this guard, `/api/models/new` and `?catalog=full` can settle in
  // either order; seeding from the still-curated effective list here would
  // have the client and the server (which always diffs against the full
  // catalog) permanently disagree on what "new" means.
  const seedEffect = hook.slice(hook.indexOf("const seededRef = useRef(false)"), hook.indexOf("const applyVisibility ="));
  assert.match(seedEffect, /if \(capabilities\.models && fullList === null\) return;/);
  assert.match(seedEffect, /fetch\("\/api\/models\/seen"/);
});

test("openInstance is keyed on the exact no-accounts message, not any account-route error", () => {
  // Any other failure (signed-out 401, a network blip, a 5xx) must not read
  // as "no accounts" — on omp that would hand a wrongly-detected admin a
  // working enabledModels write, since that PUT has no server-side role gate.
  assert.match(hook, /const openInstance = account\.error === NO_ACCOUNTS_ERROR_MESSAGE && !account\.unsupported;/);
});

test("an instance hide/unhide write is never a bare providerGlob substitution or a plain replace", () => {
  const setInstanceHidden = hook.slice(hook.indexOf("const setInstanceHidden = useCallback"), hook.indexOf("const writeProviderCuration = useCallback"));
  const writeProviderCuration = hook.slice(hook.indexOf("const writeProviderCuration = useCallback"), hook.indexOf("const markSeen = useCallback"));
  for (const [name, fn] of [["setInstanceHidden", setInstanceHidden], ["writeProviderCuration", writeProviderCuration]]) {
    assert.match(fn, /enabledModels: keepAllowListActive\(list\)/, `${name} must keep the allow-list active instead of persisting an empty (unrestricted) list`);
    assert.doesNotMatch(fn, /providerGlob\(/, `${name} must not fall back to "enable the whole provider" when the result is empty`);
    // The composer's own model fetch only reruns on session change or this
    // bump: without it, an omp hide/unhide from the hub never reaches an
    // open composer until the next session switch.
    assert.match(fn, /callbacks\.onModelsSaved\(\)/, `${name} must refresh the composer's model list`);
  }
});

test("setInstanceHidden derives the next selection from the allow-list itself, not the effective catalog", () => {
  const setInstanceHidden = hook.slice(hook.indexOf("const setInstanceHidden = useCallback"), hook.indexOf("const writeProviderCuration = useCallback"));
  assert.match(setInstanceHidden, /applyInstanceHide\(list, provider, \[\.\.\.providerKeysSet\], hidden, catalogForProvider\)/);
  // The bug this replaced built "what reaches sessions now" from the
  // effective/instance-hidden read, which lags a just-landed write by
  // seconds on omp — reading `effectiveList` or `instanceHidden` directly in
  // this loop is exactly that regression.
  assert.doesNotMatch(setInstanceHidden, /effectiveList\.filter/);
  assert.doesNotMatch(setInstanceHidden, /for \(const key of instanceHidden\)/);
});

test("baseAllowList and the per-key helpers read refs, not the render's closed-over state", () => {
  // A ref is what makes a callback correct even when the specific function
  // INSTANCE invoking it was created on an earlier render — e.g. an undo
  // toast's onClick, fired after later hides moved the state on.
  const baseAllowList = hook.slice(hook.indexOf("const baseAllowList = useCallback"), hook.indexOf("const providersPinnedByHiding = useCallback"));
  assert.match(baseAllowList, /enabledModelsRef\.current/);
  assert.match(baseAllowList, /fullListRef\.current/);
  assert.match(baseAllowList, /}, \[\]\);/, "baseAllowList takes no reactive dependency — everything it reads comes from refs");
});
