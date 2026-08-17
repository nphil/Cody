# Cody for Windows — architecture

A native Windows desktop app: a **Tauri 2 Rust shell** hosting the system
**WebView2**, displaying the exact same UI the web app serves, with the Cody
server and engines running inside a **dedicated WSL2 distro** built from the
same bits as the Docker image. Not Electron: no bundled Chromium, no Node in
the shell process; the installer stays in the tens of megabytes and the UI
composites on WebView2's GPU pipeline.

Trade-off accepted up front: the UI is web-rendered (that is what makes
byte-for-byte parity with the web app free, forever), but the shell, window
chrome, process management, WSL provisioning, updates, and GPU detection are
native Rust.

## Why WSL2 for the runtime

- The rootfs is **flattened from `ghcr.io/nphil/cody:latest`** — the engines,
  Chromium, fonts, Bun, and entrypoint behave exactly as on the proven
  container deployment. One runtime to test, not two.
- Engines (omp/Claude Code/Codex) run on Linux, their first-class platform;
  nothing Windows-specific to chase in them.
- **CUDA in WSL2 is first-class**: the Windows NVIDIA driver is the only GPU
  requirement; `/usr/lib/wsl/lib` provides `libcuda.so` + `nvidia-smi` inside
  the distro, so local model runtimes see the GPU.
- Windows interop means terminals inside the distro can still run
  `powershell.exe` / `cmd.exe`, and `\\wsl$\cody\` exposes the workspace in
  Explorer.

## Repository layout

```
desktop/
  package.json          # @tauri-apps/cli only (build tooling)
  src-tauri/
    Cargo.toml
    tauri.conf.json     # frameless window, NSIS bundle, withGlobalTauri
    capabilities/       # remote-URL IPC grants for http://localhost:PORT
    src/
      main.rs           # window + lifecycle wiring
      commands.rs       # IPC surface (see contract below)
      wsl.rs            # detect / import / run / terminate, UTF-16 decode
      server.rs         # server child lifecycle + health polling
      rootfs.rs         # download / verify / import / runtime-update
      update.rs         # shell self-update via GitHub Releases manifest
      gpu.rs            # NVIDIA presence via nvidia-smi(.exe)
    bootstrap/          # bundled first-run page (setup progress, errors)
  README.md
```

Nothing outside `desktop/` may depend on anything inside it. The web app's
only desktop awareness is runtime feature detection (below).

## Process model

1. Shell launches → shows the bundled **bootstrap page** (bundled asset, not
   the server) with status.
2. Checks, in order: WSL2 present → `cody` distro registered → runtime
   version marker matches → server healthy.
3. Missing WSL → guided enable (link + elevated command, reboot notice);
   detection is probe-based (`WSL_UTF8=1`, hex HRESULTs like `0x8007019e`
   feature-off / `0x80370102` no-virtualization — wsl.exe has no exit-code
   contract). Missing distro → download `rootfs.tar.gz` (progress UI, sha256
   verify) → stream-import via stdin: decompress in the shell and pipe into
   `wsl --import cody <dir> - --version 2` (gzip is the recommended tar
   compression; zstd/xz risk import incompatibility; streaming avoids a
   multi-GB temp file). Before importing, clear NTFS compress/encrypt
   attributes on the install dir (they corrupt WSL VHDs) and keep it on the
   system drive.
4. Starts the server: a held `wsl -d cody -- env <ENV BLOCK> sh -lc
   '/usr/local/bin/cody-entrypoint'` child (hidden window). The shell owns
   this child; app exit terminates it (`wsl --terminate cody` as cleanup).
   `docker export` strips image ENV, so **the shell owns the env block**,
   mirroring the Dockerfile: `HOME=/data/home`, `PI_CODING_AGENT_DIR=/data/agent`,
   `CODY_HARNESS=omp`, `CODY_CHROMIUM_BIN=/usr/bin/chromium`, `PORT=<port>`,
   `NODE_ENV=production`, `TERM=xterm-256color`, plus desktop-only vars below.
5. Polls `http://localhost:<port>/api/accounts/state` until healthy, then
   navigates the main window to `http://localhost:<port>/`.
6. Crash/exit of the server child → bootstrap page returns with the error and
   a retry action.

**Port**: default `30179`, persisted in the shell's config
(`%APPDATA%\Cody\config.json`); collision → next free port. The remote
capability grants `http://localhost:*` / `http://127.0.0.1:*` (port and
path wildcards are supported — an omitted `:*` would match only port 80),
so the port is free to move.

**Networking contract** (verified): the server binds `127.0.0.1` inside
WSL. Default-NAT `localhostForwarding` covers localhost-bound listeners, so
Windows reaches it at `localhost:<port>` with no firewall rule or prompt
(Hyper-V firewall `LoopbackEnabled` is default-on). `127.0.0.1` is also the
only **mode-agnostic** safe bind: under user-enabled `networkingMode=mirrored`
a `0.0.0.0` bind would become LAN-reachable, and Cody must stay loopback-only
regardless of a `.wslconfig` Cody does not own. Never bind wider.

