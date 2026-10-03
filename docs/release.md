# Release Checklist

Cody ships **one way: the container image** — but to **two hosts, both real.**
Its home is the self-hosted Gitea forge at
`https://git.nateshome.net/nphilip89/Cody` (remote `forge`), whose
`git.nateshome.net/nphilip89/cody:latest` is **what the owner's Unraid server
pulls**; it also releases on GitHub at `github.com/nphil/Cody` (remote
`origin`), whose `ghcr.io/nphil/cody:latest` is what other installs pull. Each
host builds and publishes its own image from its own workflow
(`.gitea/workflows/docker.yml`, `.github/workflows/docker.yml`); keep the two
in step, and never re-point one host's image name at the other's registry.
A versioned Release on each is the changelog Unraid's ShipLog plugin shows,
and the in-app update check compares against the latest release.
**Pushing only one host is the mistake this paragraph exists to prevent: a
GitHub-only release leaves production on the old image while every check
above it reports success.** **npm is not a release channel** — Cody is not
published there, nothing may reintroduce an npm publish step, and outside
Docker the app runs from a checkout (the Settings update check degrades to
"Update check unavailable" by design.)

That is the DEFAULT, not a hard-coded fact: Settings › Code hosts › Cody
update source repoints the check (and the `docker pull` command the card
shows) at any configured code host, so an instance whose image is published
by a self-hosted Gitea compares against that host's
`/repos/{owner}/{name}/releases/latest` and never reaches github.com. The
release procedure below is unchanged for this repository.

Everything is driven by `.github/workflows/docker.yml`:

- **Every push to `main`** rebuilds the image, runs the smoke gate (locked
  first boot, first-run admin signup, in-container engine install, SSH
  bring-up), and republishes `:latest`. A red run means the release did not
  happen — the gate blocks publishing.
- **A version release** additionally publishes `ghcr.io/nphil/cody:X.Y.Z`,
  creates/updates the `vX.Y.Z` tag, and publishes a GitHub Release.


## Rules the pipeline enforces (learned the hard way)

- **A cache write may never fail a release.** Both builds export with
  `cache-to: type=gha,mode=max,ignore-error=true`. The export runs *after* a
  successful image build, and the forge's cache backend can fail on its own
  (`error writing layer blob: failed to commit cache`) — which failed the
  publish job, and with it the release, for an image that had already built.
- **Runner disk is reclaimed before the build, not diagnosed after it.** The
  forge runners are small LXCs sharing a host daemon, and every release
  leaves an image, a builder and a smoke container behind. `Reclaim runner
  disk` prunes unreferenced containers/images/build cache older than the
  window that keeps consecutive builds fast.
- **`sha-<commit>` tags are pruned to the newest three.** They exist to tie
  `:latest` to a commit, which is a short-lived need; 46 versions of one
  image accumulated on the array before the first sweep. Semver tags and
  `:latest` are never touched — they are the rollback path.
- **Never verify against the live agent dir.** A verification server started
  with only `CODY_ACCOUNTS_DIR` isolated still shares `/data/agent`, so its
  first `/api/usage` poll reconciled routing and rewrote the owner's
  `modelRoles`. A throwaway instance MUST set `PI_CODING_AGENT_DIR` to a
  scratch directory; isolating accounts alone is not isolation.
- **A `release` job that dies on its very first step with `unable to find
  user root: no matching entries in passwd file` is the runner, not the
  workflow.** v0.47.0 hit it once: the job container started from the
  runner image without a usable root filesystem (the `bash` probe failed,
  the step fell back to `sh`, then the exec could not resolve `root`) before
  any workflow line ran. Nothing in `docker.yml` causes or can fix that, and
  the same image starts cleanly on every manual attempt. The image had
  already published. The `release` job is idempotent (it PATCHes an existing
  release), so recovery is to re-run that job from the run page; confirm
  with `forge op=releases` that the Release carries its notes.

## Cutting a release

From a clean, gated `main` checkout (`npm run typecheck && npm run lint &&
npm test && npm run build` — inside the container, prefix the build with
`env -u TURBOPACK`):

```bash
npm version minor --no-git-tag-version       # or major/patch; updates package.json + lock
git add package.json package-lock.json
git commit                                   # subject: "Release X.Y.Z", body: the changelog narrative
git tag vX.Y.Z                               # annotated (-m) or lightweight — both work
git push forge main vX.Y.Z                   # the forge FIRST: its image is what production pulls
git push origin main vX.Y.Z
```

The tag push runs the workflow's `release` job, which resolves the notes
without a checkout (annotated tag → tag message; lightweight tag → the
release commit's message body) and publishes "Cody vX.Y.Z" with generated
commit notes appended.

Alternatively, dispatch the whole thing without touching tags locally:

```bash
gh workflow run docker.yml -f version=X.Y.Z -F notes=@notes.md
```

The `@` matters: without it the literal path becomes the release body.
Dispatch with an empty version is a plain `:latest` rebuild, no release.

## Verify

**Both hosts, not one.** The forge half is the one production pulls, so
verify it first — Cody's own `forge` tool reaches it without a CLI:

```
forge op=run_watch host=nateforge repo=nphilip89/Cody branch=main
forge op=releases  host=nateforge repo=nphilip89/Cody limit=1   # vX.Y.Z, not a draft
forge op=packages  host=nateforge owner=nphilip89              # :latest AND :X.Y.Z, same timestamp
```

Pushing `main` and the tag together starts TWO runs per host (one for the
branch, one for the tag); the branch run skips its `release` job and the tag
run does not. Both must be green.

Then the GitHub half:

```bash
gh run list --workflow docker.yml --limit 2          # publish + release green
gh release view vX.Y.Z                               # public, correct notes
T=$(curl -s "https://ghcr.io/token?scope=repository:nphil/cody:pull" | jq -r .token)
curl -s -H "Authorization: Bearer $T" \
  -H "Accept: application/vnd.oci.image.index.v1+json" \
  https://ghcr.io/v2/nphil/cody/manifests/X.Y.Z |
  jq -r '.manifests[] | select(.platform.architecture=="amd64") | .digest'
```

**Compare the per-platform amd64 digest, never the index digest.** Those two
concurrent builds each attach their own provenance attestation to the index,
so `X.Y.Z` and `latest` legitimately carry DIFFERENT index digests while the
runnable image is byte-identical. An earlier version of this check compared
index digests and reported a false mismatch on its own happy path.

Then update the running server (Unraid's update button, or
`docker pull git.nateshome.net/nphilip89/cody:latest` + recreate). Note for
agents: if you are running inside that container, recreating it ends your
session — finish everything else first, and never recreate it without the
owner's say-so.
