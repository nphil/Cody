# Hardware Flashing Manual Verification Checklist

## Status

**Every acceptance criterion below is UNVERIFIED until it is exercised on the
listed real hardware and the evidence fields are completed.** Unit tests with
fake transports prove guard behavior only; they do not establish electrical,
boot-ROM, cable, vendor-tool, recovery, or retention behavior.
**This checklist authorizes no destructive write.** It records future acceptance
criteria only; a separate, exact point-of-risk approval is required for every
real operation. Protected fuse/eFuse programming is never a casual test.

Use a disposable or recoverable test device first. Do not repurpose a production
device as the initial test target.

## Evidence record

Complete one record per attempt before checking any acceptance item:

| Field | Value |
| --- | --- |
| Date / operator | **UNVERIFIED** |
| Device make, model, and board revision | **UNVERIFIED** |
| Protocol and tool version | **UNVERIFIED** |
| Chip identity, flash geometry, boot mode | **UNVERIFIED** |
| VID/PID, serial/path, and cable/adapter | **UNVERIFIED** |
| Reviewed layout ID and source | **UNVERIFIED** |
| Test image filename, byte length, SHA-256 | **UNVERIFIED** |
| Target region and absolute offset | **UNVERIFIED** |
| Backup file ID/path, byte length, SHA-256 | **UNVERIFIED** |
| Readback method, byte length, SHA-256 | **UNVERIFIED** |
| Recovery owner and procedure | **UNVERIFIED** |

## Common preflight

- [ ] **UNVERIFIED** Device identity is observed through the real transport,
  recorded above, and matches the reviewed chip-specific layout.
- [ ] **UNVERIFIED** The requested protocol, chip, named target region, and
  absolute byte offset are explicit; there is no inferred “safe” offset.
- [ ] **UNVERIFIED** The layout accounts for `preloader`, `lk*`, `tee*`,
  `fuses`/`eFuses`, MCU bootloader where applicable, and chip-specific SPI boot
  ranges as present or absent.
- [ ] **UNVERIFIED** A recovery method is physically available: known-good
  boot cable, power control, boot straps, vendor recovery tool, and a tested
  operator procedure.
- [ ] **UNVERIFIED** Firmware input is hashed before any destructive command;
  the displayed SHA-256 matches the recorded value.
- [ ] **UNVERIFIED** A readable pre-write backup of the exact destination range
  is saved to persistent escrow. Its path/ID, length, and SHA-256 are recorded.
- [ ] **UNVERIFIED** The interface presents point-of-risk confirmation with the
  exact action, device/target, SHA-256, absolute offset, length, backup
  reference, and any single named protected-region override.
- [ ] **UNVERIFIED** Cancelling that confirmation sends no write bytes and does
  not silently retry or retain an approval for a later operation.
- [ ] **UNVERIFIED** The protocol can read back the exact written byte range
  after flashing. A delivery ACK, device “OK”, progress bar, or transfer CRC is
  not accepted as verification.
- [ ] **UNVERIFIED** Fastboot without fetch presents an UNVERIFIED-write warning,
  backup-unavailable reason, and recovery verification instructions before approval.
  Other protocols retain their documented readback requirements.
- [ ] **UNVERIFIED** Disconnect, timeout, and cancelled-transfer behavior is
  recorded as unknown completion; no automatic write retry occurs.
## Session, identity, and exclusive-interface checks

- [ ] **UNVERIFIED** Starting an operation in one Cody session, then switching
  to another Cody session mid-transfer, cancels or quarantines the first
  operation; no approval, write, or result crosses the session boundary.
- [ ] **UNVERIFIED** Reconnecting the identical device identity reacquires only
  the authorized session; a different VID/PID, serial/path, or USB identity
  requires a new device grant and fresh point-of-risk confirmation.
- [ ] **UNVERIFIED** A second claimant for the same serial or USB interface is
  rejected without consuming bytes or stealing the active exclusive lease.
