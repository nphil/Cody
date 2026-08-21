# Release Checklist

Cody ships **one way: the container image**. `ghcr.io/nphil/cody:latest` is
what installs pull, a versioned GitHub Release is the changelog Unraid's
ShipLog plugin shows, and the in-app update check compares against the latest
release of this repo. **npm is not a release channel** — Cody is not
published there, nothing may reintroduce an npm publish step, and outside
Docker the app runs from a checkout (the Settings update check degrades to
"Update check unavailable" by design.)

Everything is driven by `.github/workflows/docker.yml`:

- **Every push to `main`** rebuilds the image, runs the smoke gate (locked
  first boot, first-run admin signup, in-container engine install, SSH
  bring-up), and republishes `:latest`. A red run means the release did not
  happen — the gate blocks publishing.
- **A version release** additionally publishes `ghcr.io/nphil/cody:X.Y.Z`,
  creates/updates the `vX.Y.Z` tag, and publishes a GitHub Release.

## Cutting a release

From a clean, gated `main` checkout (`npm run typecheck && npm run lint &&
npm test && npm run build` — inside the container, prefix the build with
`env -u TURBOPACK`):

```bash
npm version minor --no-git-tag-version       # or major/patch; updates package.json + lock
git add package.json package-lock.json
git commit                                   # subject: "Release X.Y.Z", body: the changelog narrative
git tag vX.Y.Z                               # annotated (-m) or lightweight — both work
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

```bash
gh run list --workflow docker.yml --limit 2          # publish + release green
gh release view vX.Y.Z                               # public, correct notes
T=$(curl -s "https://ghcr.io/token?scope=repository:nphil/cody:pull" | jq -r .token)
curl -s -o /dev/null -w '%{http_code} %header{docker-content-digest}\n' \
  -H "Authorization: Bearer $T" \
  -H "Accept: application/vnd.oci.image.index.v1+json" \
  https://ghcr.io/v2/nphil/cody/manifests/X.Y.Z      # 200; same digest as :latest
```

Then update the running server (Unraid's update button, or
`docker pull ghcr.io/nphil/cody:latest` + recreate). Note for agents: if you
are running inside that container, recreating it ends your session — finish
everything else first.
