# PC tool parity: what Cody does from a tablet or browser

Goal (owner, 2026-10-02): from Cody in Chrome on an Android tablet (WebUSB /
Web Serial through the existing browser bridge) do what a Windows PC does with
`adb`, `fastboot`, `mtkclient`, `esptool`, and `dfu-util`. The only safety is
confirmation (typed exact-target confirmation for dangerous writes) and
automatic backups where the protocol can read them.

This is the honest ledger of that goal. Every row says what Cody does **today**.
Architecture and rules live in `AGENTS.md` ("Browser-hosted hardware").

## How to read it

| Status | Meaning |
|--------|---------|
| **Done** | Implemented in Cody and exercised by the named tests against a fake transport. |
| **Composed** | No single action; reachable by combining actions (the recipe is given). |
| **Refused today** | The code deliberately refuses it. The rule is a policy choice, not a browser limit, and is listed under "Gaps" as work, not as a limitation. |
| **Not implemented** | No code yet. The reason is stated. |
| **Browser limit** | Cannot be done from a web page, with the exact reason. |

**Evidence level for every "Done" row: fake transports and local loopback only.**
No row has been exercised on real hardware by this change; each is
**UNVERIFIED on hardware** until its item in `docs/hardware-checklist.md` has
dated evidence. "Tests" below are `node --test` files under `lib/devices/`.

Tool names: all hardware tools take the browser `device` id from `device_list`
and a `protocol`. Writes pause for a direct confirmation in the Devices panel;
no tool argument can approve one.

## adb