- [ ] **UNVERIFIED** Disconnect/reconnect leaves completion unknown until a new
  identity-bound operation explicitly verifies the device state.

## Protected-region refusal and override

Protected checks are rejection-only until there is a separately approved
recoverable-device procedure. Unit/fake transports exercise named-override
confirmation; this checklist never calls for an actual fuse/eFuse burn. Each
item remains **UNVERIFIED** until its permitted evidence is completed.

- [ ] **UNVERIFIED** A request targeting `preloader` or `preloader_*` is refused
  without `allow-preloader`; an unrelated override is refused too.
- [ ] **UNVERIFIED** A request targeting `lk*` is refused without `allow-lk`.
- [ ] **UNVERIFIED** A request targeting `tee*` is refused without `allow-tee`.
- [ ] **UNVERIFIED** A request targeting `fuse*`, `efuse*`, or equivalent
  `fuses`/`eFuses` label is refused without `allow-fuses`.
- [ ] **UNVERIFIED** A known MCU bootloader range is refused without
  `allow-bootloader`.
- [ ] **UNVERIFIED** A SPI device without explicit chip-specific `spi-boot`
  ranges is refused; no generic offset such as `0x1000` is treated as safe.
- [ ] **UNVERIFIED** A defined SPI boot range is refused without
  `allow-spi-boot`.
- [ ] **UNVERIFIED** A protocol-owned range explicitly classified `unknown` is
  refused without `allow-unknown`; its confirmation identifies the exact target
  and records that its role/topology is unknown.
- [ ] **UNVERIFIED** A valid named override still triggers a new point-of-risk
  confirmation that includes the exact override, backup, digest, and offset.
- [ ] **UNVERIFIED** An override for an unprotected range is refused rather
  than silently accepted.

## Protocol verification

### ESP serial / SPI flash

- [ ] **UNVERIFIED** Detection reports the actual ESP chip, flash size, mode,
  and relevant security/encryption state before a layout is selected.
- [ ] **UNVERIFIED** The real chip’s boot offsets are represented in the
  reviewed layout and protected from generic writes.
- [ ] **UNVERIFIED** A non-protected test range is backed up, flashed after
  exact confirmation, read back by the device, and SHA-256-compared to input.
- [ ] **UNVERIFIED** Restore from the saved backup is read back and
  SHA-256-compared to the backup before the device is returned to service.
- [ ] **UNVERIFIED** Reset/reconnect confirms expected boot behavior after both
  test flash and restore.
- [ ] **UNVERIFIED** An ESP32 user selects/uploads a test image through Cody,
  sees the exact confirmation/backup/readback evidence, and the console resumes
  exclusive ownership after flashing to capture the expected boot output.
- [ ] **UNVERIFIED** `erase_region` on a recoverable board: the confirmation
  shows the exact range and a backup reference; after approval the range reads
  back blank (device MD5 and a `read_flash` of it), and restoring the backup
  with `device_flash` returns the original bytes.
- [ ] **UNVERIFIED** `erase_flash` is refused on a ROM-only connection, needs
  `allow-spi-boot` (and `allow-fuses` on a chip with secure boot or flash
  encryption burned), and never runs when the flash ID does not map to a
  recognised size.
- [ ] **UNVERIFIED** `efuse_summary` and `efuse_dump` agree with
  `espefuse.py summary` / `dump` on the same board for each reviewed chip, and
  key blocks never appear in the operation log.

### Fastboot: large images, packages and staging

- [ ] **UNVERIFIED** An image larger than the device's real `max-download-size`
  is flashed as sparse pieces on a recoverable device: every `download:` is
  within the limit, the bootloader accepts every piece, and the readback matches
  the whole image. Record the limit the device reported and the piece count.
- [ ] **UNVERIFIED** A bootloader that reports `max-download-size` in decimal
  rather than `0x` hex is split the way `fastboot` splits it.
