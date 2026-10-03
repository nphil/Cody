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
| `adb install`, `install-multiple`, `uninstall` | `device_push` the APK to `/data/local/tmp`, then `device_exec "pm install ..."` | Composed | push/shell tests above; no dedicated install test |
| `adb sideload` | `device_sideload` (AOSP `sideload-host`; reports the input hash, not installation) | Done | `adb-transfer.test.mjs` |
| `adb reboot [recovery\|bootloader\|sideload\|fastboot]` | `device_exec` with `options.kind: "reboot"`, `options.mode` | Done | none (code path only) |
| **`adb forward [--no-rebind] LOCAL REMOTE`** | **`device_forward`** (`target` = device service, `local` = `tcp:PORT`/`tcp:0`) | **Done** | `tunnel-relay.test.mjs`, `tunnel.test.mjs` |
| **`adb forward --list` / `--remove` / `--remove-all`** | **`device_tunnels`** `list` / `remove` / `remove_all` (or `device_operation_cancel`, or the card's Cancel) | **Done** | `tunnel-relay.test.mjs`, `operation-tools.test.mjs` |
| **`adb reverse REMOTE LOCAL`** | **`device_reverse`** | **Done** | `tunnel-relay.test.mjs` |
| **`adb reverse --list` / `--remove` / `--remove-all`** | **`device_exec`** `options.kind` `reverse-list` / `reverse-remove` / `reverse-remove-all`; `device_tunnels` for this session's rules | **Done** | `tunnel-relay.test.mjs` (list), `operation-tools.test.mjs` |
| `adb jdwp` (list), `forward tcp:N jdwp:PID` | forward to `jdwp:PID` is accepted; listing PIDs is `device_exec "ps"` | Done / Composed | `tunnel.test.mjs` (address grammar); never run against a debuggable app |
| `adb backup` / `restore`, `bugreport` | `device_exec "bugreport"` writes on the device and `device_pull` fetches it; `adb backup` is not wrapped | Composed | none |
| `adb root`, `unroot`, `remount`, `disable-verity`, `tcpip`, `usb` | Run the equivalent commands through the shell grant where the ROM permits (`su`, `mount -o remount`, `setprop`); the `root:` / `tcpip:` services are not wrapped | Not implemented | none |
| `adb connect` / `pair` / `disconnect` (ADB over Wi-Fi/TCP) | none | **Browser limit** | A web page cannot open a raw TCP socket to the device. USB (WebUSB) only. |
| `adb wait-for-device` | A new USB mode appears as a new device needing a fresh grant; re-run `device_detect` | Not implemented | none |

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
| image larger than `max-download-size` (auto-split into sparse pieces) | none | Not implemented | `fastboot.ts` rejects a download over 0xffffffff bytes; host-side sparse splitting is not written |
| `fastboot flashall`, `update <zip>`, `flash --force`, `-w` | flash each image with `device_flash`; `erase userdata` for the wipe half | Composed | none (no zip/`android-info.txt` parser) |
| `fastboot erase <part>` | `device_exec "erase:PART"` (backup + typed override for protected partitions) | Done | none (code path only) |
| `fastboot format[:fs] <part>` | none | Not implemented | Android's `format` builds a filesystem image on the host; Cody refuses the command and says to upload a prebuilt image |
| `fastboot boot <img>`, `download <img>` | `device_exec "boot"` / `"download"` with the chosen artifact | Done | `fastboot-dfu.test.mjs`, `fastboot-parity.test.mjs` |
| `fastboot stage` / `get_staged` | none | Not implemented | no code |
| `fastboot fetch <part> <file>` | `device_dump` (when the bootloader reports `fetch-size`) | Done | the same `fetch` read is the flash backup/readback in `fastboot-dfu.test.mjs`; standalone `dump` has no test |
| `fastboot --set-active=<slot>` | `device_exec "set_active:SLOT"` | Done | none (code path only) |
| `fastboot reboot`, `reboot-bootloader`, `-recovery`, `-fastboot` | `device_exec "reboot[-mode]"` | Done | none (code path only) |
| `fastboot oem <cmd>`, `flashing unlock\|lock\|unlock_critical\|get_unlock_ability`, `continue`, `create/delete/resize-logical-partition`, `snapshot-update` | `device_exec` sends the single bootloader command after you type the whole command in the confirmation | Done | `fastboot-parity.test.mjs` (OEM/unlock need exact command text) |
| `fastboot gsi`, `wipe-super`, `flash:raw`, `-c cmdline` | multi-step host recipes; do the underlying single commands | Not implemented | no code |

## esptool

| PC command | Cody | Status | Evidence |
|------------|------|--------|----------|
| `chip_id`, `flash_id` (chip name, flash size) | `device_detect` (esptool-js `detectFlashSize`; reports chip, flash size, stub, SPI boot offset) | Done | none for `detect` itself; `esp.test.mjs` stubs the same flash-size call inside `flash` |
| `read_mac` | not reported by `device_detect` | Not implemented | `esp.ts` detect does not read it |
| `read_flash` | `device_dump` | Done | none for standalone `dump`; the same `readFlash` is the backup/readback in `esp.test.mjs` |
| `write_flash` (compressed, MD5, offsets) | `device_flash` (preserves the whole erase footprint, one compressed write, device MD5, then full readback SHA-256; protected boot ranges need a typed override) | Done | `esp.test.mjs`, `hardware-safety.test.mjs` |
| `verify_flash` | the post-write readback inside `device_flash`; no standalone compare | Composed | `esp.test.mjs` |
| `erase_flash`, `erase_region` | none | **Refused today** | `esp.ts`: "eFuse and erase operations are deliberately unavailable". Policy, not a browser limit |
| `espefuse`, `espsecure`, secure-boot / flash-encryption commands | none | **Refused today** | same policy; `detect` reports `eFuseOperations: "disabled"` |
| `load_ram`, `run`, `dump_mem`, `read_mem`, `write_mem` | none | Not implemented | no code |
| `image_info`, `elf2image`, `merge_bin`, `make_image` | none | Not implemented | host-side file tools, out of scope for the device bridge |
| serial monitor (`idf.py monitor`, `miniterm`, `picocom`) | `device_monitor` protocol `serial` or the Devices panel terminal (baud, DTR/RTS/break) | Done | `serial-terminal.test.mjs` |

## dfu-util

| PC command | Cody | Status | Evidence |
|------------|------|--------|----------|
| `dfu-util -l` | `device_list` + `device_detect` (DFU interface/alternate, state, DfuSe memory map) | Done | `fastboot-dfu.test.mjs` (descriptor parsing and `detect` validation) |
| `-U file` (upload) | `device_dump` (descriptor-selected alternate) | Done | `fastboot-dfu.test.mjs` |
| `-D file` (download), `-a`, `-s ADDR` | `device_flash` only for DfuSe (`bcdDFU 0x011a`) `@Internal Flash`, raw `.bin`, explicit offset, exact `allow-bootloader`; escrows, merges, writes, reads back every sector | Done (DfuSe only) | `fastboot-dfu.test.mjs` |
| `-D` on plain DFU 1.1 (`bcdDFU 0x0110`) | none | Not implemented | detect/dump/exec only; flash is rejected |
| `-s ADDR:leave`, `-R` (reset/manifest), `-e` detach, `-E` | none | Not implemented | Cody deliberately does not manifest or reset before the read-back proof; `exec` allows only `abort` and `clear_status` |
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
2. **esptool `erase_flash` / `erase_region` and eFuse reads** behind confirmation
   and typed targets (currently refused by policy).
3. **fastboot**: automatic sparse splitting above `max-download-size`,
   `flashall`/`update` from a zip, `stage`/`get_staged`.
4. **dfu-util**: plain DFU 1.1 download, `:leave`/`-R` after a proven read-back.
5. **adb**: dedicated `install`, `root`, `tcpip`, `wait-for-device` actions (all
   currently reachable only through the shell grant).
6. **Hardware evidence** for every "Done" row via `docs/hardware-checklist.md`.
