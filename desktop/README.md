# Cody for Windows — the desktop shell

A Tauri 2 Rust shell hosting WebView2. It can provision a dedicated `cody`
WSL2 distro from the same bits as the Docker image, run the Cody server inside
it on loopback, or connect to one explicitly configured HTTPS origin. The UI is
the web app, byte for byte. Local WSL2 mode is the safe default when no remote
origin is configured.

**Read [`../docs/windows.md`](../docs/windows.md) first** — it is the
architecture contract this directory implements. This file only covers how to
work on the code.

Nothing outside `desktop/` depends on anything inside it.

## Layout

```
desktop/
  .env.example           sanitized remote-mode configuration template
  scripts/prepare-tauri.mjs  env loading + ignored capability generation
  package.json            @tauri-apps/cli plus the guarded dev/build wrappers
  src-tauri/
    Cargo.toml            crate; Tauri + Win32 deps are cfg(windows)-gated
    build.rs              tauri-build, compile-time env + ACL manifest
    tauri.conf.json       frameless window, NSIS bundle, withGlobalTauri
    capabilities/         bootstrap + loopback grants; remote grant is ignored
    permissions/          generated command permissions tracked in source
    icons/                app + installer icons
    bootstrap/            the bundled setup page (also build.frontendDist)
    src/
      main.rs             window, navigation confinement, setup state machine,
                          tray, taskbar, unread, sound, and toast behavior
      commands.rs         the IPC surface
      desktop_status_icon.rs  pure status badge rendering and Rust tests
      wsl.rs              probe / import / exec / terminate, UTF-16 decode
      server.rs           env block, server child, health poll, restart
      rootfs.rs           download, verify, stream-import, /data carry-over
      auth.rs             silent sign-in and cookie injection
      update.rs           release manifest, version compare, shell self-update
      gpu.rs              nvidia-smi detection
      config.rs           %APPDATA% paths, mode, preferences, per-install secret
      status.rs           the setup status shared with the bootstrap page
      win.rs              the crate's only unsafe: DPAPI + ShellExecuteW
```

## Dev loop

```powershell
cd desktop
npm install
npm run dev        # cargo tauri dev
```

The wrapper loads `desktop/.env.local` or `desktop/.env`, generates the ignored
remote capability, and then invokes Tauri. A non-empty process-level
`CODY_DESKTOP_REMOTE_URL` overrides both files. `.env.example` is never loaded.
With no configured URL the generated capability has no remote entry and a fresh
install stays in Local WSL2 mode. With a valid configured URL, Remote mode is
available and the bootstrap page still lets the user choose Local mode.

To iterate against a **local server you started yourself** (no WSL round
trip), start Cody on loopback first —

```powershell
# from the repo root, on the machine running the shell
npm start          # binds 127.0.0.1:30177
```

— and then set the shell's port before launching it, so `pick_port` lands on
the same one and the health poll finds an already-healthy server:

```powershell
'{ "port": 30177 }' | Set-Content $env:APPDATA\Cody\config.json
```

The shell will still try to start its own server child inside the distro; on a
box with no `cody` distro that step fails and the bootstrap page shows why.
For UI-only work on the shell chrome, that failure page is the thing you are
iterating on anyway.

Remote configuration accepts only an HTTPS URL on the default HTTPS port,
without credentials, query strings, or fragments. The generated capability
uses the exact configured origin and a path pattern on that origin; it never
uses a broad HTTPS wildcard. Direct `cargo build` runs the same env-file lookup
from `build.rs`, so a configured origin is compiled into `config.rs`; an
absent origin produces local-only behavior, while a non-empty invalid value
fails the build before any remote capability can be generated.

## Build

```powershell
cd desktop
npm install
npm run build      # cargo tauri build
```

Output: `src-tauri/target/release/bundle/nsis/Cody_<version>_x64-setup.exe`
(`currentUser` install mode, so no UAC prompt; WebView2 via the download
bootstrapper).

The release-manifest URL is baked at build time:

```powershell
$env:CODY_DESKTOP_MANIFEST_URL = "https://github.com/nphil/cody/releases/latest/download/desktop-manifest.json"
```

Unset, it falls back to that same URL. The manifest carries two
independently-versioned artifacts:

