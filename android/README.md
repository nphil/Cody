# Cody for Android

A native Android client for a Cody server. Kotlin Multiplatform core, Compose UI,
one APK, published from CI to a fixed URL that an updater can follow forever.

This is a **separate Gradle build** rooted at `android/`. It is not part of the
Next.js workspace: `npm run dev` never sees a Gradle daemon and `./gradlew` never
walks `node_modules`. The only thing the two halves share is the server's HTTP
API, mirrored by hand in `:shared`.

---

## What actually works

Read this section before installing. Everything below is either **live against
the real API** or it is **not there** — there is no third category, and nothing
in the app is faked, mocked, or stubbed to look finished.

### Live against the server

| Capability | Endpoint |
| --- | --- |
| Sign in with username + password, minting a token for this device | `POST /api/accounts/login` → `POST /api/accounts/me/tokens` |
| Sign in by pasting a token minted elsewhere | verified with `GET /api/accounts/me` |
| Connection + identity badge (host, user, engine, server version) | `GET /api/accounts/me`, `GET /api/info` |
| Session list, with the running ones marked | `GET /api/sessions` |
| Transcript rendering: user/assistant text, tool calls, tool results, bash and python blocks, images, file mentions | `GET /api/sessions/{id}?deferThinking=1&deferMedia=1` |
| Sending a prompt | `POST /api/agent/{id}` |
| Live updates while a turn runs | SSE `GET /api/agent/{id}/events` |
| Token persistence across launches | Android Keystore, AES-256-GCM (below) |
| Sign-out, and automatic sign-out on any `401` | local |

Onboarding never stores anything until the credential has actually answered
`200` on `GET /api/accounts/me` against that exact address, so the app cannot get
stuck holding a credential it has never proven.

### Deliberately coarse, and why

**Live updates refetch, they do not stream incrementally.** An event on the SSE
stream marks the session live and schedules a debounced (350 ms) refetch of the
transcript; frames are not applied to messages directly. The server's
`message_update` frames carry the full accumulated message and must *replace*
rather than append, and getting that wrong silently duplicates text. Refetching
is the coarse option that cannot be subtly wrong. In practice the transcript
updates about a third of a second behind the web UI. The seam for incremental
rendering is `ChatModel` and nothing above it would change.

**Thinking bodies and tool-result images are requested deferred.** The transcript
shows that a thinking block exists but not its text, because asking for
everything inline turns a long transcript into megabytes over a tail-net link.
There is no on-demand fetch yet, so deferred content is currently *not
retrievable in the app*.

### Not in this build at all

No placeholder screens were shipped for these — they simply do not exist:

- Settings of any kind (theme picker, server switching beyond sign-out)
- File browser / workspace tools / diff views
- Model picker, skills, plugins, MCP panels, engine settings, update checks
- Creating, forking, renaming or deleting a session (the list is read-only;
  prompts go to sessions that already exist)
- Checkpoints / restore
- Cancelling a running turn
- Attachments, image upload, voice
- Local (on-device) backend — `BackendKind.Local` is defined in the interface so
  that adding one later is not a rewrite, but there is no implementation

The server reports capability flags for most of the above and `:shared` decodes
all of them; the UI reads only `liveEvents` and `prompts`. The rest are wired
through to nothing, on purpose, so the screens can gate on them the day they are
written.

### Security notes

- The token is encrypted at rest with a **hardware-backed AES-256-GCM key from
  the Android Keystore**, stored via DataStore. It is not plaintext. A fresh IV
  is generated per write and prefixed to the ciphertext. If the Keystore key
  disappears (device restore, factory reset) the undecryptable blob is dropped
  and onboarding runs again.
- `setUserAuthenticationRequired` is deliberately **not** set, so there is no
  biometric prompt on launch. The threat model is offline access to the device,
  not a thief holding an unlocked tablet.
- The base URL is stored in the clear. It is not a secret and seeing it is useful
  when something is misconfigured.
- Cleartext HTTP is permitted, because Cody over a tail-net is plain HTTP far
  more often than not. See `app/src/main/res/xml/network_security_config.xml`.
- The password is never persisted and is dropped from in-memory state as soon as
  the token is minted. The login cookie lives in a per-instance, in-memory jar
  that is thrown away with the `CodyAuth` object.

### Theme

Catppuccin **Latte** (light) and **Mocha** (dark), which is what Cody actually
ships as its default — not the warm-paper/warm-ember palette in the older design
drafts. Follows the system light/dark setting. The palette is a data class of
semantic tokens (`ui/theme/CodyPalette.kt`) mirroring the CSS custom properties,
so adding the other nine families is adding entries, not rewriting screens.

---

## Building locally

### Toolchain

The build needs **JDK 21**, the **Android SDK** (platform 37, build-tools 37.0.0)
and **Gradle 9.7.0** (the wrapper pins it, with a SHA-256). In this container they
are already provisioned:

