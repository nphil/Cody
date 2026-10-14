import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeAnthropic } from "./fake-anthropic.mjs";
import { childEnv, runCommand } from "./omp-driver.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

/** The fake credits keys the scenarios save, one per plan account, in the order saved: so the first lands in `anthropic-api` and the second in `anthropic-api-2`. Obviously fake. */
export const CREDITS_KEYS = ["sk-ant-api03-FAKE-credits-key-0001", "sk-ant-api03-FAKE-credits-key-0002"];

export const MODEL = "anthropic/claude-opus-5-5";

/**
 * One self-contained omp installation in a throwaway directory, wired the way Cody wires a real one:
 *
 *  - two fake Claude plan accounts ("A" and "B") in omp's own credential store, seeded through its
 *    AuthStorage under Bun;
 *  - a fake server (fake-anthropic.mjs) behind `anthropic`, behind the credits' providers and
 *    behind a stand-in provider `fake-codex` that stands for any other provider in the chain;
 *  - one API key saved for each plan account by Cody's REAL `saveClaudeApiKey` (real Bun bridges,
 *    real AuthStorage), each in a provider of its own — `anthropic-api` for the first, `anthropic-api-2`
 *    for the second — which also writes one block per key into models.yml;
 *  - the chat overlay from Cody's REAL `materializeClaudeCreditsOverlay`, to be handed to omp as
 *    `PI_CONFIG_FILES`;
 *  - a config.yml whose `default` fallback chain is just the stand-in provider, with model
 *    fallback on and short backoffs.
 *
 * Several scenarios can be built and run at the same time: nothing is shared between them, and
 * Cody's own modules run in a child process of their own.
 */
export async function buildScenario({ repoRoot, ompBin, packageRoot, bun, fake: fakeOptions, trap = null, keys = CREDITS_KEYS, plans = ["A", "B"], saveKeys = true, config = "", model = MODEL }) {
  const root = mkdtempSync(path.join(os.tmpdir(), "cody-credits-e2e-"));
  const agentDir = path.join(root, "agent");
  mkdirSync(agentDir, { recursive: true });
  const fake = await startFakeAnthropic(fakeOptions);
  const cleanup = async () => {
    await fake.close();
    rmSync(root, { recursive: true, force: true });
  };
  try {
    writeFileSync(path.join(agentDir, "models.yml"), [
      "providers:",
      "  anthropic:",
      // An override-only entry: the plan's own models and OAuth, aimed at the fake (the usage report follows it).
      `    baseUrl: ${fake.baseUrl}`,
      "  fake-codex:",
      `    baseUrl: ${fake.standInUrl}`,
      "    api: openai-completions",
      "    auth: none",
      "    models:",
      "      - id: gpt-fake",
      // Roomy: omp skips a fallback whose window cannot hold the live context, and the stand-in must be a real candidate.
      "        contextWindow: 200000",
      "        maxTokens: 8192",
      "",
    ].join("\n"));
    writeFileSync(path.join(agentDir, "config.yml"), [
      "modelRoles:",
      `  default: ${model}`,
      "retry:",
      "  enabled: true",
      "  modelFallback: true",
      "  maxRetries: 3",
      "  baseDelayMs: 10",
      // omp WAITS out a blocked sibling credential before moving on when the wait fits under this (measured: about 60 s
      // after a credit-exhausted 402 on both keys). A test must never sleep through that, so the wait is capped.
      "  maxDelayMs: 20000",
      "  fallbackChains:",
      "    default: [fake-codex/gpt-fake]",
      config,
    ].join("\n"));

    const env = childEnv({ root, agentDir, trap });
    const seeded = await runCommand(bun, [path.join(here, "seed-plans.mjs"), packageRoot, agentDir, JSON.stringify({ plans })], { env });
    if (seeded.code !== 0) throw new Error(`seeding the plan accounts failed (${seeded.code}): ${seeded.stderr || seeded.stdout}`);

    let setup = { status: null, overlay: null, providers: [], chains: null };
    if (saveKeys) {
      const ran = await runCommand(process.execPath, [path.join(here, "cody-setup.mjs"), JSON.stringify({ repoRoot, agentDir, root, baseUrl: fake.baseUrl, keys: keys.slice(0, plans.length) })], {
        env: { ...env, CODY_OMP_BIN: ompBin },
        timeoutMs: 120_000,
      });
      if (ran.code !== 0) throw new Error(`Cody's credits setup failed (${ran.code}): ${ran.stderr || ran.stdout}`);
      setup = JSON.parse(ran.stdout);
    }
    return {
      root,
      agentDir,
      fake,
      overlay: setup.overlay,
      status: setup.status,
      /** The provider names models.yml holds once Cody has saved the keys. */
      providers: setup.providers,
      /** `retry.fallbackChains` of the overlay Cody wrote, as omp will merge it last. */
      chains: setup.chains,
      /** The environment for an omp run: the overlay in `PI_CONFIG_FILES`, as a chat's launch would pass it. */
      env: (extra = {}) => childEnv({ root, agentDir, configFiles: setup.overlay ?? "", trap, extra }),
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