```json
{
  "shell":   { "version": "0.2.0", "url": "…/Cody_0.2.0_x64-setup.exe", "sha256": "…" },
  "runtime": { "version": "1.4.2", "url": "…/cody-rootfs-1.4.2.tar.gz", "sha256": "…", "size": 0 }
}
```

## Checks

```bash
cargo fmt --check
cargo check  --target x86_64-pc-windows-msvc
cargo clippy --target x86_64-pc-windows-msvc --all-targets -- -D warnings
cargo test   --target x86_64-unknown-linux-gnu      # pure-logic units
```

Everything Tauri- or Win32-shaped is behind `cfg(windows)`, so the host target
compiles without a Tauri toolchain and the parsing/version/env-block logic
stays testable on a Linux CI box. Linking, NSIS bundling, and every real WSL
interaction need Windows.

## How the pieces fit

1. `main.rs` builds one frameless window pointed at `bootstrap/index.html`,
   captures that URL, and starts the state machine on a worker thread.
2. The machine either validates the configured HTTPS origin and waits for its
   health endpoint, or walks WSL probe → distro check → download + verify +
   stream import → server child → health poll → silent sign-in → navigate.
3. Every step publishes a `Status` to `status.rs`. The bootstrap page reads
   one snapshot through `invoke("bootstrap_status")` and then follows the
   `cody://setup-status` event — the snapshot exists so a status change that
   lands before the listener attaches is never lost.
4. Failures carry a remedy (a copyable command, a docs link, or both) and a
   retry that re-enters the machine.
5. Once the window is on the app origin, the web app talks to the shell
   through `window.__TAURI__`: core window commands for the titlebar, desktop
   config/status and notification commands, plus the existing update commands.

**Capabilities.** Local Cody receives the window/event and desktop command
permissions on the two explicit loopback host patterns. A separate ignored
capability is generated during `npm run dev`/`npm run build` (and by `build.rs`
for direct Cargo builds) only when `CODY_DESKTOP_REMOTE_URL` resolves from the
process environment, `.env.local`, or `.env`. That grant contains the exact
configured HTTPS origin and no host wildcard. Tauri gates *every* command
invoked from a non-local origin behind the ACL, which is why `build.rs`
declares the command list and the tracked generated permission files exist.

**Desktop status.** The web app publishes metadata-only lifecycle counts and
stable completion IDs from its existing session/subagent registry. The shell
persists bounded unread and deduplication IDs under `%APPDATA%\Cody`, displays
activity and unread state in the title/taskbar/tray, and can show native toast
and sound notifications. Close-to-tray and start-with-Windows are per-user
settings; changing to Remote mode never launches a local runtime.

**Auth.** The shell generates a per-install secret (DPAPI-sealed under
`%APPDATA%\Cody`), passes it as `CODY_PASSWORD`, then posts the existing
`/api/accounts/login` route itself and puts the resulting `cody_session`
cookie in the WebView's cookie store before navigating. No server code
changes. If any part of that fails, the window lands on Cody's normal
first-run/login screen instead.

**Loopback only.** The health probe is `127.0.0.1`, the window uses
`localhost`, and the env block never widens a bind. Cody adds no firewall
rule, no `netsh portproxy`, and never writes `.wslconfig`.

**WSL etiquette.** Only ever `wsl --terminate cody`, never `--shutdown`;
never `--set-default`; `--unregister` only inside the runtime-replacement
flow, and only after `/data` has been exported.

## Known gaps

- **The rootfs entrypoint binds `0.0.0.0`.** `docker/entrypoint.sh` ends with
  `cody-server.js -H 0.0.0.0`, and it takes no bind-host input. In WSL's
  default NAT mode that is not LAN-reachable, but under a user-enabled
  `networkingMode=mirrored` it would be. The desktop contract in
  `docs/windows.md` is `127.0.0.1`; closing this needs a bind-host hook in the
  rootfs build, which lives outside `desktop/`.
- **No Job Object.** An app killed from Task Manager can leave the `wsl.exe`
  child behind. `wsl --terminate cody` runs before every launch, which clears
  it on the next start.
- **No Snap Layouts flyout or edge resize.** The shell keeps custom native
  maximize/restore controls, but disables edge-drag resizing until it can be
  implemented without covering the frameless WebView with a system overlay.
- **No code signing.** SmartScreen will warn on first run. Update integrity is
  the manifest sha256 over TLS.