```
/tmp/atk/jdk        JDK 21 (Temurin)
/tmp/atk/sdk        Android SDK
/tmp/atk/gradle     Gradle 9.7.0
```

`/tmp/atk/provision.sh` is the script that installed them and is safe to re-run —
it is idempotent and takes well under a minute. On a machine without them, run it
first.

### Commands

```bash
cd android

export JAVA_HOME=/tmp/atk/jdk
export ANDROID_HOME=/tmp/atk/sdk
export ANDROID_SDK_ROOT=/tmp/atk/sdk
export PATH="$JAVA_HOME/bin:$PATH"

# Debug APK — no minification, installs alongside a release build
# (applicationId gets a .debug suffix).
./gradlew :app:assembleDebug

# Release APK — R8 minify + resource shrinking. Debug-signed unless the
# CODY_KEYSTORE_* variables below are set.
./gradlew :app:assembleRelease -Pcody.versionCode=1 -Pcody.versionName=0.1.0-local

# Wire-format and spawn-policy tests. Plain JVM, no emulator, ~10s.
./gradlew :shared:jvmTest
```

`./gradlew` downloads Gradle 9.7.0 itself. To reuse the already-provisioned copy
and skip that, substitute `/tmp/atk/gradle/bin/gradle` for `./gradlew`.

Outputs:

```
app/build/outputs/apk/debug/app-debug.apk
app/build/outputs/apk/release/app-release.apk
app/build/outputs/mapping/release/mapping.txt      # keep this for crash reports
```

`versionCode` and `versionName` are **never** committed. They are injected as
Gradle properties by CI; a local build with no properties is stamped
`0.0.0-dev` / `1`, which is obviously fake rather than plausibly wrong.

### Modules

| Module | What it is |
| --- | --- |
| `:shared` | Kotlin Multiplatform (`android` + `jvm` targets). Models, the `CodyBackend` interface, the Ktor transport, and the presentation models. Depends on kotlinx + Ktor only — no androidx, no `android.*`, enforced by the `jvm()` target being a compile error if that ever changes. `explicitApi()` is on. |
| `:app` | Android application. Compose UI, the `ViewModel` lifecycle wrapper, and the Keystore credential store. About 40 lines of it are Android-specific glue; the logic lives in `:shared` so it ports. |

`minSdk 29` (Android 10) · `targetSdk 37` · `compileSdk 37` · Java 17 bytecode,
JDK 21 toolchain.

### Signing a release build locally

```bash
export CODY_KEYSTORE_FILE=/absolute/path/to/cody-release.jks
export CODY_KEYSTORE_PASSWORD=…
export CODY_KEY_ALIAS=cody
export CODY_KEY_PASSWORD=…          # see the PKCS12 warning below
./gradlew :app:assembleRelease
```

`CODY_KEYSTORE_FILE` **must be absolute** — the build resolves it with Gradle's
`file()`, which is relative to the `app/` project directory. If the variable is
unset, the release build silently falls back to AGP's debug key.

---

## Release signing and CI

`.github/workflows/android.yml` builds on every push to `main` that touches
`android/`, on every `android-v*` tag, and on manual dispatch.

### The four GitHub secrets

Add these under **Settings → Secrets and variables → Actions → New repository
secret**. Set **all four or none** — the workflow fails fast on a partial
configuration, because AGP reports a half-configured keystore as an error that
mentions neither secrets nor signing.

| Secret name | Value |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | the keystore file, base64-encoded, single line |
| `ANDROID_KEYSTORE_PASSWORD` | the keystore (store) password |
| `ANDROID_KEY_ALIAS` | the key alias, e.g. `cody` |
| `ANDROID_KEY_PASSWORD` | the key password — **same as the store password**, see below |

Until they exist the pipeline still runs and still publishes; the APK is just
debug-signed and the release notes say so in plain language.

### Generating the keystore

```bash
keytool -genkeypair -v \
  -keystore cody-release.jks \
  -alias cody \
  -keyalg RSA -keysize 4096 \
  -validity 10000 \
  -storepass 'CHOOSE-A-STRONG-PASSWORD' \
  -keypass  'CHOOSE-A-STRONG-PASSWORD' \
  -dname "CN=Cody, O=Cody, C=US"

# One line, no trailing newline. This is the value of ANDROID_KEYSTORE_BASE64.
base64 -w0 cody-release.jks
```

> **Use the same string for `-storepass` and `-keypass`.** Since JDK 9 `keytool`
> creates **PKCS12** keystores by default, and PKCS12 cannot hold a key password
> that differs from the store password. Given two different values keytool prints
> `Warning: Different store and key passwords not supported for PKCS12
> KeyStores. Ignoring user-specified -keypass value.` and quietly uses the store
> password for both. Set `ANDROID_KEY_PASSWORD` to the other value afterwards and
> the build dies in AGP's packaging task with
> `KeytoolException: Failed to read key cody from store …: null` — a message that
> mentions neither passwords nor PKCS12. The workflow now detects this exact
> mismatch up front and tells you, but it is much easier to just use one
> password. (Pass `-storetype JKS` if you genuinely need two.)

