# Browser-hosted hardware (`lib/devices/`)

← Back to [AGENTS.md](../../AGENTS.md) · Full text of the sections AGENTS.md summarizes, moved verbatim; AGENTS.md keeps a short summary of each.

Sections in this file:
- Browser-hosted hardware (`lib/devices/`)
  - Operations, artifacts, and progress
  - Device trust: one permission per device (`lib/devices/trust*.ts`)
  - Devices panel layout (connect -> device -> actions)
  - ADB port forward and reverse
  - Trust-gated flashing and honest verification
  - Supported protocol boundaries
  - Evidence and the optional helper

### Browser-hosted hardware (`lib/devices/`)

The hardware is connected to the machine running Cody in the browser, not to the
server. The page owns the real `SerialPort`, `USBDevice`, or BLE
characteristic; the server only relays frames within that Cody session. Browser
grants are user-selected, secure-context capabilities. Do not claim, widen, or
re-use a grant across sessions.

- **Discover first.** `device_list` reports the current browser's secure-context
  and Serial/USB/Bluetooth capabilities plus its granted device IDs. If it has
  no device, ask the user to use the Devices panel's browser picker. Web Serial
  is unavailable on Android, where the WebUSB serial polyfill is used when
  available; browser/OS/driver support is reported rather than assumed.
- **A BLE UUID reaches the browser only as a full 128-bit string or an
  assigned name** (`canonicalBleUuid`, lib/devices/client.ts). Web Bluetooth
  accepts a 16/32-bit alias only as a NUMBER; the STRING `"0x18f0"` makes
  `BluetoothUUID.getService` throw, and Android Chrome fails the whole
  `requestDevice` picker on it ("Invalid Service name"). Every hex alias is
  expanded onto the Bluetooth base UUID before `requestDevice`,
  `getPrimaryService` or `getCharacteristic`, whatever form the agent or
  the user typed. Verified against headless Chromium's own `BluetoothUUID`.
- **Grants, identity, and leases are strict.** A device is owned by one session;
  raw requests and a high-level operation hold mutually exclusive leases.
  Re-adoption is limited to the same full USB VID/PID/serial identity. A device
  which re-enumerates into another identity or mode needs a fresh user grant in
  the browser's picker, then a new operation (the agent is asked afresh unless
  the unit was remembered: same vendor id and serial number, see "Device
  trust"). Do not retry or replay a write across
  disconnect, cancellation, or mode change. Raw USB IN/control-IN calls are
  bounded (five seconds by default); an expired connection is invalidated.
- **Use the raw tools only for discovery or a protocol Cody does not implement.**
  `device_open`, `device_read`, `device_write`, `device_close`,
  `usb_transfer`, and `ble_gatt` are available after a grant. Opening USB
  reports claimed interfaces, descriptors, and endpoints; a requested
  unclaimable interface fails rather than becoming a partial success. On
  Windows an interface held by another driver cannot be claimed; this is a host
  driver issue, not a retryable device error. Do not hand-roll packet loops in
  `eval` for an implemented protocol (ESP, ADB, fastboot, DFU, EDL, Gecko, STM32,
  or STK500).

#### Operations, artifacts, and progress

Use high-level operation tools for supported work:
`device_detect`, `device_dump`, `device_flash`, `device_exec`,
`device_push`, `device_pull`, `device_sideload`, `device_install`,
`device_verify`, `device_monitor`, `device_monitor_send`, `device_forward`,
`device_reverse`, `device_tunnels`, `device_operation_status`, and
`device_operation_cancel`. Start requests name the exact browser `device`,
`protocol`, and where relevant target, offset, interface, and artifact
`fileId` with its displayed SHA-256. The operation runs independently in the
page. Read progress/status or cancel it; no argument can give or move the user's
trust (see "Device trust"). Phase/state/declared/terminal events are immediate; live
progress and output are coalesced at 200 ms. Status deliberately retains only
128 terminal records, each bounded to 256 events, 512 output lines, and 64 KiB
of output.