## Auth on desktop

Single-user machine, loopback-only server, and **zero new server code**
(verified against the auth seams): the shell generates a random secret and
passes it as `CODY_PASSWORD` in the env block — the existing env-managed
`cody` admin account materializes — then the shell (not the WebView) POSTs
`/api/accounts/login` once, reads the `cody_session` cookie, and injects it
into WebView2's cookie store before first navigation. The user never sees a
login screen; web/Docker deployments are untouched. Fallback if cookie
injection misbehaves: plain first-run setup in the WebView.

## Window chrome (Discord/VSCode style, native)

- `decorations: false`; the web app renders the titlebar.
- Frontend detects the shell via `window.__TAURI__` (config
  `app.withGlobalTauri: true` — **no new npm dependency in the web app**).
- Titlebar: drag region via `data-tauri-drag-region`, theme-styled
  min/max/close buttons calling the IPC surface, maximize-state reactive via
  window events, double-click maximizes. i18n for tooltips (en/ja/zh-CN).
- Snap Layouts: ship without a plugin (decorum is abandoned; the
  alternatives add surface for one hover flyout). Win+Z and edge-drag snap
  still work — Discord-level behavior, accepted. Undecorated windows keep
  native resize borders and Win11 rounded corners (`shadow: true`).

## IPC surface (shell ⇄ web app)

Tauri commands, granted to the remote origin `http://localhost:<port>` only:

| Command | Purpose |
| --- | --- |
| `window_minimize` / `window_toggle_maximize` / `window_close` | titlebar buttons |
| `window_is_maximized` | initial titlebar state (then event-driven) |
| `desktop_info` | `{ shellVersion, runtimeVersion, port, gpu: {vendor, name} \| null }` |
| `open_external` | open a URL in the default browser |
| `runtime_update_check` / `runtime_update_apply` | rootfs update flow |

Plus core window events for maximize/unmaximize. Exact capability JSON per
Tauri research report. External navigation is confined: non-app origins open
in the system browser.

## Feature parity notes (WSL mode)

- **Terminals**: node-pty in the distro → real Linux shells; `powershell.exe`
  available through WSL interop.
- **Preview + screenshots**: dev servers the agent starts live in the distro;
  WebView2 reaches them through the same localhost forwarding as the app
  itself; `preview_screenshot` uses the distro's own Chromium. Loopback-only
  URL rules hold unchanged.
- **Git/checkpoints/tasks**: unchanged — they live behind the server.
- **SSH panel**: hidden on desktop via the existing capability-flag pattern
  (sshd never starts; the entrypoint already gates it on credentials).

## Local AI runtimes

