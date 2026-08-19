# Release Checklist

> **Status: not published yet — deliberately.** Cody is self-hosted for
> personal use right now (run from a checkout, or the Docker bundle in
> `docker/` — see `docs/unraid.md`). Publishing to npm is on the long-term
> roadmap for when the product is ready to share. Nothing depends on it
> except the version check in Settings › System & Updates, which degrades to
> "Update check unavailable" until then. The steps below are ready to run
> whenever that day comes.

Each release publishes two artifacts:

- npm package: `@nphil/cody`
- GitHub Release: [nphil/Cody](https://github.com/nphil/Cody)

After the initial bootstrap release, publishing is performed by GitHub Actions
with npm trusted publishing. No npm access token is stored in this repository
or in GitHub secrets.

## Bootstrap the first release

`@nphil/cody` is not registered on npm yet. npm exposes trusted-publisher settings
only for an existing package, so the first version must be published once from a
reviewed local checkout using the authenticated npm account:

```bash
npm ci
npm test
npm run build
npm pack --dry-run
npm publish --access public
```

`--access public` is required: a scoped package defaults to restricted.

Do not create a tag or GitHub Release for this bootstrap version: npm will
reject a duplicate version.
After this succeeds, configure trusted publishing before publishing any later
version.

## One-time trusted-publisher setup

1. In npm, open the `@nphil/cody` package settings and add a **GitHub Actions**
   trusted publisher with:
   - Owner: `nphil`
   - Repository: `Cody`
   - Workflow filename: `publish.yml`
   - Environment: `npm`
2. In GitHub, create the `npm` environment for this repository. Add required
   reviewers if releases need approval.
3. Confirm Actions are enabled for the repository.

The workflow at `.github/workflows/publish.yml` requests `contents: write` to
create the GitHub Release and `id-token: write` for trusted publishing. It
installs npm 11.5.1 or newer, as required for trusted publishing. The OIDC
permission lets npm verify the GitHub Actions identity and generate provenance
for the published package.

## Release later versions

Run these from a clean `main` checkout after the release changes are merged.

```bash
npm ci
npm test
npm run build
npm version <major|minor|patch>
git push origin main --follow-tags
```

`npm version` updates `package.json` and `package-lock.json`, creates a commit,
and creates a `v<version>` tag. Review the generated commit before pushing.

Pushing the tag starts the `Publish npm package` workflow. It checks out that
immutable tag, verifies the tag matches `package.json`, installs from the
lockfile, runs tests and the production build, then creates a draft GitHub
Release with generated notes. It publishes `@nphil/cody` through the configured
trusted publisher and makes that release public only after npm accepts the
package. A rerun can safely finish a release if npm has already accepted its
version.

## Verify

```bash
gh run list --repo nphil/Cody --workflow publish.yml --limit 1
npm view @nphil/cody@<version> version --registry https://registry.npmjs.org/
npm view @nphil/cody@<version> --json --registry https://registry.npmjs.org/
```

Confirm the workflow succeeded, the exact package version resolves, and npm
shows the expected provenance link.
