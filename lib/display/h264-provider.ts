import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import puppeteer, { type Browser, type CDPSession, type MouseButton, type Page } from "puppeteer-core";
import type { WebSocket } from "ws";
import {
  CHROMIUM_BASE_ARGS,
  IDLE_DISPOSE_MS,
  MAX_BUFFERED_BYTES,
  MAX_CLIPBOARD_CHARS,
  MAX_DEVICE_SCALE,
  MAX_FRAME_EDGE,
  MAX_INSERT_TEXT_CHARS,
  MIN_DEVICE_SCALE,
  READ_SELECTION_JS,
  RasterWebProvider,
  START_GRACE_MS,
  chromiumPath,
  hardwareRenderer,
  providerState,
  sendJson,
  virtualKeyCode,
  type DisplayProvider,
  type Viewport,
} from "./provider";
import { CHROMIUM_GPU_ARGS, CHROMIUM_SOFTWARE_ARGS, gpuRenderNode } from "../chromium-gpu";
import { attachAppLogCapture, type AppLogDetach } from "../logs/capture";
import type { DisplayClientControl, DisplayRequestV1, DisplayStreamVideo } from "./types";

/**
 * Capture cadence. 30 is the knee: `h264_vaapi` on this UHD 630 sustains 2.97x
 * realtime at 2560x1600 (measured), so 30 fps leaves headroom for a second
 * session and for the CPU-side x11grab read, while 60 would spend it all on
 * frames a dev preview does not need.
 */
const CAPTURE_FPS = 30;
/**
 * One IDR per second. This constant is load-bearing twice over and is NOT a
 * quality knob:
 *  - A client that attaches mid-stream cannot decode anything until an IDR
 *    arrives (WebCodecs sets `[[key chunk required]]` on `configure`), and we
 *    deliberately do not replay a cached IDR — the delta chain after it would be
 *    missing. So this is the worst-case time to first paint for a late joiner.
 *  - It is also the recovery window for a client we had to stop sending deltas
 *    to (see `broadcast`).
 * Measured cost of buying that: 352 kbit/s at g=30 versus 234 at g=60 and 177 at
 * g=120, on a live 2560x1600 UI page at qp 26. A quarter of a megabit to make
 * every join and every recovery sub-second is the right trade; the JPEG rung it
 * replaces spends 33 500 kbit/s.
 */
const GOP_FRAMES = CAPTURE_FPS;
const GOP_MS = 1_000;
/**
 * Constant quantiser, because it is the ONLY rate-control mode the iHD driver
 * on this device exposes: `-rc_mode CBR|VBR|ICQ|QVBR|AVBR` all hard-fail encoder
 * init with "Driver does not support CBR RC mode (supported modes: CQP)", and
 * passing `-b:v`/`-maxrate`/`-bufsize` at all forces a non-CQP mode. That is a
 * happy accident for screen content: with a fixed quantiser the bitrate
 * collapses to near nothing when the page is idle, which is what a dev preview
 * mostly is, instead of paying a constant rate for a static image.
 *
 * 26 measured on this GPU at 2560x1600: 352 kbit/s on a live UI page, 14.3
 * Mbit/s on synthetic full-frame motion — still under half the JPEG rung's
 * 33.5 Mbit/s in the worst case it will never see.
 */
const ENCODER_QP = 26;
/** Encoder profile preference, best first. All three are available on this hardware. */
const PROFILE_PREFERENCE: ReadonlyArray<{ idc: string; profile: string }> = [
  { idc: "64", profile: "high" },
  { idc: "4D", profile: "main" },
  { idc: "42", profile: "constrained_baseline" },
];
/**
 * How long a freshly spawned encoder has to produce its first access unit.
 * Measured first-bytes latency is 169-222 ms (ffmpeg + VAAPI init dominates);
 * anything past this is a wedged pipeline, not a slow one.
 */
const FIRST_AU_TIMEOUT_MS = 8_000;
/** How long an X server (either backend) gets to open its socket, and the poll step. */
const X_READY_TIMEOUT_MS = 6_000;
const X_POLL_MS = 40;
/** Weston has a GL context and a shell to bring up before its own socket appears. */
const WESTON_READY_TIMEOUT_MS = 10_000;
/** How long each child gets to exit on SIGTERM before it is killed outright. */
const ENCODER_GRACE_MS = 1_500;
const X_GRACE_MS = 2_000;
const BROWSER_CLOSE_GRACE_MS = 4_000;
/** Display numbers we will claim. Kept clear of :0 and of the low numbers CI and tooling grab. */
const DISPLAY_MIN = 120;
const DISPLAY_MAX = 160;
/**
 * Age past which a display claim with no X socket behind it is debris rather
 * than a sibling mid-startup. Startup is ~1 s, so this is two orders of margin.
 */
const STALE_CLAIM_MS = 60_000;
/** A forced-keyframe request only restarts the encoder if it looks wedged, at most this often. */
const KEYFRAME_RESTART_COOLDOWN_MS = 2_000;
/**
 * H.264 codes in 16x16 macroblocks, so the encoder would pad any odd capture up
 * to a multiple of 16 and describe the padding with SPS cropping. We align the
 * CAPTURE RECTANGLE instead: coded size then equals captured size, no cropping
 * field is involved, and the <=15px overhang is X root black — static, so it
 * costs no bitrate. The client crops it back off.
 */
const MACROBLOCK = 16;
/**
 * Headroom around the largest surface the session will ever render, so the
 * Chromium window's content box is comfortably bigger than it. Needed on both
 * axes: with no window manager the top of the window carries a decoration that
 * cannot be switched off, and Chromium has been observed to size a window a
 * pixel short of what was asked for. Generous on purpose — the framebuffer is
 * lazily faulted, so unused rows and columns cost address space rather than RAM,
 * and a surface clipped by one pixel would otherwise cost a whole session.
 */
const ROOT_MARGIN = 256;
/**
 * With no window manager, Chromium decides its window is occluded and throttles
 * the renderer: measured on this image, `requestAnimationFrame` never fired at
 * all — a 5 s rAF probe hung for 180 s — until these four were added, after
 * which it ran at 34.7 fps. Anything that animates off rAF, which is most canvas
 * work and most animation libraries, is simply dead without them, and it fails
 * silently because CSS animations keep painting regardless.
 */
const CHROMIUM_X_ARGS = [
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--disable-background-timer-throttling",
  "--disable-features=CalculateNativeWinOcclusion",
];
/**
 * Resize clamps, shared by the `resize` handler and the X root sizing so the two
 * cannot drift: a root smaller than a request the handler accepts would be a
 * surface we could never capture in full.
 */
const RESIZE_MIN_WIDTH = 320;
const RESIZE_MAX_WIDTH = 2560;
const RESIZE_MIN_HEIGHT = 240;
const RESIZE_MAX_HEIGHT = 1600;
/** Origin probe window; must comfortably contain the window decoration. */
const ORIGIN_PROBE_WIDTH = 384;
const ORIGIN_PROBE_HEIGHT = 640;
/**
 * Thickness of the two strips grabbed to measure how much surface Chromium
 * actually rendered. Wide enough to survive a stray column, small enough that
 * both grabs together are a few hundred KB.
 */
const EXTENT_PROBE_THICKNESS = 8;
/**
 * Below this on either axis there is no picture: the encoder itself refuses
 * anything under 32 ("constraints: width 32-4096 height 32-4096"), and a surface
 * that small means the capture is black, not merely smaller than we asked for.
 * This is the line between "adapt" and "this pipeline is broken".
 */
const MIN_SURFACE_EDGE = 32;

/**
 * Full-viewport magenta overlay. It answers the two questions about the render
 * surface that no API answers, both of which are properties of Chromium's own
 * window management:
 *
 *  - WHERE the page's top-left pixel is on the X root. With no window manager
 *    Chromium draws its own decoration (measured: 57 DIP, 113 device px at scale
 *    2, and `--kiosk` does not remove it because there is no WM to grant
 *    fullscreen), and neither `Browser.getWindowForTarget` bounds, nor
 *    `screenX/screenY`, nor `outerHeight - innerHeight` report the content origin.
 *  - HOW MUCH surface there actually is. A device-metrics override is a request,
 *    not a guarantee: the window's content box clips it, and a resize can land
 *    while startup is still in flight, so the surface can legitimately be smaller
 *    than the viewport we last recorded. Measuring means the capture rectangle
 *    describes real pixels rather than intended ones.
 *
 * `overflow: hidden` goes on while the overlay is up so a classic scrollbar
 * cannot shrink the fixed-position containing block and make the surface measure
 * ~15px narrow, which would clip the scrollbar out of every captured frame.
 */
const SENTINEL_SHOW_JS = `(() => {
  let el = document.getElementById("__cody_origin_probe__");
  if (!el) {
    el = document.createElement("div");
    el.id = "__cody_origin_probe__";
    el.style.cssText = "position:fixed;inset:0;background:#ff00ff;z-index:2147483647;pointer-events:none;margin:0";
    document.documentElement.dataset.codyProbeOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    document.documentElement.appendChild(el);
  }
  return true;
})()`;
const SENTINEL_HIDE_JS = `(() => {
  const el = document.getElementById("__cody_origin_probe__");
  if (el) {
    el.remove();
    document.documentElement.style.overflow = document.documentElement.dataset.codyProbeOverflow ?? "";
    delete document.documentElement.dataset.codyProbeOverflow;
  }
  return true;
})()`;
/** Two composited frames after the override, the surface is at its new size. */
const SETTLE_JS = "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))";
/** Long enough for a composited frame of the sentinel to reach the X root. */
const SENTINEL_PAINT_MS = 120;