- [ ] **UNVERIFIED** `update` with a real factory ZIP on a recoverable A/B
  device: the requirements pass, only the current slot is written, the typed
  `update:<hash>` approval is required, and each partition's readback matches.
  A ZIP for another product is refused before any write.
- [ ] **UNVERIFIED** `update` refuses logical partitions from the bootloader and
  accepts them from fastbootd.
- [ ] **UNVERIFIED** Cancelling an `update` (or pulling the cable) between and
  during partitions, and during the last partition's readback, leaves the
  operation's output naming each partition with its backup, which were written
  and verified, the one possibly modified (with its backup id) and the
  untouched ones, and nothing is written again; the named backup restores the
  possibly modified partition.
- [ ] **UNVERIFIED** `stage` followed by an OEM command that consumes staged
  data, and `get_staged` after an OEM command that stages output, on a device
  that supports `upload`.

### Fastboot

- [ ] **UNVERIFIED** The device’s actual fastboot identity, lock state, product,
  and partition information are captured before any write.
- [ ] **UNVERIFIED** Fetch support and partition size are probed. With fetch, the
  full partition is backed up and raw/sparse image-defined bytes are verified.
- [ ] **UNVERIFIED** Without fetch, no download/write occurs until the explicit
  UNVERIFIED warning is approved. An OKAY response never becomes verified=true.
- [ ] **UNVERIFIED** After booting TWRP, device_verify compares the written raw
  image range against its expected SHA-256. Sparse files require expanded-image
  verification; their file digest is not a raw-partition digest.
- [ ] **UNVERIFIED** Preloader/LK/TEE/RPMB/GPT/boot0/boot1/eFuse targets require
  typing write:<exact target>. OEM/security commands require the exact command.
- [ ] **UNVERIFIED** The device boots or returns to fastboot as expected after
  test flash and after verified restore.

### USB DFU

- [ ] **UNVERIFIED** The actual selected DFU alternate has recorded bcdDFU,
  DfuSe memory map, g-sector geometry, and a contiguous readable/erasable/
  writable `@Internal Flash` range within the supported STM32 program range.
- [ ] **UNVERIFIED** A bcdDFU `0x011a` raw-binary `internal-flash` write at
  an explicit absolute offset preserves, escrows, merges, writes, and exact-
  reads every touched sector; it remains in DFU with no manifestation/reset
  before the readback hash matches.
- [ ] **UNVERIFIED** The conservative whole-internal-flash `allow-bootloader`
  confirmation is recorded. A generic bcdDFU `0x0110` flash needs the typed
  `allow-unknown` override, escrows the current image when the device can upload,
  and is read back only when the device returns to DFU idle after manifesting.
- [ ] **UNVERIFIED** `dfu reset` and DfuSe `leave ADDRESS` make a real device run
  its application and re-enumerate, and the operation still ends as completed
  (UNVERIFIED), not cancelled, although the browser reports the disconnect. A
  plain DFU image whose device leaves the bus while it manifests is likewise an
  unverified write, and a `leave` the device answers with a DFU error status
  fails because the device did not leave. Record the new USB identity and
  whether a fresh grant was needed.
- [ ] **UNVERIFIED** Device recovery/re-enumeration is recorded after refusal,
  test flash, and restore.

### Qualcomm EDL (reads, flash and erase of one named partition, backup sets, restore and the boot drive)

Device in mind: Lenovo Smart Display 10" SD-X701B (APQ8053) with the loader
`amber_bluebbery_prog_emmc_firehose_8953_ddr.mbn` (374,900 bytes; record its
SHA-256). Per `notes/hw/lenovo-sd-x701b.md` no contact with a unit is authorised
by these notes: each session needs a coordinated go-ahead. The read items come
first and write nothing; the flash, erase, restore and boot drive items at the end change the unit. The
PC tool's output is the reference to compare with.