Pop-ups are for news, not progress. Every hardware `notice` frame comes from
`lib/devices/operation-notices.ts` (`noticeForOperation`, pure and tested alone):
a long (15 s) or bulk (flash, dump, pull, push, sideload, install) operation
finishing, a failure, and a cancel the system made. The trust question is NOT a
pop-up (it waits in the chat's input dock), nor is a countdown, and the operations
a Deny failed are not announced (`DECLINED_MESSAGE_PREFIX`): the person just said
no. Started/progress/output/state events and a routine read that succeeded
raise nothing, and a finish is news only as the step from running to finished
(`onOperation` hands the listener the snapshot it replaced): a page that re-sends
the finished operations it remembers to a restarted server announces none of them.
A run of failures is one pop-up plus one "N more" summary (`DeviceNoticeBatcher`,
5 s window). The frame carries `source: "device"` and a `dedupeKey`, and the
browser shows it as written (`shelfItemFor`), never through the engine-error
describer, so a repeat folds into one notice with a count. The Devices panel
does the same for its list (`lib/devices/activity-groups.ts`, `ActivityFeed`): a
finished agent command that declared no risk to the device (`riskDeclared`), is not a
flash/dump/transfer and saved no file is routine, and a burst of routine commands
on one device is one compact entry whose rows open to each command's full card.
Whatever is running, significant, or waiting for the person (a trust question, a
countdown) keeps its own card, and what waits for the person is listed first.
`operation-notice-wiring.test.mjs`
drives the whole chain (operation manager, frame validator, device bridge,
session wrapper); keep it passing when touching any link.

Engines launched through the MCP bridge (`displayMcpAcpServer()`,
`claudeDisplayMcpConfig()`) get their device tools from the hard-coded copy in
`bin/cody-display-mcp.js`, not from `DEVICE_OPERATION_TOOLS`. Adding or
changing an operation tool means changing both; `bin/cody-display-mcp.test.mjs`
starts the real bridge and fails when a tool is missing or takes different
arguments.

#### Device trust: one permission per device (`lib/devices/trust*.ts`)

There is exactly ONE permission between an agent and a device, it is given per
device, and it is asked in the chat, not in the Devices panel. It replaced the
per-operation approval cards, the typed protected-region overrides, the armed
approval countdown and the connection-scoped shell grant; none of them exists any more.

- **The gate** (`DeviceOperationManager.requireTrust`, operations.ts). An agent
  operation (`manager.start`) that is anything but read-only `detect`
  (`actionNeedsTrust`) waits until the person has trusted its device. The first one
  raises ONE question for that device (`trustRequests()`: one `DeviceTrustRequest`
  per device, its operations in state `awaiting-trust`); every later operation on the
  device queues behind it (`waiting` counts them) and nothing touches the device - no
  lease, no artifact read - until the answer. `answerTrust(requestId, { allow,
  remember })`: **Allow** lets every queued operation go on; **Deny** fails them all
  with `declinedMessage(label)` ("The user declined control of <device>; do not ask
  again until they reconnect it") and the agent is refused with that same sentence,
  raising no new question, until the device is disconnected (`deviceDisconnected`
  ends both a connection's trust and a refusal). The person's own operations
  (`startUser`: Devices-panel buttons and terminals) are never gated. An agent typing
  into a terminal (`send`) needs the device trusted at that moment too. An
  unanswered question has no time limit: it ends when answered, when the operations
  behind it are cancelled, or when the device leaves the bus (the cancel says why).
  The gate covers the high-level operation tools; the raw tools (`device_open`,
  `device_read`, `device_write`, `usb_transfer`, `ble_gatt`) are still governed only
  by the browser's own device grant, as before.
- **Who can give it.** Only `answerTrust`, which only the chat card's Allow reaches
  (`DeviceTrustCard` -> `respondToInput` -> `useDeviceTrustRequests` ->
  `deviceTrustHub`, lib/devices/trust-hub.ts, the registry each session's manager
  adds itself to, so a chat with no device never loads the bridge). No tool, request
  option, server frame or `PageOperationCommand` names it. The card latches with a
  ref so a double-click sends one answer, and neither button carries
  `data-input-choice`, so the dock's Enter and digit shortcuts can never consent to
  hardware control.
- **Remembering.** "Remember this device" (ticked by default, not rendered for a
  device without a serial number) makes the Allow last. The key (`deviceTrustKey`) is
  the USB vendor id plus the serial number and NOT the product id: one unit
  enumerates as adb, then fastboot, then recovery and stays trusted; a second unit
  of the same model has its own serial number and is asked about. A device with no
  serial number has no key and is trusted for the connection only (until unplug or
  reload). Remembered devices are stored per account on the server:
  `<accounts dir>/device-trust.json` (`trust-store.ts`, 0600, atomic write, keyed by
  user id, `__instance` on an open instance), through `GET/PUT/DELETE
  /api/devices/trust` (owner-scoped, 4 KB bodies, 100 devices per account). PUT
  refuses any request that carries an `Authorization` header, so an access token, a
  capability token or an agent's script can never remember a device; the key and the
  time are set by the server; DELETE only removes. The page's copy is
  `ServerTrustBook` (`pageTrustBook()`, trust-client.ts): the gate waits for its
  first read (`ready`, 4 s limit) before deciding about a keyed device, a hidden tab
  re-reads when it returns, and `remember()` is called from `answerTrust` alone. A
  save that fails leaves the device trusted for the connection and the chat says why.
- **Seeing and revoking it.** The device card shows a Trusted (or Trusted for now, or
  Agent blocked) chip, and **Forget** (device card, or Settings > Preferences >
  Trusted devices, `TrustedDevicesSetting`): `withdrawTrust` / the store's DELETE end
  the connection's trust and the remembered entry, cancel what the agent had running
  on the device (`TRUST_WITHDRAWN_REASON`; a question still waiting stays open) and
  the next operation asks again. Forget can only remove trust.
- **What stayed.** Backup before a write, readback verification, UNVERIFIED
  reporting, the hard refusals (eFuse burns, EDL boot0/boot1/rpmb, partitions that
  overlap a table) and the browser's own USB picker are unchanged, and the REQUEST
  still names an exact `options.protectedOverride` for a protected ESP/DFU/STM32/STK500
  range (named by whoever makes the request: the refusal says which, nothing is
  typed in a prompt). A flasher still calls `context.confirm(risk)`, but that now
  only DECLARES the exact action, target, range, digest and backup: the manager
  checks it against the request (`bindRisk`), writes `Starting <action> on
  <target>. Backup: ...` to the operation's log, emits a `declared` event, marks the
  snapshot `riskDeclared` and asks nobody. No extra prompt exists for bootloader or
  partition-table targets (they get a PROTECTED note in the declared details).
- **A visible wait before sending.** `options.sendDelaySeconds` (1-300, accepted by
  every start tool, checked in `requestFor` and `validateRequest`) is a countdown,
  not an approval. The manager strips the key before a flasher sees the request
  (several refuse option keys they do not know), so a protocol can neither read nor
  move the clock. Once the device is trusted and the flasher declares its first risk,
  the operation is in state `countdown` (`snapshot.countdown`: startedAt, releaseAt,
  the declared binding): the card reads "Starting in N s" with its own Cancel,
  nothing is sent, and the wait runs once, before the first command. At the due time
  `refuseRelease` checks once more that the page did not oversleep
  (`COUNTDOWN_SLACK_MS`), that the connection is the one it started on
  (`currentIdentity`, `transport.connected()`), and fails with "Not sent: ..."
  otherwise. Tests: `operation-trust.test.mjs` (the gate, remembering, Forget),
  `operation-countdown.test.mjs`, the route and store tests, `DeviceTrustCard.test.mjs`.

Input uploads (picker, drop, or an authorized local-path import) and device
outputs are browser-owned session artifacts. `DeviceArtifactStore` hashes each
Blob and waits for its IndexedDB commit in `cody-device-artifacts`; hydrate
restores that session's escrow after reload. Artifacts never become server files
or cross another session. Use the Devices panel's explicit download to retain an
important backup outside browser storage. An output backup is selectable as a new input without download/re-upload; selecting it does not itself restore anything, and there is no generic or automatic restore. The panel displays artifact hashes, output,
progress, cancellation, and the exact action each operation declared before it sent anything.

ADB shell access is covered by the device's trust like everything else: once the
device is trusted an agent `device_exec` streams arbitrary shell commands,
and `device_monitor` / `device_monitor_send` open and type into an ADB PTY. There
is no separate shell grant and no literal-diagnostics tier. `DeviceTerminal` is the
person's own terminal and is never gated; an agent may type into it only while the
device is trusted, and Forget, a disconnect or page replacement cancels the agent's
active ADB work and refuses its later input.

Serial consoles use protocol serial and the same user terminal surface as ADB.
Both use xterm for ANSI/control characters plus mobile input/line-ending controls.
Serial supports baud selection and DTR/RTS/break. Android can use the existing
CDC polyfill or a descriptor-bound raw WebUSB CDC data/control interface pair;
CDC Union descriptors disambiguate composite devices. Stalled/short USB writes
fail instead of reporting delivery. Prompt chunks appear without waiting for a
newline. Explicit disconnect waits for the borrowed operation lease to finish.

For an agent-run TWRP command the device is trusted first (the one question in
the chat), then device_exec accepts protocol adb and the exact command without a
regex filter or per-command prompt. No total shell-command timeout is imposed;
a missing initial daemon response is bounded, but quiet established connections
stay alive. Output is streamed into bounded logs and nonzero exit status fails.
A reboot/disconnect before status arrives means unknown completion, not success.
Port rules, shells, pulls, detection, and terminals share one ADB connection per
device; push staging, sideload, reboot, and the TWRP script still need the device
lease alone, so they fail with a lease-busy error while any of those is open.

#### Devices panel layout (connect -> device -> actions)

`components/DevicePanel.tsx` reads top to bottom as the job does. `ConnectCard`
offers the three ways a browser is handed hardware (USB, serial, Bluetooth) and
states what this browser can do; it shrinks to one row once a device exists.
`DeviceCard` is one card per granted device: identity, current mode, state, and
tabs holding only the actions that mode has. `ArtifactPanel` ("Files &
backups") is the session-level file library the action forms draw their input
from. Operations appear in the card of the device they ran on; those of
disconnected devices are listed in a closed disclosure at the bottom.

`lib/devices/ui-model.ts` is the single table behind it: the mode from the USB
descriptors (`deviceMode`), the protocols offered (`offeredProtocols`), the
groups for those protocols (`availableGroups`) and which `(protocol, action)`
pairs each group exposes. A new flasher action MUST be added to a group there;
`ui-model.test.mjs` fails when any action a shipped flasher declares is
unreachable. Terminal-shaped actions (`adb` monitor, `serial` monitor,
`fastboot` exec) are covered by `DeviceTerminal` / `FastbootCommand`, and EDL's
exec, dump and flash by `EdlWorkflow` (connect, partition tables, check, flash and
erase of a partition picked from the last table read, the whole-area backup
offered only after a passing check, a backup set and its restore), not by the
generic `ActionForm`. A device in a mode Cody cannot read (`unknown-usb`),
or a card with "Show every protocol" on, offers every protocol. There is no
confirmation or armed card in `OperationList.tsx` any more: an operation
waiting for the trust answer says so on its card (`awaiting-trust`; the question
itself is in the chat), and one counting down shows `CountdownCard` ("Starting in
N s", the exact action and target, its own Cancel). `DeviceCard` shows the
Trusted / Agent blocked chip with Forget under its title (`TrustStatus`,
`useTrustLevel`). The activity under each device is `ActivityFeed`, not a flat list.
Every control is at least 44 px (`components/devices/ui.tsx`); the panel is
used with a finger, and the right panel can be as narrow as 300 px, so layouts
wrap rather than scroll sideways.

#### ADB port forward and reverse

`device_forward` (`adb forward`), `device_reverse` (`adb reverse`), and
`device_tunnels` (`--list` / `--remove` / `--remove-all` for this session) are
real, relay-backed ADB features, not a local shell helper. The browser cannot
listen on a TCP port, and the server cannot reach the device, so the rule is
split: the page owns the authenticated ADB connection and the server owns the
TCP endpoint, joined by `{ type: "tunnel" }` frames on the existing device
socket (`lib/devices/tunnel.ts` vocabulary, `tunnel-host.ts` server half,
`tunnel-client.ts` page half, `adb.ts` forward/reverse).

- **"Host" means the machine running Cody.** A forward listens on
  `127.0.0.1:PORT` of the Cody server (what an agent calls `localhost`), never
  on the tablet or PC holding the device, and never on a LAN address. A reverse
  dials `127.0.0.1:PORT` of the Cody server. Browsers cannot listen or open raw
  TCP, so the tablet's own `localhost` is unreachable by design.
- **Grammar.** Forward device side: `tcp:`, `localabstract:`, `localreserved:`,
  `localfilesystem:`, `dev:`, `jdwp:`. Reverse device side: `tcp:` (also
  `tcp:0`), `localabstract:`, `localreserved:`, `localfilesystem:`. Host side is
  always `tcp:PORT` (forward: 1024+ or `tcp:0`). `;` and control characters are
  refused (`parseDeviceSpec` / `parseHostSpec`).
- **One rule = one long-running operation.** It follows the normal operation
  path: request -> the device's trust (the one question in the chat, if it has not
  been answered) -> the rule is declared (action `adb.forward` / `adb.reverse`,
  exact target, host port, who can then connect) -> running until
  `device_operation_cancel`, `device_tunnels remove`, the card's Cancel, a
  disconnect, or a lost connection. Nothing listens and the device is not
  touched before the trust answer. Cancelling removes the listener, closes every
  connection, and (reverse) asks the device to `killforward` before the
  connection is closed.
- **The server verifies; it does not trust the page blindly.** A `listen` or
  `reverse` claim is accepted only for an operation of this session whose
  snapshot is `running` and has declared its rule (`riskDeclared`); one rule per
  operation, 16 per session (both reserved before the listener binds, so
  concurrent claims cannot overshoot), 64 connections per rule; privileged ports and
  Cody's own port (`PORT`, `CODY_INTERNAL_DISPLAY_ORIGIN`) are refused for both
  listening and dialing; page-minted connection ids must start `p-`. Rules die
  with the page socket, a replacing page, the device's `gone`, or the
  operation's terminal snapshot (`TunnelHost.closeAll/closeDevice/closeOperation`).
- **One device listening address, one rule.** adbd rebinds silently, so a second
  reverse rule on the same `tcp:PORT` (or the same host port) on one connection
  is refused; otherwise cancelling the first would delete the second's listener.
  `tcp:0` always gets a fresh device port. Reverse registration is bounded
  (15 s) and cancellable; a rule that is installed after the operation gave up
  is removed again, and its device and host addresses stay reserved until that
  late answer has settled and been cleaned up, so a replacement rule cannot be
  deleted by it. Waiting for a closing ADB connection is cancellable too.
- **Directional EOF.** The device ending its stream and the host client closing
  are separate events; the page always hears the host side finish (`end` after
  an ordinary close, `reset` after an abrupt one), so short-lived requests do
  not leave connection objects in the browser.
- **Credit-based flow control**, not unbounded buffering: 48 KiB chunks, a
  512 KiB window per connection, acknowledged only after the far sink accepted
  the bytes. Half-close does not exist in ADB, so (like a PC) the first end
  closes the stream after the bytes already sent.
- **Shared ADB connection.** Forward/reverse, `detect`, `pull`/`dump`,
  `verify`, terminals and read/shell `exec` join the lease already held for the
  device (`DeviceOperationManager.acquireLease`, one real `borrowHardwareTransport`)
  and one authenticated session (`adb.ts` `AdbHold`): the connection is bound
  to the hold, not to one operation's signal, and torn down only when the last
  operation leaves or every remaining one is cancelled. A new operation waits
  for a closing or aborted connection to be fully gone before it authenticates,
  so two ADB sessions never overlap on one USB transport. Cancelling one rule
  never drops another. Anything that rewrites the device or connection (push
  staging/reacquire, sideload, reboot, TWRP script) keeps the exclusive lease.
- `device_exec` with `options.kind` `reverse-list`, `reverse-remove`, or
  `reverse-remove-all` manages rules *on the device* (including ones other
  programs made); remove and remove-all are declared like any other change.

ADB transfers hash in bounded chunks (`blob-stream.ts`). Pull/backup uses an OPFS
spool, commits the result to IndexedDB escrow, then removes the spool. Raw/symlink
push uses direct sync, offers a backup, and is declared for the exact path (no
typed `write:<path>`: the device's trust covers it). Regular-file
push retains verified staging/atomic replacement. `device_sideload` serves AOSP
`sideload-host` block requests; it reports the input SHA-256, not installation
verification.

#### Trust-gated flashing and honest verification

Caller options cannot supply authority, device geometry, or trust. Each
structured mutation declares its real target, input digest, and backup status
before anything is sent (`context.confirm`: a declaration the manager checks and
logs, never a question); the device's trust, given earlier in the chat, is the only
permission. Protected destinations (the boot chain, partition tables) are noted
PROTECTED in the declared details and proceed with no extra prompt. Unknown
readback is not a write veto:
Fastboot explicitly warns, writes once, and reports UNVERIFIED.
An ACK, progress counter, CRC or successful command is never readback proof.
A transport timeout is unknown completion, never permission to replay a write.

Every system cancel records its reason (`cancel(id, reason)` -> `snapshot.error`),
so the card and `device_operation_status` say why an operation ended: a tablet whose
volume keys are held drops off the bus, `deviceDisconnected` cancels what waits
on it, and the card would otherwise simply vanish.

Protocols with intrinsic erase geometry preserve and verify their whole erase
footprint. Fastboot addresses named partitions: when fetch is available it
backs up the whole partition and verifies raw bytes or sparse RAW/FILL extents;
sparse DONT_CARE bytes and bytes beyond the image are explicitly unverified.
Without fetch, boot recovery and use ADB device_verify with the raw image's
exact target path, byte length, and SHA-256. Sparse file hashes cannot be used
as expanded-image hashes.

#### Supported protocol boundaries

- **ESP serial/SPI:** `detect`, `dump`, and verified `flash` are supported
  through esptool. Detected ESP targets accept exact caller offsets within detected capacity and
  `firmware`, `flash`, `factory`, or `spi-boot` targets; a 4 KiB
  leading/trailing read-modify-write plan preserves the whole erase footprint.
  ESP32 factory spans the intrinsic prefix/spi-boot/firmware range, and the
  ESP8266 offset-zero `0..0x10000` range is conservatively spi-boot
  protected; either needs exact `allow-spi-boot` when intersected. The flasher writes
  once, uses esptool device MD5, then reads the full footprint back and
  SHA-256-verifies it. `device_exec` takes esptool-style commands
  (`parseEspCommand`): read-only `chip_id`, `read_mac`, `flash_id`,
  `get_security_info`, `efuse_summary` and `efuse_dump`, and the stub-only
  `erase_flash` / `erase_region ADDRESS SIZE`. An erase refuses a ROM-only
  connection and any flash whose SPI ID does not map to a size esptool-js
  recognises, escrows every byte it will remove (checking the stub's read-digest
  frame), and declares itself in the log with no override asked: the SPI boot area
  it touches, a chip with secure boot or flash encryption burned, and an eFuse map
  that is not reviewed are all named in the declared details. It then proves the
  range blank with the device's own MD5. eFuse reads
  use the register maps in `lib/devices/esp-efuse.ts` (ESP32, S2, S3, C3, C2, C6,
  H2); `efuse_dump` declares itself first and keeps key-block contents out of the operation
  log. eFuse burns and `espsecure` are not offered (irreversible).
- **Fastboot:** detection, arbitrary getvar, streamed dump/backup, raw/sparse
  named-partition flash, volatile download/boot, set_active, erase, reboot modes,
  OEM/flashing commands, and arbitrary vendor commands are available. Missing
  fetch permits an UNVERIFIED flash after the warning; available fetch keeps full backup
  and image-defined readback. Boot-critical and partition-table targets
  (preloader/LK/TEE/RPMB/GPT/boot0/boot1/eFuse) and vendor/security commands are
  declared in the log with a PROTECTED note or the exact command; nothing is typed
  or asked. FastbootCommand uses the selected artifact for
  boot/flash/stage/update. `flash` reads `max-download-size` (decimal, or hex with
  `0x`) and resparses a larger image into sparse pieces (`sparse-image.ts`, at
  most 1 GiB each) that are flashed in turn; a failed piece stops with no retry.
  `stage` / `get_staged` move data to and from the bootloader's staging buffer.
  `update` / `flashall` flash the images of a package ZIP (`zip-archive.ts`,
  `android-info.ts`): its `android-info.txt` must be met by the device (it is
  read under its own bound, 64 KiB and 256 requirements, refused on its recorded
  size before it is opened; `partition-exists` also needs that image in the
  package, and like AOSP only its first value names the partition), stored and
  deflated members are CRC-checked when opened, every partition is backed up
  before ONE declared risk (the package digest and every partition's backup),
  and each partition is written once and read back before the next. A failed
  update names four states: written and verified, written but not verifiable,
  POSSIBLY MODIFIED (a `flash:` command was sent; with its backup id), and
  untouched. A cancel (Cancel, or the browser reporting the USB device gone,
  which cancels) leaves no error in the operation record, so the same accounting
  (preceded by one line naming every partition and the backup taken of it) is
  published line by line to the operation's retained output BEFORE the
  cancellation is rethrown (`updateFromPackage`'s catch). The loop also checks
  the signal after each partition is recorded: a cancel that lands while the
  last readback is only being compared locally (a raw image's `hashBlob`, a
  fill extent) throws nothing by itself and the manager discards the result of a
  cancelled run, so without that check the accounting would be lost. The tests
  drive it through `DeviceOperationManager` (`managedUpdate`, which can cancel
  from a progress report) and read `snapshot.output`). Logical
  partitions need fastbootd; bootloader/radio/super/userdata
  images, `-w`, and mode switches are not part of it. Host filesystem
  generation (format) is not implemented.
- **USB DFU:** `detect`, `dump`, verified `flash`, and `abort`/`clear_status`
  maintenance are descriptor-bound. Flash is allowed
  only for bcdDFU `0x011a` on the actual selected `@Internal Flash` DfuSe
  map, with contiguous readable/erasable/writable g-sectors inside the STM32
  program range; it requires target `internal-flash`, an explicit absolute
  offset, and raw binary (not a `.dfu` container). All internal flash is
  conservatively protected and needs exact `allow-bootloader`. Cody escrows,
  merges, writes, and exact-reads every touched sector without manifestation or
  reset before proof. Generic bcdDFU `0x0110` flash (`flashDfu11` in dfu.ts) is
  also supported: target is the exact selected alternate, offset 0, raw binary
  (a `.dfu` suffix is refused); the request must name `allow-unknown` (or the
  role the alternate's name implies); the current image is escrowed when the
  device can upload; the image is sent as numbered blocks plus the zero-length
  block; a manifestation-tolerant device is read back and SHA-256-compared, an
  intolerant one restarts itself and is reported UNVERIFIED. A backup the device
  uploaded but Cody could not save refuses the write; only a device that will
  not upload downgrades to the UNVERIFIED warning. `exec` also takes `reset`
  (USB reset through `HardwareTransport.reset`; a failed reset is an error
  unless `HardwareTransport.connected()` shows the device left the bus) and, for
  DfuSe, `leave ADDRESS` (`DfuSession.leave` validates the GETSTATUS that follows:
  an explicit DFU error, a reply that is not a six-byte status, or a failed read
  while the device is still connected is an error; only a device that left the
  bus may stay silent). Manifestation, leave and reset make the device leave the
  bus on purpose, and the browser reports that as a disconnect that would cancel
  the operation: each opens `context.expectDeviceRestart(DFU_DEPARTURE_WINDOW_MS)`
  just before the transfer that causes it (the zero-length block, the leaving
  download, the reset). Only an idle (tolerant) device ends the window; every
  other path leaves it to expire, because the browser's `disconnect` event can
  trail the transfer that failed and arrive while the operation is finishing.
  A disconnect during the download blocks and the user's Disconnect still
  cancel. Real-route tests: `dfu-browser-lifecycle.test.mjs`
  (`fakeUsbDfuDevice` in `usb-dfu.test-helper.mjs` over `fakeDfuDevice`, whose
  `onDeparture` hook tells the fake browser the device left). The Devices form
  offers `allow-unknown` for DFU through `flashOverrideChoices` (ui-model.ts).
  No caller descriptor option creates a capability.
- **ADB:** detection, shell/PTY, push, pull/dump, recovery sideload and raw-image
  readback verification use Cody's persistent browser IndexedDB RSA credential.
  A trusted device permits arbitrary shell, including mount/dd and recovery
  scripts; there is no shell grant and no separate literal-diagnostics tier.
  A user's terminal never grants the agent access by itself. Normal file push retains verified
  staged chunks and atomic replacement; direct block/symlink push instead offers
  a backup and is declared for the exact path. Pull streams into escrow.
  Reboot mode and queued TWRP OpenRecoveryScript remain the original bounded
  helpers in this checkpoint; arbitrary commands use the shell path.
  A new USB mode needs the user's new grant. `adb forward` / `adb reverse` are
  supported through the server relay (see "ADB port forward and reverse").
  `device_install` (`install` in adb.ts) stages an APK with the push path's
  verified chunks, runs `pm install` with validated flags on that exact file, and
  removes the copy and its staging files on every exit (copy failure, `pm`
  failure, and cancel: it keeps the connection for that cleanup, and
  `stagingIo(adb, capabilities, signal)` stops at the next step when cancelled).
  The retained lifetime belongs to the OPERATION, not the transport: the hold an
  operation entered is found through `contextHolds` (keyed by context), so the
  connection made on a replacement transport after a resumed copy (or a restart,
  or a wait reacquisition) lives and dies with the same hold, and a cancel after
  the resume still removes the files over it. Cancel also ends the subprocess in
  flight without touching that connection: `shellStatus(adb, command, signal)`
  spawns with a dependent signal (ya-webadb closes only that stream and rejects
  `exited`; its own `spawnWaitText` takes no signal, so it is not used), `pm
  install` and every staging step receive the operation's signal, and a cancelled
  operation is never classified as a connection failure (it would reconnect and
  close the connection the cleanup needs). ya-webadb waits for the daemon's
  acknowledgement of a subprocess's OPEN without any limit and looks at the
  signal only afterwards, so `untilAborted` races that wait against the signal
  (a stream that opens late is closed). `adbFor(context, { signal })` makes the
  AUTHENTICATION of a replacement connection (after a lost connection mid-copy)
  cancellable without tying an authenticated connection to the signal: the
  connection still lives as long as the hold, the signal stops reaching it once
  it is up. `removeRemote` is the cleanup: waiting for the connection, opening
  the stream and running `rm` are all under one limit (`adbLimits.cleanupMs`,
  10 s, exported only so tests can shorten it), it never starts a new
  authentication (no cached session means nothing to clean over), and when the
  limit passes the retained count is released so the lease comes back. The
  operation tells the operator `pm` may still finish installing. The sandbox
  device (`adb-device.test-helper.mjs`) can hold `pm` silent (`pm: () => undefined`),
  stay silent before an OPEN acknowledgement (`silentOpen`), speak the shell v2
  protocol (`features: "shell_v2"`), share storage between two connections
  (`root`) and report a lost connection (`syncFault: "disconnect"`);
  `mutedTransport()` is a daemon that answers nothing, not even the CONNECT.
  Replacement is off unless `options.replace`: `-R` on Android 9+ (API read from
  `ro.build.version.sdk`; unreadable counts as modern), nothing on older Android,
  where `-R` is an unknown option and refusing is already the default. The
  declared risk names the exact `pm install` command and the APK's SHA-256.
  `device_exec` `options.kind` `root`, `unroot`, `tcpip` (with `options.port`)
  and `usb` restart adbd, and the device usually leaves the USB bus. The flasher
  calls `context.expectDeviceRestart(windowMs)` after it declares the restart; while that
  window is open `DeviceOperationManager.deviceDisconnected` does not cancel THAT
  operation (the connection's trust still ends with the disconnect; `disconnectDevice` passes
  `"forgotten"` and still cancels everything), the manager waits up to 4 s to see
  the disconnect before reacquiring, and `reacquireTransport` retries (it needs no
  current lease: `OperationRecord.identity` says which device) until
  `options.timeoutSeconds` (default 45) for the SAME stable USB identity.
  `tcpip` and `usb` verify adbd's effective legacy listener with `adbTcpListeners`
  (fixed `service.adb.listen_addrs`, then `service.adb.tcp.port` even when `0`,
  then `persist.adb.tcp.port`), refuse before anything is declared or sent when fixed addresses make
  the request impossible, and report `verified: false` when a property overrides
  the result. Wireless debugging (`persist.adb.tls_server.enable`,
  `service.adb.tls.port`) is a SEPARATE TLS listener that `adb usb` leaves
  running: `adbTcpListeners().wireless` reports it, the `usb` declaration says
  whether it is on, and `usb` is `verified: false` ("not USB-only") while it is on
  even with the legacy port at `0`. Never write "no TCP listener" from the three
  legacy properties alone.
  `wait-for-device` (`adbWaitOptions`) uses ONE deadline for lease
  acquisition (`record.waitDeadline`, handed to the flasher as
  `context.deadline`), authentication (`adbFor(context, { deadline })`), queries
  and every reacquisition; a failed reacquisition leaves no lease and nothing is
  authenticated until one succeeds; `pause()` (pause.ts) makes every poll
  cancellable. A wait is never cancelled by its device leaving the bus
  (`DeviceOperationManager.departureExpected`: an announced restart window OR a
  `record.waitDeadline` still ahead; the connection's trust still ends with the departure, only the
  same granted identity is ever taken again, and `disconnectDevice`'s
  `"forgotten"` still cancels). `awaitLease` (operations.ts) races every wait
  acquisition and every reacquisition against the deadline and Cancel (a
  reacquisition's backstop is `PROVIDER_TIMEOUT_GRACE_MS` later, so a provider's
  own `timeoutMs` error wins a photo finish) and releases a lease that arrives
  after the wait gave up; WebUSB open/configure/claim can take as long as it
  likes. The server (`DeviceBridge.departedDevice`) remembers the ids of
  devices that left the page (15 min, 16 at most, cleared when another page takes
  over, never for a roster drop) and `device_exec` accepts them for
  `wait-for-device` by exact id only. Call `reacquireHardwareTransport` on its
  provider (`.call`): the browser implementation uses `this`. Tests:
  `adb-lifecycle.test.mjs` (manager level) and `adb-browser-lifecycle.test.mjs`,
  which drives the real `DeviceBridgeConnection` with `fakeBrowser()` /
  `fakeUsbAdbDevice()` from `usb-adb.test-helper.mjs` (a `disconnect` event, then
  the device returning as a NEW USB object with the same vendor/product/serial;
  a `device.open` replaced by a held promise for the slow-open cases).
  yume's `AdbBanner` has no string form: use `banner.state` (`bannerText` builds
  the `state::props` text). MTK
  preloader/BROM/download-agent support is **not implemented** (parked); see
  `docs/hardware-parity.md` for every tool's command-by-command status.
- **Qualcomm EDL (USB `05c6:9008`, `edl*.ts`) — read-only commands plus guarded `flash`, `erase`, backup sets, restore and the boot-drive change.** Implemented
  from the Sahara/Firehose wire format; the GPLv3 `edl` tool was read as a
  behavioural reference only and none of its code or tables are used (Cody is
  MIT). Cody ships no loader: the user chooses one as a session artifact.
  `usbProtocolCandidates` (client.ts) offers `edl` only for that vendor/product
  pair with a vendor-class interface that has one bulk IN and one bulk OUT
  endpoint (the 0xff/0xff/0xff triplet alone names far too many devices; the
  Sahara HELLO still decides). Layers: `edl-link.ts` (a buffered pipe over the
  lease: ONE constant 64 KiB bulk-IN request size, because the browser transport
  remembers the largest length ever asked and a smaller request can come back
  with MORE bytes; it also remembers where each USB transfer ended), `edl-sahara.ts`
  (the boot ROM: HELLO, command mode for chip serial / hardware id / public-key
  hash, image transfer of the loader, reset; a ROM needing Sahara above 2 is
  refused; rejections quote the status code), `edl-xml.ts` (Firehose answers come
  from a device nobody vouches for, so this is a bounded scanner, not a parser:
  no DOCTYPE/entities/CDATA, every dimension capped, control characters made
  harmless), `edl-firehose.ts`, `edl-gpt.ts` (CRC32, header and entry checks,
  `evaluateSpan`), `edl-session.ts` (what state is the device in: boot ROM or
  programmer, the recovery ladder, the declared loader upload), `edl-disk.ts`
  (shared reads/saves/hashes and partition lookup), `edl-protect.ts` (which names
  are refused, protected or ordinary), `edl-write.ts` (flash and erase),
  `edl-manifest.ts` (the backup-set manifest: format, strict parser, and every
  check a restore makes against the saved tables), `edl-backup.ts` (backup and
  restore) and `edl.ts` (the flasher). Components: `components/devices/EdlWorkflow.tsx`
  (Commands tab: connect, partition tables, check, reset; Flash tab: `EdlFlash`,
  a partition from the last table read or typed, the chosen file as the image
  with a pad choice, flash and erase; Backup tab: one partition, the whole area
  after a passing check, `EdlBackupSets` for a backup set and a restore from the
  manifests in the session). Nothing in these forms asks for a confirmation or an
  override: the person's own click, or the agent's trust, is the permission, and
  what each operation declares is in its log; `setbootablestoragedrive` has no form and is
  reached through the agent tools. `adviseFlash` is the one decision the Flash
  card makes (protected/refused name, size against the partition, pad); the
  flasher checks it all again.
  - **Writes only inside a grant.** Firehose commands exist only as the closed
    union `FirehoseCommand`, built from validated integers and fixed words, and
    `assertFirehoseXml` parses every document about to be sent. Reading
    (`nop`, `configure` for eMMC, `getstorageinfo`, `read`, `power reset`) needs
    nothing. `program`, `erase` and `setbootablestoragedrive` go out only under a
    `WriteGrant`, and a grant exists only after `grantWrites` declared the exact
    sector ranges (`context.confirm`: logged, and held for the visible countdown if one was asked
    for). The guard then refuses any
    write outside the declared merged ranges, of a kind not declared, in another
    sector size, or in a physical partition other than 0 (so the eMMC boot areas
    and RPMB cannot be addressed at all). patch, peek, poke, digests, `power`
    other than reset and unknown tags are refused under any grant; `patch` is
    deliberately not shipped (a same-unit GPT restore writes the saved sectors
    byte for byte, so nothing needs it). `parseEdlCommand` accepts connect,
    printgpt, check, erase, backup, restore, setbootablestoragedrive and reset.
  - **Flash and erase** (`edl-write.ts`). Target = exact GPT partition name. A
    flash needs an image of exactly the partition's size, or `options.pad`
    `zero`|`ff` to fill the rest (the partition is always written whole). Before
    anything is written the partition is saved, the saved file is checked to
    hold exactly those bytes and the partition is read a second time to agree
    with it (no saved copy = no write); one declaration carries
    the exact sectors and the backup, and the protected boot-chain / radio / identity /
    partition-table names (`edl-protect.ts`) add a PROTECTED note to it (no override, no prompt).
    Names like boot0/boot1/rpmb/mmcblk*boot* and partitions
    that overlap a partition table or another partition are refused with no
    override; where the backup table lives is read from the header in the last
    sector (`backupTableFloor`), not assumed from the primary header, and a header
    whose entry array sits somewhere implausible refuses the write. Writes run in blocks; a cancel lands BETWEEN blocks (the link rides
    a signal that follows the operation's only after `edlTimeouts.cancelGrace`),
    because a programmer left waiting for the rest of a block takes the next
    command for sector data. A failure once a block's data was attempted, even
    part of it, is reported as POSSIBLY MODIFIED with the saved copy's id
    (explicit stage tracking in the block hooks, not a byte count); "nothing was
    written" is said only when no data had gone out. The partition is read back
    and compared by SHA-256:
    a mismatch is reported as POSSIBLY MODIFIED with the id of the saved copy; a
    programmer that will not read back leaves the write UNVERIFIED. An erase
    reports what the partition reads as afterwards (all zero, all 0xFF,
    unchanged, mixed) and never claims a value. Neither sends a loader: run
    Connect first. Flash/erase are emulator-tested only.
  - **Boot drive** (`setBootableDrive` in `edl-write.ts`). `exec setbootablestoragedrive`
    takes the drive number 0-7 as its target (nothing else is accepted), needs a
    running programmer, and declares itself once. The declaration says plainly
    that there is no saved copy (the protocol cannot
    report the setting) and the result is always `verified: false` / UNVERIFIED: a
    NAK is quoted and means it was not applied, a verdict that never arrives after
    the command went out is POSSIBLY CHANGED. Emulator-tested only.
  - **Backup sets and restore** (`edl-backup.ts`, `edl-manifest.ts`). `exec backup`
    (no target; read-only) needs the span check to pass, then saves the primary
    table region (sectors 0 .. end of its entry array), every partition (one
    file each) and the backup table region at the end of the disk, each read a
    second time and required to hash the same, plus a JSON
    manifest that names each by SHA-256 and records the unit: chip serial,
    public-key hash (boot ROM only), eMMC serial and product, disk GUID, sector
    size, measured capacity. The result's SHA-256 is the manifest's: the set's
    id. A set taken while a programmer was already running has no public-key
    hash and says NOT RESTORABLE, as does one holding a partition Cody would
    never write. Bytes outside the tables and partitions, the eMMC boot areas
    and RPMB are not in a set. `exec restore` takes the LOADER as the request's
    file and the manifest as `options.manifestSha256` (a declared risk's digest
    must be the request's own, so the loader owns that slot). It finds every
    saved file with `context.findArtifact(sha256)` (`DeviceArtifactStore.findBySha256`),
    hashes each again, parses the saved tables and requires the manifest to agree
    with them, all before the device is touched. It needs a boot ROM it can
    identify in this very operation (a running programmer is refused): chip
    serial and public-key hash are compared before the loader is declared;
    after `configure` the eMMC serial and product, sector size, capacity and the
    disk GUID of an intact table on the device (primary, else backup; neither
    intact = refused) must match as well. Every region the set covers is then
    read and hashed; a region that already holds the set's bytes is left alone
    (the set is its copy), and what each of the others holds is saved (and must
    hash the same on the second read) before anything is written. ONE
    declaration carries the merged ranges,
    partitions are written in disk
    order, then the backup table, then the primary table last, and each region is
    read back and compared before the next starts. The first mismatch, or a
    programmer that will not read back, stops the restore and the tables are
    written only if every partition verified. An interruption names the regions
    that are done, the one in doubt and those never started. Saved copies of
    overwritten partitions can be flashed back; no command writes saved
    partition tables back. Emulator-tested only.
  - **Actions.** `detect` (Sahara identity; leaves the ROM's re-offered HELLO
    unread so the next operation finds an ordinary device), `exec connect`
    (loader only if the device is still in the boot ROM, after declaring
    the file's SHA-256; `configure`; storage), `exec printgpt` (primary
    AND the real backup table at the end of the disk, both saved byte for byte),
    `exec check` (table span vs. the capacity the programmer reports, the backup
    header in the last sector, the last sector readable), `exec reset`
    (declared; announces the departure), `dump NAME` (one GPT partition) and
    `dump user-area` (only with `options.sectors` equal to the verified count and
    only when the check passes IN THE SAME OPERATION).
  - **Data integrity.** Reads are segmented (16 MiB per `read`) and the raw bytes
    are counted exactly, and three independent guards decide whether a read can
    be trusted. (1) *Alignment* (`FirehoseSession.requireDataEnd`): the last
    byte of the data must coincide with the end of a USB transfer the link
    actually saw (a short packet, or the zero-length packet that follows a
    transfer that filled the read request), so the closing answer is a transfer
    of its own. Data that ends inside a transfer, or whose count was made up with
    the first bytes of the next one (white space in front of the answer, its XML
    declaration, a log line), is refused without looking at what the bytes say. A
    programmer that ends its data transfers with neither a short nor a
    zero-length packet cannot be read from (Cody asks for them with
    `ZLPAwareHost`), and the refusal says so. (2) *Programmer text taken for
    data* (`RawMessageWatch`): alignment cannot see text of the programmer's own
    that arrives as a transfer of its own and completes the byte count, because
    it ends on a transfer end (and it can repeat on every read). So a stretch
    between two ends of the device's transfers - the start and the end of the
    data count - refuses the read, wherever it sits and even when no disk byte
    arrived, when it is (a) nothing but complete documents (read with the
    reader's own rule for what may precede one, `leadBeforeDocument`), or, when
    it is shorter than one sector and its end was marked, (b) nothing but white
    space (the padding in front of an answer) or (c) the start of a document (an
    XML declaration, a tag). (b) and (c) rest on disk data arriving in whole
    sectors; NUL and 0xFF stretches (erased flash) and a sector or more of
    blanks stay data, and so does the same text inside a transfer of data.
    (3) *Two reads*: a copy that later justifies a write - the
    preflash and pre-erase copies, each region a restore overwrites, every region
    of a backup set - is read a second time and the two SHA-256s must agree
    before anything is declared (for a set: before the manifest is
    written); `readsDisagree` is the one refusal. A plain `dump` is read once.
    On top of that the SHA-256 is computed on the wire and compared with the
    artifact store's, and a failed or cancelled read saves nothing. A cancelled
    read leaves data in flight: the next operation's `discover` discards it.
  - **What only hardware can prove.** Everything is emulator evidence. Open
    questions are listed in `docs/hardware-checklist.md` ("Qualcomm EDL"): whether
    the ROM's HELLO survives Cody closing and re-opening the USB device, whether
    the programmer re-enumerates after it starts, the exact framing of XML versus
    raw data on the wire, whether the ROM accepts a reset from command mode,
    whether Android Chrome claims the 9008 interface, and whether browser storage
    can hold a 3.5 GB artifact. Not covered: UFS, NAND/SPI-NOR, other LUNs, the
    eMMC boot areas and RPMB, Sahara 3, memory-debug (900E).
- **Serial bootloaders:** Gecko provides detection/XMODEM framing only until a
  verified readback-capable flash profile exists. STM32 flash is limited to ROM
  PID `0x0410` (STM32F103 medium-density), factory-size discovery, and 1 KiB
  page-aligned backup/program/readback; unknown geometry refuses and every
  program-flash write needs the request to name `allow-bootloader`. STK500 is limited to
  ATmega328P signature `1e950f`, 32 KiB flash, 128-byte pages, application
  `[0,0x7000)`, and its protected top 4 KiB bootloader; bootloader writes need
  `allow-bootloader`. Both retain full physical-footprint escrow/readback.
- **CMSIS-DAP/DAPLink and generic UF2 are not shipped.** WebUSB transport is
  assessed feasible for a future target-specific CMSIS-DAP profile, but there
  is no DAP dependency, generic memory-write/flash operation, or host helper
  here. Generic UF2 copy does not prove programming or retention and has no
  flash capability.

#### Evidence and the optional helper

Browser and fake-transport tests exercise the software guards only. No real browser
grants or physical hardware operations were performed; hardware behavior is **unverified on real hardware**. Follow
`docs/hardware-checklist.md` for the manual, recoverable-device evidence
before treating any protocol as field-verified; it authorizes no destructive
operation, and each real attempt is still the operator's own decision (Cody's
device trust is permission to drive a device, not a go-ahead for a test).

`docs/hardware-host-helper.md` is a design, not a shipped component. A future
optional local helper would be per-user and local-only, signed and bound to one
origin/session/device/protocol, use typed allowlisted vendor invocations (never
shell/PATH passthrough), require native point-of-risk confirmation and
revocation, and enforce the same backup/readback rule. It supplies no current
vendor CLI parity, elevated capability, CMSIS-DAP, or generic UF2 flashing.