/**
 * Whether this host can serve the video rung at all. Two independent axes, both
 * published by `docker/entrypoint.sh`'s boot probe and never probed here — the
 * same rule `gpuRenderNode()` follows, so exactly one detector exists in the
 * system and a host that never runs that entrypoint stays on JPEG by leaving
 * them unset. Something has to be able to HOST the page (an X backend) and
 * something has to be able to ENCODE it; either one missing means the session is
 * constructed as a plain `RasterWebProvider` rather than as a pipeline whose only
 * possible outcome is degrading into one.
 *
 * `h264_vaapi` is the only encoder implemented here. A future NVENC rung is a
 * different argv, not a different string in this check.
 */
export function h264Available(): boolean {
  return process.env.CODY_GPU_ENCODER?.trim() === "h264_vaapi" && backendChain().length > 0;
}

function encoderDevice(): string | null {
  const device = process.env.CODY_GPU_ENCODER_DEVICE?.trim() || gpuRenderNode();
  return device ? device : null;
}

function ffmpegPath(): string {
  return process.env.CODY_FFMPEG_BIN?.trim() || "ffmpeg";
}

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/**
 * Signals a child's whole process GROUP. Every child here is spawned detached
 * precisely so this is possible: a negated pid names the child AND anything it
 * forked, which is the only handle that reaches a helper we never spawned
 * ourselves. Falling back to the child alone covers a host where `setsid` did not
 * take, where the parent is still better than nothing.
 */
function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* already gone; there is nothing to do */ }
  }
}

/**
 * SIGTERM the child's process group, then SIGKILL it if the child is still there.
 * Every exit path in this provider goes through here on purpose: a leaked Xvfb,
 * Chromium or ffmpeg on a long-lived host is a real cost, so "best effort" is not
 * good enough for any of the three.
 *
 * The GROUP rather than the child, and that distinction was measured. weston
 * under its default shell forks `weston-desktop-shell` and `weston-keyboard` and
 * does NOT take them with it, so signalling weston alone left both behind on
 * every single teardown: 47 orphaned pairs from one evening of testing, each one
 * reparented onto PID 1 and stuck there for the life of the container. Both are
 * ordinary clients that install no SIGTERM handler, so reaching them at all is
 * the entire fix — they were never ignoring a signal, they were never being sent
 * one.
 */
async function terminate(child: ChildProcess, graceMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const { promise, resolve } = Promise.withResolvers<void>();
  const hard = setTimeout(() => { signalGroup(child, "SIGKILL"); resolve(); }, graceMs);
  // The child's own exit clears the escalation, which is correct even though a
  // group member could in principle outlive it: once node has reaped the leader
  // its pid is free for reuse, and a negated pid sent after that could name a
  // stranger's group. A straggler is hypothetical; killing an unrelated process
  // would not be.
  child.once("exit", () => { clearTimeout(hard); resolve(); });
  signalGroup(child, "SIGTERM");
  await promise;
}

/** A spawned child plus the best available account of why it is unhappy. */
interface TrackedChild {
  child: ChildProcess;
  /**
   * Non-empty only when the child could not be spawned AT ALL. Kept separate
   * from `problem` because a healthy weston narrates its whole startup on
   * stderr, so "wrote to stderr" is not a failure signal on any of these.
   */
  failure: () => string;
  /** The spawn failure if there was one, else the last line it wrote to stderr. */
  problem: () => string;
}

/**
 * The single spawn point for every child in this file, which is what lets the two
 * process-hygiene rules below be invariants instead of conventions.
 *
 * 1. `detached: true`, always — one process group per child, so `terminate` can
 *    name the child and anything it forked with one negated pid. It also keeps
 *    these children OUT of the server's own group, which is what makes that
 *    negated pid safe to send in the first place.
 * 2. `setpriv --pdeathsig SIGKILL` — the kernel kills the child if this process
 *    dies without running any teardown at all. That is the one case no code of
 *    ours can cover, because on SIGKILL no handler runs, and it is not
 *    theoretical: measured on this host, `kill -9` on the server mid-stream left
 *    21 live strays behind (weston, Xwayland and a nine-process Chromium tree,
 *    every one reparented onto PID 1), and zero with this in place.
 *
 * Both are needed and neither implies the other: a group kill cannot run if we
 * are killed outright, and a parent-death signal only ever reaches OUR children,
 * never a helper one of them forked. Chromium is the deliberate exception to
 * both — puppeteer spawns it, already detached, and `closeBrowser` group-kills it
 * — and it needs no parent-death signal because it exits by itself the moment
 * Xwayland is gone, which the same measurement confirmed.
 *
 * Whether the wrapper works here is `docker/entrypoint.sh`'s boot probe to answer
 * and never ours, the same rule the binaries above follow; empty loses rule 2 and
 * nothing else. It does move one diagnostic: a missing or unexecutable COMMAND
 * then arrives as setpriv exiting non-zero with its reason on stderr instead of
 * as an `error` event here, which `problem()` reports either way and
 * `waitForPath` already reads as a failure.
 *
 * The `error` listener stays mandatory and is not defensive: an unhandled `error`
 * event on a ChildProcess takes the whole server down with it, Xvfb, weston,
 * Xwayland and ffmpeg are all paths that come from the environment, and setpriv is
 * now one more of them. The correct outcome of a wrong one is a JPEG stream and a
 * log line.
 */
function spawnTracked(command: string, args: string[], options: Parameters<typeof spawn>[2]): TrackedChild {
  const guard = process.env.CODY_SETPRIV_BIN?.trim();
  const child = guard
    ? spawn(guard, ["--pdeathsig", "SIGKILL", command, ...args], { ...options, detached: true })
    : spawn(command, args, { ...options, detached: true });
  let failure = "";
  let stderr = "";
  child.on("error", (cause: Error) => { failure = cause.message; });
  child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-2048); });
  return { child, failure: () => failure, problem: () => failure || stderr.trim().split("\n").pop() || "" };
}

function align(value: number): number {
  return Math.ceil(value / MACROBLOCK) * MACROBLOCK;
}

const START_CODE = Buffer.from([0, 0, 1]);
const EMPTY = Buffer.alloc(0);

/** Index of the next Annex-B start code at or after `from`, or -1. */
function nextStartCode(buffer: Buffer, from: number): number {
  const at = buffer.indexOf(START_CODE, from);
  if (at < 0) return -1;
  // `00 00 00 01` is one four-byte start code, not a stray zero followed by a
  // three-byte one; returning the earlier index keeps the zero off the tail of
  // the access unit we are about to close.
  return at > 0 && buffer[at - 1] === 0 ? at - 1 : at;
}

/**
 * Splits an Annex-B byte stream into access units.
 *
 * The framing rule is not a guess: `h264_vaapi` on this device emits exactly one
 * slice per frame at every size we can ask for (verified 1280x800 through
 * 4096x2560 — VCL NAL count always equals frame count), so a VCL NAL (type 1 or
 * 5) ENDS an access unit, and the non-VCL NALs that precede it (7 SPS, 8 PPS, 6
 * SEI) belong to the unit that follows them. AUD delimiters would have made this
 * explicit, but `-aud 1` on this driver produces a stream that decoders reject
 * ("missing picture in access unit", 3 of 90 frames recovered), so it is off.
 *
 * A chunk boundary is emphatically NOT an access-unit boundary: a `write()` can
 * split a NAL, and a single write can carry SPS+PPS+IDR. Everything is therefore
 * driven off start-code positions, with at most one partial NAL held over.
 */
export class AccessUnitSplitter {
  /** Bytes of the access unit under construction, starting at its first start code. */
  private buffer: Buffer = EMPTY;
  private cursor = 0;
  private open = false;
  private vcl = false;
  private key = false;
  /** First four bytes of the most recent SPS NAL: header, profile, constraints, level. */
  latestSps: Buffer | null = null;

  push(chunk: Buffer, emit: (accessUnit: Buffer, key: boolean) => void): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const at = nextStartCode(this.buffer, this.cursor);
      if (at < 0) {
        // Hold back the last two bytes: they may be the head of a start code.
        this.cursor = Math.max(this.cursor, this.buffer.length - 2);
        return;
      }
      const payload = at + (this.buffer[at + 2] === 1 ? 3 : 4);
      // Classification reads the NAL header plus, for an SPS, three more bytes.
      if (payload + 4 > this.buffer.length) { this.cursor = at; return; }
      if (this.open && this.vcl) {
        emit(this.buffer.subarray(0, at), this.key);
        this.buffer = this.buffer.subarray(at);
        this.cursor = 0;
        this.vcl = false;
        this.key = false;
        continue;
      }
      if (!this.open) {
        if (at > 0) this.buffer = this.buffer.subarray(at);
        this.open = true;
        this.cursor = 0;
        continue;
      }
      const type = this.buffer[payload] & 0x1f;
      if (type === 7) this.latestSps = Buffer.from(this.buffer.subarray(payload, payload + 4));
      if (type >= 1 && type <= 5) {
        this.vcl = true;
        if (type === 5) this.key = true;
      }
      this.cursor = payload + 1;
    }
  }
}

/**
 * RFC 6381 codec string for the bitstream actually on the wire. Derived from the
 * SPS rather than from the profile we asked for, because level_idc tracks
 * resolution (measured: 3.2 at 1280x800, 5.0 at 2560x1600, 6.0 at 4096x2560) and
 * the constraint byte is not what a client would guess: High comes out as
 * `640C32`, not the `640033` a client advertises.
 */