- [ ] **UNVERIFIED** The browser (Android Chrome, over USB-C OTG) offers the
  `05c6:9008` device in the picker, claims its interface, and `device_list`
  shows it as an EDL candidate. On Windows the QDLoader driver must first be
  replaced with WinUSB.
- [ ] **UNVERIFIED** `device_detect` returns the chip serial number, hardware id
  (MSM / OEM / model) and public-key hash; they match what the PC tool prints
  for the same unit. Record all three.
- [ ] **UNVERIFIED** Right after a `detect`, a `connect` finds the boot ROM's
  re-offered HELLO. If it instead needs the recovery ladder ("asking it to start
  over"), record that and whether the ROM accepted the restart packet. Record
  whether a HELLO survives Cody closing and re-opening the USB device.
- [ ] **UNVERIFIED** The loader confirmation shows a SHA-256 equal to
  `sha256sum` of the file. Declining sends nothing. A loader for another device
  is rejected with a Sahara status and nothing runs.
- [ ] **UNVERIFIED** After the loader starts, the programmer keeps the same USB
  device. If it re-enumerates, record how the operation reported it (it is
  reported as the device leaving the bus).
- [ ] **UNVERIFIED** `configure` is accepted with `MemoryName="eMMC"`,
  `ZLPAwareHost="1"` and the payload size the programmer reports; `getstorageinfo`
  `total_blocks` and `block_size` equal the PC tool's. Record the product name.
- [ ] **UNVERIFIED** The XML answer and the raw sector data are framed as
  assumed: the first sector read for the partition table shows `EFI PART` at
  offset 0 of sector 1, and a whole partition's SHA-256 equals the PC tool's
  `r NAME` dump of the same partition. A one-byte offset would surface as
  "misaligned" or a GPT with a shifted signature: record it if it does.
- [ ] **UNVERIFIED** The programmer ends each raw-data transfer with a short packet or a
  zero-length packet and sends its log lines and answers as transfers of their own.
  Cody relies on that to tell a log line taken for sector data (a read that came up
  short by its length, or that carried a log line among the data, or that carried
  nothing else) from data that merely contains similar text. A message that shares a
  USB transfer with real data cannot be told apart, and a transfer that is itself
  nothing but programmer-style log or answer XML is refused as a message. Record any
  read that fails with "are a complete message from the programmer" on a unit whose
  partition really holds such text.
- [ ] **UNVERIFIED** `printgpt` lists the same partitions as the PC tool; the
  saved primary region equals sectors 0-33 read by the PC tool and the saved
  backup region equals the last 33 sectors. Record the disk GUID, the span the
  table describes and the capacity the programmer measures.
- [ ] **UNVERIFIED** `check` says whether the table's span equals the measured
  capacity on this unit (the research notes list this as unknown). A mismatch
  must stop the whole-area read; confirm that on the real unit.
- [ ] **UNVERIFIED** A large partition (for example `system_a`, 512 MiB) reads
  completely; record the speed. Cancelling mid-read leaves no file and the next
  operation recovers; unplugging mid-read ends with the "left the USB bus"
  message and no file.
- [ ] **UNVERIFIED** The whole-area read of about 3.5 GB completes in the
  tablet's browser storage (it needs about twice the size while it is saved) and
  its SHA-256 equals the PC tool's `rs 0 COUNT` for the same count. Record free
  space before and after. It does not include the eMMC boot areas or RPMB.
- [ ] **UNVERIFIED** `reset` makes the unit leave EDL and boot normally, and the
  operation ends as completed, not cancelled.

Flash and erase (emulator-tested only; each item below needs a coordinated
go-ahead on a real unit and a saved copy of every partition touched):

- [ ] **UNVERIFIED** `program` is accepted by the programmer WITHOUT a
  `filename` attribute and with the raw data followed by a zero-length packet
  after each payload-sized piece; record any NAK text and whether the programmer
  needs `ZLPAwareHost` to be 1.
- [ ] **UNVERIFIED** A flash of a small ordinary partition (for example `cache`
  or a scratch partition) reads back with the SHA-256 of the image; the saved
  copy taken first equals what the PC tool reads for the same partition.
- [ ] **UNVERIFIED** The read-back goes through the same programmer path as the
  write: record whether a programmer with a write cache could return cached data
  (the read-back would then not prove the flash holds the bytes). Power-cycle and
  read again if in doubt.
- [ ] **UNVERIFIED** Cancelling a flash between blocks leaves the programmer
  answering the next command; cancelling while a block is in flight (the grace
  period `edlTimeouts.cancelGrace`) leaves it waiting for data and needs the
  device put into EDL again. Record which one happened.
- [ ] **UNVERIFIED** `erase` is in the programmer's function list; record what a
  freshly erased partition reads as (all zero, all 0xFF, unchanged) - Cody reports
  it and assumes nothing.
- [ ] **UNVERIFIED** The typed override `write:<name>` is demanded in the panel's
  confirmation for a protected partition (for example `persist`) and the write is
  refused without it; `boot0`, `boot1` and `rpmb` are refused outright.

Backup sets and restore (emulator-tested only; the backup items only read, the restore items write and need a coordinated go-ahead and a set taken from the same unit beforehand):

- [ ] **UNVERIFIED** `backup` from a unit freshly put into EDL mode (loader chosen, nothing connected before) saves a set whose manifest records the chip serial and public-key hash `detect` printed, the eMMC serial and product `getstorageinfo` reports, and the disk GUID `printgpt` lists. Every partition file's SHA-256 equals the PC tool's `r NAME` of the same partition; the primary and backup table files equal sectors 0-33 and the last 33 sectors. Record the time and the browser storage the whole set used.
- [ ] **UNVERIFIED** The programmer reports an eMMC `serial_num` in `getstorageinfo`. If it does not, the set records none and says NOT RESTORABLE; record that.
- [ ] **UNVERIFIED** A set taken after `Connect` (programmer already running) says NOT RESTORABLE and `restore` refuses it, because the boot ROM's public-key hash cannot be read any more.
- [ ] **UNVERIFIED** `restore` is refused for a manifest edited to carry another chip serial or public-key hash BEFORE any loader is sent, and for another eMMC serial or disk GUID after `configure` with nothing written. The manifest's SHA-256 changes with every edit, so the edited copy is a new file.
- [ ] **UNVERIFIED** After one ordinary partition (for example `cache`) was changed, `restore` rewrites only that partition, asks for the typed override `restore:<first 8 characters of the manifest SHA-256>` (and refuses without it), reads it back identical, and leaves every other region alone. Compare the result with the PC tool's reads.
- [ ] **UNVERIFIED** The programmer accepts `program` for the sectors that hold the partition tables at BOTH ends of the disk (sectors 0-33 and the last 33). Factory flash scripts write them with `program` and then fix them with `patch`; Cody writes the saved tables byte for byte and ships no `patch`. Record any NAK text and whether the unit still boots and lists the same partitions afterwards.
- [ ] **UNVERIFIED** A restore interrupted by Cancel or an unplug between regions leaves the unit able to re-enter EDL, and the output names the regions done, the one in doubt and those never started. The saved copies of overwritten partitions can be flashed back with `device_flash`; no command writes saved partition tables back.

Boot drive (emulator-tested only; changes what the unit may start from, so it needs a coordinated go-ahead and the PC tool at hand to put it back):

- [ ] **UNVERIFIED** The programmer lists `setbootablestoragedrive` among its functions and accepts `setbootablestoragedrive` with a single `value` attribute. Record what the number means on this unit (UFS logical unit or eMMC boot partition) and the programmer's answer.
- [ ] **UNVERIFIED** The panel's confirmation demands the typed override `set-bootable:<N>`, shows that there is no saved copy, and the result reads UNVERIFIED whatever the programmer answers. Record what the unit does after `Reset`, and the PC tool's reading of the setting, if it has one.

### CMSIS-DAP / DAPLink (not shipped)

- [ ] **UNVERIFIED** WebUSB transport feasibility through DAP.js/DAPLink is
  assessed only with a real probe and exact target identity; this change ships
  no CMSIS-DAP implementation.
- [ ] **UNVERIFIED** No generic DAP memory-write/flash action is enabled without
  a target-specific flash algorithm, immutable geometry/protection profile,
  reset sequence, full erase-footprint preservation, and exact readback.
- [ ] **UNVERIFIED** The limitations in
  `hardware-host-helper.md#cmsis-dap-boundary` are satisfied before a
  device-specific CMSIS-DAP protocol can be proposed.
### STM32, Gecko, and STK500 serial bootloaders

- [ ] **UNVERIFIED** The selected serial adapter, baud settings, boot entry
  sequence, and chip identity work with the physical board.
- [ ] **UNVERIFIED** Application range, bootloader range, option-byte/fuse
  range, and any protected regions are represented in the reviewed layout.
- [ ] **UNVERIFIED** The selected protocol reads back exact application bytes;
  backup, post-write hash verification, and restore hash verification succeed.
- [ ] **UNVERIFIED** A protocol/device lacking exact readback is refused before
  write rather than returning an unverified success.
- [ ] **UNVERIFIED** Cancellation during an actual transfer produces no retry;
  device state and recovery result are recorded.

### ADB authenticated shell and file operations

- [ ] **UNVERIFIED** The physical device shows a deliberate authenticated ADB
  trust prompt and the observed key/device identity is recorded.
- [ ] **UNVERIFIED** A test file push is SHA-256-checked, staged to a
  non-destructive location, pulled back, and SHA-256-compared before/after its
  atomic replacement path.
- [ ] **UNVERIFIED** The exact destination, digest, offset where applicable,
  and backup/rollback path appear in point-of-risk confirmation.
- [ ] **UNVERIFIED** Arbitrary shell and raw paths are blocked until the user
  grants this connection shell access; revoke/disconnect removes that authority.
- [ ] **UNVERIFIED** A granted recovery script streams output and reports its
  actual exit status. Keep the tablet awake; a disconnect before status means
  unknown completion and never triggers automatic command replay.
- [ ] **UNVERIFIED** The user can open an ADB terminal without granting the agent
  shell access. The terminal shares the device's ADB connection with shells and
  port rules; push staging, sideload, and reboot still need it closed first.
- [ ] **UNVERIFIED** Raw block/symlink push offers a backup and requires the
  exact typed target override rather than pretending to be an atomic file push.
- [ ] **UNVERIFIED** Interrupted push/pull recovery preserves the original
  destination or restores it from escrow.
- [ ] **UNVERIFIED** A file of at least 100 MB is interrupted after a recorded
  offset, then resumes only after authenticated reacquisition; the final remote
  file and local source have matching SHA-256.
- [ ] **UNVERIFIED** Switching Cody sessions during that 100 MB+ transfer does
  not resume or complete the original operation in the new session.

### ADB install, adbd restarts and wait-for-device

- [ ] **UNVERIFIED** `device_install` of a real debug APK on a recoverable
  device: the confirmation shows the digest and the `pm install` command line;
  the app appears; `/data/local/tmp` holds no `cody-install-*` file or
  `.cody-adb-stage-*` directory afterwards. A downgrade without `-d` and a
  reinstall without `-r` fail with the package manager's own message.
- [ ] **UNVERIFIED** Cancel while `pm install` of a large debug APK is running
  ends the wait at once; `/data/local/tmp` holds no `cody-install-*` file or
  `.cody-adb-stage-*` directory afterwards, the operation says the package
  manager may still finish installing, and the device can be used again
  immediately. Also cancel while the device is silent: after the cable is
  pulled and replugged mid-copy (the replacement connection waiting for the
  RSA prompt), and with the device frozen so it never answers the stream
  `pm install` opens; Cancel ends the install within about 10 s and the device
  is released. Record whether the app was installed anyway.
- [ ] **UNVERIFIED** `adb root` on a userdebug build restarts adbd and the
  operation reconnects and reports `service.adb.root` 1; the same request on a
  production build is refused with adbd's message. `unroot` returns it.
- [ ] **UNVERIFIED** `tcpip 5555` makes `adb connect <device>:5555` work from a
  PC on the same network and `usb` turns that legacy listener off (the same
  `adb connect` is refused); record whether the USB identity changed and whether
  a fresh grant was needed. With Wireless debugging switched ON in Developer
  options, `usb` must report `verified: false` ("not USB-only") and a paired PC
  can still connect over TLS; switched OFF, `usb` verifies.
- [ ] **UNVERIFIED** `wait-for-device` started while the device reboots (after
  `device_exec` reboot) returns once adbd answers, even though the browser
  reports the device leaving and returning (same USB identity); with the cable
  pulled it ends at its timeout; Cancel ends it at once, also while the browser
  is still opening the device.

### ADB port forward and reverse

Use a recoverable, non-critical device and a throwaway service on each side
(for example `python3 -m http.server` on the Cody server, and a listener on
the device). None of this writes device storage; it opens network paths.

- [ ] **UNVERIFIED** `device_forward` shows a confirmation card naming the
  device service, the Cody-server loopback port, and that every process on the
  Cody server can then connect. Nothing listens before the tap (check with
  `ss -ltn` on the server); declining leaves nothing behind.
- [ ] **UNVERIFIED** After the tap, a client on the **Cody server** reaches the
  device service (HTTP request returns the device's real response). Record the
  port, device model, and Android release.
- [ ] **UNVERIFIED** A multi-megabyte download through the forward matches its
  source SHA-256 while a second client connects at the same time.
- [ ] **UNVERIFIED** `device_reverse` card names the device address and Cody
  server port; an app or `nc` on the device reaches the Cody-server service.
  `device_exec` `reverse-list` shows the rule; after removal it is gone.
- [ ] **UNVERIFIED** While both are live, a diagnostic `device_exec "id"` and a
  Devices-panel terminal still work on the same connection, and cancelling the
  forward leaves the reverse working (`device_tunnels` agrees).
- [ ] **UNVERIFIED** Cancel, the card's Cancel button, unplugging the USB
  cable, closing the tab, and a second tab taking over each remove the
  listener (port refused on the server) and any device-side reverse rule.
- [ ] **UNVERIFIED** A reverse to Cody's own port, and a forward below 1024,
  are refused with the stated reason.

## Optional local helper (not shipped)

The helper described in `hardware-host-helper.md` is design-only. These items
are **UNVERIFIED** and do not authorize deployment:

- [ ] **UNVERIFIED** Package signatures, key rotation, origin binding,
  one-time grants, page-key proof, device binding, TTL, and sequence checks are
  exercised on each supported OS.
- [ ] **UNVERIFIED** Native local confirmation names exact device, target,
  offset, image hash, backup, and protected override immediately before write.
- [ ] **UNVERIFIED** Revocation from Cody and from the local UI terminates the
  grant, cancels queued work, and removes temporary input without a write.
- [ ] **UNVERIFIED** Every vendor invocation is schema-allowlisted; arbitrary
  shells, paths, environment, and command strings remain impossible.
- [ ] **UNVERIFIED** Linux user socket, macOS user service, and Windows
  per-user named pipe reject other users and network clients.
- [ ] **UNVERIFIED** Generic UF2 is not presented as flash or verified success;
  it remains manual preparation until a device-specific exact readback path
  exists.

## Completion gate

Do not mark a protocol hardware-verified until every applicable item has dated
evidence, including the pre-write backup and exact post-write readback hash.
An approved no-fetch Fastboot write remains explicitly UNVERIFIED until a
separate recovery readback succeeds. This checklist does not certify hardware.