Detection is **server-side** (benefits the container deployment too): a scan
service probes well-known local endpoints (Ollama `:11434`, LM Studio
`:1234`, llama.cpp/llama-swap `:8080`/`:9292`) on the server's localhost
**and** — when `CODY_HOST_GATEWAY=<ip>` is set — the same ports on the
Windows host across the WSL NAT boundary. The shell computes and passes
`CODY_HOST_GATEWAY`. [VERIFY gateway discovery method.] Found endpoints are
listed in Settings (model list via each runtime's API) and plug into the
existing local-endpoint engine configuration. GPU presence from
`desktop_info` is displayed alongside.

## Updates

Two independently-versioned artifacts, one CI run, two Releases:

- **Shell** (`desktop-vX.Y.Z`): NSIS installer. Self-update: at launch (and
  on demand) the shell fetches the update manifest from its fixed,
  permanently-stable URL — `.../releases/download/desktop-latest/
  desktop-manifest.json` — compares versions, downloads the new installer,
  verifies sha256, spawns it detached with `/S`, exits. No signing-key
  infrastructure in v1; transport trust is TLS to github.com, integrity via
  manifest sha256.
- **Runtime** (rootfs, gzip-compressed and named `rootfs-cody-<cody
  version>.tar.gz` after the Cody version it was flattened from): the
  manifest's `runtime` object carries both the container's version label and
  the source image's digest (`runtime.imageDigest`), and the import writes
  each into the distro — `/etc/cody-runtime-version` and
  `/etc/cody-runtime-digest`. An update is offered when the manifest's
  version is **newer** than the installed marker, **or** when both digests
  are known and they **differ**. The digest is the signal that carries the
  weight: `ghcr.io/nphil/cody:latest` is republished far more often than its
  version label moves, so version-compare alone would sit on a stale runtime
  indefinitely. Neither marker present (a distro predating them) counts as
  outdated. The reverse case is the common one and costs nothing: a release
  that only changed the shell republishes the previous `runtime` block
  unchanged (see CI, below), so the digests match and no runtime update is
  offered at all. Applying it: export `/data` to a tar on the Windows side →
  `--unregister` → import new rootfs → restore `/data` → restart server.
  `/data` is the only stateful path (same contract as the container). Past
  the `--unregister` there is no distro to fall back to, so a failed import
  retries, then reimports the previously cached rootfs, and the `/data`
  backup goes back into whichever one comes up; if none does, the error
  names the backup's path and the next successful install restores it
  automatically. The two newest backups are kept, older ones pruned.
  Export→reimport is also the disk-reclaim story: sparse VHDs are disabled
  by WSL as corruption-prone (`--allow-unsafe`-gated) and shrinking is
  admin-only, so Cody never enables sparse mode.

Release/tag scheme: every release run publishes **two** releases.
`desktop-vX.Y.Z` is immutable, one per version, kept forever as desktop's own
changelog alongside the installer, rootfs, and `desktop-manifest.json` — an
ordinary **visible** release (not a prerelease), created with `--latest=false`
so it can never win the repo's single `/releases/latest` slot. That slot
belongs to the container train, which ShipLog reads as the server's changelog;
GitHub only moves the pointer for a release published with `make_latest`
true/legacy, so the explicit false is the whole isolation mechanism. (Marking
desktop releases `prerelease: true` used to do that job, at the cost of
burying every one of them below every container release.) `desktop-latest` is
force-moved to the new commit every run — the fixed URL above, the only thing
the shell's updater ever polls — and stays `prerelease: true`: it is a
machine-facing pointer, not a changelog entry, so keeping it out of the human
release list is deliberate.

## CI

- `.github/workflows/desktop.yml` — **every push to `main` that touches
  `desktop/**` or the workflow file itself publishes a release.** There is no
  build-only mode: shell build (windows-latest, NSIS installer), rootfs build
  (ubuntu, flatten + **gzip** the published container image — gzip, not zstd,
  is WSL's own recommended `wsl --import` compression; other formats risk
  import incompatibility on older WSL versions) **when the runtime actually
  changed**, then publish installer + rootfs + manifest to both the immutable
  `desktop-vX.Y.Z` and the rolling `desktop-latest`.
  - **Version** — computed from the tags, never committed anywhere: the
    highest existing `desktop-v*` tag compared *numerically* (0.1.10 > 0.1.9)
    plus one patch, or 0.1.0 if no desktop tag exists yet. It is patched into
    `tauri.conf.json`, `Cargo.toml` and `Cargo.lock` at build time and verified
    there. A computed tag that already exists fails the run loudly rather than
    clobbering an immutable release.
  - **Changelog** — generated from the commits touching `desktop/**` between
    the previous `desktop-v*` tag and the released commit: one
    `- subject (short sha)` bullet each, newest first, de-duplicated. A run
    with no such commits (a CI-only change, say) says so in the body instead of
    shipping an empty section. The artifact/SHA-256 table and the rootfs
    provenance line follow it.
  - **Runtime reuse** — the rootfs is a snapshot of a container image this
    workflow does not build, so a desktop-only change would otherwise spend
    ten minutes and ~740 MB reproducing a byte-identical runtime. Before
    anything builds, the workflow reads the current digest of
    `ghcr.io/nphil/cody:latest` straight from the registry API (an anonymous
    pull token; no image data transferred) and compares it with the digest
    recorded in the **live** `desktop-manifest.json`. Equal digests, plus a
    liveness probe confirming the rootfs that manifest names is still
    downloadable, skip the rootfs job entirely: the release republishes the
    previous `runtime` block verbatim — same URL, same sha256, same size, same
    `imageDigest` — so a typical desktop-only release is just the ~1.6 MB
    installer and a new manifest, and installed clients see no runtime change.
    Anything unproven falls back to rebuilding: no published manifest, an
    unparseable one, a digest that moved, an asset that 404s, or a registry
    that will not answer. The release body says which happened, and when the
    runtime is reused it names the release that hosts the tarball (the
    per-version release carries installer + manifest only).
  - **Dispatch overrides**, all optional: `version` (exact X.Y.Z, wins over
    everything), `bump` (patch/minor/major, default patch), `notes` (prepended
    to the generated changelog), `force_rootfs` (rebuild and re-upload the
    rootfs even when the image has not moved — the escape hatch for a bad
    snapshot or a changed exclude list).
  - The release job pushes **tags only** and never commits back to `main`, and
    the push trigger is branch-filtered — which a tag push does not match — so
    a release cannot re-trigger the workflow.
- `.github/workflows/docker.yml` gains a paths guard so `desktop/**`-only
  pushes stop cutting container releases (and vice versa: web/docker pushes
  never build the desktop app — the runtime picks up web changes through
  rootfs updates, the shell doesn't need rebuilding). Path filters are never
  evaluated for tag pushes or `workflow_dispatch`, so container releases are
  unaffected either way.
- The container smoke-gate contract is untouched.

## Non-goals for v1

- macOS/Linux shells (the architecture ports, but not now).
- Windows-native (non-WSL) engine execution — future per-workspace choice.
- Code signing (SmartScreen warning accepted; revisit with a cert).
- Auto-start on boot, tray minimization — candidates for v1.1.