function codecFromSps(sps: Buffer): string {
  const hex = (value: number) => value.toString(16).toUpperCase().padStart(2, "0");
  return `avc1.${hex(sps[1])}${hex(sps[2])}${hex(sps[3])}`;
}

/**
 * The H.264 profile_idc values a client says it can decode: the FIRST TWO hex
 * digits of each RFC 6381 string and nothing else. The constraint-flag byte
 * differs between what browsers advertise (`avc1.640033`) and what this encoder
 * emits (`avc1.640C32`), and level_idc is a function of resolution, so comparing
 * either would reject a codec the client handles perfectly well.
 */
function profileIdcs(decoders: readonly string[]): Set<string> {
  const offered = new Set<string>();
  for (const entry of decoders) {
    const match = /^avc[13]\.([0-9a-f]{2})[0-9a-f]{4}$/i.exec(entry.trim());
    if (match) offered.add(match[1].toUpperCase());
  }
  return offered;
}

/** The best profile this hardware can encode that the client also decodes. */
function chooseProfile(decoders: readonly string[]): string | null {
  const offered = profileIdcs(decoders);
  for (const candidate of PROFILE_PREFERENCE) if (offered.has(candidate.idc)) return candidate.profile;
  return null;
}

/**
 * Sentinel magenta at byte offset `i` of a BGRA buffer. Loose thresholds on
 * purpose: the grab is a raw X capture, but the surface underneath may have been
 * composited and the exact bytes are not worth depending on.
 */
function isSentinel(raw: Buffer, i: number): boolean {
  return raw[i] > 200 && raw[i + 1] < 60 && raw[i + 2] > 200;
}

/** Top-left magenta pixel of the sentinel overlay within a BGRA grab, or null. */
function findSentinel(raw: Buffer, width: number, height: number): { x: number; y: number } | null {
  for (let y = 0; y < height; y += 1) {
    const row = y * width * 4;
    for (let x = 0; x < width; x += 1) if (isSentinel(raw, row + x * 4)) return { x, y };
  }
  return null;
}

/** How far the sentinel reaches down a vertical strip, i.e. the surface height. */
function sentinelHeight(strip: Buffer, width: number, height: number): number {
  for (let y = height - 1; y >= 0; y -= 1) {
    const row = y * width * 4;
    for (let x = 0; x < width; x += 1) if (isSentinel(strip, row + x * 4)) return y + 1;
  }
  return 0;
}

/** How far the sentinel reaches along a horizontal strip, i.e. the surface width. */
function sentinelWidth(strip: Buffer, width: number, height: number): number {
  for (let x = width - 1; x >= 0; x -= 1) {
    for (let y = 0; y < height; y += 1) if (isSentinel(strip, (y * width + x) * 4)) return x + 1;
  }
  return 0;
}

/**
 * The largest macroblock-aligned span not exceeding `limit`. Aligning UP is
 * preferred — the overhang is static black that the client crops, and it keeps
 * the coded size at least as large as the content — but a span that would run off
 * the end of what exists aligns down instead, because x11grab refuses a capture
 * area that leaves the root and the encoder refuses one past 4096.
 */
function fitAligned(wanted: number, limit: number): number {
  const up = align(Math.min(wanted, limit));
  return up <= limit ? up : Math.floor(limit / MACROBLOCK) * MACROBLOCK;
}

interface ClientState {
  /**
   * True while this client must not be sent delta access units. Set on attach
   * (a decoder cannot start on a delta), on a `keyframe` request, and whenever
   * backpressure made us skip a unit — see `broadcast` for why skipping one
   * delta forces skipping the rest of the GOP.
   */
  needsKey: boolean;
  /**
   * True for a client that joined a session already encoding a profile it cannot
   * decode. It has been told so; sending it access units after that would only
   * spend bandwidth on bytes it must throw away.
   */
  blocked: boolean;
  onMessage: (raw: unknown, isBinary: boolean) => void;
  onClose: () => void;
}

interface CaptureRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * X display backends, strongest first. `xwayland` is a headless weston whose GL
 * renderer runs on the render node, with a ROOTED Xwayland spawned against it:
 * Chromium then rasterizes on the GPU exactly as the headless rung does
 * (measured `ANGLE (Intel, Mesa Intel(R) UHD Graphics 630 (CFL GT2))`, 60 fps
 * rAF versus 34.7 on Xvfb). `xvfb` keeps the page on llvmpipe but still encodes
 * in hardware. Which of them exists is `docker/entrypoint.sh`'s boot probe to
 * answer, never ours — the same rule `gpuRenderNode()` follows — so an unset
 * variable means "no X here", which lands the session on JPEG.
 */
type XBackend = "xwayland" | "xvfb";

function backendChain(): XBackend[] {
  const raw = process.env.CODY_X_BACKENDS?.trim();
  if (!raw) return [];
  const chain: XBackend[] = [];
  for (const entry of raw.split(",")) {
    const name = entry.trim();
    if ((name === "xwayland" || name === "xvfb") && !chain.includes(name)) chain.push(name);
  }
  return chain;
}

/**
 * `--shell=` for a weston that forks no helper clients, or nothing at all.
 *
 * This exists because of what the DEFAULT shell does: it forks
 * `weston-desktop-shell` and `weston-keyboard`, one pair per session, and a
 * headless compositor hosting one Chromium window has no use for either a desktop
 * or an on-screen keyboard. `terminate` reaches them now, but not spawning them is
 * strictly better than killing them, and measured on this image's weston 10.0.1 it
 * costs exactly nothing: with `kiosk-shell.so` the compositor has ZERO children,
 * while the rooted Xwayland still comes up, `glRenderer` still reads
 * `ANGLE (Intel, Mesa Intel(R) UHD Graphics 630 (CFL GT2), OpenGL ES 3.2 Mesa
 * 22.3.6)`, and a capture of the X root is byte-identical in mean luma and in
 * encoded size.
 *
 * Which module a given weston actually has is `docker/entrypoint.sh`'s boot probe
 * to answer, never ours, for the same reason `backendChain()` defers to it — and
 * here the cost of guessing is specific: weston resolves a relative module name
 * against a compiled-in MODULEDIR, and naming one it does not have is not a
 * warning but an exit, which would fail the xwayland rung and silently demote the
 * session to software rasterization on Xvfb. So the probe publishes an absolute
 * path it has already stat()ed, and empty means this weston gets its default
 * shell and the two helpers — which is exactly why teardown goes by group.
 */
function westonShell(): string[] {
  const shell = process.env.CODY_WESTON_SHELL?.trim();
  return shell ? [`--shell=${shell}`] : [];
}

/**
 * Whether Chromium found hardware GL on a backend, remembered process-wide
 * because the answer is a property of the image rather than of the session and
 * discovering it costs a browser launch. Measured here: yes on `xwayland`, no on
 * `xvfb` — Xvfb has no DRI3, so Mesa's EGL falls back to llvmpipe even with the
 * render node present. The encoder is hardware either way, which is the point of
 * this provider; losing the RASTERIZER is what the xwayland rung buys back.
 */
const gpuUsableByBackend: Partial<Record<XBackend, boolean>> = {};

/** A running X display and everything that has to die with it. */
interface XDisplay {
  backend: XBackend;
  display: string;
  /**
   * Torn down front to back, so the X server goes before the compositor hosting
   * it, and each entry by process GROUP rather than by pid — a compositor's
   * helper clients are in its group and nowhere in this array.
   */
  processes: ChildProcess[];
  /** Our claim on the display number, released on teardown. */
  lock: string;
  /** Wayland socket to unlink, for backends that made one. */
  socket: string | null;
}

/**
 * Claims a display number by creating a directory for it, which is atomic
 * against a sibling session starting in the same millisecond.
 *
 * The claim is only a mutex between STARTING sessions; the X socket, checked
 * first, is the authority on whether a display is actually live. So a claim
 * directory with no socket behind it is debris from a process that was killed
 * mid-teardown, and refusing to reuse it would burn a display number for the
 * lifetime of the container. Such a claim is taken over — but only once it is old
 * enough that it cannot belong to a sibling still in the act of spawning its
 * server, and taking it over refreshes the timestamp so a third session does not
 * make the same judgement about US.
 */
function claimDisplay(): { number: number; lock: string } | null {
  for (let number = DISPLAY_MIN; number < DISPLAY_MAX; number += 1) {
    if (existsSync(`/tmp/.X11-unix/X${number}`) || existsSync(`/tmp/.X${number}-lock`)) continue;
    const lock = `/tmp/.cody-display-${number}`;
    try {
      mkdirSync(lock);
    } catch {
      const claimed = statSync(lock, { throwIfNoEntry: false })?.mtimeMs;
      if (claimed === undefined || Date.now() - claimed < STALE_CLAIM_MS) continue;
      rmSync(lock, { recursive: true, force: true });
      try { mkdirSync(lock); } catch { continue; }
    }
    return { number, lock };
  }
  return null;
}

/**
 * Resolves once `path` exists, or false if the child is gone or the deadline
 * passes. `problem()` is consulted rather than only `exitCode`, because a child
 * that never existed reports an `error` event and keeps a null exit code forever.
 */
async function waitForPath(tracked: TrackedChild, path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { child } = tracked;
    if (child.exitCode !== null || child.signalCode !== null || tracked.failure()) return false;
    // A socket file appears only once its server is accepting connections.
    if (existsSync(path)) return true;
    await delay(X_POLL_MS);
  }
  return false;
}

