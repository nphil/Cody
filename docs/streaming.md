# Streaming: turning the preview rung into a real remote-display transport

This is an engineering roadmap, not a survey. It exists because the streamed rung
of `lib/display/` is no longer just a fallback for framing a dev server: the
intent is to carry an **X11/Wayland desktop session** and an **Android VM** over
the same seam. That changes the requirements, and the current design does not
meet them.

The centrepiece is **[m1k1o/neko](https://github.com/m1k1o/neko)**, because neko
already solved most of this problem in the same shape Cody needs (Linux desktop
in a container, browser client, input + clipboard round trip). The other
transports are evaluated *against* neko rather than presented as a menu.

**The four decisions this document makes, up front:**

1. **Keep the CDP/JPEG path for web previews** and stop trying to make it more.
   It is the only rung that needs no GPU, no second container and no new ingress,
   and it inherits Cody's auth for free (§4.1).
2. **Implement neko's techniques inside Cody's own `DisplayProvider`** for
   desktops and Android — Xvfb + damage-aware capture + hardware H.264 — but ship
   them over Cody's **existing authenticated WebSocket, decoded with WebCodecs**,
   not over WebRTC (§4.2). Run neko as a sidecar only for a genuinely shared,
   multi-participant desktop (§4.3).
3. **VAAPI on the UHD 630 is the primary encoder**, NVENC a runtime option, x264
   and then today's JPEG the floors — as an automatic degradation chain, not a
   setting (§8).
4. **Do not promise "crisp" without reading §8.8.** H.264's 4:2:0 chroma harms
   exactly the small and coloured text Cody shows, and 4:4:4 is unavailable in
   hardware here. The answer is a content-switched still/video design, and one
   cheap experiment (§12 item 5) decides whether it is required.

**And the shape to carry away — a latency ladder, not a single number.** On a
realistic *idle* page, full-viewport repaint latency scales at roughly 9–10 ms per
megapixel (§2.2c), so the cost is proportional to how much screen the user gives the
preview:

| Surface | Device px | Mpx | Repaint median |
| --- | --- | --- | --- |
| **Docked Preview panel** (a range — depends on the panel split) | 640×1518 – 2150×1518 | 0.97 – 3.3 | **≈23–45 ms** — immediate |
| **Popped out / maximised** | 2880×1800 – 3180×2000 | 5.2 – 6.4 | **≈64–76 ms** — noticeable |
| **Architectural maximum** (the clamps' ceiling) | 4096×2560 | 10.5 | **115 ms**, 154 ms p95 — not native |

So today's path is *fine where it is normally used* and degrades exactly where the
user is looking hardest: **the penalty becomes visible when they pop the preview out
to inspect something closely.** The problem is not that the path is bandwidth-hungry
— idle bandwidth is a modest 1–6 Mbit/s — it is that **density costs interaction
latency and no amount of bandwidth buys it back.** Everything below follows from that.

Everything named here is verifiable: API names come from the spec or from the
named project's own source/docs, and every URL was read. Numbers labelled
**measured** were produced on this machine by the harness in
[§2.2](#22-what-a-jpeg-frame-actually-costs-measured). Anything I could not
confirm is marked `[UNVERIFIED]`; anything I reasoned to rather than read is
marked `[INFERENCE]`.

---

## 1. Today's baseline

Accurate as of this commit, *including* the in-flight clipboard/pop-out/DPR work
— do not read the following as future tense.

| Piece | Where | What it does |
| --- | --- | --- |
| Frame source | `lib/display/provider.ts` | `puppeteer-core` launches Chromium (`CODY_CHROMIUM_BIN`), CDP `Page.startScreencast` |
| Encode | Chromium, in-process | `format: "jpeg"`, `quality: 90`, `everyNthFrame: 1` |
| Capture density | Chromium launch flag | `--force-device-scale-factor=<captureScale>`, derived from the first client's `deviceScaleFactor` (clamped 1–3) |
| Frame bounds | `startScreencast()` | `maxWidth`/`maxHeight` derived from `viewport × scale`, capped at 4096 px/axis (`MAX_FRAME_EDGE`) |
| Transport | `bin/cody-server.js` | authenticated WebSocket `/api/display/socket?sessionId=` |
| Wire | `provider.ts` | frames as **binary** WS messages; control/state as JSON |
| Pacing | `Page.screencastFrameAck` | ack after send; a stalled-client drain timer prevents a slow peer wedging the stream |
| Client | `components/StreamedDisplay.tsx` | `createImageBitmap` → `drawImage` into a `<canvas>` |
| Pop-out | `app/display/[id]/page.tsx`, `components/DisplayWindow.tsx` | same socket, standalone window |
| Input | `DisplayClientControl` | `pointer`, `keyboard`, `resize`, `reload`, `clipboard` |
| Capability gate | `DisplayStreamHello.input` | client gates UI on the advertised array, not on `renderer` |

Three properties of this baseline are load-bearing and must survive any change:

1. **It inherits Cody's auth for free.** The frame socket *is* Cody's socket, on
   Cody's origin, behind Cody's session gate and Caddy's TLS. Nothing else in
   this document gets that for free.
2. **It needs nothing of the client's network.** No UDP, no ports, no TURN. That
   is why `stream` is the ladder's floor in `lib/display/native-gateway.ts` and
   why it "cannot fail to be available".
3. **It is surface-agnostic on the wire already.** `DisplayClientControl` and the
   `hello` capability array say nothing about "web page" or "DOM".

Four facts checked in source against Chromium 151, each of which corrects a
plausible assumption. The last two are the important ones — they are structural
limits of CDP, not tuning misses:

- Frames are **already binary** on Cody's wire (`provider.ts`,
  `client.send(image, { binary: true })`). The base64 hop is *inside* CDP's JSON
  transport and cannot be removed without leaving CDP.
- `resize` **already carries `deviceScaleFactor`**; there was never a need for a
  new `dpr` field. The plumbing existed; the client simply never populated it,
  which is why output looked soft.
- **`Page.startScreencast` ignores the emulated `deviceScaleFactor` entirely.**
  Setting it via `setViewport` only changes what the *page* believes
  `devicePixelRatio` is. The screencast captures the host surface, whose density
  comes from Chromium's `--force-device-scale-factor` **launch** flag. So capture
  density is a **per-process property, not a per-client one**. With one container
  serving many sessions, and clients of differing DPR (a 2× tablet and a 1×
  desktop on the same Cody), the first client to connect fixes the density for
  every later one, and changing it means relaunching Chromium. That is a
  multi-tenancy defect with no fix inside CDP.
- **`maxWidth`/`maxHeight` can only ever shrink a frame.** Chromium clamps its
  internal screencast scale to ≤ 1, so those parameters cannot recover density —
  they can only stop us shipping more pixels than the client owns. Together with
  the previous point this means the CDP path has exactly one lever for sharpness
  (the launch flag) and it is process-global.

Both of the last two facts argue the same way: **CDP can be made to serve a web
page sharply, but it cannot be made to serve many clients at their own densities.**
A capture-based provider (§6) has neither limit — an X screen can be resized and
the encoder reconfigured at runtime.

---

## 2. Why this path cannot become a desktop transport

### 2.1 The structural limits

**Intra-frame only, by protocol.** `Page.startScreencast`'s `format` parameter
has exactly two allowed values, `jpeg` and `png`
([CDP `Page.startScreencast`](https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-startScreencast)).
Every frame is a complete, independently-coded picture. There is no P-frame, no
motion vector, no skipped macroblock. A desktop that is 99 % static costs the
same per frame as a desktop playing video. This is the single biggest problem,
and it is not tunable — it is the ceiling of the API.

For contrast, Sunshine's behaviour on static content is the correct model:
Moonlight's own FAQ notes Sunshine "uses variable frame rate encoding to match
the rate of content updates on the host… you'll see a low frame rate (typically
around 10 FPS) when streaming static content"
([Moonlight FAQ](https://github.com/moonlight-stream/moonlight-docs/wiki/Frequently-Asked-Questions)).
Damage-driven *and* inter-frame coded is the target; we have neither.

**CPU-side encode, per frame, with the GPU explicitly off.** Cody launches
Chromium with `--disable-gpu` (`provider.ts`). Every JPEG is encoded on the CPU
in the browser process, for every connected client's benefit, at full frame rate.

**TCP head-of-line blocking.** RFC 9114 §1.1 states the mechanism plainly for
HTTP/2-over-TCP, and it applies verbatim to a WebSocket carrying frames: "because
the parallel nature of HTTP/2's multiplexing is not visible to TCP's loss
recovery mechanisms, a lost or reordered packet causes all active transactions to
experience a stall regardless of whether that transaction was directly impacted
by the lost packet" ([RFC 9114](https://www.rfc-editor.org/rfc/rfc9114)). A lost
segment in the middle of frame *N* delays frame *N+1* that has already superseded
it.

**No way to discard a stale frame.** RFC 6455 gives reliable, ordered delivery.
Once `send()` has handed a frame to the stack it *will* be delivered, even though
a newer frame makes it worthless. The only backpressure signal is
`bufferedAmount`, and MDN is precise about its meaning: "the number of bytes of
data that have been queued using calls to `send()` but not yet transmitted to the
network"
([MDN `WebSocket.bufferedAmount`](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket/bufferedAmount)).
It tells you about your own local queue. It says nothing about what the peer
received, decoded, or displayed. Cody's `MAX_BUFFERED_BYTES` guard is the right
use of the only signal available, and it is still a blunt instrument.

**No congestion control, no adaptive bitrate.** There is one quality knob
(`JPEG_QUALITY`, currently `90`) and it is a compile-time constant. Nothing
observes the path and nothing reacts.

**Density is per-process, not per-client** (§1). Two clients at different DPR
cannot both be served sharply from one Chromium, and the first to connect wins.
For a preview panel that is a wart; for a desktop meant to be reached from a
tablet *and* a laptop it is disqualifying.

**It is pixel-rate-bound — but only when content churns.** `GpuPassthrough`
measured the real screencast path twice, and the two results say different things.
Under continuous animation (§2.2b) the path holds a **roughly constant
~150–180 Mpx/s** from about 4 Mpx upward: a fixed per-second pixel budget, so more
density buys proportionally fewer frames, at any bitrate. On a realistic
mostly-idle page (§2.2c) that ceiling never binds — idle frame rate is flat at
~2.8–3.25 fps across a **10× spread in pixel count**, because it is set by the
content's damage rate, not by the pipeline. So the throughput ceiling is a genuine
worst case, not the daily state, and this document is careful not to overclaim it.

**The daily cost is latency, and that one does scale with density.** On the idle
page a single full-viewport repaint costs **25 ms median at 1280×800 and 115 ms at
4096×2560** (§2.2c) — roughly a fixed cost plus ~9–10 ms per megapixel. At the
density the owner actually wants that is around 64 ms, and at DPR 3 it is ~100 ms
median with a 154 ms p95. This is felt on an *idle* page, on **every keystroke**,
and it is the single most important consequence of the current design: the
constraint is a software JPEG encoder running per frame in the browser process, not
the link, so **the crispness the owner wants costs interaction latency and cannot be
bought back with bandwidth.** That is why §4.2 moves the encode off the CPU rather
than trying to make CDP faster.

### 2.2 What a JPEG frame actually costs (measured)

I measured the **same Chromium JPEG encoder** the screencast uses, driving
`Page.captureScreenshot` with `format: "jpeg"` over a full-bleed real Cody UI
screenshot (`docs/screenshot-dark.png`) at 1:1 device pixels. Chromium
`/usr/bin/chromium` via `puppeteer-core` 25.8.0, `deviceScaleFactor: 1`.
The **q92 column is the one to read**, since the shipped `JPEG_QUALITY` is 90:

| Device pixels | MPx | q70 | q82 | **q92 (shipped ≈)** | q92 @25 fps | q92 @60 fps |
| --- | --- | --- | --- | --- | --- | --- |
| 1280×800 | 1.02 | 84.1 KB | 107.7 KB | **152.0 KB** | 31.1 Mbps | 74.7 Mbps |
| 1440×900 | 1.30 | 100.6 KB | 128.3 KB | **180.7 KB** | 37.0 Mbps | 88.8 Mbps |
| 1920×1200 | 2.30 | 147.6 KB | 188.2 KB | **267.3 KB** | 54.7 Mbps | 131.4 Mbps |
| 2560×1600 | 4.10 | 217.2 KB | 275.2 KB | **389.3 KB** | 79.7 Mbps | 191.3 Mbps |
| 2880×1800 | 5.18 | 245.7 KB | 310.3 KB | **439.2 KB** | 89.9 Mbps | 215.9 Mbps |

Arithmetic is `KB × 1024 × 8 × fps`, e.g. 267.3 KB at 1920×1200:
`267.3 × 1024 × 8 × 25 = 54.7 Mbps`. At the older `quality: 82` the same cell is
`188.2 × 1024 × 8 × 25 = 38.5 Mbps`, so the quality bump to 90 cost ~42 % more
bandwidth — a reasonable trade for a mostly-static page, and an unaffordable one
for a desktop.

Now the comparison, and it is the most important number in this document. neko's
**documented default high-quality pipeline** targets
`target-bitrate: round(3072 * 650)` — **≈ 2.0 Mbps** at 25 fps for a full
desktop, with the low-quality pipeline at `1024 * 650` ≈ **0.67 Mbps**
([neko capture config](https://neko.m1k1o.net/docs/v3/configuration/capture)).

> **1920×1200 at 25 fps: Cody's JPEG path ≈ 54.7 Mbps, measured (38.5 Mbps at
> the old quality 82). neko's default inter-frame pipeline ≈ 2.0 Mbps,
> documented. That is a 19–27× gap at comparable resolution and frame rate** —
> and neko's number is a *ceiling* it rate-controls to, whereas Cody's is what a
> static screen costs whether anything moved or not.

**But do not read that as a pure win.** The bandwidth gap is real; the *sharpness*
comparison is not one-directional. H.264's mainstream profiles subsample chroma at
4:2:0, which specifically damages small and coloured text — the content Cody shows
most. §8.8 works this through and lands on a content-switched design rather than a
single codec. Read §8.8 before quoting the 19–27× figure to anyone.

Three corollaries worth internalising:

- At 2880×1800 (a 1440-wide panel at DSF 2) a full-rate JPEG stream is
  **216 Mbps**, well past the point where Moonlight's own bitrate slider stops —
  its docs cap at 150 Mbps and note that "almost no content is produced at a
  bitrate above 100 Mbps"
  ([Moonlight FAQ](https://github.com/moonlight-stream/moonlight-docs/wiki/Frequently-Asked-Questions)).
  Crisp *and* full-rate is not reachable on this codec.
- Cost grows *sublinearly* but relentlessly: 149 KB/MPx at 1280×800 falling to
  85 KB/MPx at 2880×1800, i.e. **2.9× the bytes for 5.1× the pixels**. So density
  is cheaper than linear, but there is no regime where it is nearly free — and
  unlike an inter-frame codec, none of that cost is recovered when the screen
  stops changing.
- The reason today's stream is nonetheless usable is that a web page emits damage
  rarely, so the real frame rate sits far below 60 — and Cody's ack-paced loop
  means an idle page costs nearly nothing. That accident does not survive a
  desktop with a blinking cursor, or an Android VM with animations.

**Caveats on my own method.** The second one is now closed by §2.2b:

- `Page.captureScreenshot` captures at layout size and ignored
  `deviceScaleFactor` in my runs (a DSF-2 1440×900 viewport produced
  byte-identical output to DSF-1). That is consistent with what `provider.ts`
  documents about `startScreencast` and `--force-device-scale-factor`, but it
  means my table is a clean pixels→bytes curve measured at DSF 1, **not** a
  measurement of the DSF-2 code path.
- It is a still image, so it measures the cost of a *full refresh* and says
  nothing about content churn. That is exactly the gap §2.2b fills.

### 2.2b The real screencast path, measured by `GpuPassthrough`

These are **not my numbers** and they measure a different thing from §2.2: the live
`Page.startScreencast` path on current code, software encode, `/dev/dri` absent,
driven by a fixture that animates continuously via `requestAnimationFrame`. So this
is the *throughput* bound where my §2.2 table is the *per-full-refresh cost* bound.
Both matter; neither replaces the other.

| Device pixels | Mpx | fps | KB/frame | Mbit/s | **Mpx/s** |
| --- | --- | --- | --- | --- | --- |
| 1280×800 | 1.02 | 60.0 | 63.6 | 30.5 | 61 *(content-capped)* |
| 2560×1600 | 4.10 | 44.5 | 164.5 | 58.6 | **182** |
| 3840×2400 | 9.22 | 17.0 | 303.8 | 41.3 | **157** |
| 4096×2560 | 10.49 | 14.2 | 205.0 | 23.4 | **149** |

**The Mpx/s column is the finding.** Rows 2–4 sit at a roughly constant
**149–182 Mpx/s** (mean ≈163) across a 2.6× spread in pixel count. A pipeline that
holds constant pixel throughput while resolution climbs is **pixel-rate-bound**, and
that is the strong form of the argument:

> From roughly 4 Mpx upward this path has a fixed pixel budget per second, so asking
> for more density buys proportionally fewer frames — **at any bitrate.** At the
> density the owner actually wants (a 1440-wide panel at DPR 2 is 2880×1800, between
> rows 2 and 3) it delivers something in the 17–44 fps band and falling. That is not
> "slightly soft"; it is visibly not native, and no amount of bandwidth fixes it.

Four honest caveats, three of which correct my own first reading of these numbers:

- **Row 1 is not a pipeline ceiling.** The fixture animates at 60 Hz, so 60.0 fps is
  the *content's* cap, not the encoder's. The pipeline never saturated at 1280×800.
  The claim is therefore "pixel-rate-bound from roughly 4 Mpx upward", **not**
  "saturating across the board".
- **Do not read the bytes/frame dip (303.8 → 205.0 KB) as saturation evidence.** I
  originally did, and it is wrong: those two rows differ in *layout* as well as
  pixel count — row 3 is a 1280 CSS-px-wide page at captureScale 3, row 4 is a
  2560 CSS-px-wide page at captureScale 1.6. Different CSS layout and different
  per-pixel glyph sharpness means different JPEG entropy, so frame sizes are not
  comparable between them. Two variables moved at once. The Mpx/s normalisation is
  the claim that survives.
- **Do not diff these against `StreamServer`'s static-page figures** (e.g. 29.0 fps).
  Different fixture, different question, and that fixture no longer exists.
- **The GPU branch is deliberately UNMEASURED.** `/dev/dri` does not exist in this
  container yet, so nobody has produced that number and this document does not
  invent one; it needs the pending template change (§8.7). And note GPU
  rasterization moves *page drawing* off the CPU while leaving the JPEG encode
  exactly where it is, so it is not expected to lift the pixel-rate ceiling — which
  is precisely why the fix is a codec provider (§4.2) and not a flag.

One thing these numbers *confirm* rather than challenge: **the geometry contract is
exact** — 1280×800@dpr1 → 1280×800, @dpr2 → 2560×1600, @dpr3 → 3840×2400, and
2560×1600@dpr3 → 4096×2560 (the `MAX_FRAME_EDGE` clamp). The density plumbing in §1
works; it is the encoder behind it that runs out of budget.

### 2.2c The daily case: a mostly-idle page (measured by `GpuPassthrough`)

The measurement that actually decides how bad the current path is. §2.2 is a still
image and §2.2b is a 60 Hz animation; **this is the case the owner lives in.**
Fixture: a realistic mostly-idle dev-server page — static log and text blocks, a
blinking caret, a 1 Hz clock, so the only self-generated damage is the caret and the
clock. Current code, devices absent. "Repaint latency" is a client click that flips
the body background, guaranteeing **full-viewport** damage, timed to first frame
back; n = 8–18 per row.

| Viewport / dpr | Device px | Mpx | Idle fps | B/frame | Idle Mbit/s | **Repaint median** | **p95** |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1280×800 dpr1 | 1280×800 | 1.02 | 2.83 | 53,997 | 1.22 | **25 ms** | 51 ms |
| 1280×800 dpr2 | 2560×1600 | 4.10 | 2.83 | 145,737 | 3.30 | **55 ms** | 78 ms |
| 1280×800 dpr3 | 3840×2400 | 9.22 | 3.00 | 260,827 | 6.26 | **97 ms** | 106 ms |
| 2560×1600 dpr3 | 4096×2560 | 10.49 | 3.25 | 167,869 | 4.36 | **115 ms** | 154 ms |

**Three findings, and they reweight this document's argument.**

1. **Idle frame rate is flat** at ~2.8–3.25 fps across a 10.3× spread in pixel
   count — a 1.15× spread in fps. It is set by the content's damage rate, not the
   pipeline. So §2.2b's throughput ceiling is a real worst case but **not** the daily
   state, and §2.1 is scoped accordingly.
2. **Latency is where density bites, and it scales cleanly.** Median repaint goes
   25 → 55 → 97 → 115 ms. A linear fit gives roughly **13–16 ms fixed plus
   ~9–10 ms per megapixel** (`GpuPassthrough` reports ~13 + 9.9; my own
   least-squares on the four points gives 16.1 + 9.17 — the same answer within the
   noise of four samples). **Interpolated onto the surfaces that actually exist it
   becomes a ladder.** The "surface" column says where the *geometry* comes from; the
   only row whose *latency* was directly measured is the last one, and every other
   median is interpolated from the fit — all of them inside the measured 1.02–10.49
   Mpx span except the floor row, which is below it and so marked:

   | Surface | CSS viewport | Device px | Mpx | Median | Geometry from |
   | --- | --- | --- | --- | --- | --- |
   | Docked, client floor | 320×240 @dpr2 | 640×480 | 0.31 | ≈16 ms *(extrapolated)* | clamp |
   | Docked, narrow panel | 320×759 @dpr2 | 640×1518 | 0.97 | ≈23 ms | measured |
   | Docked, ~42 % of a 1280 window | 538×759 @dpr2 | 1076×1518 | 1.63 | **≈30 ms** | measured |
   | Docked, ~42 % of a 2560 window | 1075×759 @dpr2 | 2150×1518 | 3.26 | ≈45 ms | arithmetic |
   | Pop-out, 1440 logical | 1440×900 @dpr2 | 2880×1800 | 5.18 | **≈64 ms** | arithmetic |
   | Pop-out, 1600×1000 logical | 1590×1000 @dpr2 | 3180×2000 | 6.36 | ≈76 ms | measured |
   | **Architectural maximum** | 2560×1600 @dpr3 | 4096×2560 | 10.49 | **115 ms** (154 p95) | **latency measured** |

   **The docked panel is a range, not a number** — it is whatever CSS width
   `AppShell`'s panel split hands the canvas, since the panel shares the window with
   chat and the file tree. `StreamClient` measured the 320- and 538-wide cases and
   confirmed the pop-out sends the **full window** viewport. So **≈30 ms is a fair
   everyday figure and it is comfortably inside the immediate-feel budget.** I
   earlier attached the 64 ms number to everyday use, which was wrong by about 2×:
   64–76 ms is the price of **popping out or maximising**.

   **The last row is the satisfying part: the worst case measured is the worst case
   that can exist.** Working the clamps in `provider.ts` through — CSS clamped to
   320–2560 × 240–1600, `deviceScaleFactor` to 1–3, and `captureScale` additionally
   reduced by `fit = min(4096/w, 4096/h)` so the surface stays inside
   `MAX_FRAME_EDGE` — a 2560×1600 CSS viewport at dpr 3 yields `captureScale` 1.6 and
   a frame of exactly **4096×2560 = 10.49 Mpx**, which is precisely
   `GpuPassthrough`'s row 4. So ~115 ms median / 154 ms p95 is not a test artefact,
   it is the architectural ceiling, and the `fit` clamp is what prevents the
   5120×3200 (16.4 Mpx) frame the raw CSS limits would otherwise permit.

   **Correcting myself on where the latency control lives.** I wrote earlier that a
   pop-out surface cap acts as a latency control. There is **no client-side area
   cap**: the client sends its measured CSS size with only a 320×240 floor, and caps
   **density** at `min(3, max(1, devicePixelRatio))`. The area backstop is entirely
   server-side, in `control()`'s clamps and `MAX_FRAME_EDGE`. So the knobs that
   actually bound latency are the server's CSS clamp, the dsf ceiling of 3, and
   `MAX_FRAME_EDGE` — and since device pixels go as `css × min(dsf, fit)`, both a
   high-DPI client and a large panel push toward the same ceiling.
3. **Idle bandwidth is modest**: 1.22–6.26 Mbit/s, against 30.5–58.6 Mbit/s
   saturated. So bandwidth is genuinely the *weaker* half of the case against the
   current path, and latency is the strong half. The 19–27× bandwidth gap in §2.2 is
   real and worth having, but it is not what the owner feels day to day.

Two cautions carried forward:

- **Row 4 again has fewer bytes/frame than row 3** (167.9 vs 260.8 KB) despite more
  pixels. Same layout/`captureScale` confound as §2.2b — 1280 CSS px at 3× versus
  2560 CSS px at 1.6× — so it is not saturation evidence here either.
- **The GPU branch remains UNMEASURED.** Worth stating precisely what it should be
  expected to do: GPU rasterization attacks finding 2, because raster is part of the
  per-repaint cost — but the JPEG encode inside that same cost is **not**
  accelerated, so it should **shrink the ~9–10 ms/Mpx slope without eliminating it**.
  That is a falsifiable prediction and §12 item 10 should test it as one.

---

## 3. neko: what it actually does, and what to take

Read this section as "the reference architecture", because it is.

### 3.1 Architecture

neko streams "a desktop inside of a docker container" over WebRTC
([README](https://github.com/m1k1o/neko)), and the pieces map almost 1:1 onto
what Cody would need:

- **Frame source** — an X display. `capture.video.display` names it; the
  container ships Xvfb. Not limited to a browser: "it can run anything that runs
  on linux (e.g. VLC)… you can install a full desktop environment (e.g. XFCE,
  KDE)".
- **Capture + encode** — GStreamer. The canonical pipeline in neko's own docs is
  `ximagesrc display-name={display} show-pointer=true use-damage=false ! <elements> ! appsink name=appsink`
  ([capture config](https://neko.m1k1o.net/docs/v3/configuration/capture)).
- **Codecs** — `vp8`, `vp9`, `av1`, `h264`, `h265`, with a documented
  encoder matrix: software `x264enc`, VAAPI `vah264enc`, NVENC `nvh264enc` /
  `nvautogpuh264enc`. (I independently confirmed `vah264enc` exists in current
  GStreamer, plugin `va`, GStreamer Bad Plug-ins, exposing `key-int-max`,
  `ref-frames`, and `b-frames` defaulting to 0 —
  [GStreamer `vah264enc`](https://gstreamer.freedesktop.org/documentation/va/vah264enc.html).
  `b-frames=0` matters: B-frames add reorder latency.)
- **Transport** — WebRTC via [Pion](https://github.com/pion/webrtc)
  ([webrtc config](https://neko.m1k1o.net/docs/v3/configuration/webrtc)).
- **Multi-quality** — several named pipelines (`ids: [hq, lq]`); the client picks
  one or lets the server pick. Pipelines are built by expression over live
  `width`/`height`/`fps`.
- **Lifecycle** — "The Gstreamer pipeline is started when the first client
  requests the video stream and is stopped after the last client disconnects",
  which the source bears out: capture sinks share one pipeline and listener set
  and start on the first listener
  (`server/internal/capture/streamsink.go:50-110`). Exactly Cody's existing
  `IDLE_DISPOSE_MS` instinct.
- **Fallback — real, but weaker than the docs imply.** neko documents a JPEG path:
  "The WebRTC Fallback mechanism allows you to capture the display in the form of
  JPEG images and serve them over HTTP using Screencast." **neko independently
  arrived at Cody's current rung as its floor**, which is a strong signal the floor
  is right and only the ceiling is missing. But `NekoStudy`'s source audit sharpens
  it into something more useful to us: it is a *separate HTTP endpoint*, not a rung
  the client can fall back to. There is **no WebCodecs, no MSE and no
  WebSocket/TCP video path anywhere in the repo**, `tcpmux` is ICE-over-TCP rather
  than a video transport, and the client **hard-refuses to run at all without
  `RTCPeerConnection`** (`base.ts:40`, `:62`).

  So on this specific axis Cody's architecture is genuinely better than neko's, not
  merely different: a client that cannot do WebRTC gets nothing from neko, whereas
  Cody's ladder degrades to a JPEG rung over the same authenticated socket it was
  already using. That is worth stating plainly because it is the part of §4.2 that
  is *not* copied from anyone.

### 3.2 The seven things worth taking

1. **Damage-driven, inter-frame coded video instead of full frames.** The 19–27×
   number in §2.2 is the whole argument.
2. **Named quality pipelines rather than one hardcoded quality.** A `hq`/`lq`
   pair, selectable per client, is a far better fit for Cody's ladder philosophy
   than a magic constant — and it degrades explicitly rather than silently.
3. **Encoder settings tuned for latency, not for filesize.** neko's documented
   VP8 params are a latency recipe: `end-usage=cbr`, `deadline=1`, `cpu-used=4`,
   `keyframe-max-dist=25`, `min-quantizer=4 max-quantizer=20`, plus explicit
   `buffer-size`/`buffer-initial-size`/`buffer-optimal-size`. The H.264
   equivalents are `x264enc tune=zerolatency` and, on VAAPI, `key-int-max` with
   `b-frames=0`.
4. **Pipeline lifecycle bound to client attach/detach.** Already Cody's model;
   keep it.
5. **Expression-driven resolution.** neko evaluates `width`/`height`/`fps` from
   the live display, so a resize reconfigures the encoder rather than resampling
   downstream. Cody now derives its screencast bounds this way too; the
   previously hardcoded `maxWidth: 1920, maxHeight: 1200` is exactly the bug
   class this prevents, and the new provider must not reintroduce it.
6. **Capability-per-user, not capability-per-renderer.** neko's member profile
   carries `can_host`, `can_watch`, `can_access_clipboard`,
   `can_see_inactive_cursors`
   ([auth config](https://neko.m1k1o.net/docs/v3/configuration/authentication)).
   Cody's `hello.input` array is the same idea one level down; the *user* axis is
   the piece Cody lacks and will want the moment a desktop is shareable.
7. **A single explicit "who has control" concept.** For a multi-client desktop,
   input arbitration has to exist somewhere; neko makes it a first-class
   permission.

### 3.3 Where neko's choices do **not** fit Cody

This is the part that decides §4, so it is stated bluntly and with citations.

**(a) WebRTC *media* does not survive Cody's reverse proxy — though signalling
does.** The distinction matters, so state it precisely: Caddy proxies neko's HTTP
and WebSocket **signalling** perfectly well. It is the **media** that cannot be
forwarded. neko's own documentation
(`webpage/docs/configuration/webrtc.md:146-148`):

> "WebRTC does not use the HTTP protocol, therefore it is not possible to use
> nginx or other reverse proxies to forward the WebRTC traffic. If you only have
> exposed port `443` on your server, you must expose as well the WebRTC ports or
> use a TURN server."
> — [neko WebRTC config](https://neko.m1k1o.net/docs/v3/configuration/webrtc)

The owner reaches Cody at `https://cody.nateshome.net` through Caddy. So adopting
neko's transport means publishing, in addition to the existing HTTPS route,
either an unremapped UDP port range (`webrtc.epr: "59000-59100"`) or a single mux
port (`webrtc.udpmux` / `webrtc.tcpmux`), or standing up TURN. It is not a config
detail; it is a second ingress path alongside the one Cody already has, and it is
the single biggest reason §4 does not simply adopt WebRTC.

**(b) neko's adaptive bitrate is experimental and off.** The bandwidth estimator
is documented with a `danger` admonition — "experimental… might not work as
expected" — and `enabled: false` by default. When on, it *switches between
pipelines* rather than smoothly rate-controlling. So "WebRTC gives you congestion
control for free" is *not* what neko actually delivers today; it delivers
quality-step switching, which a WebSocket transport can also do.

**(c) neko has its own auth, and it cannot delegate to Cody's.** Providers are
`multiuser`, `file`, `object`, `noauth`; the docs state plainly "LDAP, OIDC, and
other subsystems are *not* currently implemented." Sessions are a
`NEKO_SESSION` cookie or an `Authorization` header, plus an admin `api_token`.
Putting neko behind Cody therefore means a **second authentication boundary
inside the first** — Cody would have to mint a neko session on the user's behalf
via the API token and hand back a cookie scoped to neko's domain/path. That is
doable but it is real security surface, and `noauth` is explicitly flagged
`danger`.

**(d) One neko process is one shared desktop, not many isolated sessions.** This
is the deepest structural mismatch, and it is confirmed in neko's source rather
than inferred: one `serve` instance constructs exactly one
`DesktopManager`/`CaptureManager`/`WebRTCManager` (`server/cmd/serve.go:86-152`),
each app image supervises one browser plus Openbox on one `DISPLAY`
(`apps/firefox/supervisord.conf:1-20`), and capture sinks share one pipeline and
listener set, starting on the first listener
(`server/internal/capture/streamsink.go:50-110`).

So neko's concurrency model is **many clients on one desktop** — which is exactly
right for a watch party and exactly wrong for Cody, whose model is **many
independent sessions, each with its own surface**. Consistent with that,
`capture.video.display` names a single display, "all video pipelines must use the
same video codec", and multi-room is a *separate project*: "For neko room
management software, visit [neko-rooms](https://github.com/m1k1o/neko-rooms)".

Mapping N Cody sessions onto neko therefore means N containers plus an
orchestrator — one process per session, each carrying a full browser and window
manager. Cody currently gets N sessions from N `RasterWebProvider` instances in
one process.

**(e) Cody's engine must run in Cody's container.** `docs/unraid.md` is explicit
that the engine "must run **inside** Cody's container: Cody spawns it as a child
process over stdio and shares its filesystem". A sidecar cannot host the *dev
server preview* case without breaking that. It can perfectly well host a
*desktop*, which shares nothing.

---

## 4. The decision: sidecar, or neko's techniques in Cody's seam?

**Recommendation: hybrid, split by surface — and the split is not a hedge, it
falls exactly along the seam that already exists in `lib/display/`.**

### 4.1 Web previews (today's use case): keep CDP. Do not involve neko.

The dev-server-page case is served well by the improved CDP path, and every neko
advantage is either irrelevant or unreachable here:

- A web page emits damage rarely, so the inter-frame win is smallest exactly
  here `[INFERENCE, from §2.2's static-content reasoning]`.
- The CDP path needs no second container, no GPU, no UDP, no TURN, no second auth
  boundary — and it is the *only* option that keeps working when `/dev/dri` is
  absent (see §8, which is a decision, not an assumption).
- Cody already has the page in a Chromium it controls, with real
  `Input.dispatchKeyEvent` / `Input.insertText` semantics that an X11 keysym path
  would have to re-derive.

So: finish the sharpness/pacing/clipboard work, take neko's *settings* lessons
(§3.2 items 3 and 5 — derive capture bounds from the scaled viewport instead of
hardcoding them), and stop there.

### 4.2 Desktop and Android: implement neko's techniques inside `DisplayProvider`. Do not run neko.

Build a second provider behind the *existing* `DisplayProvider` interface that
does what neko does — Xvfb (or a headless wlroots compositor) + damage-aware
capture + hardware H.264 — but ships the result over **Cody's existing
authenticated WebSocket, decoded with WebCodecs**, not over WebRTC.

Why in-house rather than sidecar, given neko already works:

| Constraint | Sidecar neko | Techniques in Cody's seam |
| --- | --- | --- |
| Caddy HTTPS only | Signalling proxies fine; **media** needs a UDP range / mux port / TURN as a second ingress | Reuses `/api/display/socket`, one TCP port, already proxied |
| One container, many sessions | neko is *one shared desktop, many peers* (`serve.go:86-152`) → N containers + neko-rooms | N providers in one process, as today |
| Auth | Second boundary; no OIDC; API-token session minting | Already gated by `canAccessDisplaySession` |
| Tailscale-only clients | Direct UDP *usually* works, DERP relay when not | Irrelevant — it is TCP over the same origin |
| Wire stays surface-agnostic | neko's protocol, not ours | Additive changes to `DisplayClientControl`/`hello` |
| Engine-in-container invariant | Broken for previews, fine for desktops | Untouched |

The decisive point is that **the WebSocket + WebCodecs combination is not
speculative — it is what the closest comparable project ships by default.**
Selkies (MPL-2.0) "streams over plain WebSockets by default, with WebRTC
available as an opt-in transport", to "a WebCodecs-based web client" with "a
low-latency zero-copy rendering path", and its documentation is emphatic that
this is the deployment-friendly choice: "Selkies only requires one HTTP web
server or reverse proxy which supports WebSocket, or a single TCP port… This
allows many existing infrastructure previously utilizing noVNC to switch to
Selkies without changing other components"
([selkies design](https://selkies-project.github.io/selkies/design/),
[components](https://selkies-project.github.io/selkies/component/)). It also
advertises exactly the embedding property Cody needs: "in any HTML5 web interface
you wish to embed inside".

In other words: neko is the right *architecture* and the wrong *transport for
Cody's deployment*; selkies proves the architecture works over the transport Cody
already has.

### 4.3 The one case for a sidecar

If the goal ever becomes a **shared, multi-participant desktop** — several people
watching and passing control, with neko's `can_host` arbitration and its
watch-party lineage — that is neko's actual specialty and re-implementing it is
foolish. Note that §3.3(d) cuts *both* ways: "one shared desktop, many peers"
(`serve.go:86-152`) is the wrong shape for N isolated Cody sessions and precisely
the right shape for one collaborative desktop. In that case:

- Run neko as a sidecar, one container per desktop, orchestrated by neko-rooms.
- Attach it to Cody through the **existing** `native` gateway machinery in
  `lib/display/native-gateway.ts`, which already mints a single-use
  wildcard-subdomain hostname and reverse-proxies it *from inside the container*
  while "stripping cookies and auth headers so the iframe never carries your Cody
  credentials" (`docs/unraid.md`). That is precisely the right primitive for
  embedding a foreign authenticated app.
- **Publish the media port directly; do not expect Caddy to carry it.** I had this
  wrong in an earlier draft: `webrtc.tcpmux` collapses media onto a single **TCP**
  port, which is genuinely easier to firewall than an ephemeral UDP range, but it is
  **ICE-over-TCP, not HTTP** — Caddy's `reverse_proxy` cannot proxy it. It needs a
  raw TCP passthrough (Caddy's `layer4` plugin) or a plainly published container
  port. Accept the latency cost neko's docs warn about ("UDP is generally better for
  latency, but some networks block UDP so it is good to have TCP available as a
  fallback"). The HTTP/WebSocket **signalling** proxies through Caddy normally; it is
  only the media that needs its own door.
- Keep neko's own auth; do not try to fuse it with Cody's. Mint short-lived rooms
  with a random `session.api_token`, which is the usage neko's docs explicitly
  bless: "useful in some situations when the rooms are generated by the server
  and the token is guaranteed to be random every time a short-lived room is run."

**Never** put the *web preview* on a neko sidecar. It costs a container per
session to solve a problem the CDP path does not have.

---

## 5. Transports, evaluated against neko

### 5.1 Option A — encoded video over the existing WebSocket, decoded with WebCodecs (**recommended**)

The client side is small and fully specified.

`VideoDecoder` ([spec](https://w3c.github.io/webcodecs/#videodecoder-interface),
[MDN](https://developer.mozilla.org/en-US/docs/Web/API/VideoDecoder)) is
constructed with `output` and `error` callbacks and driven with
`configure()` / `decode()` / `flush()` / `reset()` / `close()`, plus the static
`VideoDecoder.isConfigSupported()`. Chunks are `EncodedVideoChunk` with
`type: "key" | "delta"`, `timestamp`, `data`.

The two config members that matter:

- `optimizeForLatency` — spec text: "Hint that the selected decoder *SHOULD* be
  configured to minimize the number of `EncodedVideoChunk`s that have to be
  decoded before a `VideoFrame` is output." This is the knob that kills reorder
  buffering.
- `hardwareAcceleration` — `"no-preference"` (default) / `"prefer-hardware"` /
  `"prefer-software"`. The spec is candid that these are **hints**: "User Agents
  may ignore these values in some or all circumstances for any reason", and warns
  that `prefer-hardware` "can significantly restrict what configurations are
  supported". So: do not set it, and do not build logic that assumes hardware
  decode happened.

**Bitstream format is the detail people get wrong.** Per the
[AVC WebCodecs registration](https://w3c.github.io/webcodecs/avc_codec_registration.html):
codec strings are `avc1.` or `avc3.` plus a 6-character suffix (RFC 6381 §3.4);
if `VideoDecoderConfig.description` is **present** it is an
`AVCDecoderConfigurationRecord` and the bitstream is `avc` format; if it is
**absent** the bitstream is **Annex B**. And crucially, for Annex B, a `key`
chunk "is expected to contain both a primary coded picture that is an
instantaneous decoding refresh (IDR) picture, **and all parameter sets necessary
to decode**" — i.e. SPS/PPS must be repeated in-band with every IDR. That is the
live-streaming shape, and the registration says so: Annex B "is commonly used in
live-streaming applications, where including the SPS and PPS data periodically
allows users to easily start from the middle of the stream."

→ **Send Annex B, omit `description`, repeat SPS/PPS on every IDR.** No muxing,
no MP4 boxes, no init segment.

**Recovery is specified, not improvised.** The spec gives `VideoDecoder` a
`[[key chunk required]]` internal slot, set `true` by `configure()` and by
`reset()`; if the next chunk's `type` is not `key`, `decode()` throws
`DataError`. So the recovery protocol is forced and simple: on decoder error,
`reset()`, ask the server for a keyframe, drop everything until one arrives.
This is exactly what ws-scrcpy does — `WebCodecsPlayer.ts` keeps a `hadIDR` flag
and refuses to `decode()` until it has seen an IDR, configures with
`optimizeForLatency: true`, and builds its codec string as `avc1.<hex>` from the
parsed SPS
([`src/app/player/WebCodecsPlayer.ts`](https://github.com/NetrisTV/ws-scrcpy/blob/master/src/app/player/WebCodecsPlayer.ts)).

**Rendering.** The spec notes "`VideoFrame` is a `CanvasImageSource`. A
`VideoFrame` can be passed to any method accepting a `CanvasImageSource`,
including `CanvasDrawImage`'s `drawImage()`." So the existing canvas painter in
`StreamedDisplay.tsx` barely changes: swap `createImageBitmap(blob)` for a
`VideoFrame` from the decoder's `output` callback, `drawImage`, then
`frame.close()` — closing is mandatory, since the spec classifies decoder outputs
as *Codec System Resources* that "*MAY* be quickly exhausted and *SHOULD* be
released immediately when no longer in use."

**Browser support** (MDN BCD, `api/VideoDecoder.json`): Chrome/Edge **94**,
Firefox **130**, Safari **16.4**, Android Chrome mirrors Chrome. One real gap:
`firefox_android` is `version_added: false`. Plan for a JPEG fallback rung rather
than assuming universal availability — which is what ws-scrcpy does with its
five players (`WebCodecsPlayer`, `MsePlayer`, `TinyH264Player`, `BroadwayPlayer`,
`MjpegPlayer`) and what selkies does by keeping JPEG in `pixelflux`.

**Latency floor.** Removing frame-level buffering, `optimizeForLatency`, and no
jitter buffer means the floor is `encode + one RTT + decode`. What Option A
*cannot* remove is TCP's retransmission stall (§2.1) — under loss it degrades by
waiting, where WebRTC degrades by concealing. On a WireGuard/Tailscale LAN with
negligible loss, that difference is largely theoretical `[INFERENCE]`; it is the
thing §12 must measure before dismissing.

**And the decisive practical advantage:** it changes *nothing* about auth or the
proxy. Same URL, same cookie, same Caddy route, same
`canAccessDisplaySession` gate, same single TCP port. Compare §3.3(a).

### 5.2 Option B — WebRTC

What it genuinely buys that Option A cannot:

- **UDP**, so a lost packet does not stall the frames behind it.
- **Media-aware congestion control** — Google Congestion Control, and RTCP
  feedback for it (RFC 8888).
- **Loss repair without full reliability** — NACK/RTX (RFC 4585, RFC 4588) and
  FEC, plus PLI/FIR keyframe requests (RFC 4585, RFC 5104) instead of an
  application-level "please send a keyframe".
- **A jitter buffer you can shrink.** The knob is
  `RTCRtpReceiver.jitterBufferTarget`
  ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/RTCRtpReceiver/jitterBufferTarget),
  spec [`webrtc-pc`](https://w3c.github.io/webrtc-pc/#dom-rtcrtpreceiver-jitterbuffertarget)),
  settable 0–4000 ms, `RangeError` outside. **Note the naming:**
  `playoutDelayHint` is the older Chrome-only spelling; `jitterBufferTarget` is
  the current specified name, and MDN is careful that it only "influences" the
  target and "does not directly set it".

**But note who actually uses these.** `NekoStudy`'s audit found neko sets **none**
of them: no `jitterBufferTarget`, no `playoutDelayHint`, no `contentHint`, no
`setCodecPreferences` — `base.ts:265-271` is a bare `new RTCPeerConnection`. So the
realistic comparison is not "WebRTC as tuned by an expert" versus "our WebSocket";
it is "WebRTC with defaults" versus "our WebSocket", and on that comparison the gap
narrows a great deal. The knobs above are WebRTC's *potential*, and adopting it
means committing to actually use them, which is engineering work neko has not done
and which does not come free with the transport.

What it costs, in Cody's specific deployment:

- SDP/ICE (RFC 8445), STUN (RFC 8489), TURN (RFC 8656) — and per §3.3(a), it does
  not traverse Caddy. neko needs `epr`/`udpmux`/`tcpmux` published unremapped.
- `nat1to1` accepts only one address, so serving the same instance on LAN and
  publicly needs router hairpinning (neko's docs).
- A server-side stack: Pion (Go, what neko uses), `webrtcbin` (GStreamer), or
  `webrtc-rs`. Selkies chose to vendor a fork of the pure-Python `aiortc` rather
  than depend on a native WebRTC stack — a signal about the integration cost.
- TURN opex when it does not connect: coturn, credentials, a REST-ish
  short-credential scheme (selkies ships a whole TURN-REST container for this).

**Is it worth it for clients that are all on WireGuard/Tailscale?** Mostly no,
and Tailscale's own documentation explains why the upside is smaller than it
looks: connections are direct UDP when NAT traversal succeeds, but "All
connections start as relayed through a DERP server" and are only then upgraded;
if UDP is blocked or both ends are behind hard NAT they stay relayed
([Tailscale connection types](https://tailscale.com/docs/reference/connection-types)).
So on the good path you have a clean low-loss UDP tunnel — on which Option A's
TCP weakness barely manifests — and on the bad path WebRTC is relayed through
DERP anyway, which is "generally slower than direct connections". You pay ICE,
TURN and a second transport to win in a regime that the overlay has already
mostly eliminated.

**Verdict: defer.** Revisit only if §12's loss/latency measurements show TCP
stalls that are actually perceptible on this network.

### 5.3 Option C — WebTransport / QUIC

Genuinely the right shape: QUIC gives independent streams and unreliable
datagrams, so you can send a frame per stream and let stale ones be reset. The
API is real and small — `new WebTransport(url)`, `ready`, `closed`,
`datagrams`, `createUnidirectionalStream()`, plus a `congestionControl` option
that "indicates the application preference for either high throughput or
low-latency"
([MDN `WebTransport`](https://developer.mozilla.org/en-US/docs/Web/API/WebTransport)).

Support is better than its reputation. MDN BCD (`api/WebTransport.json`):
Chrome **97**, Firefox **114**, **Safari 26.4**. It is no longer a
Chrome-only technology.

The blocker is not the browser, it is the path. WebTransport is defined over
HTTP/3, i.e. QUIC over UDP end-to-end, and MDN describes the interface as
connecting "to an HTTP/3 server". Cody sits behind Caddy on HTTPS. Terminating
HTTP/3 at Caddy and forwarding WebTransport to an origin is not the same thing as
proxying HTTP — I did **not** find a Caddy capability that does it
`[UNVERIFIED]`, and treating that as solved would be exactly the kind of
assumption this document is supposed to prevent.

**Verdict: premature — but for a different reason than usual.** Not "browsers
aren't ready" (they are); rather "the reverse proxy in front of this specific
deployment isn't". Recheck when the proxy story is verified, because the
technology fit is the best of the three.

---

## 6. Frame sources beyond Chromium

### 6.1 Display server

- **Xvfb** — what neko's containers and selkies' default backend use. Simplest,
  most proven, and the one with a complete input-injection story. Selkies' image
  even carries "an Xvfb with DRI3" so GL reaches the render node
  ([components](https://selkies-project.github.io/selkies/component/)).
- **Headless Wayland** — selkies' Wayland backend runs a capture compositor and
  **nests [labwc](https://labwc.github.io) inside it** to supply window
  management and an XWayland server. Note its hard-won caveat: a Wayland session
  "asked for on a GPU it cannot reach starts as X11 instead", because the
  compositor needs "a working GBM/EGL stack on a DRM render node" and "device
  paths do not answer whether that stack works" — so selkies probes at startup
  (`selkies-gpu-probe`). If Cody goes Wayland, copy the probe, not the optimism.

**Recommendation: X11/Xvfb first.** Wayland is the better long-term substrate and
strictly more work; there is no reason to pay for it in phase one.

### 6.2 Capture

> **Before reading the pipeline strings below:** they are written in GStreamer
> terms because that is what neko and selkies use, but `docker/Dockerfile`
> deliberately ships **no GStreamer and no ffmpeg** today. Which dependency Cody
> actually takes on is an open decision — see §11 Phase 1.5 — so treat these as
> "the shape of the pipeline", not "the packages we already have".

- **`ximagesrc`** (GStreamer) — neko's choice, with `show-pointer=true` and
  `use-damage=false`. That `use-damage=false` is notable: neko turns damage
  tracking *off* and lets the encoder do the work.
- **ffmpeg `x11grab`** — `-f x11grab -i :0.0+10,20` with `grab_x`/`grab_y`,
  `video_size`, `window_id`, and `draw_mouse` (default `1`)
  ([ffmpeg devices](https://ffmpeg.org/ffmpeg-devices.html)).
- **`wlr-screencopy-unstable-v1` — do not build on this.** Its own protocol XML
  says so: "Note! This protocol is deprecated and not intended for production
  use. The ext-image-copy-capture-v1 protocol should be used instead."
  ([wlr-protocols XML](https://gitlab.freedesktop.org/wlroots/wlr-protocols/-/raw/master/unstable/wlr-screencopy-unstable-v1.xml))
- **`ext-image-copy-capture-v1`** — the successor, in wayland-protocols
  *staging* ("currently in the testing phase"). It has the two features that
  matter: `damage_buffer` for incremental capture and `dmabuf_format` /
  `dmabuf_device` for zero-copy
  ([XML](https://gitlab.freedesktop.org/wayland/wayland-protocols/-/raw/main/staging/ext-image-copy-capture/ext-image-copy-capture-v1.xml)).
- **PipeWire via `org.freedesktop.portal.ScreenCast`** — the desktop-correct
  route, but it is a *portal*, i.e. built around interactive user consent.
  Wrong ergonomics for an unattended container `[INFERENCE]`.
- **ffmpeg `kmsgrab`** — real, and pairs beautifully with VAAPI
  (`-f kmsgrab -i - -vf 'hwmap=derive_device=vaapi,…' -c:v h264_vaapi`), but
  ffmpeg's own docs say "If you don't understand what all of that means, you
  probably don't want this. Look at `x11grab` instead." Needs a real KMS device;
  not applicable to Xvfb.

### 6.3 Input injection

- **XTEST — choose this, but not naively.** It is what both selkies (vendored
  `python-xlib`, XTEST/XFixes) and neko use, it is synchronous, and it works on a
  headless X server. Three implementation traps, all of which neko hit and solved,
  and all of which would otherwise cost days:

  1. **Dispatch on the XTEST XInput device, not the core API.** Use
     `XTestFakeDeviceKeyEvent` against the XTEST XInput device — **not** core
     `XTestFakeKeyEvent`. neko's own comment explains why: GDK3 selects XI2, and
     with core XTest "core XTest silently drops every key into Firefox"
     (`xorg.c:4-8`). This is the single highest-value detail in this section: the
     naive call compiles, runs, reports success, and delivers nothing to a GTK app.
  2. **Send keysyms, not `KeyboardEvent.code`.** neko converts in the *browser*
     using Guacamole's vendored keyboard mapping and puts a bare `uint32` X11
     keysym on the wire (`guacamole-keyboard.js:26-27`, resolution order at
     `:269-303` = `keysym_from_key_identifier(key, location)` then
     `keysym_from_keycode(keyCode, location)`, with a `recentKeysym[keyCode]` cache
     at `:317`; wire path `payload/receive.go:36-38` → `webrtc/handler.go:132` →
     `xorg.go:128`). Note this is a **different wire contract from Cody's today**,
     which sends `key`/`code`/`modifiers` for CDP — see §10.1.
  3. **A keysym may have no keycode, so be prepared to rewrite the keymap.** neko
     does three tiers (`xorg.c:251-282`): a remembered-keycode list for key-up
     (`:116-155`), then `XkbKeysymToKeycode` searching the live map under the
     current modifier state (`:158-194`, borrowed from TigerVNC), then
     `XkbAddKeyKeysym`, which finds a free keycode and **rewrites the XKB map** via
     `XkbChangeMap` (`:197-249`). Modifiers are applied as `XkbLockModifiers`
     state rather than synthetic key presses (`:411-415`) — which is also why
     modified shortcuts work reliably there.

  Source: `NekoStudy`'s source audit of neko at `baf21c1`.
- **`libei` / `libeis`** — the Wayland-era answer, with `liboeffis` for the
  `org.freedesktop.portal.RemoteDesktop` D-Bus handshake
  ([libei docs](https://libinput.pages.freedesktop.org/libei/)). The client is
  "roughly equivalent to a physical input device coming from the kernel". Right
  for a Wayland future; portal-mediated, so same consent caveat.
- **`uinput`** — kernel-level, and the escape hatch when nothing else is
  available. Selkies uses it for *gamepads* specifically, where `/dev/uinput` is
  writable, and falls back to an `LD_PRELOAD` interposer inside unprivileged
  containers where it is not. Needs a device and a group; in Docker that is
  another privilege to grant.

Wayland deliberately has no universal injection protocol, which is why this list
is fragmented rather than a single answer.

### 6.4 Clipboard

Cody's wire already carries `{ type: "clipboard", action: "read" | "write" }` and
answers `{ type: "clipboard", text }`, gated on `"clipboard"` in `hello.input` —
that contract is surface-agnostic and needs no change. What changes is what sits
behind it, and X11 clipboard ownership is fiddlier than "shell out to `xclip`"
suggests. From `NekoStudy`'s audit of neko (`desktop/clipboard.go`):

- **The writer process must stay alive to own the selection.** X11 selection
  ownership belongs to a live client, so neko holds one running `xclip -in`
  `*exec.Cmd` and kills the previous one on each write (`:64-79`). A fire-and-forget
  `xclip` that exits immediately loses the selection.
- **Read must be event-driven, and the handler registered before the process
  starts** (`:96-118`), or the first change is missed.
- **`CLIPBOARD` only, never `PRIMARY`** (`:49`, `:82`, `:133`) — a deliberate
  choice, since PRIMARY is the middle-click selection and syncing it produces
  surprising behaviour.
- **Multiple targets are an unsolved problem there.** neko offers `UTF8_STRING` and
  `text/html` (`:13-19`) but writes them *either/or*, with an admitted "unable to
  set multiple targets" TODO at `:37-39`, and no image support at all. So if Cody
  wants rich or image clipboard, this is original work rather than something to
  copy — and selkies advertising "two-way clipboard (text and images)" suggests the
  images case does get asked for.
- **Browser-side clipboard read is not portable.** neko hard-excludes Firefox from
  the async Clipboard API *read* path by user-agent string (`video.vue:335-345`) and
  keeps a floating-`textarea` fallback so Firefox users still have a clipboard
  (`clipboard.vue:1-5`). Whatever Cody's client does needs the same escape hatch.

KasmVNC's design is the other reference worth copying from: it enumerates permitted
clipboard MIME types explicitly (`text/html`, `image/png`,
`chromium/x-web-custom-data`), bounds transfer size in both directions, and
rate-limits operations.

---

## 7. Android

### 7.1 scrcpy is the answer, and its protocol is documented

`scrcpy`'s server encodes with Android's `MediaCodec` from a `Surface` bound to
the display and writes packets to a socket over `adb`; input is injected with the
hidden `InputManager.injectInputEvent()`
([`doc/develop.md`](https://github.com/Genymobile/scrcpy/blob/master/doc/develop.md)).
The framing is fully specified there:

- Codec id, `u32`: `"h264"` `0x68323634`, `"h265"` `0x68323635`, `"av1"`
  `0x00617631`, `"vp8"`, `"vp9"`.
- A 12-byte **session packet** per capture session (MSB set), carrying video
  width and height — i.e. rotation/resize is a protocol event, not a guess.
- A 12-byte **frame header** per media packet: media-packet flag (`u1`),
  config-packet flag (`u1`), key-frame flag (`u1`), PTS (`u61`), packet size
  (`u32`).

Two things make this directly usable by Cody:

1. **It is designed to be driven by a foreign client.** "Although the server is
   designed to work for the scrcpy client, it can be used with any client which
   uses the same protocol", with `send_frame_meta=false`, `send_device_meta=false`
   and `raw_stream=true` to strip framing down to a bare H.264 stream on a TCP
   socket. A Cody `DisplayProvider` can consume this without linking anything.
2. **Its control socket already does clipboard both ways** — "when the device
   clipboard changes, the new content is sent from the device to the client to
   support seamless copy-paste" — which maps onto Cody's existing clipboard
   contract with no protocol change.

The key-frame flag in scrcpy's header is precisely the bit WebCodecs needs to set
`EncodedVideoChunk.type`, and the `u61` PTS is its `timestamp`. **This is the
cleanest fit in the entire document:** scrcpy's wire and WebCodecs' input are
nearly the same shape, which is exactly why ws-scrcpy works.

### 7.2 ws-scrcpy is the proof, not the dependency

[`NetrisTV/ws-scrcpy`](https://github.com/NetrisTV/ws-scrcpy) already carries
scrcpy's H.264 to a browser over a WebSocket, with five interchangeable players
in `src/app/player/`: `WebCodecsPlayer`, `MsePlayer`, `TinyH264Player`,
`BroadwayPlayer`, `MjpegPlayer`. Read `WebCodecsPlayer.ts` for the recovery and
codec-string logic (§5.1) and then write Cody's own — it is ~200 lines, and
vendoring the project would drag in its whole device-management app.

### 7.3 The emulator's own WebRTC bridge: avoid

The Android emulator does ship a gRPC/WebRTC path — WebRTC activates when the
emulator is launched with the `-grpc` flag, and Google publishes an
`android-emulator-webrtc` React component package. But
`google/android-emulator-container-scripts` **was archived on 2026-01-20 and is
read-only**, and WebRTC support there is documented as Linux-only. Depending on
an archived bridge, in order to adopt the transport §5.2 already recommends
deferring, is the wrong trade. Use scrcpy against the emulator like any other
device.

---

## 8. Hardware encode — approved; the prerequisites and the encoder ladder

The host has two usable encoders and **hardware encode is approved**: the
**Intel UHD Graphics 630** iGPU in the i9-9900K (Coffee Lake, Gen 9.5) and an
**NVIDIA discrete GPU**. Unraid's Nvidia driver and the Intel GPU are already
installed on the host; what was missing was the container passthrough.

**The decision, settled:**

| Rung | Encoder | Status |
| --- | --- | --- |
| 1 | **VAAPI / QuickSync on the UHD 630** (`vah264enc`) | **Primary target and documented default.** Design for this first. |
| 2 | **NVENC on the dGPU** (`nvh264enc`) | Supported **option**, selected at runtime. Never an architectural assumption. |
| 3 | **Software** (`x264enc tune=zerolatency`) | Last resort, so a box with no passthrough still works. |
| 4 | **JPEG** (today's CDP path) | The floor that already exists and never goes away. |

Note that this ranking is *not* "best encoder first" — NVENC is the better
encoder. It is "best fit for Cody first", and the two reasons are in §8.2 and
§8.4: NVENC's concurrent-session cap collides with one-container-many-sessions,
and the dGPU is usually already serving something else.

> **Division of labour, and what has already shipped.** A separate agent
> (`GpuPassthrough`) owns getting the device into the container. As of this
> writing that work has **partly landed**, so this section describes the real
> state rather than a plan:
>
> - **Landed** in `docker/Dockerfile`: `intel-media-va-driver` (the iHD driver —
>   `iHD_drv_video.so`, covering Gen8+, so the host's Gen 9.5 UHD 630 is in
>   scope), `libva-drm2`, `vainfo`, and `libegl1` / `libegl-mesa0`.
> - **Landed** in `docker/entrypoint.sh`: a boot-time capability probe that
>   reports rather than warns, because passthrough is legitimately optional. It
>   publishes the contract §10.2 should consume — `CODY_GPU_RENDER_NODE` (the DRM
>   render node, empty when absent) and `CODY_GPU` (vendor summary, or `none`),
>   with the vendor read from the PCI id in sysfs (`0x8086` Intel, `0x1002` AMD,
>   `0x10de` NVIDIA) instead of assumed. `provider.ts` gates GPU rasterization on
>   `CODY_GPU_RENDER_NODE` specifically, since a render node is what Mesa needs.
> - **Still pending**: the `/dev/dri` **Device** entry in
>   `docker/unraid-template.xml`, and the matching section in `docs/unraid.md`.
>   Until the template entry exists, the probe correctly reports `none` on a
>   default install.
>
> This section does not re-specify that work. §8.7 is the operator-facing summary;
> treat `CODY_GPU_RENDER_NODE` as the interface a codec provider consumes.

### 8.1 Step zero: identify the NVIDIA card

The codec recommendation *branches on generation*, so this is not optional. On
the **Unraid host** (not in the container):

```bash
nvidia-smi --query-gpu=name,driver_version,uuid --format=csv
```

Then branch:

- **Turing (RTX 20 / GTX 16) or newer** — good low-latency H.264 and HEVC. This
  is the target; H.264 via NVENC is what Sunshine and Parsec actually ship.
- **Ada (RTX 40) or newer** — additionally has **AV1** encode. Only then is
  `nvav1enc` meaningful.
- **Pascal (GTX 10) or older** — still fine for H.264, noticeably weaker
  quality-per-bit than Turing+ `[INFERENCE]`; not a reason to avoid it, but do not
  expect Sunshine-class results.

The `uuid` from that command is what pins Cody to one GPU in §8.4.

### 8.2 NVENC — the better encoder, the secondary option

GStreamer element names, **verified against the current `nvcodec` plugin index**
([GStreamer nvcodec](https://gstreamer.freedesktop.org/documentation/nvcodec/index.html)):
`nvh264enc`, `nvh265enc`, `nvav1enc` (CUDA mode) and `nvautogpuh264enc`,
`nvautogpuh265enc`, `nvautogpuav1enc` (auto-GPU-select mode). ffmpeg's equivalents
are `h264_nvenc`, `hevc_nvenc`, `av1_nvenc`.

> **Correction worth recording:** `nvcudah264enc` is **not** a GStreamer element —
> it does not appear in the `nvcodec` plugin index. Do not put it in a pipeline.
> The CUDA-mode element is plain `nvh264enc`.

Note that an element *existing* is not the same as the card supporting it:
`nvav1enc` is present in any modern GStreamer build, but AV1 encode needs Ada+
silicon (§8.1).

**The concurrent-session ceiling is the architectural problem.** Consumer GeForce
drivers cap simultaneous NVENC sessions where Quadro/datacenter cards do not. The
cap has been raised repeatedly over time — from 2 to 3 in 2020
([TechPowerUp](https://www.techpowerup.com/268495/nvidia-silently-increases-geforce-nvenc-concurrent-sessions-limit-to-3)),
and to 5 in 2023
([Tom's Hardware](https://www.tomshardware.com/news/nvidia-increases-concurrent-nvenc-sessions-on-consumer-gpus)) —
and reports of 8 on recent drivers exist. **I am not treating any specific number
as verified** `[UNVERIFIED]`: those are secondary sources, and the authority is
NVIDIA's own matrix, which should be checked for the actual card before this is
designed against:
<https://developer.nvidia.com/video-encode-and-decode-gpu-support-matrix-new>.

Why it matters here specifically: **Cody is one container serving many sessions**,
so a naive "one encoder pipeline per session" design walks straight into that
ceiling. With a cap of 5 and Plex already holding two, the sixth Cody preview
fails — and it fails at *pipeline construction*, not gracefully mid-stream.

**neko's source settles why this is Cody's problem and not neko's**, which turns
out to be the strongest technical argument for VAAPI-primary, independent of the
owner's preference. Per `NekoStudy`'s audit: neko has **zero** handling for encode
session exhaustion, and in the resize path a pipeline-creation failure is escalated
straight to `logger.Panic()` (`capture/manager.go:216-219`). It gets away with that
because **one encoder serves all viewers of a stream id** (`streamsink.go:153-171`,
`:370-398`) — a watch party of ten costs one NVENC session. Cody's model is the
opposite: N independent desktops cannot share an encode, so per-session encoders
multiply sessions one-for-one and walk into the consumer cap that neko never
reaches. Do not inherit neko's error handling here; §8.5's chain exists precisely
because this failure is expected rather than exceptional.

### 8.3 VAAPI on the UHD 630 — the primary target

Per Jellyfin's Intel hardware-acceleration documentation, organised by exactly
these generation boundaries
([Jellyfin: Intel GPU](https://jellyfin.org/docs/general/post-install/transcoding/hardware-acceleration/intel/)):

- **H.264 8-bit encode — yes.** "Any Intel GPU that supports Quick Sync Video".
- **HEVC 8-bit encode — yes.** "Gen 9 Skylake (6th Gen Core) and newer".
- **HEVC 10-bit encode — yes.** "Gen 9.5 Kaby Lake (7th Gen Core)… and newer".
- **AV1 encode — no.** Encode arrives with "Gen 12.5 DG2 / ARC A-series,
  Gen 12.7 Meteor Lake… and newer". AV1 *decode* starts at Gen 12 Tiger Lake, so
  this chip does neither.
- Tier: UHD 630 is listed under "Mainstream".

Two facts from that page matter more than the codec list, and they are precisely
why the iGPU is the better *architectural* fit even though NVENC is the better
encoder:

- **"Unlike NVIDIA NVENC, there is no concurrent encoding sessions limit on Intel
  iGPU and ARC dGPU."** So the many-sessions problem in §8.2 simply does not
  exist on the iGPU. Throughput is still finite (§12 item 12).
- **"QSV and VA-API support headless server on both Windows and Linux, which
  means a connected monitor is not required."** Exactly this deployment.

GStreamer element: **`vah264enc`** (plugin `va`, GStreamer Bad Plug-ins —
[docs](https://gstreamer.freedesktop.org/documentation/va/vah264enc.html)). Note
the naming history, because it decides a package choice: the older
`gstreamer-vaapi` plugin's element was `vaapih264enc`; the current `va` plugin uses
`vah264enc`. Those ship in **different Debian packages**, and the modern one comes
for free — `gstreamer1.0-plugins-bad` ships `libgstva.so` **and**
`libgstnvcodec.so`, so one package covers both hardware encoders in §8.5's chain,
while `gstreamer1.0-vaapi` ships only the legacy `libgstvaapi.so` and **should not
be installed at all** (§11 Phase 1.5). ffmpeg's equivalent is `h264_vaapi`.

**A known-good starting pipeline**, from neko's source rather than invented
(`capture_pipeline.go:159`, via `NekoStudy`):

```
vah264enc rate-control=cbr bitrate=<kbps> key-int-max=60 target-usage=7
  ! h264parse config-interval=-1
  ! video/x-h264,stream-format=byte-stream,profile=constrained-baseline
```

Three of those are load-bearing and worth understanding before changing them:

- **`config-interval=-1`** re-emits SPS/PPS before every IDR. This is exactly the
  Annex-B requirement §5.1 derives from the WebCodecs AVC registration — without it
  a client that joins late, or re-`configure()`s after a resize, cannot decode.
  Independent confirmation that the §5.1 wire format is right.
- **`stream-format=byte-stream`** is Annex B, which pairs with omitting
  `VideoDecoderConfig.description` (§5.1). Do not switch to `avc` without also
  starting to send a description.
- **`target-usage=7`** is the *fastest* end of VA's 1–7 speed/quality scale, i.e.
  neko has chosen latency over quality-per-bit. Given the owner's sharpness bar
  (§8.8) this is one of the first knobs to reconsider, not a value to copy blindly.

And **`profile=constrained-baseline` is a choice to revisit.** It is the safest
possible decode target, but it forbids the tools that help most on text. For a
WebCodecs client whose capabilities you have already negotiated (§10.1c), main or
high profile is available and better.

**Do not inherit neko's colour-conversion path — this is real headroom.** neko's
VAAPI pipeline does a **CPU download**, not zero-copy: the caps immediately before
the encoder are plain `video/x-raw,format=NV12` (`capture_pipeline.go:159`) and
there is no `VASurface`, no `vapostproc` and no dmabuf anywhere in the repo, while
its *NVENC* documentation does show a GPU-memory variant
(`cudaupload ! cudaconvert ! video/x-raw(memory:CUDAMemory)`, `capture.md:291-292`).
So on the VAAPI path a full-resolution `BGRx → NV12` `videoconvert` runs on the CPU
for **every frame**.

That matters more than it looks, because it is the *same class of bottleneck* this
document already measured on the current path: per-frame, per-pixel CPU work that
makes throughput pixel-rate-bound (§2.1, §2.2b). Adopting neko's pipeline verbatim
would move the *encode* to hardware and leave a CPU colour-convert in the hot path
— trading one pixel-rate ceiling for a lower one rather than removing it. Keeping
the conversion on the GPU (`vapostproc`, or importing dmabuf from the capture side)
is therefore not a micro-optimisation here; it is the difference between clearing
the ceiling and relocating it. §12 should measure both variants before the pipeline
is fixed.

Userspace needed in the image: `libva`, `vainfo`, and the **iHD** driver
(`intel-media-va-driver`) for Gen 9.5 — legacy `i965` is the pre-Broadwell path.
All of that has now landed (§8.7).

### 8.4 Why the iGPU wins the default

Do not assume exclusive use of either. On an Unraid box both are commonly already
committed — Plex/Jellyfin transcoding is the usual tenant, and Jellyfin's own
docs walk users through claiming exactly these devices.

**Recommendation: Cody claims the Intel iGPU; leave the NVIDIA card to whatever
already uses it.** The reasoning is not that NVENC is worse — it is better — but:

1. **No session cap** (§8.3), which is the constraint that actually bites Cody's
   one-container-many-sessions model.
2. **No contention with the media server**, which is usually the dGPU tenant and
   whose failures are far more visible to the household than a soft preview.
3. **Lower blast radius**: `--device /dev/dri/renderD128` is a device node, not a
   runtime swap; it does not require the Nvidia Driver plugin or `--runtime=nvidia`.
4. The quality difference is real but small at desktop bitrates, and it is
   dominated by the 19–27× win from moving off JPEG at all (§2.2).

**Switch to NVENC if** the dGPU turns out to be idle, the card is Turing+, and
§12's measurement shows the iGPU cannot sustain the session count. That is a
measurement-driven change, and the fallback chain makes it a one-line
reconfiguration rather than a rewrite.

### 8.5 The degradation chain (build this, do not configure it)

```
VAAPI (vah264enc)  →  NVENC (nvh264enc)  →  x264enc tune=zerolatency  →  JPEG (today's path)
```

Probe at pipeline construction, fall through on failure, and log which rung was
taken. Four rungs, each earning its place:

- **VAAPI first** because it is the documented default (§8.4) and has no session
  cap.
- **NVENC next** when VAAPI is unavailable *or* explicitly preferred by
  configuration — but note it can fail at *session-open* time for reasons that
  have nothing to do with this process (another tenant holds the last session), so
  it must be a fall-through and not a fatal error.
- **x264 `tune=zerolatency`** because a Cody that cannot show a desktop without a
  GPU is worse than a slow one, and because the container may legitimately run
  with no passthrough at all.
- **JPEG last**, which costs nothing to keep: it is the rung that exists today and
  it is the only one guaranteed to decode in every browser (§5.1's
  `firefox_android` gap). It is also, awkwardly, the sharpest rung for static text
  — see §8.8.

Surface the active encoder the way the ladder surfaces the active rung. A silent
downgrade to software x264 — or to JPEG — is exactly the class of thing Cody's
design philosophy already rejects.

### 8.6 What device passthrough does **not** give you

- **Not an X server, and not a display.** These are codec devices. Xvfb (§6.1) is
  still required.
- **Not automatic GL/Vulkan for a headless process.** Selkies' experience is the
  cautionary tale: a Wayland compositor needs "a working GBM/EGL stack on a DRM
  render node", and where there is none it silently "composites in software and
  hands its clients no dmabuf either" — which is why they ship a runtime probe
  instead of trusting the device path.
- **Not accelerated Chromium by itself.** Passing a device changes nothing until
  Chromium's flags change too. `GpuPassthrough` has landed that separately, gated
  on `CODY_GPU_RENDER_NODE`, with a verified working set worth recording here so
  nobody re-derives it: **`--use-gl=angle --use-angle=gl-egl
  --enable-gpu-rasterization --ignore-gpu-blocklist`**, plus a fail-safe relaunch
  in software if that fails. Note the trap: **`--use-gl=egl` is REJECTED on
  Chromium 151** — verified from Chromium's own log, not inferred — so the older
  advice you will find for VAAPI-in-Docker is wrong for this version.
  Scope, carefully: even with rasterization accelerated, **the CDP path's dominant
  cost is JPEG encoding, which neither VAAPI nor NVENC accelerates in that
  pipeline.** GPU rasterization makes the page *draw* faster; it does not make the
  stream cheaper, and it is not expected to lift the pixel-rate ceiling in §2.2b.
  The encode win in this section belongs to §4.2, not §4.1.
- **Not AV1 encode**, on the iGPU at all, and on the dGPU unless it is Ada+.

### 8.7 The concrete Unraid changes

**For the Intel iGPU (recommended):** on the container template use **Add another
Path, Port, Variable, Label or Device** → type **Device**, value
`/dev/dri` (or specifically `/dev/dri/renderD128`). The Docker equivalents
Jellyfin documents are `--device /dev/dri/renderD128:/dev/dri/renderD128` plus
`--group-add="<gid>"`, where the gid comes from the host:

```bash
getent group render | cut -d: -f3
```

The group matters: Jellyfin's listing shows `renderD128` owned by `render` while
`card*` is owned by `video`, and warns "On some releases, the group may be `video`
or `input` instead". Miss the group and every VAAPI call fails in a way that reads
as "no hardware". Verify inside the container with:

```bash
vainfo --display drm --device /dev/dri/renderD128
```

**For NVENC (if §8.4 goes the other way):** install Unraid's **Nvidia Driver**
plugin, then on the template add `--runtime=nvidia` (Extra Parameters) and two
variables:

- `NVIDIA_VISIBLE_DEVICES=<GPU-UUID>` — the UUID from §8.1. Per NVIDIA's container
  toolkit docs this accepts "a comma-separated list of GPU UUID(s) or index(es)",
  and pinning by UUID rather than index is what survives a reboot that reorders
  devices.
- `NVIDIA_DRIVER_CAPABILITIES=compute,utility,video` — **this is the gotcha.**
  NVIDIA's own table documents `video` as "required for using the Video Codec
  SDK", and documents the default when the variable is empty or unset as
  `utility, compute`. So the common `compute,utility` value **silently omits
  NVENC**: `nvidia-smi` works, CUDA works, and encoding fails
  ([NVIDIA Container Toolkit: Driver Capabilities](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/docker-specialized.html)).

**Image state, accurately:** the VA-API *runtime* has landed — `intel-media-va-driver`
(iHD), `libva-drm2`, `vainfo` and the EGL libs are in `docker/Dockerfile` now. What
is still absent, and one of those absences is a deliberate decision rather than an
oversight:

- **No `ffmpeg`, and no GStreamer.** The Dockerfile says why, explicitly: "nothing
  in the app consumes them yet, and they would dwarf this" — the whole VA-API group
  costs 15.2 MB, of which the driver is 13.8 MB. A GStreamer stack with the `va`
  plugin is a different order of magnitude.
- **No `nvidia-smi`**, which arrives with the NVIDIA runtime's `utility` capability
  rather than from a package (§8.7).
- **No Xvfb, and no XTEST-capable input path**, both of which §4.2 needs.

**This makes the Phase 2 image cost a real decision, not a detail.** See §11's
Phase 2 note: the encode pipeline this document recommends is specified in
GStreamer terms because that is what neko and selkies actually use and what the
documentation I could verify describes — but Cody's image deliberately has no
GStreamer, so adopting it means justifying that size increase or choosing a
narrower dependency. Do not treat the pipeline strings in §6.2 and §8 as though the
dependency were already paid for.

`docs/unraid.md` will need a matching subsection when this lands, alongside the
existing "Full-fidelity previews behind HTTPS" section. `GpuPassthrough` owns
that; this document should not duplicate it.

### 8.8 The 4:2:0 text-sharpness risk — read this before promising "crisp"

The quality bar is "crisp and as close to native as possible with the best
latency". There is a real tension in that sentence which every other section of
this document glosses over, so it gets stated plainly here:

> **Moving from JPEG to H.264 is a large win on bandwidth, latency and motion, and
> can be a *loss* on static text sharpness.** The 19–27× bandwidth figure in §2.2
> is real, but it is not free.

**Why.** H.264's mainstream profiles code chroma at 4:2:0 — four luma samples
share one chroma pair. For natural video that is invisible; for screen content it
is not. The academic framing is unambiguous: "chroma subsampled 4:2:0 TGM data …
can cause significant issues concerning the readability of the textual content; in
other words, the readability of text is much clearer in 4:4:4 screen content video
data" ([JND-Based Perceptual Video Coding for 4:4:4 Screen Content Data in HEVC,
arXiv:1710.09919](https://arxiv.org/pdf/1710.09919)). The damage lands hardest on
exactly what Cody shows: sub-pixel-antialiased text, thin UI borders, and coloured
text — perceived resolution "drops first on red or blue text, desktop icons,
browser tabs" rather than on large bright shapes.

**This is not a theoretical concern; it is why the incumbents pay for 4:4:4.**
Microsoft RDP forces 4:4:4 even when it is using H.264. Citrix HDX exposes 4:4:4
vs 4:2:0 as an explicit quality/bandwidth choice
([GO-EUC comparison](https://www.go-euc.com/evaluating-the-visual-quality-and-colour-differences-of-fullscreen-h265-video-compression-with-yuv-420-and-yuv-444-in-citrix-hdx/)).
Jump Desktop shipped 4:4:4 as a headline "studio-quality" remote-desktop feature.

**And 4:4:4 is not available to us in hardware.** Two independent blockers:

1. **Encode.** UHD 630 is Gen 9.5: H.264 and HEVC, 4:2:0. `[UNVERIFIED — confirm
   by running `vainfo` in the container (it is installed now) and looking for a
   `VAProfileH264High444` / 4:4:4 entrypoint; expect it to be absent. Note the
   boot probe does NOT answer this: it detects the render node and reads the PCI
   vendor id from sysfs, it does not enumerate VA profiles.]`
2. **Decode.** H.264's 4:4:4 capability lives in the High 4:4:4 Predictive
   profile, which in practice is a professional post-production format, not a
   streaming one, and has no meaningful browser hardware-decode support. Note the
   asymmetry: WebCodecs' `VideoPixelFormat` enum *does* define `I444`, `I444P10`,
   `I444P12` and their alpha variants, so a `VideoFrame` can *represent* 4:4:4 —
   that says nothing about whether any shipped `VideoDecoder` will produce one from
   an H.264 bitstream.

So AV1 or HEVC-with-SCC-tools are the codec-level answers, and neither is reachable
here: AV1 encode needs Arc or an Ada-class NVIDIA card (§8.1, §8.3), and HEVC
screen-content coding is not on Gen 9.5 either.

**What to actually do — in preference order:**

1. **Do not use one codec for both regimes. Switch on content, like KasmVNC
   does.** This is the single best answer available and it is proven prior art:
   KasmVNC keeps lossy-image *and* video paths and switches between them on
   measured screen change, with configurable thresholds
   (`enter_video_encoding_mode.time_threshold` / `area_threshold`,
   `exit_video_encoding_mode.time_threshold`) and a separate
   `video_streaming_mode` carrying `codec`/`quality`/`gop` (§9). Sunshine's
   variable-frame-rate instinct is the same idea from the other direction. For
   Cody this maps onto the degradation chain it already needs: **static screen →
   JPEG/still path at 4:4:4-ish quality; moving screen → H.264 4:2:0.** Text is
   read when it is still, and chroma error is masked when it moves.
2. **Spend bitrate, and drop the profile floor.** Lower QP does not restore chroma
   *resolution*, but it removes the compounding blocking and ringing that makes
   4:2:0 text look worse than it has to. There is room: neko's default is only
   ~2.0 Mbps for an entire desktop, and §2.2 shows even a generous H.264 bitrate is
   an order of magnitude under the JPEG path. Two specific knobs, both of which
   neko sets against sharpness because it optimises for latency:
   `profile=constrained-baseline` → main or high once §10.1c has negotiated the
   client's real capability, and `target-usage=7` (the *fastest* end of VA's 1–7
   scale) → something slower once the pixel-rate headroom exists.
3. **Never rescale, and if you must, never with nearest-neighbour.** Much of what
   reads as "blurry" in the current rung was resampling, not chroma (§1), and any
   resample on top of 4:2:0 is multiplicative — so the density work is a
   prerequisite for judging chroma at all. Concrete trap from neko's source: its
   `videoscale method=0` is **nearest neighbour** (`pkg/types/capture.go:217`),
   which is actively destructive to antialiased text. If Cody's pipeline ever
   scales, that value must not be copied.
4. **Consider 4:4:4-over-4:2:0 tunnelling only if 1–3 are insufficient.** The
   technique is real and documented — packing full-resolution chroma into
   auxiliary 4:2:0 frames, which is how RDP achieves 4:4:4 over a 4:2:0 codec
   ([Microsoft Research, *Tunneling High-Resolution Color Content through 4:2:0
   HEVC and AVC Video Coding Systems*](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/DCC1320Wu_et_al20Hi-Res20Color.pdf))
   — but it roughly doubles the encoded payload and requires a matching client-side
   recombination step. **Recommendation: do not build this.** It is the correct
   answer for a product whose whole value is colour fidelity; it is disproportionate
   for a coding assistant's preview pane. Record it as the known escape hatch.

**The honest summary for the owner:** for an X11/Wayland desktop and an Android VM
— where content moves — H.264 at a generous bitrate will look dramatically better
than today's rung, because motion is where JPEG collapses. For a *static page of
small text*, today's JPEG rung may remain the sharper renderer, and that is a
reason to keep it as rung 4 of §8.5 rather than delete it. §12 item 5 is the
measurement that decides whether the content-switching design in point 1 is worth
building or whether generous-bitrate 4:2:0 is simply good enough.

**Open question, deliberately unanswered:** whether Unraid's stock kernel exposes
a `renderD*` node for this iGPU without further action (i915 module, BIOS iGPU
enable while a dGPU drives the console). Jellyfin's instruction is "Make sure at
least one `renderD*` device exists in `/dev/dri`. Otherwise upgrade your kernel or
enable the iGPU in the BIOS." The boot probe reports whether a `renderD*` node is
visible *inside the container* (`CODY_GPU_RENDER_NODE`), which answers the
passthrough question but not the host-kernel question — with the template entry
still pending, an empty value currently proves nothing about the host
`[UNVERIFIED]`.

---

## 9. Other prior art, briefly

Compressed to the decision-relevant facts: transport, codec, input, and whether
it can live inside an already-authenticated web app.

| Project | Transport | Codec | Input | Embeddable in Cody? |
| --- | --- | --- | --- | --- |
| **[neko](https://github.com/m1k1o/neko)** | WebRTC (Pion) **only** — no WebCodecs, no MSE, no WS video fallback; client hard-refuses without `RTCPeerConnection` | VP8/VP9/AV1/H264/H265 via GStreamer | X11 keysyms via XTEST XInput | Own auth + own UI; via `native` gateway only (§4.3) |
| **[selkies](https://github.com/selkies-project/selkies)** (MPL-2.0) | **WebSocket default**, WebRTC opt-in | H.264 (NVENC/VAAPI/x264/OpenH264) or JPEG | XTEST/XFixes | **Yes** — "any HTML5 web interface you wish to embed inside" |
| **[KasmVNC](https://github.com/kasmtech/KasmVNC)** | WebSocket; WebRTC UDP transit | JPEG/WebP/QOI tiles **+ WebCodecs H.264/H.265/AV1** | RFB-derived | Ships `COOP: same-origin` + `COEP: require-corp` — hostile to embedding |
| **[noVNC](https://github.com/novnc/noVNC)** | WebSocket (or `RTCDataChannel`) | RFB Tight/TightPNG | RFB | **Yes**, cleanest API of any (below) |
| **[Sunshine](https://github.com/LizardByte/Sunshine)/Moonlight** | GameStream: RTSP handshake + ENet control + RTP over UDP `[UNVERIFIED — from a third-party bridge's description, not Sunshine's source]` | H.264/HEVC/AV1 | GameStream | **No** (below) |
| **[ws-scrcpy](https://github.com/NetrisTV/ws-scrcpy)** | WebSocket | H.264 | scrcpy control msgs | Reference implementation, not a dependency (§7.2) |

Three worth a sentence more:

- **noVNC** has the API shape Cody should imitate for its own client module:
  `new RFB(target, urlOrChannel, options)` where `target` is an `HTMLElement`
  and `urlOrChannel` may be a URL, **a `WebSocket`, or an `RTCDataChannel`**
  ([API.md](https://github.com/novnc/noVNC/blob/master/docs/API.md)). Accepting a
  live socket rather than a URL is what makes it embeddable in an app that
  already did its own authentication — a lesson Cody's `StreamedDisplay` can take
  directly. What noVNC cannot do is video-rate content, for the reason selkies
  articulates: RFB's Tight encoding, "combining 'rectangle, palette and gradient
  filling with zlib and JPEG'", is "adequate for partial screen refresh, but not
  fullscreen refresh and 3D graphics".
- **KasmVNC** is the most interesting *technical* comparison, because it reached
  the same conclusion as this document from the VNC side: it "has broken from the
  RFB specification… in order to support modern technologies", and its feature
  list now includes "WebCodecs video streaming with H.264, H.265, and AV1
  support" alongside a `video_streaming_mode` with `codec`/`quality`/`gop` and a
  `gpu.drinode: /dev/dri/renderD128` setting. Independent convergence on
  WebCodecs + a render node is a good sign for §4.2.
- **Sunshine/Moonlight is not vendorable for a browser**, and Moonlight's own FAQ
  explains exactly why: "there is not a pure web-based Moonlight client. The
  GameStream protocol requires us to use raw TCP and UDP sockets which is not
  currently supported in web browsers." The official `moonlight-chrome` was
  archived in June 2025. Third-party bridges exist (e.g. `linckosz/moonlight-web`,
  which relays GameStream to the browser over WebRTC with WebCodecs decode) but
  it is **GPL-3.0**, which is a licensing decision for Cody, not just a technical
  one. Take Sunshine's *ideas* — variable frame rate on static content, an
  explicit latency budget broken into network/decode/queue/render — and none of
  its code.

---

## 10. The plug-in point: concrete seam changes

Mapping onto the real code. Nothing here requires a rewrite; the seam was built
for this.

### 10.1 `lib/display/types.ts`

**(a) `source` must become a union.** Today `DisplayRequestV1.source` is
`WebDisplaySource` (`kind: "web"`, a loopback `url`). Add siblings:

```ts
export interface X11DisplaySource { kind: "x11"; display: string }      // e.g. ":99"
export interface AndroidDisplaySource { kind: "android"; serial: string }
export type DisplaySource = WebDisplaySource | X11DisplaySource | AndroidDisplaySource;
```

> **Security note, and it is the important line in this section.**
> `lib/display/validation.ts` is the SSRF guard, and it guards a *URL*. An
> `x11`/`android` source has no URL, so it does not pass through that check at
> all — it bypasses rather than weakens it. Whatever admits these sources needs
> its own authority check (they should only ever be mintable by the
> capability-token path in `lib/display/capability.ts`, never from a
> model-supplied string). Do not widen the loopback rule to accommodate them.

**(b) `hello.media` must describe a codec, not a mime literal.** Today it is the
literal `"jpeg"`. Widen it while keeping the old value decodable:

```ts
export type DisplayMedia =
  | { kind: "image"; mime: "image/jpeg" }
  | { kind: "video";
      /** Fully qualified RFC 6381 string, e.g. "avc1.640028" — profile and level
       *  are ENCODED IN IT, so do not add separate profile/level fields. */
      codec: string;
      /** AvcBitstreamFormat. "annexb" + absent `description` is the live case. */
      bitstream: "annexb" | "avc";
      /** AVCDecoderConfigurationRecord, base64. Present iff bitstream is "avc". */
      description?: string;
      /** Coded frame size. May differ from the client's CSS viewport. */
      codedWidth: number;
      codedHeight: number;
      /** 4:2:0 today; named so a future 4:4:4 rung is not a breaking change (§8.8). */
      chroma: "4:2:0" | "4:4:4" };
```

On **profile and level**: they are not separate fields, because RFC 6381 already
carries them in the codec string — `avc1.640028` *is* High profile, level 4.0
(`64` = profile_idc 100, `00` = constraint flags, `28` = level_idc 40). Adding
`profile` and `level` alongside `codec` would create two sources of truth that can
disagree. The provider's job is to emit a codec string the client has already
confirmed it can decode, which is what (c) is for.

**(c) A decoder-capability handshake.** `hello` is server→client, so the client
must speak first. Add one additive `DisplayClientControl` variant, sent
immediately on open:

```ts
| { type: "capabilities";
    /** Codec strings the client confirmed via VideoDecoder.isConfigSupported().
     *  Ordered by client preference. Absent/empty ⇒ image path only. */
    decode?: string[];
    /** Client's own view of its surface, so the provider can size the encoder
     *  before the first frame instead of after the first `resize`. */
    width?: number; height?: number; deviceScaleFactor?: number }
```

The provider intersects that list with what its active encoder rung (§8.5) can
actually produce, picks the first match, and falls back to JPEG when the list is
empty or absent — which is exactly what an older client that never sends
`capabilities` looks like. Note the ordering requirement: the client must call
`VideoDecoder.isConfigSupported()` and report only *confirmed* strings, because
`hardwareAcceleration` is a hint the UA may ignore (§5.1) and a codec the client
merely recognises is not a codec it can decode.

**Who owns resolution and density — decide this once, in the protocol.** Today it
is muddled: the client proposes via `resize`, and the provider both clamps *and*
is silently constrained by a launch flag it cannot change (§1). For the codec
provider make it explicit and one-directional:

- **The client owns the request.** It knows its CSS size, its DPR, and its
  container. It sends `width`/`height`/`deviceScaleFactor` and nothing else.
- **The provider owns the decision, and must report it.** It clamps to what the
  surface and encoder can do and then states the result in `media.codedWidth` /
  `codedHeight`. The client scales the decoded `VideoFrame` into its canvas from
  those numbers rather than assuming its request was honoured.
- **A density change is a stream event, not a silent adjustment.** Re-emit `hello`
  (or a `media` update) whenever the coded size changes, because the client must
  `configure()` the decoder again and, per §5.1, the next chunk must then be a
  keyframe. This is precisely the case the CDP path cannot serve at all, since its
  density is fixed at browser launch.

That contract is what makes an X11 provider strictly better than CDP rather than
merely different: an X screen can be resized and the encoder reconfigured mid
session, so the round trip above actually terminates in the client getting what it
asked for.

**(d) `renderer` needs a value for "codec over our own socket".** The union is
`"raster" | "webrtc" | "native"`. A WebCodecs-over-WebSocket provider is none of
those; calling it `"webrtc"` would be a lie that the client might act on. Add
`"video"`. And keep the client gating on `hello.input` / `media`, never on
`renderer` — the existing comment in `types.ts` already says this.

**(d2) The keyboard contract does not survive the move to X11 — decide where the
mapping lives.** `DisplayClientControl`'s `keyboard` variant carries
`key`/`code`/`modifiers`, which is shaped for CDP's `Input.dispatchKeyEvent`. An X11
provider needs an X **keysym**, and the two are not mechanically interconvertible:
neko does the conversion in the *browser*, with Guacamole's vendored keyboard
mapping, and puts a bare `uint32` keysym on the wire (§6.3). So there is a real
choice here, and it should be made deliberately rather than discovered:

- **Map client-side**, as neko does, and add a `keysym?: number` field alongside the
  existing `key`/`code`. Pro: the browser has the full `KeyboardEvent`, including
  `location`, which is what disambiguates left/right modifiers and numpad keys.
  Con: ships a keymap table to every client and makes the wire surface-specific.
- **Map server-side**, keeping the wire as it is, and translate `code` → keysym in
  the provider. Pro: the wire stays surface-agnostic, which is a stated constraint
  of this whole seam, and older clients keep working unchanged. Con: `code` alone
  loses information the browser had, so the table has to be more careful.

**Recommendation: server-side is the primary map, but the client should send a
keysym when it knows one — and the server prefers it.** Neither pure option is
complete, and it is worth being precise about why:

- Server-side must be the *primary* map, because keeping the wire surface-agnostic
  is a stated constraint of this seam and because it keeps the fiddly table in one
  place Cody controls. neko pays structurally for the opposite choice: its keysym
  conversion, browser-quirk handling and `recentKeysym` cache live in a **1540-line
  vendored file** (`client/src/utils/guacamole-keyboard.js`), which every
  non-browser client would have to reimplement. Cody must carry CDP, X11 *and* an
  Android VM over this one seam, so that cost lands harder here than it does there.
- But a server-side map **cannot** be complete either, because **only the browser
  knows its own keyboard layout and IME state**. A `code` is a physical position,
  not a character.

So the honest design is additive and already fits the wire: keep `key`/`code`/
`modifiers`, add an optional `keysym?: number`, and have the provider **prefer the
keysym when present** and fall back to its own table when it is not. That also gives
the client a way to say "I am confident about this one" — which is exactly what
neko's `reliable` flag expresses (`guacamole-keyboard.js:230-231`), and it is the one
piece of Guacamole worth lifting even if the rest is rejected.

Budget for this honestly regardless: it is the fiddliest single piece of the X11
provider, it is where neko needed three fallback tiers including rewriting the XKB
map at runtime (§6.3), and it is the most likely source of "most keys work but some
do not" bug reports.

**(e) Per-chunk metadata for video frames.** JPEG frames are self-delimiting;
encoded video chunks are not — the client needs `key` vs `delta` and a timestamp
to build an `EncodedVideoChunk`. WebSocket already frames messages, so a small
fixed binary prefix on each binary message is enough. Borrow scrcpy's proven
layout (§7.1) rather than inventing one: **flags byte** (bit 0 key, bit 1
config/parameter-sets) followed by a **64-bit PTS in microseconds**. scrcpy's
`u32` length field is redundant here because WS gives us the length, so a 9-byte
prefix suffices; pad to 12 if alignment is wanted.

### 10.2 `lib/display/provider.ts`

`DisplayProvider` (`descriptor` / `requestId` / `attach` / `dispose`) is already
the right interface and needs **no change** — which is the strongest evidence the
seam was designed correctly. The work is a second implementation beside
`RasterWebProvider`, plus turning `attachDisplaySocket`'s hardcoded
`new RasterWebProvider(...)` into a selection on `request.source.kind`.

Three lessons to carry into the new provider:

- **Derive capture bounds from the scaled viewport, never hardcode them.**
  `RasterWebProvider` now does this (`maxWidth = ceil(width × scale)` under a
  `MAX_FRAME_EDGE` cap); the previous fixed `1920×1200` against a DSF-2 viewport
  is what made sharp frames get resampled twice. neko expresses the same idea as
  expressions over live `width`/`height`/`fps`. Do not reintroduce the constant.
- **Density must be reconfigurable at runtime.** This is where the new provider gets
  to be *better* than CDP, not merely equal, and `NekoStudy`'s audit confirms the
  claim end to end rather than leaving it aspirational. `RasterWebProvider` is stuck
  with `--force-device-scale-factor` fixed at launch (§1), so a client that changes
  DPR mid-session cannot be served without relaunching Chromium. neko resizes live:
  `xorg.ChangeScreenSize` tries `XRRSetScreenConfigAndRate` and, on failure,
  **creates the mode first** (`XRRCreateMode` + `XRRAddOutputMode` on every output),
  generating the modeline at runtime with `libxcvt_gen_mode_info`
  (`xorg.c:284-311`, `:357-409`); width is rounded to a multiple of 8 and the rate
  defaults to 60 (`xorg.go:200-238`). Downstream, `capture/manager.go:203-234`
  destroys and recreates the pipelines, and because they are rebuilt from
  `GetPipeline(desktop.GetScreenSize())` every width/height/fps expression
  re-evaluates.

  Three consequences worth designing around:

  1. **The transport survives the resize.** In neko the `PeerConnection` and its
     tracks are untouched — no renegotiation, no ICE restart — and a keyframe lobby
     (`streamsink.go:173-196`) guarantees the first post-resize sample is an IDR.
     That is precisely the contract §10.1 specifies for Cody: re-emit the media
     descriptor, then send a keyframe, without tearing down the socket.
  2. **It needs a patched X driver.** Upstream `xf86-video-dummy` 0.3.8 has no
     CRTC or output at all; neko carries a 316-line patch grafting on a RandR 1.2
     provider including `DUMMYAdjustScreenPixmap`
     (`01_v0.3.8_xdummy-randr.patch:49-50`, `:98-118`, `:131-191`), plus
     deliberately permissive `HorizSync 5.0-1000.0` / `VertRefresh 5.0-200.0` in
     `xorg.conf:45-46` so any generated modeline validates. That is a real
     dependency to plan for, and it belongs in the §11 Phase 1.5 accounting.
  3. **neko's resize is admin-only and global** (`handler/screen.go:12-24`) —
     one screen, one size, broadcast to every viewer. Cody's model is per-session
     surfaces, so this is one of the few places the neko design must be
     *changed* rather than copied: density belongs to the session, not the server.
- **Offer named quality pipelines rather than one constant, and surface which one
  is live.** This is the same "the active rung is visible" principle the ladder
  already enforces — a silent quality downgrade is the thing to avoid.

### 10.3 `lib/display/native-gateway.ts` and `lib/display/ladder.ts`

- `resolveDisplayCandidates()` currently always terminates in `{ kind: "stream" }`
  and that invariant should hold — it is what makes the floor unfailable.
- For §4.3's sidecar, add a candidate kind that is **proxied like `native`**, so
  it inherits the credential-stripping wildcard-subdomain hop that already
  exists. Do not add a rung that needs client-side UDP; that would break the
  ladder's promise that the floor "needs nothing of the client's network".
- `orderDisplayCandidates()` is pure and unit-tested (`lib/display.test.mjs`).
  Any new kind must be added to its filter deliberately: the mixed-content and
  loopback-is-this-machine rules are correctness, not preference.
- A desktop/Android source has no meaningful `direct` or `native` rung — there is
  no origin to frame — so for those sources the ladder is a single rung. Worth
  making explicit rather than letting it fall out of an empty list.

---

## 11. Phased recommendation

**Phase 0 — the current path (landed / in flight, no new decisions).**
Sharpness (screencast bounds derived from the scaled viewport, density via
`--force-device-scale-factor`), ack pacing with a stalled-client drain, clipboard,
pop-out. This is the everyday path for the owner and it stays the floor forever.
No new protocol. What remains is **measurement**, not code — items 1–5 of §12.

**Phase 0.5 — GPU passthrough (owned by `GpuPassthrough`; partly landed).**
Already in: the iHD driver, `libva-drm2`, `vainfo` and EGL libs in
`docker/Dockerfile`, plus a boot-time probe in `docker/entrypoint.sh` publishing
`CODY_GPU_RENDER_NODE` / `CODY_GPU`, and GPU rasterization for the current Chromium
path gated on that render node. Still pending: the `/dev/dri` **Device** entry in
`docker/unraid-template.xml` and the `docs/unraid.md` section. Everything below
consumes `CODY_GPU_RENDER_NODE` rather than probing for itself; §8.7 is the
operator-facing summary, not a duplicate specification.

**Phase 1 — prove the codec seam, with no new frame source and no new dependency.**
Deliberately decoupled from Phase 0.5 because it needs **no GPU**: land the
*protocol* half of §10.1 against the existing Chromium source — `capabilities`
handshake, `DisplayMedia` with codec/bitstream/coded-size/chroma, the per-chunk
binary prefix, the resolution-ownership contract, and a `VideoDecoder` path in the
client with the JPEG rung retained. Doing the protocol first means the risky part —
browser decode, keyframe recovery, capability negotiation, fallback — is proven
while the frame source is still the one that already works, and it sits behind
neither a container change nor an image change.

**Phase 1.5 — the encoder dependency, now costed.** `docker/Dockerfile` deliberately
ships **no GStreamer and no ffmpeg** ("nothing in the app consumes them yet, and
they would dwarf this"), yet every pipeline in this document is written in GStreamer
terms. `NekoStudy` costed the options against the Debian trixie/amd64 index (the
base neko builds on), and the numbers **invert** what I had assumed:

| Package | Download | Installed |
| --- | --- | --- |
| `intel-media-va-driver-non-free` (iHD) | 6,568.8 kB | ~40 MB |
| `gstreamer1.0-plugins-bad` | 3,261.5 kB | ~12 MB |
| `gstreamer1.0-vaapi` | 310.5 kB | 906 kB |
| `libva2` | 77.5 kB | 250 kB |
| `libva-drm2` | 17.9 kB | 44 kB |
| `vainfo` | 16.3 kB | 50 kB |

**The decisive fact is not size, it is package contents.** From the actual file
lists, the two GStreamer packages ship **disjoint** plugins:

- `gstreamer1.0-plugins-bad` ships `libgstva.so` **and** `libgstnvcodec.so` — i.e.
  it satisfies both `vah264enc`/`vah265enc` **and** `nvh264enc`/`nvautogpuh264enc`.
- `gstreamer1.0-vaapi` ships **only** `libgstvaapi.so` — the *legacy* `vaapi*`
  elements.

So: **do not add `gstreamer1.0-vaapi`.** It is not a small cost to accept, it is a
dependency that buys nothing we want — its sole contribution is the legacy element
family, of which neko uses exactly one (`vaapivp8enc`, `capture_pipeline.go:85`) on
a path neko's own comment says is disappearing from recent Intel silicon. neko's
Intel image carries it as a legacy artefact alongside its deprecated `NEKO_HWENC` V2
bridge, so copying that package list wholesale imports both mistakes. This also
explains something otherwise puzzling: neko's *nvidia* flavour adds no extra
GStreamer package at all, because `plugins-bad` already covers NVENC.

**Revised conclusion.** Cody's image already has the VA driver side
(`intel-media-va-driver`, `libva-drm2`, `vainfo` — §8.7). What is genuinely missing
is GStreamer itself, and the marginal cost of the encoder plugins on top of that is
`plugins-bad` at ~12 MB — modest, and it covers **both** VAAPI and NVENC with one
package, which is exactly what §8.5's degradation chain needs. That makes
**GStreamer the front-runner rather than the expensive option**, and it removes the
main argument I had for the ffmpeg or libva-shim alternatives:

- **GStreamer + `plugins-bad`** — one package covers both hardware encoders, and
  neko's and selkies' pipeline strings and tuning transfer directly. **Recommended.**
- **ffmpeg with `h264_vaapi`** — still viable, and `x11grab`/`kmsgrab` live in the
  same binary, but it no longer wins on footprint and the prior art's tuning does not
  transfer as cleanly.
- **libva directly, or a small encoder shim** — what selkies chose with `pixelflux`.
  Smallest footprint, most code to own; justified only if the GStreamer core turns
  out to be the bulk of the cost.

Remaining `[UNVERIFIED]`: the GStreamer **core** (`libgstreamer1.0-0`,
`gstreamer1.0-plugins-base`) that `plugins-bad` pulls in is not in the table above,
so the true delta is larger than 12 MB. Measure the full `apt-get install` delta
before committing — but measure it knowing the plugin question is already settled.

**Phase 2 — the X11 provider on VAAPI.**
Xvfb + damage-aware capture + **`vah264enc` (or the Phase 1.5 equivalent) as the
primary encoder**, with the §8.5 degradation chain behind it (NVENC as a runtime
option, x264 and then JPEG as floors) + XTEST injection, behind the same
`DisplayProvider` interface, over the same authenticated WebSocket. This is neko's
architecture on Cody's transport, which is selkies' proven combination. Requires
Phase 0.5 (template entry) **and** Phase 1.5 (dependency decision), and adds Xvfb
plus an XTEST path to the image. Resolve §8.8's content-switching question here
rather than later — it changes the pipeline shape, not just a constant.

**Phase 3 — Android.**
`scrcpy-server` with `raw_stream`/`send_frame_meta` framing into the same
provider seam; its key-frame flag and PTS map straight onto `EncodedVideoChunk`.
Reuse the whole Phase 1 client.

**Defer:** WebRTC (§5.2) until measurement shows TCP stalls that are perceptible
on a Tailscale/WireGuard path. WebTransport (§5.3) until Caddy's HTTP/3 forwarding
story is verified, then reconsider seriously — it is the best technical fit.
Wayland capture until X11 is shipped and something actually needs it.

**Never bother with:** Sunshine/Moonlight as a browser target (its own FAQ rules
it out); the archived Android emulator WebRTC bridge; RFB/noVNC as a transport
(right embedding API, wrong wire); AV1 on this hardware; and a neko sidecar for
the *web preview* case.

---

## 12. What must be measured to validate each phase

Claims in this document that rest on inference, and the experiment that settles
each. Nothing above should be promoted from "expected" to "true" without these.

**Phase 0**
1. ~~Bytes/frame and frames/second on the real screencast path.~~ **Largely
   answered — see §2.2b.** `GpuPassthrough` measured it under continuous animation
   and independently confirmed the geometry contract is exact at dpr 1/2/3 including
   the `MAX_FRAME_EDGE` clamp. What remains open is the *static-page* counterpart
   on the current code (the earlier fixture that produced ~29 fps is deleted), so
   the realistic-content case between "still image" and "60 Hz animation" is still
   unmeasured. That middle case is the one the owner actually experiences.
2. ~~Whether any resample remains.~~ **Answered.** The geometry contract is exact
   at every tested density (§2.2b), so no resample remains in the sizing path. The
   residual softness question is now purely about chroma and quantisation, which is
   §8.8 and item 5, not geometry.
3. ~~Input-to-photon latency baseline.~~ **Answered — see §2.2c.** Full-viewport
   repaint latency on an idle page is 25 ms median at 1280×800 rising to 115 ms at
   4096×2560, ≈13–16 ms fixed plus ~9–10 ms/Mpx, with ≈64 ms interpolated for the
   owner's real 2880×1800 panel. Every later "it feels faster" is now falsifiable
   against those numbers. What is still unmeasured is the *end-to-end* figure
   including network and client paint on the owner's actual devices over Tailscale,
   rather than server-side to first frame.
4. **How much the per-process density limit actually bites.** Connect two clients
   at different DPR to one session and record what the 1× client sees when a 2×
   client connected first, and vice versa. This is the number that decides whether
   runtime-reconfigurable density (§10.2) is a real requirement for the new
   provider or a nicety — and if the owner only ever uses one device at a time, it
   is a nicety and should be descoped.
5. **The 4:2:0 text-legibility test — do this one first, it can change the plan.**
   It needs no Cody code and no GPU: take a real 1920×1200 Cody/desktop frame,
   encode it to H.264 4:2:0 at a ladder of bitrates (say 2, 5, 10, 20 Mbps) with
   `x264enc tune=zerolatency`, decode, and compare small-text and coloured-text
   legibility side by side against the JPEG rung at q90 (188–267 KB/frame,
   measured in §2.2). The outcome decides §8.8: if generous-bitrate 4:2:0 is
   indistinguishable, the codec path is a clean win and the content-switching
   design is unnecessary complexity; if it is visibly softer on text at any
   bitrate, the KasmVNC-style still/video split in §8.8 point 1 becomes a Phase 2
   requirement rather than an option. Judge it at 1:1 on the owner's actual
   display, not zoomed.

**Phase 1**
6. `VideoDecoder.isConfigSupported()` results on the owner's actual clients —
   including iPad Safari, which is the case MDN's `firefox_android: false` should
   make you paranoid about generally.
7. Decode latency and whether `optimizeForLatency: true` measurably reduces
   output delay for the first frame after an IDR.
8. Recovery behaviour: kill frames mid-GOP and time until the picture is correct
   again, with the `reset()` + wait-for-key protocol.
9. The §2.2 comparison redone honestly: measured H.264 bitrate for *the same*
   content and frame rate, against the measured JPEG bitrate. My 19–27× figure
   pairs my measurement with neko's documented target; a single-machine A/B is
   what makes it a fact.

**Phase 2**
10. **Does `/dev/dri` exist on the Unraid *host*?** The boot probe only sees inside
    the container, and the template `/dev/dri` entry is still pending, so this
    needs one command on the host. It gates all of Phase 2. Then test the one
    **falsifiable prediction** §2.2c makes about it: GPU rasterization should
    *shrink* the ~9–10 ms/Mpx repaint slope, because raster is part of that cost,
    but must **not** eliminate it, because the JPEG encode in the same path is not
    accelerated. If the slope vanishes, my model of where the time goes is wrong; if
    it does not move at all, the flags are not taking effect.
11. The NVIDIA card's model, driver version and **actual** NVENC concurrent-session
    cap for that model, from NVIDIA's own support matrix rather than the secondary
    sources I cited. Then: what a Cody pipeline does when the cap is already
    exhausted by another tenant — does it fail at session-open as §8.2 predicts,
    and does the §8.5 chain actually catch it?
12. Simultaneous 1080p60 encode sessions each GPU sustains before frames are
    dropped — VAAPI on the UHD 630 first, since it is the primary target, and NVENC
    on the dGPU second. Jellyfin says there is no *session cap* on Intel; it says
    nothing about throughput, and I found **no authoritative benchmark** for this
    chip, so measure it rather than quoting anyone.
13. Whether the UHD 630 exposes any 4:4:4 H.264 encode entrypoint at all
    (expected: no). One `vainfo` line, and it closes the §8.8 `[UNVERIFIED]`.
14. CPU cost on each rung of the chain (VAAPI / NVENC / x264 zerolatency), i.e.
    what §8's container change actually buys, and whether the software floor is
    tolerable for one session on this CPU.
15. Whether Cody encoding on the iGPU measurably disturbs whatever already uses
    the dGPU (and vice versa) — the contention question in §8.4, which is a
    household-visible failure if wrong.
16. Whether `use-damage=false` (neko's choice) or damage-driven capture wins for
    Cody's content mix.
16b. **CPU colour-convert versus GPU/zero-copy, measured as Mpx/s not as CPU %.**
    neko's VAAPI path downloads to `video/x-raw,format=NV12` and converts BGRx→NV12
    on the CPU every frame (§8.3). Build both variants — that one, and one keeping
    the conversion on the GPU (`vapostproc` / dmabuf import) — and compare pixel
    throughput at 2880×1800. This is the measurement that says whether the codec
    provider *clears* the pixel-rate ceiling in §2.2b or merely raises it, and it is
    the single most important Phase 2 number.

    **Work out the session budget before building, because it is alarming.** With
    `use-damage=false` the pixel rate is `resolution × framerate` unconditionally,
    with no discount for an idle screen: 1920×1080×30 = **62 Mpx/s per session**.
    Against the 150–180 Mpx/s ceiling measured in §2.2b that is **roughly 2–3
    concurrent 1080p30 sessions on the colour-convert stage alone**, before any
    encoding happens — and that stage is pure CPU in neko's design, so it does not
    benefit from `/dev/dri` at all. For a product whose model is many concurrent
    sessions in one container, that is a capacity wall, not a tuning detail. There
    are exactly two ways off it and neko takes neither: **enable damage** so idle
    sessions cost ≈0, and **get the frame into VA/DMA-BUF memory** so the conversion
    happens on the GPU. Both belong in Phase 2's design, not its optimisation pass.
17. Bitrate on a genuinely static desktop. The whole inter-frame argument
    predicts near-zero; verify it, because if it does not hold the codec change
    bought much less than §2.2 claims.

**Phase 3**
18. End-to-end latency over `adb` versus the X11 path, and whether the Android
    `MediaCodec` encoder's keyframe cadence needs the same server-side
    request-a-keyframe path as §5.1.

**If WebRTC is ever reconsidered**
19. Actual packet loss and RTT on the Tailscale path, and whether
    `tailscale status` reports `direct` or `relay` for the owner's real clients.
    §5.2's entire "defer" verdict rests on loss being negligible and the path
    being direct — measure it before spending the ICE/TURN budget.
