# Ground rules: provider safety text and the shared-product constraint

← Back to [AGENTS.md](../../AGENTS.md) · Full text of the sections AGENTS.md summarizes, moved verbatim; AGENTS.md keeps a short summary of each.

Sections in this file:
- Never reproduce a provider's safety text
- Cody is meant to be SHARED — never ship the owner's environment

### Never reproduce a provider's safety text

Anything written into long-term memory, or into a file that is injected as
context (this file, `CLAUDE.md`, omp's `RULES.md`), comes back in LATER
prompts — every workspace, every model, every subagent. A provider's own
refusal wording is therefore self-propagating: quote it once and later
sessions carry it as context, where the same classifier reads it and refuses
the turn before any work begins.

That is not hypothetical. Diagnosing one refusal in a Cody session was
auto-retained as a transcript memory (`mnemopi.autoRetain`, recalled
globally), and unrelated sessions in other projects were then redirected to a
fallback model on their first turn, on unrelated topics. A test fixture in
this repo had pinned the same wording verbatim "so the test uses the real
string" — the fixture now asserts the SHAPE (stop reason plus classifier tag)
and never the blurb.

So: paraphrase, or name only the machine-readable stop reason / error code.
Describe a refusal structurally — which stop reason, which code path, what the
harness did next — which is what makes it fixable anyway. If such text is
already stored, DELETE the memory rather than superseding it, and de-quote the
file. The standing rule lives in omp's user `RULES.md` so it reaches every
agent and subagent, not just whoever reads this file.

### Cody is meant to be SHARED — never ship the owner's environment

Cody is published for other people to install fresh, with their own accounts,
engines and provider credentials. That is a standing constraint on every
change, not a one-off audit: a stranger with an empty data dir, no engine on
PATH and no credentials must reach a working first chat, and every failure
must name the panel that fixes it.

- **Never hardcode this deployment**: the owner's forge/registry, hostnames,
  LAN addresses, `/data/agent`, his MCP servers or his provider plans. A value
  that varies per install is an env var with a sane default, or a first-run
  step. Anything CI-only that genuinely cannot be portable (a self-hosted
  forge login) is driven from repository variables with the current value as
  the fallback, so a fork works and the owner's release path is untouched.
- **Never seed a stranger's config with a provider they do not have.** The
  pay-as-you-go price overlay (`lib/model-pricing-overlay.ts`) used to write
  `alibaba-token-plan` rates into `models.yml` on EVERY first run: a brand-new
  instance grew a file naming a prepaid plan the user had never heard of, and
  the Providers hub then listed it as connected. `seedPayAsYouGoPricesOnce`
  now takes the set of providers the catalog actually reaches and writes
  nothing — not even the file — for an install that has none of them.
- **A `models.yml` entry with no endpoint and no models is an OVERRIDE, not a
  provider.** `readOmpProviderDirectory` (lib/harness/omp.ts) skips entries
  carrying only `cost`/`modelOverrides`; treating them as custom endpoints is
  what turned the price seed into a phantom "connected" row. Pinned by
  `lib/provider-directory.test.mjs`.
- **Prices for models omp does not know yet** (`lib/model-price-fill.ts`).
  omp prices every turn from its BUNDLED catalog (`@oh-my-pi/pi-catalog`, read for membership by `readBundledCatalog` in
  `lib/omp/bundled-catalog.ts`; layouts below), so a
  model reached through runtime discovery before omp's next release (a new
  GPT on a ChatGPT subscription) reads as free. `/api/models` reconciles in
  the background at most every 30 min: an `unpriced` model omp's catalog does
  NOT list, with an exact models.dev match on the same provider (or a
  declared `PRICE_PROVIDER_ALIASES` entry — only `openai-codex → openai`,
  because omp's own catalog prices the two identically) and a nonzero rate,
  gets that rate in `providers.<id>.modelOverrides.<model>.cost`, so omp
  still does the math. A model omp LISTS at zero is omp's decision (prepaid
  plan, free tier) and is never touched. Every write is recorded in
  `cody-price-fill.json`; if models.yml no longer holds exactly that value
  the user changed it, and the entry becomes a permanent tombstone. Once
  omp's catalog lists the model, Cody removes its value (handback). Only the
  four flat rates exist in models.yml's override schema — a long-context
  tier is not carried. Verified on a live omp: the utility registry reports
  the written cost for a discovered `openai-codex` model.
  **Bundled catalog layouts.** Two on-disk layouts exist and Cody reads whichever engine is installed: up to omp 18.13 `src/models.json` is plain `provider -> modelId -> model` (exported as `./models.json`); from 18.14 it is a compact encoded object and the package no longer exports it, so the package's own `src/model-catalog-format.ts` decoder is loaded (never hand-decoded in Cody, it would go stale with the next format change). A failed read is a typed `reason`, never an empty catalog: callers treat it as "cannot tell", not as "omp ships nothing" (price fill then does nothing rather than pricing against a wrong set). Pinned by `lib/omp/claude-credits.test.mjs` (both layouts via `fixtures/claude-credits/fake-omp-package.mjs`).
- **An engine's own CLI advice is not Cody's advice.** `OMP_BIN_MISSING`
  (lib/omp/omp-cli.ts) is the one missing-binary string, and it names Settings
  › System › Engines — not "install oh-my-pi or set CODY_OMP_BIN", which is
  what the setup wizard showed a new user verbatim. Same rule for a catalog
  with no credentials: `classifyModelError` tags it `no_credentials` and the
  composer prints Cody's own sentence pointing at Settings › Providers,
  instead of omp's "Use /login … or create models.yml". Match on the shared
  constant (`isOmpBinMissing`), never on a copied substring.
- **Verify shareability the way everything else here is verified**: a live run
  against an EMPTY agent dir with no engine on PATH and no credentials — not
  just a green test suite. Both of the traps above passed every test.