export class H264WebProvider implements DisplayProvider {
  readonly descriptor = { renderer: "h264", media: ["video/H264"], audio: false, interactive: true } as const;
  readonly requestId: string;
  private request: DisplayRequestV1;
  private sessionId: string;
  private clients = new Map<WebSocket, ClientState>();
  private browser: Browser | null = null;
  private page: Page | null = null;
  private cdp: CDPSession | null = null;
  /** Teardown for the console/network capture feeding lib/logs/ring. */
  private detachLogs: AppLogDetach | null = null;
  private x: XDisplay | null = null;
  private encoder: ChildProcess | null = null;
  private splitter = new AccessUnitSplitter();
  private starting: Promise<void> | null = null;
  private startTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private firstAuTimer: NodeJS.Timeout | null = null;
  private disposed = false;
  /** Set once the session has given up on H.264; `raster` then owns every client. */
  private raster: RasterWebProvider | null = null;
  private viewport: Viewport = { width: 1280, height: 800, deviceScaleFactor: 1 };
  /** Whether a client has told us its real viewport yet; half of the start gate. */
  private viewportSeen = false;
  /**
   * Density the surface is rendered at. Fixed for the browser's lifetime for the
   * same reason as the raster provider: measured on this path, the PHYSICAL size
   * of the rendered surface is the emulated viewport times the LAUNCH
   * `--force-device-scale-factor`, not times the emulated `deviceScaleFactor`
   * (verified at emulated 1, 2 and 3 against a launch flag of 2 — the pixels
   * followed the launch flag every time). So honouring a later density change
   * still means relaunching Chromium, and we still refuse to trade the user's
   * page state for it.
   */
  private captureScale = 1;
  /** X root size; large enough for the session's ceiling so a resize never restarts it. */
  private rootWidth = 0;
  private rootHeight = 0;
  /** Where the page's top-left pixel lives on the root, measured at startup. */
  private origin: { x: number; y: number } = { x: 0, y: 0 };
  /**
   * How much surface the page actually renders, measured rather than assumed.
   * Starts at the encoder's ceiling so the very first `setRect` is bounded only by
   * the root, until a real measurement replaces it.
   */
  private surface = { width: MAX_FRAME_EDGE, height: MAX_FRAME_EDGE };
  /** Viewport the surface was last sized to; see `applyViewport`. */
  private applied: Viewport | null = null;
  private rect: CaptureRect | null = null;
  /** Codec strings the first client verified with `VideoDecoder.isConfigSupported`. */
  private decoders: readonly string[] | null = null;
  private profile: string | null = null;
  /** Pending `video` message; cleared on encoder restart so the next AU re-sends it. */
  private video: DisplayStreamVideo | null = null;
  /** Bumped on every encoder spawn so a stale process's events are ignored. */
  private generation = 0;
  private encoderStopping = false;
  private restarting: Promise<void> | null = null;
  private lastKeyAt = 0;
  private lastRestartAt = 0;
  /** Diagnostics for the live encoder, so a failure reports ffmpeg's own words. */
  private encoderProblem: (() => string) | null = null;

  constructor(sessionId: string, request: DisplayRequestV1) {
    this.sessionId = sessionId;
    this.request = request;
    this.requestId = request.id;
  }

  attach(socket: WebSocket): void {
    // Post-degrade sockets belong to the raster provider, which is also the one
    // registered for this session; this branch only catches an in-flight attach.
    if (this.raster) { this.raster.attach(socket); return; }
    if (this.disposed) { socket.close(1011, "Display disposed"); return; }
    clearTimeout(this.idleTimer ?? undefined);
    this.idleTimer = null;
    const state: ClientState = {
      needsKey: true,
      blocked: false,
      onMessage: (raw: unknown, isBinary: boolean) => {
        if (isBinary) return;
        const payload = Array.isArray(raw) ? Buffer.concat(raw as Buffer[]) : Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
        if (payload.byteLength > 64 * 1024) return;
        try {
          this.control(socket, JSON.parse(payload.toString("utf8")) as DisplayClientControl).catch(() => { /* input races with navigation are non-fatal */ });
        } catch { /* invalid controls are ignored */ }
      },
      onClose: () => this.detach(socket),
    };
    this.clients.set(socket, state);
    sendJson(socket, { type: "hello", version: 1, renderer: "h264", media: "video/H264", input: ["pointer", "keyboard", "resize", "reload", "clipboard"], requestId: this.request.id });
    sendJson(socket, { type: "state", state: this.rect ? "ready" : "connecting" });
    // A client joining a running stream needs the decoder config before its
    // first access unit, exactly like the first one did.
    if (this.video) sendJson(socket, this.video);
    socket.on("message", state.onMessage);
    socket.once("close", state.onClose);
    if (this.starting === null && this.startTimer === null) {
      this.startTimer = setTimeout(() => {
        this.startTimer = null;
        // The grace ran out with no `capabilities`, so nothing has told us this
        // client can decode video. Treat silence as "cannot": the floor works
        // for every client, and a wrong guess here shows a dead canvas.
        if (this.decoders === null) { this.degrade("client did not advertise a video decoder"); return; }
        this.starting ??= this.start();
      }, START_GRACE_MS);
    }
  }

  /**
   * Starts once BOTH halves of the gate are in: a decoder profile we can encode,
   * and the client's viewport. Waiting for the viewport is not politeness — the
   * density in it decides `--force-device-scale-factor`, which is a LAUNCH flag,
   * so starting on the `capabilities` message alone (which arrives in the same
   * tick, just first) pins the whole session to 1x and streams a quarter of the
   * pixels the client asked for.
   */
  private maybeStart(): void {
    if (this.starting !== null || this.disposed || this.raster) return;
    if (this.profile === null || !this.viewportSeen) return;
    clearTimeout(this.startTimer ?? undefined);
    this.startTimer = null;
    this.starting = this.start();
  }