Cody speaks ADB to `adbd` directly over WebUSB (`@yume-chan/adb`); there is no
adb server, so `start-server`, `kill-server`, `mdns`, and `-s SERIAL` have no
meaning (the browser's device grant is the selection).

| PC command | Cody | Status | Evidence |
|------------|------|--------|----------|
| `adb devices`, `get-state`, `get-serialno`, `getprop` | `device_list`, `device_detect` (banner, model, product, Android release, shell protocol) | Done | `adb.test.mjs` (CNXN/AUTH/legacy-probe, run through `detect`); the `getprop` fields themselves have no test |
| `adb shell <cmd>` | `device_exec` protocol `adb` + the user's connection-scoped shell grant (without it only `id`, `uname -a`, `df -h`, `getprop [ro.*]`) | Done | `adb-shell.test.mjs` (quoting, stderr/stdout, exit status, grant revoke) |
| `adb shell` (interactive), `exec-out` text | `device_monitor` / `device_monitor_send`; user terminal in the Devices panel (needs no agent grant) | Done | `adb-shell.test.mjs` (terminal tests) |
| `adb logcat` | `device_exec "logcat ..."` (shell grant); runs until cancelled | Composed | none dedicated; streamed shell output is `adb-shell.test.mjs` |
| `adb push` | `device_push` (verified staging + atomic replace; raw/symlink direct push needs backup + typed `write:<path>`) | Done | `adb-transfer.test.mjs`, `adb.test.mjs` (resume) |
| `adb pull`, partition dumps (`dd` over shell) | `device_pull`, `device_dump` (stream to a session artifact with SHA-256) | Done | `adb-transfer.test.mjs` |
| `adb install` | `device_install`: the APK (a session artifact) is staged to `/data/local/tmp` with the push path's chunked, hash-verified, resumable copy, `pm install` runs on exactly that file, and the copy and staging files are removed when the copy fails, when `pm` fails, and when the user cancels. Replacement is off unless `options.replace` is set: Cody passes `-R` on Android 9+ (where the package manager replaces by default and `-r` is ignored) and nothing on older Android (where `-R` is an unknown option and refusing replacement is already the default); an unreadable API level is treated as modern. The approval is typed (`install:<hash prefix>`), enforced by the operation manager, and needs no shell grant; a file with no `AndroidManifest.xml` is refused | **Done** (implemented, host-tested; hardware evidence pending) | `adb-admin.test.mjs`: "an app that is already installed is replaced only when the user approved replacement, on the package manager's real rules" (emulated `pm` with Android 14, 9 and 8 rules), "an install started through the manager is approved only by typing the exact confirmation", "a copy that fails verification, runs out of space, or is cancelled leaves nothing behind" (real `/bin/sh` for the staging commands) |
| `adb install-multiple`, split APKs / bundles, `uninstall` | `device_exec "pm uninstall PACKAGE"` / `pm install-*` through the shell grant | Composed | none |
| `adb sideload` | `device_sideload` (AOSP `sideload-host`; reports the input hash, not installation) | Done | `adb-transfer.test.mjs` |
| `adb reboot [recovery\|bootloader\|sideload\|fastboot]` | `device_exec` with `options.kind: "reboot"`, `options.mode` | Done | none (code path only) |
| **`adb forward [--no-rebind] LOCAL REMOTE`** | **`device_forward`** (`target` = device service, `local` = `tcp:PORT`/`tcp:0`) | **Done** | `tunnel-relay.test.mjs`, `tunnel.test.mjs` |
| **`adb forward --list` / `--remove` / `--remove-all`** | **`device_tunnels`** `list` / `remove` / `remove_all` (or `device_operation_cancel`, or the card's Cancel) | **Done** | `tunnel-relay.test.mjs`, `operation-tools.test.mjs` |
| **`adb reverse REMOTE LOCAL`** | **`device_reverse`** | **Done** | `tunnel-relay.test.mjs` |
| **`adb reverse --list` / `--remove` / `--remove-all`** | **`device_exec`** `options.kind` `reverse-list` / `reverse-remove` / `reverse-remove-all`; `device_tunnels` for this session's rules | **Done** | `tunnel-relay.test.mjs` (list), `operation-tools.test.mjs` |
| `adb jdwp` (list), `forward tcp:N jdwp:PID` | forward to `jdwp:PID` is accepted; listing PIDs is `device_exec "ps"` | Done / Composed | `tunnel.test.mjs` (address grammar); never run against a debuggable app |
| `adb backup` / `restore`, `bugreport` | `device_exec "bugreport"` writes on the device and `device_pull` fetches it; `adb backup` is not wrapped | Composed | none |
| `adb root`, `unroot`, `tcpip PORT`, `usb` | `device_exec` with `options.kind` `root` / `unroot` / `tcpip` (+ `options.port`, 1024-65535) / `usb`, optional `options.timeoutSeconds` (1-300, default 45) for how long to wait for the device to come back: asks first, announces the restart to the operation manager so the USB disconnect it causes does not cancel it (shell access is still revoked, a disconnect the user makes on purpose still cancels, and only the SAME granted USB identity is taken again), reconnects, and checks what the device reports. `root`/`unroot` read `service.adb.root`. `tcpip`/`usb` evaluate adbd's EFFECTIVE legacy listener in adbd's own order (`service.adb.listen_addrs`, then `service.adb.tcp.port` even when `0`, then `persist.adb.tcp.port`): fixed listener addresses that make the request impossible are refused before approval, and an overriding property after the restart is reported as not verified rather than as success. `usb` also reads Wireless debugging (`persist.adb.tls_server.enable`, `service.adb.tls.port`), a SEPARATE TLS listener that `adb usb` leaves running: while it is on the result is `verified: false` and says the device is not USB-only (it names the property that says so and that only Developer options can switch it off), and the approval says so before anything restarts. `tcpip` verifies the legacy listener only and reports the wireless state beside it. An adbd that is already in the state, or refuses, is reported as such | **Done** (implemented, host-tested; hardware evidence pending). `tcpip` only switches the device for a PC on the network: a browser cannot open raw TCP, so Cody keeps using USB. A device that hides the Wireless-debugging properties from the shell reads as having it off. | `adb-admin.test.mjs` (restart, verify, wrong state, unverified when it cannot reconnect, refusals), `adb-lifecycle.test.mjs` (listener precedence and overriding-property cases; Wireless debugging on through the switch, the published port, or both, with the legacy port at 0, and the approval wording; refusal before approval; the operation surviving the announced disconnect; unannounced and user-made disconnects still cancelling; a different identity never taking the device), `adb-browser-lifecycle.test.mjs` (the real `DeviceBridgeConnection` with an emulated `navigator.usb`: the WebUSB `disconnect` event, the device returning as a NEW USB object with the same vendor/product/serial and being adopted again, an unannounced unplug still cancelling, a different device never adopted or touched) |
| `adb remount`, `disable-verity` | through the shell grant where the ROM permits | Not implemented | none |
| `adb connect` / `pair` / `disconnect` (ADB over Wi-Fi/TCP) | none | **Browser limit** | A web page cannot open a raw TCP socket to the device. USB (WebUSB) only. |
| `adb wait-for-device` (`-recovery`, `-sideload`) | `device_exec` with `options.kind: "wait-for-device"` (`timeoutSeconds` 1-600, `state` device / recovery / sideload). ONE deadline covers lease acquisition, authentication (a silent or unapproved device no longer holds the lease for the 20 s quiet-read limit), state queries and every reacquisition. It can be started while the device is absent (rebooting) by the exact id the device had: the server remembers the ids of devices that left the page (15 minutes, 16 at most; cleared when another page takes over, never for a device the user disconnected) and accepts them for this one request only. A reacquisition that fails does not strand the wait: the granted identity is kept with the operation and the next attempt is for that same identity. Cancelling ends a poll at once and no acquisition starts afterwards. A mode change that re-enumerates under a different USB identity still needs a fresh grant. | **Done** (implemented, host-tested; hardware evidence pending). Limits: ids remembered by the server mean nothing after a page reload (the wait then fails at its deadline); the RSA-approval silence is emulated as a silent transport because the browser credential store needs IndexedDB | `adb-admin.test.mjs` (manager retry, timeout, wrong state, cancel), `adb-lifecycle.test.mjs` (deadline over a silent device, recovery after failed reacquisition, cancel before reacquisition, departed-id acceptance and refusals) |

### Forward / reverse: exactly what matches a PC and what cannot

Matches the PC: real byte streams in both directions over the device's own ADB
connection; many clients at once; `tcp:0` for a free port; the device-service
grammar (`tcp`, `localabstract`, `localreserved`, `localfilesystem`, `dev`,
`jdwp`); rules removed on cancel, device loss, page loss; reverse rule really
installed on `adbd` and really removed (`killforward`) before the connection
closes; no half-close (as on a PC, the first end closes the stream after the
bytes already sent).

Differs, with the reason:

- **"localhost" is the machine running Cody, not the tablet.** A browser cannot
  listen on a TCP port or dial a raw TCP socket, so the host end must be the
  Cody server. For an agent that is simply `localhost`. Apps on the tablet
  itself (Termux, other browser tabs) cannot reach a forwarded port, and a
  reverse cannot reach a server running only on the tablet.
- **Host side is always loopback `tcp:PORT`.** `adb forward tcp:... ` never binds
  a LAN address, privileged ports (< 1024) are refused, and Cody's own port is
  never reachable through a reverse. Host `localabstract:` / `localfilesystem:`
  endpoints are not offered.
- **Each rule is a long-running operation with a confirmation card**, not a
  fire-and-forget command. It keeps the browser tab and the USB connection in
  use; a locked screen or closed tab ends it.
- `--no-rebind` is the only behaviour: a host port already in use fails.

## fastboot

| PC command | Cody | Status | Evidence |
|------------|------|--------|----------|
| `fastboot devices`, `getvar <name>`, `getvar all` | `device_list`; `device_detect` (`getvar:version`, `getvar:all`); `device_exec "getvar:NAME"` | Done | `fastboot-dfu.test.mjs` (detect), `fastboot-parity.test.mjs` (arbitrary getvar) |
| `fastboot flash <part> <img>` (raw and Android sparse) | `device_flash` (backup via `fetch` when offered, confirmation, full readback of raw bytes / sparse RAW and FILL extents; without `fetch` it writes after an UNVERIFIED warning) | Done | `fastboot-dfu.test.mjs`, `fastboot-parity.test.mjs` |
| image larger than `max-download-size` (auto-split into sparse pieces) | `device_flash` reads `getvar:max-download-size` (decimal, or hex with `0x`) and resparses a raw or sparse image above it into pieces of at most that size (never over 1 GiB), each flashed in turn; the approval shows the piece count | **Done** (implemented, host-tested; hardware evidence pending) | `fastboot-set.test.mjs` (split, limit grammar, piece failure, sparse source), `sparse-split.test.mjs` (every piece fits and rewrites exactly the carried blocks, random layouts) |
| `fastboot flashall`, `update <zip>` | `device_exec "update"` (or `"flashall"`) with the package ZIP as the artifact: `android-info.txt` read under its own 64 KiB / 256-requirement bound before anything else, requirements checked (a `partition-exists` requirement also needs that image in the package, and only its first value names the partition, as in AOSP), stored and deflated members CRC-checked, A/B current slot resolved, each partition backed up, ONE approval typed as `update:<package hash prefix>`, each partition written once and read back in order. If it stops, the message separates partitions written and verified, written but not verifiable, the one possibly modified (a flash command was sent; with its backup id), and untouched | **Done** (implemented, host-tested; hardware evidence pending) for the images `update` flashes. Not offered: `-w`, `--force`, `update-super`, secondary-slot `*_other` images, `bootloader`/`radio`/`super`/`userdata` images, reboots between steps (a mode switch re-enumerates USB and needs a fresh grant), compressed entries over 2 GiB | `fastboot-set.test.mjs` (partition-exists, bounded metadata, damaged stored member, three-state accounting incl. readback and sparse-piece failures), `zip-archive.test.mjs`, `android-info.test.mjs` |
| `fastboot flash --force`, `-w` | flash each image with `device_flash`; `erase userdata` for the wipe half | Composed | none |
| `fastboot erase <part>` | `device_exec "erase:PART"` (backup + typed override for protected partitions) | Done | none (code path only) |
| `fastboot format[:fs] <part>` | none | Not implemented | Android's `format` builds a filesystem image on the host; Cody refuses the command and says to upload a prebuilt image |
| `fastboot boot <img>`, `download <img>` | `device_exec "boot"` / `"download"` with the chosen artifact | Done | `fastboot-dfu.test.mjs`, `fastboot-parity.test.mjs` |
| `fastboot stage` / `get_staged` | `device_exec "stage"` (the chosen artifact to the bootloader's buffer) and `"get_staged"` (the protocol's `upload`, saved as an artifact) | **Done** (implemented, host-tested; hardware evidence pending) | `fastboot-set.test.mjs` (stage, get_staged, large staged upload) |
| `fastboot fetch <part> <file>` | `device_dump` (when the bootloader reports `fetch-size`) | Done | the same `fetch` read is the flash backup/readback in `fastboot-dfu.test.mjs`; standalone `dump` has no test |
| `fastboot --set-active=<slot>` | `device_exec "set_active:SLOT"` | Done | none (code path only) |
| `fastboot reboot`, `reboot-bootloader`, `-recovery`, `-fastboot` | `device_exec "reboot[-mode]"` | Done | none (code path only) |
| `fastboot oem <cmd>`, `flashing unlock\|lock\|unlock_critical\|get_unlock_ability`, `continue`, `create/delete/resize-logical-partition`, `snapshot-update` | `device_exec` sends the single bootloader command after you type the whole command in the confirmation | Done | `fastboot-parity.test.mjs` (OEM/unlock need exact command text) |
| `fastboot gsi`, `wipe-super`, `flash:raw`, `-c cmdline` | multi-step host recipes; do the underlying single commands | Not implemented | no code |

## esptool

| PC command | Cody | Status | Evidence |
|------------|------|--------|----------|
| `chip_id`, `flash_id` (chip name, flash size) | `device_detect` (chip, description, revision, features, crystal, MAC, flash size, stub, SPI boot offset, secure boot and flash encryption state) and `device_exec "chip_id"` / `"flash_id"` | Done (implemented, host-tested; hardware evidence pending) | `esp-admin.test.mjs` (chip_id/read_mac/flash_id, detect) |
| `read_mac` | `device_exec "read_mac"`; also reported by `device_detect` | Done (implemented, host-tested; hardware evidence pending) | `esp-admin.test.mjs` |
| `read_flash` | `device_dump` | Done | none for standalone `dump`; the same `readFlash` is the backup/readback in `esp.test.mjs` |
| `write_flash` (compressed, MD5, offsets) | `device_flash` (preserves the whole erase footprint, one compressed write, device MD5, then full readback SHA-256; protected boot ranges need a typed override) | Done | `esp.test.mjs`, `hardware-safety.test.mjs` |
| `verify_flash` | the post-write readback inside `device_flash`; no standalone compare | Composed | `esp.test.mjs` |
| `erase_flash`, `erase_region` | `device_exec "erase_flash"` / `"erase_region ADDRESS SIZE"` (stub only, 4096-byte aligned; the whole range is escrowed first with the stub's read MD5 checked; typed override `allow-spi-boot` for the boot area, `allow-fuses` when secure boot or flash encryption is burned, `allow-unknown` for a chip whose eFuse map is not reviewed; afterwards the device's own MD5 of every erased byte must equal blank flash) | **Done** (implemented, host-tested; hardware evidence pending) | `esp-admin.test.mjs`, run through the real esptool-js loader over an emulated stub: wire payloads, backup before approval, overrides, an erase the chip ignored, a rejected erase, a corrupted backup read, and an erase-then-restore round trip on zero-boot-offset chips (ESP32-S3/C3/C2/C6/H2: the backup is flashed back with `allow-spi-boot` and the flash matches the original) |
| `espefuse summary`, `espefuse dump`, `get_security_info` | `device_exec "efuse_summary"`, `"efuse_dump"` (asks first; key contents saved only in Files & backups and withheld from the log), `"get_security_info"` | **Done** for ESP32, S2, S3, C3, C2, C6, H2 (implemented, host-tested; hardware evidence pending); other chips report "unreviewed" | `esp-admin.test.mjs` (summary, dump, register map, unreviewed chip, ESP32-H2 key purposes: 1 is ECDSA_KEY, 2 is RESERVED, 3 is unknown) |
| `espefuse burn_*`, `write_protect_*`, `espsecure`, secure-boot / flash-encryption commands | none | **Refused today** | irreversible; Cody reads eFuses and never burns them (`parseEspCommand` rejects the commands with that reason) |
| `load_ram`, `run`, `dump_mem`, `read_mem`, `write_mem` | none | Not implemented | no code |
| `image_info`, `elf2image`, `merge_bin`, `make_image` | none | Not implemented | host-side file tools, out of scope for the device bridge |
| serial monitor (`idf.py monitor`, `miniterm`, `picocom`) | `device_monitor` protocol `serial` or the Devices panel terminal (baud, DTR/RTS/break) | Done | `serial-terminal.test.mjs` |

## dfu-util

| PC command | Cody | Status | Evidence |
|------------|------|--------|----------|
| `dfu-util -l` | `device_list` + `device_detect` (DFU interface/alternate, state, DfuSe memory map) | Done | `fastboot-dfu.test.mjs` (descriptor parsing and `detect` validation) |
| `-U file` (upload) | `device_dump` (descriptor-selected alternate) | Done | `fastboot-dfu.test.mjs` |
| `-D file` (download), `-a`, `-s ADDR` | `device_flash` only for DfuSe (`bcdDFU 0x011a`) `@Internal Flash`, raw `.bin`, explicit offset, exact `allow-bootloader`; escrows, merges, writes, reads back every sector | Done (DfuSe only) | `fastboot-dfu.test.mjs` |
| `-D` on plain DFU 1.1 (`bcdDFU 0x0110`) | `device_flash` with target = the exact selected alternate name, offset 0, raw binary (a `.dfu` suffix is refused). The device's current image is escrowed when it can upload; the typed override `allow-unknown` (or the role named by the alternate) is required; numbered DNLOAD blocks, zero-length block, status polling; a manifestation-tolerant device is read back and SHA-256-compared, an intolerant one restarts itself and is reported UNVERIFIED | **Done** (implemented, host-tested; hardware evidence pending) | `dfu-11.test.mjs` (state-machine emulator: block numbering, backup before approval, a backup the device uploaded but Cody could not save refuses the write, tolerant/intolerant/vanishing devices, rejected image, readback mismatch, stalled block never retried, refusals; the Devices form offers `allow-unknown` for DFU and the flash is approved through the operation manager only by typing it) |
| `-s ADDR:leave` | `device_exec "leave ADDRESS"` (DfuSe only): set address pointer, abort to idle, zero-length download as block 2 (as dfu-util does); asks first; result is UNVERIFIED because the device leaves the bus | **Done** (implemented, host-tested; hardware evidence pending) | `dfu-11.test.mjs` (wire order, address bounds, plain DFU refused, decline sends nothing) |
| `-R` (USB reset) | `device_exec "reset"` (WebUSB `device.reset()`); asks first; a reset that fails is reported as an error unless the browser bridge can show the device left the bus (Chromium on Windows reports a failure for every reset) | **Done** (implemented, host-tested; hardware evidence pending) | `dfu-11.test.mjs` (device vanishing, rejected reset from a device that stays, transport that cannot tell) |
| `-e` detach, `-E`, `:unprotect`, `:force` | none | Not implemented | `exec` allows only `abort`, `clear_status`, `reset`, `leave ADDRESS` |
| `-s ADDR:mass-erase` | none | Refused today | not offered; sector-wise erase only |
| `.dfu` container files | none | Not implemented | raw binary only |

## mtkclient (MediaTek)

| PC command | Cody | Status | Evidence |
|------------|------|--------|----------|
| every command: `printgpt`, `r`/`rl`/`rf`, `w`/`wl`/`wf`, `e`/`ef`, `gettargetconfig`, `da`, `payload`, `stage`, `seccfg`, `crash`, `reset`, DA loading, preloader and BROM handshake (USB `0e8d:2000` / `0e8d:0003`) | none | **Not implemented (parked)** | There is no MediaTek protocol code in Cody. The work (preloader/BROM handshake, Download Agent loading, partition and GPT reads, writes) was scoped and deliberately set aside; nothing in this table claims it. mtkclient is GPLv3, so the plan must also record a licensing decision and DA provenance before any code lands. |

Until that work is done, a MediaTek device can use only the protocols it
exposes once running (ADB, fastboot) from the rows above.

## Other bootloaders Cody covers

| PC tool | Cody | Status | Evidence |
|---------|------|--------|----------|
| `stm32flash` (ROM UART) | `device_*` protocol `stm32` (STM32F103 medium-density only, 1 KiB pages) | Done (narrow) | `serial-bootloaders.test.mjs` |
| `avrdude -c arduino` | protocol `stk500` (ATmega328P only) | Done (narrow) | `serial-bootloaders.test.mjs` |
| Silicon Labs Gecko bootloader | protocol `gecko`: detect and XMODEM framing; no flash (no readback) | Done (detect only) | `serial-bootloaders.test.mjs` |
| CMSIS-DAP / OpenOCD / pyocd, generic UF2 | none | Not implemented | see `AGENTS.md` ("CMSIS-DAP/DAPLink and generic UF2 are not shipped") |

## Gaps to close next (in order of value for the owner's intent)

1. **MediaTek** (preloader/BROM, DA, GPT read, partition read/write) behind the
   existing confirmation model, with a recorded licensing/DA-provenance decision.
   Parked by the owner; nothing here claims it.
2. **Hardware evidence** for every row marked "implemented, host-tested" via
   `docs/hardware-checklist.md`, including the erase, eFuse, sparse-split,
   `update`, `stage`, DFU download/`leave`/`reset`, and adb
   `install`/`root`/`tcpip`/`wait-for-device` items.
3. Smaller non-MediaTek gaps that remain: `adb uninstall`, `install-multiple`
   and split APKs, `remount` / `disable-verity`, DFU `-e` detach / `-E` /
   `:unprotect` / `:mass-erase`, `.dfu` container files, fastboot `format`,
   `gsi`, `wipe-super`, esptool `load_ram` / `read_mem` family, eFuse burning
   (refused on purpose: irreversible).

Closed since the previous revision (implemented and host-tested; hardware
evidence pending): esptool `erase_flash` / `erase_region`, `read_mac`, eFuse and
security-info reads; fastboot automatic sparse splitting, `update` / `flashall`
from a ZIP, and `stage` / `get_staged`; dfu-util plain DFU 1.1 download,
DfuSe `:leave`, and `-R` reset; adb `install`, `root` / `unroot`, `tcpip` /
`usb`, and `wait-for-device`.
