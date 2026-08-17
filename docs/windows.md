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

**Port**: fixed default `30179`, chosen at first run, persisted in the
shell's config (`%APPDATA%\Cody\config.json`); collision → next free port.
[VERIFY: if remote-capability URLs cannot wildcard ports, pin the chosen
port into the capability at build time and make the config port fixed.]

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
- Snap Layouts: [VERIFY decorum/WCO recommendation; otherwise accept
  Discord-level behavior (Win+Z and edge-drag still work).]

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

Two independently-versioned artifacts, one Release:

- **Shell** (`desktop-vX.Y.Z`): NSIS installer. Self-update: at launch (and
  on demand) the shell fetches the update manifest from GitHub Releases,
  compares versions, downloads the new installer, verifies sha256, spawns it
  detached with `/S`, exits. No signing-key infrastructure in v1; transport
  trust is TLS to github.com, integrity via manifest sha256.
- **Runtime** (rootfs, versioned by the Cody version it was flattened from):
  manifest lists the current rootfs; on mismatch the shell offers "update
  runtime": export `/data` to a tar on the Windows side → `--unregister` →
  import new rootfs → restore `/data` → restart server. `/data` is the only
  stateful path (same contract as the container). Export→reimport is also
  the disk-reclaim story: sparse VHDs are disabled by WSL as
  corruption-prone (`--allow-unsafe`-gated) and shrinking is admin-only, so
  Cody never enables sparse mode.

Release/tag scheme, manifest name, and the `releases/latest` collision with
container `vX.Y.Z` releases: per CI research report. [VERIFY]

## CI

- `.github/workflows/desktop.yml` — push to `main` filtered to `desktop/**`
  + manual dispatch with `version`/`notes`. Jobs: shell build
  (windows-latest, NSIS), rootfs build (ubuntu, flatten + zstd the published
  container image), release publish (installer + rootfs + manifest).
- `.github/workflows/docker.yml` gains a paths guard so `desktop/**`-only
  pushes stop cutting container releases (and vice versa: web/docker pushes
  never build the desktop app — the runtime picks up web changes through
  rootfs updates, the shell doesn't need rebuilding).
- The container smoke-gate contract is untouched.

## Non-goals for v1

- macOS/Linux shells (the architecture ports, but not now).
- Windows-native (non-WSL) engine execution — future per-workspace choice.
- Code signing (SmartScreen warning accepted; revisit with a cert).
- Auto-start on boot, tray minimization — candidates for v1.1.