  private async start(): Promise<void> {
    try {
      const device = encoderDevice();
      if (!device) throw new Error("no VAAPI device for the encoder");
      // Density is a launch property here as well (see `captureScale`), and the
      // encoder refuses outright above 4096 on either axis ("Hardware does not
      // support encoding at size 5120x3200, constraints: width 32-4096 height
      // 32-4096"), so the clamp has to hold before anything is spawned.
      const fit = Math.min(MAX_FRAME_EDGE / this.viewport.width, MAX_FRAME_EDGE / this.viewport.height);
      this.captureScale = Math.round(Math.max(MIN_DEVICE_SCALE, Math.min(this.viewport.deviceScaleFactor, fit)) * 100) / 100;
      // One root for the session, sized to the largest surface the resize clamps
      // in `control` can ever ask for, PLUS margin, so ordinary growth is a
      // viewport override and an encoder restart — never a display restart, which
      // would take Chromium and the user's page state down with it.
      //
      // The arithmetic, deliberately: RESIZE_MAX x captureScale is the biggest
      // surface a legal `resize` can request; MAX_FRAME_EDGE caps it because the
      // encoder refuses anything wider or taller than 4096 ("Hardware does not
      // support encoding at size 5120x3200, constraints: width 32-4096 height
      // 32-4096"); ROOT_MARGIN on top covers the window decoration's offset and
      // any pixel a backend rounds off. Bigger costs nothing to render because the
      // window is sized explicitly rather than filling the root with `--kiosk`,
      // and the framebuffer is lazily faulted, so the margin is only address space.
      this.rootWidth = align(Math.min(MAX_FRAME_EDGE, Math.ceil(RESIZE_MAX_WIDTH * this.captureScale))) + ROOT_MARGIN;
      this.rootHeight = align(Math.min(MAX_FRAME_EDGE, Math.ceil(RESIZE_MAX_HEIGHT * this.captureScale))) + ROOT_MARGIN;
      await this.startDisplay();
      if (this.disposed) return;
      this.browser = await this.launchBrowser();
      if (this.disposed) { await this.closeBrowser(); return; }
      await this.grantClipboard();
      this.page = await this.adoptCaptureTarget(this.browser);
      this.cdp = await this.page.createCDPSession();
      // Same capture as the raster rung, at the same point in the lifecycle:
      // page adopted, nothing navigated yet. It runs on its own CDP session, so
      // it neither sees nor disturbs the screencast one above.
      this.detachLogs = await attachAppLogCapture(this.sessionId, this.page);
      // Read the root BEFORE any device-metrics override exists, so `screen`
      // unambiguously reports the X screen rather than an emulated viewport.
      await this.measureRoot();
      // Ask for more surface than the window can hold, so the one probe below
      // measures the window's content box rather than this client's viewport.
      // Everything after this can then resize by arithmetic alone.
      await this.applyCeilingViewport();
      if (this.page.url() !== this.request.source.url) {
        await this.page.goto(this.request.source.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      } else {
        await this.page.waitForFunction("document.readyState !== 'loading'", { timeout: 30_000 }).catch(() => { /* a page that never settles still streams */ });
      }
      // The clipboard API refuses to run in an unfocused document, and with no
      // window manager nothing hands out focus on its own.
      await this.page.bringToFront().catch(() => { /* focus is best-effort */ });
      await this.probeSurface();
      if (this.disposed) return;
      await this.applyViewport();
      this.setRect();
      await this.startEncoder(device);
      for (const client of this.clients.keys()) sendJson(client, { type: "state", state: "ready" });
      // A resize can land at any point during the ~2s above, and the surface was
      // sized against whichever viewport was current when `applyViewport` ran.
      // Honour the newer one now rather than streaming a stale size all session.
      if (this.viewportStale) await this.reconfigure();
    } catch (error) {
      this.degrade(error instanceof Error ? error.message : "the H.264 pipeline did not start");
    }
  }

  /**
   * Walks the backend chain the boot probe published, strongest first, and stops
   * at the first display that comes up. Every downgrade is logged AND reported to
   * the clients, because "your preview is software-rasterized now" is real
   * information; a chain that runs out throws, which lands the session on JPEG.
   */
  private async startDisplay(): Promise<void> {
    const chain = backendChain();
    if (chain.length === 0) throw new Error("no X backend is available");
    const failures: string[] = [];
    for (const backend of chain) {
      const claim = claimDisplay();
      if (!claim) { failures.push("every X display number is taken"); break; }
      try {
        this.x = backend === "xwayland" ? await this.startXwayland(claim) : await this.startXvfb(claim);
      } catch (error) {
        const reason = error instanceof Error ? error.message : `${backend} did not start`;
        failures.push(`${backend}: ${reason}`);
        console.log(`[Cody] display: X backend ${backend} unavailable (${reason})`);
        for (const client of this.clients.keys()) sendJson(client, { type: "state", state: "connecting", message: `${backend} unavailable: ${reason}` });
        rmSync(claim.lock, { recursive: true, force: true });
        continue;
      }
      const owner = this.x;
      for (const child of owner.processes) {
        child.once("exit", () => {
          if (this.x === owner && !this.disposed) this.degrade("the X display exited");
        });
      }
      return;
    }
    throw new Error(failures.join("; "));
  }

  private async startXvfb(claim: { number: number; lock: string }): Promise<XDisplay> {
    const display = `:${claim.number}`;
    const xvfb = spawnTracked(process.env.CODY_XVFB_BIN?.trim() || "Xvfb", [
      display, "-screen", "0", `${this.rootWidth}x${this.rootHeight}x24`, "-nolisten", "tcp", "-noreset", "-dpi", "96",
    ], { stdio: ["ignore", "ignore", "pipe"] });
    if (await waitForPath(xvfb, `/tmp/.X11-unix/X${claim.number}`, X_READY_TIMEOUT_MS)) {
      return { backend: "xvfb", display, processes: [xvfb.child], lock: claim.lock, socket: null };
    }
    signalGroup(xvfb.child, "SIGKILL");
    throw new Error(xvfb.problem() || "Xvfb did not start");
  }

  /**
   * Headless weston plus a ROOTED Xwayland on top of it. Two processes, and the
   * rootedness is the whole point: weston's own `--xwayland` module runs Xwayland
   * ROOTLESS, where the X root window has no content at all and x11grab captures
   * pure black from a display whose Chromium is demonstrably alive (measured: a
   * 35.7 kbit/s stream that decodes to all zeros, and a full-root grab of
   * 56 MB in which every byte is 0). Spawning Xwayland ourselves with an explicit
   * `:N` gives a real root drawable and pins the display number, so two sessions
   * cannot collide.
   *
   * weston 10's flag dialect is not weston 12's: the backend is
   * `headless-backend.so`, the GL switch is a bare `--use-gl` (`--renderer=gl`
   * does not exist), and the screen size is the backend's `--width`/`--height`.
   * No render node is named anywhere: weston's EGL device platform finds it
   * (`EGL_EXT_device_drm_render_node`), which is how the page ends up on the GPU.
   * `--no-config` and `westonShell()` are not the same lever and both are wanted:
   * the first keeps a stray weston.ini on the host out of our session, the second
   * replaces the shell module whose only job here would be to fork two helper
   * clients we have no use for.
   */
  private async startXwayland(claim: { number: number; lock: string }): Promise<XDisplay> {
    const runtimeDir = process.env.CODY_X_RUNTIME_DIR?.trim() || process.env.XDG_RUNTIME_DIR?.trim() || "/run/cody-x";
    // The entrypoint makes this at boot; a dev shell has not, and weston refuses
    // to start without a 0700 runtime dir.
    mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
    const socketName = `wayland-cody-${claim.number}`;
    const env = { ...process.env, XDG_RUNTIME_DIR: runtimeDir };
    const weston = spawnTracked(process.env.CODY_WESTON_BIN?.trim() || "weston", [
      "--backend=headless-backend.so", "--use-gl",
      `--width=${this.rootWidth}`, `--height=${this.rootHeight}`,
      `--socket=${socketName}`, "--no-config", "--idle-time=0",
      ...westonShell(),
    ], { env, stdio: ["ignore", "ignore", "pipe"] });
    const socket = `${runtimeDir}/${socketName}`;
    if (!(await waitForPath(weston, socket, WESTON_READY_TIMEOUT_MS))) {
      signalGroup(weston.child, "SIGKILL");
      throw new Error(weston.problem() || "weston did not start");
    }
    const display = `:${claim.number}`;
    const xwayland = spawnTracked(process.env.CODY_XWAYLAND_BIN?.trim() || "Xwayland", [
      display, "-noreset", "-nolisten", "tcp",
    ], { env: { ...env, WAYLAND_DISPLAY: socketName }, stdio: ["ignore", "ignore", "pipe"] });
    if (await waitForPath(xwayland, `/tmp/.X11-unix/X${claim.number}`, X_READY_TIMEOUT_MS)) {
      // Xwayland dies with its compositor, so it is killed first on teardown.
      return { backend: "xwayland", display, processes: [xwayland.child, weston.child], lock: claim.lock, socket };
    }
    const reason = xwayland.problem() || "Xwayland did not start";
    signalGroup(xwayland.child, "SIGKILL");
    await terminate(weston.child, X_GRACE_MS);
    throw new Error(reason);
  }

  /**
   * The X root's real size, read off the page rather than assumed from what we
   * asked the backend for: `screen` is reported in CSS pixels, so times the
   * launch density it is the root in device pixels. Backends have been observed
   * to hand out a screen a pixel short of the request, and the capture rectangle
   * is clamped against this.
   */
  private async measureRoot(): Promise<void> {
    const page = this.page;
    if (!page) return;
    const screen = await page.evaluate("[screen.width, screen.height]").catch(() => null) as [number, number] | null;
    if (!screen) return;
    this.rootWidth = Math.floor(screen[0] * this.captureScale);
    this.rootHeight = Math.floor(screen[1] * this.captureScale);
  }

  /**
   * Same fail-safe shape as the raster provider's launch — try the GPU flags,
   * believe `glRenderer` over Chromium's feature table, relaunch on software if
   * it is lying — with three differences forced by the X display: `headless` is
   * off (there has to be a window for x11grab to capture), the anti-throttling
   * flags come along, and the outcome is remembered PER BACKEND, because on Xvfb
   * the answer is always no and paying two launches per session to rediscover
   * that is waste, while on weston it is always yes.
   *
   * `--force-device-scale-factor` survives both branches for the same reason it
   * does there: it is what decides the captured surface's density.
   */
  private async launchBrowser(): Promise<Browser> {
    const backend = this.x?.backend;
    const density = `--force-device-scale-factor=${this.captureScale}`;
    // The window is launched big enough for the biggest surface this session can
    // render and is never resized, because CDP `Browser.setWindowBounds` is
    // unreliable with no window manager: measured, a 900x600 request produced an
    // 800x600 viewport and a second call did not land at all. Resizes move the
    // RENDER SURFACE inside this window instead (see `applyViewport`).
    // `--window-size` is in DIP, hence the division.
    const window = [
      `--window-size=${Math.floor(this.rootWidth / this.captureScale)},${Math.floor(this.rootHeight / this.captureScale)}`,
      "--window-position=0,0",
      `--app=${this.request.source.url}`,
    ];
    const node = gpuRenderNode();
    if (node && backend && gpuUsableByBackend[backend] !== false) {
      let candidate: Browser | null = null;
      let downgrade = "";
      try {
        candidate = await this.launch([...CHROMIUM_GPU_ARGS, density, ...window]);
        const renderer = await hardwareRenderer(candidate);
        if (renderer) {
          gpuUsableByBackend[backend] = true;
          console.log(`[Cody] display: H.264 source on ${backend} using GPU rasterization on ${node} — ${renderer}`);
          return candidate;
        }
        downgrade = "GPU process reported a software renderer";
      } catch (error) {
        downgrade = error instanceof Error ? error.message.slice(0, 200) : "Chromium did not start with GPU flags";
      }
      await candidate?.close().catch(() => { /* nothing left to salvage */ });
      gpuUsableByBackend[backend] = false;
      console.log(`[Cody] display: H.264 source on ${backend} cannot rasterize on ${node} (${downgrade}) — software rasterization, hardware encode`);
      for (const client of this.clients.keys()) sendJson(client, { type: "state", state: "connecting", message: "software rasterization on this display backend" });
    }
    return this.launch([...CHROMIUM_SOFTWARE_ARGS, density, ...window]);
  }

  private launch(args: string[]): Promise<Browser> {
    return puppeteer.launch({
      executablePath: chromiumPath(),
      headless: false,
      env: { ...process.env, DISPLAY: this.x?.display ?? ":0" },
      args: [...CHROMIUM_BASE_ARGS, ...CHROMIUM_X_ARGS, ...args],
    });
  }

  private async grantClipboard(): Promise<void> {
    const browser = this.browser;
    if (!browser) return;
    try {
      const origin = new URL(this.request.source.url).origin;
      await browser.defaultBrowserContext().overridePermissions(origin, ["clipboard-read", "clipboard-sanitized-write"]);
    } catch { /* clipboard degrades to empty reads; never block the stream on it */ }
  }

  /**
   * Adopts the page whose X window x11grab is going to capture, and closes every
   * other page in the browser.
   *
   * This is enforced rather than assumed because the failure it prevents is
   * INVISIBLE: input is dispatched to `this.page` over CDP while frames come from
   * whatever window is on the X root, so a second window means a stream that
   * looks perfect and ignores every click. Two things could produce one. Puppeteer
   * hands Chromium a positional `about:blank` whenever every argument it was given
   * starts with `-`, which is exactly our argv (confirmed in a live process:
   * `about:blank` at argv[9], `--app=` at argv[25]); Chromium 151 discards it,
   * because `--app=` returns from the startup path before the URL list is opened
   * (confirmed on both backends: one page target, one large X window). That is a
   * fact about today's Chromium, not a guarantee — and `browser.newPage()`, which
   * this replaces, opened such a window on purpose.
   *
   * Which page is adopted is decided by window geometry first and creation order
   * second. `--window-position=0,0` and a `--window-size` covering the whole root
   * make the startup window the largest one at the origin, so a genuinely smaller
   * helper can never win. Geometry alone is NOT enough, though, and that was
   * measured rather than reasoned: a `browser.newPage()` window on the same
   * display reports the SAME bounds as the startup window (2175x1727+0,0 for both,
   * on a scratch Xvfb), so the tie is real and is broken by creation order —
   * `browser.pages()` enumerates targets in the order Chromium registered them,
   * and `--app=` opens its window before anything else can. Closing every other
   * page is what makes the outcome safe even if that order ever changed: one page
   * left means one window on the root, so the adopted surface is the captured one
   * by construction. `probeSurface` then proves it from the other end, by finding
   * a sentinel painted BY THIS PAGE in a real capture of the root — which is why a
   * wrong adoption ends the session instead of streaming a dead surface.
   */
  private async adoptCaptureTarget(browser: Browser): Promise<Page> {
    await browser.waitForTarget((candidate) => candidate.type() === "page", { timeout: 20_000 });
    const ranked: Array<{ page: Page; area: number; offset: number; born: number; where: string }> = [];
    for (const page of await browser.pages()) {
      const session = await page.createCDPSession();
      // A window whose bounds cannot be read cannot be the capture target, but it
      // is still a stray to be closed, so it is ranked last rather than dropped.
      const bounds = await session.send("Browser.getWindowForTarget").then((result) => result.bounds).catch(() => null);
      await session.detach().catch(() => { /* the page may already be gone */ });
      const width = bounds?.width ?? 0;
      const height = bounds?.height ?? 0;
      const left = bounds?.left ?? 0;
      const top = bounds?.top ?? 0;
      ranked.push({ page, area: width * height, offset: Math.abs(left) + Math.abs(top), born: ranked.length, where: `${width}x${height}+${left},${top} ${page.url() || "about:blank"}` });
    }
    ranked.sort((a, b) => b.area - a.area || a.offset - b.offset || a.born - b.born);
    const [captured, ...strays] = ranked;
    if (!captured) throw new Error("Chromium opened no page to capture");
    for (const stray of strays) {
      console.log(`[Cody] display: H.264 closing stray Chromium window ${stray.where}`);
      await stray.page.close().catch(() => { /* a window that is already gone needs nothing */ });
    }
    console.log(`[Cody] display: H.264 input target is the captured window ${captured.where} (${ranked.length} page target${ranked.length === 1 ? "" : "s"} at launch)`);
    return captured.page;
  }

  /**
   * Sizes the rendered surface. The window is untouched; only the emulated
   * metrics move. What was applied is remembered, because the surface is sized
   * from THIS snapshot while `viewport` can move on underneath — a client resize
   * lands whenever it likes, including in the middle of startup — and the caller
   * needs to know whether it is still current.
   */
  private async applyViewport(): Promise<void> {
    const page = this.page;
    if (!page) return;
    const target: Viewport = { ...this.viewport };
    await page.setViewport({ width: target.width, height: target.height, deviceScaleFactor: this.captureScale });
    await page.evaluate(SETTLE_JS).catch(() => { /* a page without rAF still resizes */ });
    this.applied = target;
  }

  /**
   * Asks for a surface as large as the whole X root. The window cannot possibly
   * satisfy it — its content box is the root minus the decoration — so what gets
   * rendered IS the content box, which is what `probeSurface` is there to measure.
   * `applied` is deliberately left alone: this is not a client's viewport, and the
   * real one is applied straight after the probe.
   */
  private async applyCeilingViewport(): Promise<void> {
    const page = this.page;
    if (!page) return;
    await page.setViewport({
      width: Math.floor(this.rootWidth / this.captureScale),
      height: Math.floor(this.rootHeight / this.captureScale),
      deviceScaleFactor: this.captureScale,
    });
    await page.evaluate(SETTLE_JS).catch(() => { /* a page without rAF still resizes */ });
  }

  /** True when a resize arrived after the surface was last sized to a viewport. */
  private get viewportStale(): boolean {
    const applied = this.applied;
    return applied !== null && (applied.width !== this.viewport.width || applied.height !== this.viewport.height);
  }

  /**
   * Locates the page on the X root and measures the largest surface the window
   * can ever hold. Run ONCE per session, deliberately: the Chromium window is
   * created at the root's size and never resized afterwards (CDP
   * `Browser.setWindowBounds` is unreliable with no window manager), so its
   * content box is a constant, and so is the decoration inset above it. Measuring
   * the ceiling here rather than the current size is what keeps every later resize
   * to one CDP call and an encoder restart instead of three x11grab probes — the
   * difference between a ~0.5 s and a ~3 s reconfigure.
   *
   * Both answers have to come from real captures because both are properties of
   * Chromium's window management that no API reports (see SENTINEL_SHOW_JS). To
   * make the measurement describe the CEILING, the caller asks for a viewport
   * larger than the window can satisfy; what comes back is the content box.
   *
   * Nothing here treats "smaller than requested" as a failure. A device-metrics
   * override is a request, not a guarantee, and clamping to what exists is always
   * better than trading a 0.45 Mbit/s stream that is a few pixels short for a
   * 33 Mbit/s one that is not. Only a surface with no picture in it at all (see
   * MIN_SURFACE_EDGE) means the pipeline is broken rather than merely constrained.
   */
  private async probeSurface(): Promise<void> {
    const page = this.page;
    if (!page) throw new Error("no page to capture");
    await page.evaluate(SENTINEL_SHOW_JS);
    try {
      const probeWidth = Math.min(this.rootWidth, ORIGIN_PROBE_WIDTH);
      const probeHeight = Math.min(this.rootHeight, ORIGIN_PROBE_HEIGHT);
      let found: { x: number; y: number } | null = null;
      for (let attempt = 0; attempt < 3 && !found; attempt += 1) {
        await delay(SENTINEL_PAINT_MS);
        found = findSentinel(await this.grab(0, 0, probeWidth, probeHeight), probeWidth, probeHeight);
      }
      if (!found) {
        // Both shipping backends put the window in the top-left corner, so the
        // cheap probe above is the normal path. A backend that places it
        // elsewhere should still work rather than lose the whole rung, and one
        // full-root grab in a path that has already failed is worth that.
        found = findSentinel(await this.grab(0, 0, this.rootWidth, this.rootHeight), this.rootWidth, this.rootHeight);
      }
      if (!found) throw new Error("could not find the page on the X display");
      this.origin = found;
      // Two thin strips through the overlay: the last magenta pixel on each axis
      // is where the window's content box really ends.
      const spanWidth = this.rootWidth - found.x;
      const spanHeight = this.rootHeight - found.y;
      const thickness = Math.min(EXTENT_PROBE_THICKNESS, spanWidth, spanHeight);
      const column = await this.grab(found.x, found.y, thickness, spanHeight);
      const row = await this.grab(found.x, found.y, spanWidth, thickness);
      this.surface = {
        width: sentinelWidth(row, spanWidth, thickness),
        height: sentinelHeight(column, thickness, spanHeight),
      };
    } finally {
      await page.evaluate(SENTINEL_HIDE_JS).catch(() => { /* the overlay dies with the page anyway */ });
    }
    if (this.surface.width < MIN_SURFACE_EDGE || this.surface.height < MIN_SURFACE_EDGE) {
      throw new Error(`the page rendered only ${this.surface.width}x${this.surface.height} on the X display`);
    }
    console.log(`[Cody] display: H.264 window content box ${this.surface.width}x${this.surface.height} at +${this.origin.x},${this.origin.y} on ${this.x?.display} (root ${this.rootWidth}x${this.rootHeight})`);
  }

  /**
   * The capture rectangle: the requested surface, clamped to what was measured,
   * to what is left of the root, and to the encoder's 4096 wall, then aligned to
   * macroblocks. The `video` message reports exactly these numbers, so a clamped
   * frame is described honestly rather than silently mismatched.
   *
   * The measured surface is rounded UP to a macroblock before it is used as a
   * limit, because a shortfall smaller than one macroblock is not a real
   * constraint: both backends hand out a surface a pixel short of the request
   * (measured 2560x1639 for a requested 2560x1640, 2880x1799 for 2880x1800), and
   * treating that literally would align DOWN and throw away eight rows of content
   * that Chromium really did render. The codec works in 16x16 blocks either way,
   * and the client crops sub-macroblock overshoot.
   */
  private setRect(): void {
    const wantedWidth = Math.round(this.viewport.width * this.captureScale);
    const wantedHeight = Math.round(this.viewport.height * this.captureScale);
    const width = fitAligned(wantedWidth, Math.min(MAX_FRAME_EDGE, align(this.surface.width), this.rootWidth - this.origin.x));
    const height = fitAligned(wantedHeight, Math.min(MAX_FRAME_EDGE, align(this.surface.height), this.rootHeight - this.origin.y));
    this.rect = { x: this.origin.x, y: this.origin.y, width, height };
    const short = width < wantedWidth || height < wantedHeight;
    console.log(`[Cody] display: H.264 capturing ${this.x?.display} ${width}x${height} at +${this.rect.x},${this.rect.y} of ${this.rootWidth}x${this.rootHeight}${short ? ` (surface ${this.surface.width}x${this.surface.height} is short of the requested ${wantedWidth}x${wantedHeight}; the client scales)` : ""} (viewport ${this.viewport.width}x${this.viewport.height} @${this.captureScale}x)`);
  }

  /** One raw BGRA frame of a root rectangle. Used only by the startup probes. */
  private async grab(x: number, y: number, width: number, height: number): Promise<Buffer> {
    const { promise, resolve, reject } = Promise.withResolvers<Buffer>();
    const { child, problem } = spawnTracked(ffmpegPath(), [
      "-hide_banner", "-loglevel", "error", "-nostdin",
      "-f", "x11grab", "-draw_mouse", "0", "-video_size", `${width}x${height}`, "-i", `${this.x?.display}.0+${x},${y}`,
      "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "bgra", "pipe:1",
    ], { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.once("close", () => {
      const raw = Buffer.concat(chunks);
      if (raw.length < width * height * 4) reject(new Error(problem() || "x11grab produced no frame"));
      else resolve(raw);
    });
    return promise;
  }

  /**
   * Spawns the encoder. Every flag here was measured on this device rather than
   * copied: CQP is the only rate control the driver has, `-async_depth 1` is the
   * shallowest encoder pipeline it accepts, `-flush_packets 1` makes each packet
   * its own write so an access unit reaches the socket as soon as it exists, and
   * `-nostdin` keeps ffmpeg's hands off the server's own stdin. Nothing else
   * helps: `-fflags nobuffer`, `-probesize 32`, `-analyzeduration 0` and
   * `-flags low_delay` were all measured to change nothing on a live x11grab
   * device, where the 170-220 ms to first byte is ffmpeg and VAAPI init.
   *
   * SPS and PPS are repeated before every IDR by the VAAPI encoder itself
   * (verified: every IDR preceded by both, none without), which is what the
   * WebCodecs AVC registration requires of an Annex-B key chunk, so no
   * `-bsf:v dump_extra` is needed.
   */
  private async startEncoder(device: string): Promise<void> {
    const rect = this.rect;
    const display = this.x?.display;
    if (!rect || !display) throw new Error("no capture rectangle");
    const generation = this.generation += 1;
    this.splitter = new AccessUnitSplitter();
    this.video = null;
    this.encoderStopping = false;
    const { child, problem } = spawnTracked(ffmpegPath(), [
      "-hide_banner", "-loglevel", "error", "-nostdin",
      "-f", "x11grab", "-framerate", String(CAPTURE_FPS), "-draw_mouse", "0",
      "-video_size", `${rect.width}x${rect.height}`, "-i", `${display}.0+${rect.x},${rect.y}`,
      "-vaapi_device", device,
      "-vf", "format=nv12,hwupload",
      "-c:v", "h264_vaapi", "-profile:v", this.profile ?? "high",
      "-rc_mode", "CQP", "-qp", String(ENCODER_QP),
      "-g", String(GOP_FRAMES), "-bf", "0", "-async_depth", "1",
      "-flush_packets", "1", "-f", "h264", "pipe:1",
    ], { stdio: ["ignore", "pipe", "pipe"] });
    this.encoder = child;
    this.encoderProblem = problem;
    child.stdout?.on("data", (chunk: Buffer) => {
      if (this.generation !== generation) return;
      this.splitter.push(chunk, (accessUnit, key) => this.publish(accessUnit, key));
    });
    // A missing ffmpeg arrives as `error` and never as an exit; a rejected argv
    // or device arrives as an exit. Both mean this session is not getting video.
    child.once("error", () => {
      if (this.generation === generation) this.degrade(problem() || "the encoder could not be started");
    });
    child.once("exit", (code, signal) => {
      if (this.generation !== generation || this.encoderStopping || this.disposed) return;
      this.degrade(problem() || `the encoder exited (${signal ?? code})`);
    });
    this.armFirstAuTimer();
  }

  private armFirstAuTimer(): void {
    clearTimeout(this.firstAuTimer ?? undefined);
    this.firstAuTimer = setTimeout(() => {
      this.firstAuTimer = null;
      this.degrade(this.encoderProblem?.() || "no encoded frame arrived");
    }, FIRST_AU_TIMEOUT_MS);
  }


  private publish(accessUnit: Buffer, key: boolean): void {
    if (this.disposed || this.raster) return;
    if (this.firstAuTimer) { clearTimeout(this.firstAuTimer); this.firstAuTimer = null; }
    if (key) this.lastKeyAt = Date.now();
    if (this.video === null) {
      const sps = this.splitter.latestSps;
      const rect = this.rect;
      // A decoder cannot be configured without the codec string, and the string
      // comes out of the SPS, so anything before the first SPS is undecodable
      // and is dropped rather than sent.
      if (!sps || !rect) return;
      this.video = { type: "video", codec: codecFromSps(sps), codedWidth: rect.width, codedHeight: rect.height };
      for (const client of this.clients.keys()) sendJson(client, this.video);
    }
    this.broadcast(accessUnit, key);
  }

  /**
   * Backpressure, which does NOT work the way the JPEG rung's does. There,
   * dropping a frame costs one stale frame; here every delta access unit refers
   * to the ones before it, so dropping a single delta desynchronises the
   * decoder for the rest of the GOP and WebCodecs answers with a `DataError`.
   * So a client that has gone over the buffered-bytes threshold is switched to
   * "needs key": it receives NOTHING until the next IDR, then rejoins cleanly.
   * That drops whole GOPs instead of individual frames, which is the only
   * coherent choice, and it is bounded at one second by GOP_FRAMES rather than
   * by a client-side recovery round trip.
   */
  private broadcast(accessUnit: Buffer, key: boolean): void {
    for (const [client, state] of this.clients) {
      if (client.readyState !== client.OPEN || state.blocked) continue;
      if (client.bufferedAmount >= MAX_BUFFERED_BYTES) { state.needsKey = true; continue; }
      if (state.needsKey) {
        if (!key) continue;
        state.needsKey = false;
      }
      client.send(accessUnit, { binary: true });
    }
  }

  /**
   * Resizes the surface and rebuilds the capture rectangle and the encoder.
   *
   * Nothing is captured or probed: the window's content box was measured once at
   * startup and cannot change (the window is never resized), so the new rectangle
   * is pure arithmetic against it. The X display is not touched either — neither
   * `xrandr` nor a restart is needed, because the root was allocated at the
   * session's ceiling and only the rectangle we grab out of it moves. A restart
   * would have taken Chromium's X connection with it and destroyed the page's
   * scroll position and form state; RANDR against Xvfb only offers the modes it
   * was started with, so arbitrary sizes were never available that way either.
   */
  private async reconfigure(): Promise<void> {
    await this.restartEncoder(async () => {
      await this.applyViewport();
      this.setRect();
    });
  }

  /**
   * Restarts the encoder, optionally reshaping the capture between the stop and
   * the start. The fresh encoder opens with SPS/PPS/IDR, so the client repaints on
   * the first access unit rather than waiting for the next scheduled GOP.
   */
  private async restartEncoder(prepare?: () => Promise<void>): Promise<void> {
    if (this.restarting) return this.restarting;
    const run = (async () => {
      const device = encoderDevice();
      if (!device || this.disposed || this.raster || !this.rect) return;
      this.lastRestartAt = Date.now();
      await this.stopEncoder();
      if (this.disposed || this.raster) return;
      if (prepare) await prepare();
      if (this.disposed || this.raster) return;
      for (const state of this.clients.values()) state.needsKey = true;
      await this.startEncoder(device);
    })().catch((error: unknown) => {
      this.degrade(error instanceof Error ? error.message : "the encoder could not be restarted");
    }).finally(() => { this.restarting = null; });
    this.restarting = run;
    return run;
  }

  private async stopEncoder(): Promise<void> {
    const child = this.encoder;
    this.encoder = null;
    if (this.firstAuTimer) { clearTimeout(this.firstAuTimer); this.firstAuTimer = null; }
    if (!child) return;
    this.encoderStopping = true;
    await terminate(child, ENCODER_GRACE_MS);
  }

  /** Evaluates in the remote surface; a thrown or non-string result reads as "". */
  private async evaluate(expression: string, awaitPromise: boolean): Promise<string> {
    const cdp = this.cdp;
    if (!cdp) return "";
    try {
      const result = await cdp.send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true, userGesture: true, timeout: 2_000 });
      if (result.exceptionDetails) return "";
      const value: unknown = result.result?.value;
      return typeof value === "string" ? value : "";
    } catch {
      return "";
    }
  }

  private async readSelection(): Promise<string> {
    const page = this.page;
    if (!page) return "";
    for (const frame of page.frames()) {
      const text: unknown = await frame.evaluate(READ_SELECTION_JS).catch(() => "");
      if (typeof text === "string" && text.length > 0) return text.slice(0, MAX_CLIPBOARD_CHARS);
    }
    return "";
  }

  private async clipboardRead(): Promise<string> {
    const selection = await this.readSelection().catch(() => "");
    if (selection) return selection;
    const clipboard = await this.evaluate("navigator.clipboard.readText()", true);
    return clipboard.slice(0, MAX_CLIPBOARD_CHARS);
  }

  private async clipboardWrite(text: string): Promise<void> {
    const payload = text.slice(0, MAX_CLIPBOARD_CHARS);
    if (!payload) return;
    await this.evaluate(`navigator.clipboard.writeText(${JSON.stringify(payload)})`, true);
    await this.cdp?.send("Input.insertText", { text: payload.slice(0, MAX_INSERT_TEXT_CHARS) }).catch(() => {});
  }

  /**
   * Input goes through CDP against the Chromium we launched, which is the same
   * path and the same `windowsVirtualKeyCode` table the raster rung uses — the
   * frame source changed, the input surface did not.
   *
   * A real X11 desktop or an Android VM behind this provider will NOT be able to
   * reuse it: there is no CDP there, so input becomes XTEST against the XTEST
   * XInput device (core `XTestFakeKeyEvent` is silently dropped by GTK apps that
   * select XI2), with the browser converting `KeyboardEvent` to X keysyms and
   * the server mapping keysym to keycode, rewriting the keymap when it has to.
   * See docs/neko-architecture.md §4.2 and §11.4 — that is a slice of its own,
   * not a variation on this one.
   */
  private async control(socket: WebSocket, frame: DisplayClientControl): Promise<void> {
    if (frame.type === "capabilities") {
      const decoders = Array.isArray(frame.decoders) ? frame.decoders : [];
      if (this.decoders !== null) {
        // The codec is chosen once per SESSION, from the first client. Per-client
        // encoders are deliberately out of scope: one encode per viewer would
        // multiply GPU cost by viewer count to serve a case Cody does not have
        // (its viewers are the same person's tabs), and the alternative — a
        // second encoder on the same capture — is a whole quality-ladder design.
        // So a later client that cannot decode what is already running is TOLD,
        // rather than left to render a canvas that never paints, and is dropped
        // from the broadcast so it is not charged for bytes it must discard.
        const running = PROFILE_PREFERENCE.find((candidate) => candidate.profile === this.profile);
        if (running && !profileIdcs(decoders).has(running.idc)) {
          const state = this.clients.get(socket);
          if (state) state.blocked = true;
          sendJson(socket, { type: "state", state: "error", message: `This preview is already streaming H.264 ${running.profile}, which this browser cannot decode. Reopen it after closing the other view to get a format it can.` });
        }
        return;
      }
      this.decoders = decoders;
      this.profile = chooseProfile(decoders);
      if (this.profile === null) {
        this.degrade(decoders.length === 0 ? "this client cannot decode video" : "this client decodes no H.264 profile this hardware can encode");
        return;
      }
      this.maybeStart();
      return;
    }
    const page = this.page;
    if (frame.type === "resize") {
      const width = Math.max(RESIZE_MIN_WIDTH, Math.min(RESIZE_MAX_WIDTH, Math.round(frame.width)));
      const height = Math.max(RESIZE_MIN_HEIGHT, Math.min(RESIZE_MAX_HEIGHT, Math.round(frame.height)));
      const deviceScaleFactor = Math.max(MIN_DEVICE_SCALE, Math.min(MAX_DEVICE_SCALE, frame.deviceScaleFactor ?? 1));
      if (!Number.isFinite(width) || !Number.isFinite(height) || !Number.isFinite(deviceScaleFactor)) return;
      const changed = width !== this.viewport.width || height !== this.viewport.height;
      this.viewport = { width, height, deviceScaleFactor };
      this.viewportSeen = true;
      if (this.starting === null) {
        // Still gated: this resize is what tells us the client's density, which
        // the launch flag needs.
        this.maybeStart();
        return;
      }
      // Startup still running: it applies the newest viewport itself once the
      // pipeline is up (see the tail of `start`), so there is nothing to do here
      // beyond having recorded it. Reconfiguring now would race that.
      if (!page || !changed || !this.rect) return;
      await this.reconfigure();
      return;
    }
    if (frame.type === "keyframe") {
      const state = this.clients.get(socket);
      if (state) state.needsKey = true;
      // The periodic IDR normally satisfies this within GOP_MS, so a request is
      // just "stop sending me deltas". Only a stream that has produced no IDR in
      // well over a GOP is actually wedged, and only then is a restart — which
      // re-configures every OTHER client's decoder too — worth it.
      const now = Date.now();
      if (this.rect && now - this.lastKeyAt > GOP_MS * 1.5 && now - this.lastRestartAt > KEYFRAME_RESTART_COOLDOWN_MS) await this.restartEncoder();
      return;
    }
    if (!page) return;
    if (frame.type === "reload") { await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 }); return; }
    if (frame.type === "clipboard") {
      if (frame.action === "read") { sendJson(socket, { type: "clipboard", text: await this.clipboardRead() }); return; }
      if (typeof frame.text === "string") await this.clipboardWrite(frame.text);
      return;
    }
    if (frame.type === "pointer") {
      if (!Number.isFinite(frame.x) || !Number.isFinite(frame.y)) return;
      const button = (frame.button ?? "left") as MouseButton;
      if (frame.action === "move") await page.mouse.move(frame.x, frame.y);
      else if (frame.action === "down") await page.mouse.down({ button });
      else if (frame.action === "up") await page.mouse.up({ button });
      else await page.mouse.wheel({ deltaX: frame.deltaX ?? 0, deltaY: frame.deltaY ?? 0 });
      return;
    }
    if (frame.type === "keyboard" && this.cdp) {
      if (frame.action === "text") {
        if (frame.text) await this.cdp.send("Input.insertText", { text: frame.text.slice(0, MAX_INSERT_TEXT_CHARS) });
        return;
      }
      const type = frame.action === "down" ? "keyDown" : "keyUp";
      const key = frame.key ?? "";
      const code = frame.code ?? "";
      const virtual = virtualKeyCode(key, code);
      await this.cdp.send("Input.dispatchKeyEvent", { type, key, code, modifiers: frame.modifiers ?? 0, windowsVirtualKeyCode: virtual, nativeVirtualKeyCode: virtual });
    }
  }

  /**
   * Hands this session's sockets to a fresh raster provider and gets out of the
   * way. The wire says the renderer in `hello`, so a downgrade is a second
   * `hello` — authoritative, and it carries the floor's own input array — with
   * the reason following as a `state`. The raster provider then REPLACES this one
   * in the session map, so from here on dispose, idle teardown and requestId
   * matching are exactly today's semantics; nothing wraps or delegates.
   */
  private degrade(reason: string): void {
    if (this.disposed || this.raster) return;
    console.log(`[Cody] display: H.264 unavailable for session ${this.sessionId} (${reason}) — streaming JPEG instead`);
    const sockets = [...this.clients.keys()];
    for (const [socket, state] of this.clients) {
      socket.off("message", state.onMessage);
      socket.off("close", state.onClose);
    }
    this.clients.clear();
    if (sockets.length === 0) { void this.dispose(); return; }
    const raster = new RasterWebProvider(this.sessionId, this.request);
    this.raster = raster;
    const state = providerState();
    if (state.providers.get(this.sessionId) === this) state.providers.set(this.sessionId, raster);
    void this.teardown();
    for (const socket of sockets) {
      raster.attach(socket);
      sendJson(socket, { type: "state", state: "connecting", message: reason });
    }
  }

  private detach(socket: WebSocket): void {
    this.clients.delete(socket);
    if (this.clients.size > 0 || this.idleTimer || this.raster) return;
    this.idleTimer = setTimeout(() => { void this.dispose(); }, IDLE_DISPOSE_MS);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const client of this.clients.keys()) client.close(1001, "Display closed");
    this.clients.clear();
    await this.teardown();
    const state = providerState();
    if (state.providers.get(this.sessionId) === this) state.providers.delete(this.sessionId);
  }

  /**
   * Order matters: the encoder holds an X connection, Chromium holds an X
   * connection, and the X server owns the display both of them are on — and on
   * the weston backend the compositor in turn owns the X server. Killing from the
   * bottom up would turn everything above into a process that logs and lingers.
   */
  private async teardown(): Promise<void> {
    for (const timer of [this.idleTimer, this.startTimer, this.firstAuTimer]) clearTimeout(timer ?? undefined);
    this.idleTimer = null;
    this.startTimer = null;
    this.firstAuTimer = null;
    this.generation += 1;
    await this.stopEncoder();
    await this.closeBrowser();
    const x = this.x;
    this.x = null;
    if (x) {
      for (const child of x.processes) await terminate(child, X_GRACE_MS);
      rmSync(x.lock, { recursive: true, force: true });
      if (x.socket) {
        rmSync(x.socket, { force: true });
        rmSync(`${x.socket}.lock`, { force: true });
      }
    }
    this.rect = null;
    this.video = null;
  }

  /**
   * A wedged Chromium must not outlive the session, and Chromium is a TREE: a
   * zygote, a GPU process and a renderer per page. Puppeteer spawns it with
   * `detached: true`, which makes it a process-group leader precisely so the group
   * can be signalled as a unit, and its own `kill()` uses the negated pid for this
   * reason. Signalling only the parent would leave the rest running with no
   * display left to draw on — measured on this host as eight live Chromium
   * processes after a truncated teardown, which is the expensive kind of leak.
   */
  private async closeBrowser(): Promise<void> {
    this.detachLogs?.();
    this.detachLogs = null;
    const browser = this.browser;
    this.browser = null;
    this.page = null;
    this.cdp = null;
    if (!browser) return;
    const child = browser.process();
    await Promise.race([browser.close().catch(() => {}), delay(BROWSER_CLOSE_GRACE_MS)]);
    if (!child || child.exitCode !== null || child.pid === undefined) return;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // No group to signal (the leader is already gone, or the platform refused);
      // the parent alone is the best that can still be done.
      child.kill("SIGKILL");
    }
  }
}