**Back the keystore up somewhere durable.** Android identifies an app by its
signing key: lose it and no future build can ever update an installed copy — the
app has to be uninstalled and reinstalled, losing its stored token.

For the same reason, moving from the debug-signed fallback to a real key is a
one-time uninstall/reinstall. Add the secrets **before** the tablet has anything
worth keeping, or accept one reinstall later.

---

## Installing on the tablet

### Obtainium (recommended — gives automatic updates)

Add an app in [Obtainium](https://github.com/ImranR98/Obtainium) with:

**App Source URL**

```
https://github.com/nphil/Cody
```

Then set these, all of which are on the app's settings page in Obtainium:

| Setting | Value | Why it is required |
| --- | --- | --- |
| **Release title as version** | **ON** | Obtainium takes the version from the release *tag* by default. Our tag is the rolling `android-latest` on every single release, so with this off the version string never changes and **Obtainium will never offer an update**. The rolling release is titled with the bare version number precisely so this switch works. |
| **Fallback to older releases** | **ON** | This repo also publishes container (`vX.Y.Z`) and desktop (`desktop-v*`) releases, which carry no APK. Obtainium stops scanning after the first release it cannot use unless this is on, so without it the Android release is never reached. |
| **Filter APKs by Regular Expression** | `^cody-android\.apk$` | Belt and braces: pins the download to the rolling asset so a version-stamped archive APK can never be picked instead. |

"Include prereleases" should stay **OFF**. The rolling release is deliberately a
normal visible release so the default works; the immutable `android-v*` archives
are marked prerelease exactly so they stay out of Obtainium's way.

### Manual install

This URL is stable across every release, forever:

```
https://github.com/nphil/Cody/releases/download/android-latest/cody-android.apk
```

`cody-android.apk.sha256` sits beside it, and `android-manifest.json` on the same
release carries the version, versionCode, size, sha256 and whether the build was
release-signed.

---

## How releases are published

Mirrors `.github/workflows/desktop.yml`, which is the house precedent for
rolling-tag releases; the reasoning is written out at the top of
`.github/workflows/android.yml`. In short:

- **`android-latest`** — rolling tag, force-moved to each new commit. Its release
  is updated **in place**, never deleted and re-created, because deleting takes
  the download URL offline for everyone polling in that window. Asset name is
  always `cody-android.apk`. Titled with the bare version string, which is what
  Obtainium reads as the version.
- **`android-v<X.Y.Z>`** — immutable archive, created only when you push an
  `android-v*` tag. Its APK is version-stamped, and it is marked prerelease so it
  cannot compete with the rolling release for Obtainium's attention.
- Every asset is uploaded **before** the manifest that names it. A reader takes
  `android-manifest.json` and then follows its URL and checksum, so the manifest
  must never land first.
- Neither ever takes the repo's `/releases/latest` slot (`--latest=false`); that
  belongs to the container train, which the ShipLog plugin on Unraid reads as the
  server's version. The workflow asserts this afterwards.
- `versionCode` is the workflow **run number** — monotonic and never repeated.
  Renaming the workflow file would restart it at 1 and every installed copy would
  refuse the "downgrade", so don't.
- `versionName` is the tag for a tag build, otherwise `<base>+<short-sha>`. The
  base lives in the workflow's `BASE_VERSION` env var.

### Cutting a named version

```bash
git tag android-v0.2.0 && git push origin android-v0.2.0
```

---

## Tests

```bash
./gradlew :shared:jvmTest
```

30 tests, no emulator, about ten seconds. They cover the things that fail
silently rather than loudly:

- **`WireFormatTest`** — the decoding contract against the payload shapes in
  `docs/api.md`. Most importantly the *forward-compatibility* rules: a field a
  newer server added must not break decoding, and a message kind or content block
  this build has never heard of must degrade to a placeholder row instead of
  taking the whole transcript down.
- **`RemoteBackendTest`** — the transport. Status-to-failure mapping, the bearer
  header, path encoding of session ids, the deferred-content query parameters,
  and the `401 auth_required` body byte-for-byte as a live server sends it.
- **`ChatModelSpawnPolicyTest`** — the spawn policy, and the most consequential
  file here. `GET /api/agent/{id}/events` **cold-spawns an engine process** when
  the session is not already running, so the app may only attach the stream to a
  session the server reported as running, or straight after a prompt (which
  spawns the engine anyway). A regression would not fail anything visibly; it
  would just quietly fork an engine per tap.
- **`ServerConfigTest`** — what a typed-on-a-tablet address normalises to.

CI additionally asserts that R8 kept the `kotlinx.serialization` generated
serializers in the shipped dex. That check exists because a missing keep rule
does not fail the build — it produces an APK that throws the first time it
decodes a server response.
