# neko (m1k1o/neko) — source-verified engineering notes for Cody's streamed display

**Source of truth:** shallow clone at `/tmp/neko`, branch `master`, commit `baf21c1`
("feat: remove default configuration to prevend accidental override").
All `path:line` citations are relative to that clone. Browser-API claims cite MDN/spec.

**Method note / honesty disclaimer.** Nine parallel `scout` readers were dispatched to
split this work; all nine died instantly on a provider usage limit
(`code=usage_limit_reached`), the same failure that killed the earlier `librarian`
attempt. Everything below was therefore read by hand. Where I did not open a file, I say
so with `UNCERTAIN:` rather than guess. No identifier below is invented — every element
name, config key, env var and function name was grepped out of the tree. In particular:

- `nvcudah264enc` **does not appear anywhere in neko's source.** (`StreamNextGen`'s
  correction stands, for neko at least.) The only NVENC element names in the tree are
  `nvh264enc`, `nvautogpuh264enc`, `nvh265enc`, and `nvav1enc` (docs table only).
- `vaapih264enc` **does not appear either.** neko's H.264 VAAPI path uses the *newer*
  `va` plugin element **`vah264enc`**. Only VP8 still uses the legacy `vaapi` plugin
  (`vaapivp8enc`).

---

## 0. Executive summary — the eight things worth stealing

| # | neko's decision | Why it matters to Cody |
|---|---|---|
| 1 | **Real Xorg + patched `xf86-video-dummy`**, not Xvfb | Gets RandR 1.2, so resolution is changeable at runtime |
| 2 | **`libxcvt` generates a modeline on demand**, then `XRRCreateMode`+`XRRAddOutputMode` | *Arbitrary* resolution mid-session — the exact thing CDP cannot do |
| 3 | **One encoder per named stream, N listeners fanned out**, keyframe lobby on join | Encode cost is per-*quality*, not per-*viewer* |
| 4 | **Client sends X keysyms, server maps keysym→keycode, rewriting the keymap if needed** | The non-US-layout problem, solved properly (TigerVNC's algorithm) |
| 5 | **Input on a WebRTC DataChannel** with a 3-byte binary header | No JSON per mousemove |
| 6 | **Cursor sent out-of-band** (position + ARGB image over the DataChannel) | Pointer stays smooth and sharp regardless of video bitrate/framerate |
| 7 | **Named GStreamer elements** (`name=encoder`, `name=resolution`, `name=framerate`) | Retune without rebuilding the pipeline |
| 8 | **Pipelines are *expressions* over live `width`/`height`/`fps`** | One config survives every resolution change |

And the four things **not** to steal, because they are exactly Cody's problem:

1. Resolution is **global and admin-only** — neko explicitly punts on per-client sizing.
2. **`use-damage=false`** — neko throws away X damage events and encodes full frames.
3. **No WebCodecs, no MSE, no WS/TCP video fallback** — pure `<video>`+WebRTC or nothing.
4. **One desktop per container.** Many-independent-desktops is delegated to a separate
   orchestrator (`neko-rooms`), not solved in-process.

---

## 1. Transport

### 1.1 Stack

pion, v4 line, from `server/go.mod`:

- `github.com/pion/webrtc/v4 v4.2.11` — `server/go.mod:17`
- `github.com/pion/ice/v4 v4.2.2` — `server/go.mod:13`
- `github.com/pion/interceptor v0.1.44` — `server/go.mod:14`
- `github.com/pion/rtcp v1.2.16` — `server/go.mod:16`
- indirect: `pion/srtp/v3 v3.0.10`, `pion/dtls/v3 v3.1.2`, `pion/sctp v1.9.4`,
  `pion/turn/v4 v4.1.4` — `server/go.mod:35-44`

Imports actually used in the WebRTC manager: `pion/ice/v4`, `pion/interceptor`,
`pion/interceptor/pkg/cc`, `pion/interceptor/pkg/gcc`, `pion/rtcp`, `pion/webrtc/v4` —
`server/internal/webrtc/manager.go:13-18`.

### 1.2 PeerConnection construction, step by step

`newPeerConnection` — `server/internal/webrtc/manager.go:174-269`:

1. **MediaEngine**: fresh `&webrtc.MediaEngine{}`, then exactly two codecs registered —
   the audio codec and the video codec (`manager.go:176-181`, called with
   `[]codec.RTPCodec{audioCodec, videoCodec}` at `manager.go:290-291`). Registration is
   `engine.RegisterCodec(...)` in `server/pkg/types/codec/codecs.go:63-68`.
   **Consequence:** the offer advertises one video codec only — no in-band codec
   negotiation, no fallback list.
2. **SettingEngine** (`manager.go:184-223`):
   - `settings.DisableMediaEngineCopy(true)` — `manager.go:188`
   - `settings.SetICETimeouts(disconnectedTimeout, failedTimeout, keepAliveInterval)` — `manager.go:189`
     with constants `disconnectedTimeout = 4 * time.Second` (`manager.go:41`),
     `failedTimeout = 6 * time.Second` (`manager.go:44`),
     `keepAliveInterval = 2 * time.Second` (`manager.go:47`).
     These are **far more aggressive than pion's defaults** (the comments state the
     defaults as 5 s / 25 s / 2 s at `manager.go:40-47`) — neko gives up on a dead path
     in ~10 s instead of ~30 s.
   - `settings.SetNAT1To1IPs(manager.config.NAT1To1IPs, webrtc.ICECandidateTypeHost)` — `manager.go:190`
     (note: rewrites **host** candidates, not srflx)
   - `settings.SetLite(manager.config.ICELite)` — `manager.go:191`
   - `settings.SetAnsweringDTLSRole(webrtc.DTLSRoleServer)` — `manager.go:194`, with the
     comment at `manager.go:192-193`:
     > `// make sure server answer sdp setup as passive, to not force DTLS renegotiation`
     > `// otherwise iOS renegotiation fails with: Failed to set SSL role for the transport.`
     **This is a hard-won iOS Safari fix worth copying verbatim.**
   - Network types are set explicitly from what is actually configured:
     `settings.SetICEUDPMux(manager.udpMux)` (`manager.go:200`) **or**
     `settings.SetEphemeralUDPPortRange(min, max)` (`manager.go:206`), plus
     `settings.SetICETCPMux(manager.tcpMux)` (`manager.go:215`), then
     `settings.SetNetworkTypes(networkType)` (`manager.go:223`).
     `SetEphemeralUDPPortRange`'s error is deliberately discarded (`_ =`, `manager.go:206`).
3. **InterceptorRegistry** (`manager.go:226-256`): empty registry; if the estimator is
   enabled, a `cc.NewInterceptor` wrapping
   `gcc.NewSendSideBWE(gcc.SendSideBWEInitialBitrate(...), gcc.SendSideBWEPacer(gcc.NewNoOpPacer()))`
   is added (`manager.go:231-245`) followed by
   `webrtc.ConfigureTWCCHeaderExtensionSender(engine, registry)` (`manager.go:246`).
   Then unconditionally `webrtc.RegisterDefaultInterceptors(engine, registry)`
   (`manager.go:254`) — which is what supplies NACK/RTCP/TWCC-receiver behaviour.
   **Note the `NoOpPacer`: neko estimates bandwidth but does not pace packets.**
4. **API + PC**: `webrtc.NewAPI(WithMediaEngine, WithSettingEngine, WithInterceptorRegistry)`
   (`manager.go:259-263`), then `api.NewPeerConnection(configuration)` (`manager.go:267`).
5. **Configuration**: built once in `New` — `webrtc.Configuration{SDPSemantics: webrtc.SDPSemanticsUnifiedPlan}`
   (`manager.go:56-58`), with `ICEServers` filled from `ICEServersBackend` **only when
   ICE-lite is off** (`manager.go:60-78`). Credential handling quirk: an empty credential
   becomes the boolean `false`, not `""` (`manager.go:63-68`).

### 1.3 Tracks and DataChannel

- Audio track created and **paused immediately**: `audioTrack.SetPaused(true)` with the
  comment `// we disable audio by default manually` — `manager.go:318-319`, mirrored by
  `audioDisabled: true` in the peer struct (`manager.go:374`).
- Video track gets an RTCP channel: `NewTrack(logger, videoCodec, connection, WithRtcpChan(videoRtcp))`
  — `manager.go:329`. Video's *stream* is bound later (`manager.go:334-336`:
  `// stream for video track will be set later`).
- **DataChannel**: `connection.CreateDataChannel("data", nil)` — `manager.go:340`.
  Label `"data"`, **`nil` options**, i.e. browser/pion defaults: ordered, reliable, not
  negotiated, auto-assigned id. There is no `maxRetransmits`/`ordered:false` tuning.
  **Cody take-away:** input is ordered+reliable, so a stalled channel head-of-line-blocks
  later input. neko accepts that.
- Inbound media (client webcam/mic) is accepted on the same PC via `connection.OnTrack`
  (`manager.go:377`), gated on `session.Profile().CanShareMedia` (`manager.go:385-389`),
  and a PLI is sent to the *remote* publisher every `rtcpPLIInterval = 3 * time.Second`
  (`manager.go:50`, loop at `manager.go:443-458`).

### 1.4 Signalling — exact message shapes

Event name constants — `server/pkg/types/event/events.go:16-26`:

```go
SIGNAL_REQUEST   = "signal/request"
SIGNAL_RESTART   = "signal/restart"
SIGNAL_OFFER     = "signal/offer"
SIGNAL_ANSWER    = "signal/answer"
SIGNAL_PROVIDE   = "signal/provide"
SIGNAL_CANDIDATE = "signal/candidate"
SIGNAL_VIDEO     = "signal/video"
SIGNAL_AUDIO     = "signal/audio"
SIGNAL_CLOSE     = "signal/close"
```

Payload structs — `server/pkg/types/message/messages.go`:

```go
type SignalRequest struct {                              // :54-59
    Video types.PeerVideoRequest `json:"video"`
    Audio types.PeerAudioRequest `json:"audio"`
    Auto  bool                   `json:"auto"`  // TODO: Remove this
}
type SignalProvide struct {                              // :61-67
    SDP        string            `json:"sdp"`
    ICEServers []types.ICEServer `json:"iceservers"`
    Video      types.PeerVideo   `json:"video"`
    Audio      types.PeerAudio   `json:"audio"`
}
type SignalCandidate struct { webrtc.ICECandidateInit }  // :69-71
type SignalDescription struct { SDP string `json:"sdp"` }// :73-75
type SignalVideo struct { types.PeerVideoRequest }       // :77-79
type SignalAudio struct { types.PeerAudioRequest }       // :81-83
```

Per-peer stream selection types — `server/pkg/types/webrtc.go:21-40`:

```go
type PeerVideo struct {
    Disabled bool   `json:"disabled"`
    ID       string `json:"id"`
    Video    string `json:"video"` // TODO: Remove this, used for compatibility with old clients.
    Auto     bool   `json:"auto"`
}
type PeerVideoRequest struct {
    Disabled *bool           `json:"disabled,omitempty"`
    Selector *StreamSelector `json:"selector,omitempty"`
    Auto     *bool           `json:"auto,omitempty"`
}
```

**Who offers:** the **server** offers first. `CreatePeer` returns a
`*webrtc.SessionDescription` (`manager.go:271`, `return offer, peer, nil` at
`manager.go:594`), delivered to the client as `signal/provide` carrying both the SDP and
the *frontend* ICE server list. Afterwards it is **not** perfect negotiation: the client
also offers on `onnegotiationneeded` (`client/src/neko/base.ts:331-343`), and the server
can offer again via `CreateOffer(ICERestart)` (`server/internal/webrtc/peer.go:51-63`).
There is no rollback / collision handling in `base.ts` — it just creates and sends.

**Trickle ICE:** on by default (`webrtc.icetrickle`, default `true` —
`server/internal/config/webrtc.go:64`). Server side, `connection.OnICECandidate` fires
`event.SIGNAL_CANDIDATE` with `message.SignalCandidate{ICECandidateInit: candidate.ToJSON()}`
(`manager.go:297-309`). When trickle is **off**, `setLocalDescription` blocks on
`webrtc.GatheringCompletePromise` before returning the SDP
(`server/internal/webrtc/peer.go:78-91`) — i.e. non-trickle = full vanilla ICE gather.

Client side: `onicecandidate` sends `{ event, data: JSON.stringify(init) }`
(`client/src/neko/base.ts:314-329`). **Wire quirk worth knowing:** the candidate is
*double-encoded* — a JSON string inside the `data` field, not a nested object.

### 1.5 ICE / TURN configuration, and the reverse-proxy verdict

Config keys — `server/internal/config/webrtc.go`:

| key | default | line |
|---|---|---|
| `webrtc.icelite` | `false` | `:59` |
| `webrtc.icetrickle` | `true` | `:64` |
| `webrtc.iceservers.frontend` | `[]` | `:75` |
| `webrtc.iceservers.backend` | `[]` | `:80` |
| `webrtc.epr` | `""` | `:85` |
| `webrtc.tcpmux` | `0` | `:90` |
| `webrtc.udpmux` | `0` (comment: "replaces EPR") | `:95` |
| `webrtc.nat1to1` | `[]` | `:100` |
| `webrtc.ip_retrieval_url` | `https://checkip.amazonaws.com` | `:105` |

Frontend/backend split: the **frontend** list is what the browser is told
(`manager.ICEServers()` → `SignalProvide.ICEServers`, `manager.go:170-172`); the
**backend** list is what pion itself uses (`manager.go:62`). Defaulting: if neither is
set, `webrtc.iceservers` is parsed, and if that is empty too, a single
`stun:stun.l.google.com:19302` is appended to **both** (`config/webrtc.go:18`,
`:237-255`). If ICE-lite is on *and* backend servers are configured, backend is ignored
with a warning (`config/webrtc.go:232-234`).

Port defaulting: with no `epr`, no `tcpmux` and no `udpmux`, neko forces
**59000–59100** and warns (`config/webrtc.go:283-292`).

**VERDICT — plain HTTPS reverse proxy, no TURN, clients on LAN/WireGuard: YES, it works,
but ONLY if you also expose a UDP (or TCP-mux) port range directly. A 443-only proxy is
not sufficient, and neko's own docs say so in as many words** —
`webpage/docs/configuration/webrtc.md:147`:

> "WebRTC does not use the HTTP protocol, therefore it is not possible to use nginx or
> other reverse proxies to forward the WebRTC traffic. If you only have exposed port
> `443` on your server, you must expose as well the WebRTC ports or use a TURN server."

and `webrtc.md:144`:

> "All specified ports along with the server's IP address will be sent to the client in
> ICE candidates to establish a connection. Therefore, it is important to ensure that the
> specified ports are open on the server's firewall, are not remapped to different ports,
> and are reachable from the client."

Minimum viable exposure for Cody's topology (Caddy on 443 + clients on LAN/Tailscale):

- Set `webrtc.udpmux` to **one** UDP port (e.g. 59000) and publish it as UDP. One port
  serves all peers — `ice.NewMultiUDPMuxFromPort` (`manager.go:140`).
- Set `webrtc.nat1to1` to the address clients actually reach (the Tailscale IP or LAN IP),
  because `SetNAT1To1IPs(..., ICECandidateTypeHost)` (`manager.go:190`) rewrites the host
  candidate to that address. Without it, the container's internal Docker IP is advertised
  and nothing connects.
- No TURN needed: on a LAN/WireGuard the host candidate is directly routable, so the
  default Google STUN server is not even required.

**TCP fallback exists but only for ICE, not as a video transport.** Set
`webrtc.tcpmux` to a TCP port and pion adds `NetworkTypeTCP4/TCP6` candidates
(`manager.go:214-220`), built on `ice.NewTCPMuxDefault` with
`ReadBufferSize: tcpReadChanBufferSize` (50, `manager.go:35`) and
`WriteBufferSize: tcpWriteBufferSizeInBytes` (4 MiB, `manager.go:38`). Docs frame it
exactly as a UDP-blocked fallback — `webpage/docs/configuration/webrtc.md:190`:

> "The server uses only port `59000` for both UDP and TCP connections. ... UDP is
> generally better for latency, but some networks block UDP so it is good to have TCP
> available as a fallback."

That is ICE-over-TCP (still DTLS/SRTP inside), **not** a WebSocket video path.

### 1.6 Input rides the DataChannel — exact wire format

Header — `server/internal/webrtc/payload/types.go:3-6`:

```go
type Header struct {
    Event  uint8
    Length uint16
}
```

Read with **`binary.BigEndian`** — `server/internal/webrtc/handler.go:30`.

Client→server opcodes — `server/internal/webrtc/payload/receive.go:5-17`:

```go
OP_MOVE         = 0x01
OP_SCROLL       = 0x02
OP_KEY_DOWN     = 0x03
OP_KEY_UP       = 0x04
OP_BTN_DOWN     = 0x05
OP_BTN_UP       = 0x06
OP_PING         = 0x07
OP_TOUCH_BEGIN  = 0x08
OP_TOUCH_UPDATE = 0x09
OP_TOUCH_END    = 0x0a
```

Bodies — `payload/receive.go:19-55`: `Move{X,Y uint16}`;
`Scroll{DeltaX,DeltaY int16; ControlKey bool}` plus a legacy
`Scroll_Old{X,Y int16}` disambiguated purely by `header.Length == 4`
(`handler.go:102`); `Key{Key uint32}` (used for **both** keysyms and mouse buttons);
`Ping{ClientTs1,ClientTs2 uint32}`; `Touch{TouchId uint32; X,Y int32; Pressure uint8}`.

Server→client opcodes — `server/internal/webrtc/payload/send.go:5-9`:

```go
OP_CURSOR_POSITION = 0x01
OP_CURSOR_IMAGE    = 0x02
OP_PONG            = 0x03
```

**Gotcha for reimplementation:** the two opcode spaces **overlap numerically**
(`0x01` is `OP_MOVE` upstream and `OP_CURSOR_POSITION` downstream). They are
disambiguated by direction only. Cody should not copy that; use one space.

RTT measurement is in-band: `OP_PING` carries a client timestamp split across two
`uint32` (because JS cannot round-trip a `uint64`), and the server answers `OP_PONG`
with both client and server stamps — `handler.go:59-91`, reassembly helpers at
`payload/receive.go:46-48` and `payload/send.go:31-33`. Note the reassembly uses
`* math.MaxUint32` rather than `<< 32`, so it is not a clean 64-bit split; it round-trips
consistently only because both sides use the same arithmetic.

**Authorisation is enforced per-opcode inside the DataChannel handler**, not at the
channel level: `OP_MOVE` and `OP_PING` are processed for everyone, and everything else
returns early unless `session.IsHost()` — `handler.go:21`, `:94-97`. A non-host's
`OP_MOVE` becomes a *ghost cursor* broadcast instead of real input
(`handler.go:50-56`, `session.SetCursor`).

### 1.7 Latency tuning — what they set, and the striking gaps

Set:

- Aggressive ICE timeouts (§1.2) — fail fast.
- `SetAnsweringDTLSRole(DTLSRoleServer)` to avoid DTLS renegotiation on iOS (`manager.go:192-194`).
- Rich RTCP feedback on every video codec — `server/pkg/types/codec/codecs.go:9-19`:
  `TypeRTCPFBTransportCC`, `TypeRTCPFBGoogREMB` (marked `// TODO: Deprecated.`),
  `TypeRTCPFBCCM/fir`, `TypeRTCPFBNACK/pli`, `TypeRTCPFBNACK`.
- **Keyframe on subscriber join** — the single most valuable latency trick here.
  `StreamSinkManagerCtx.addListener` puts a new listener in a "keyframe lobby" and calls
  `manager.pipeline.EmitVideoKeyframe()` if it is the first
  (`server/internal/capture/streamsink.go:173-196`); `onSample` promotes the lobby to
  live listeners the moment a non-delta sample arrives
  (`streamsink.go:379-386`). So a joining viewer never renders garbage and never waits
  for the natural GOP boundary.
- GCC send-side bandwidth estimation, opt-in (§2.5).

**Not set anywhere — verified by grep across `server/` and `client/src/`:**

- No `playout-delay` RTP header extension, no `receiver.playoutDelayHint`, no
  `jitterBufferTarget`.
- No `RTCRtpSendParameters` / `sendEncodings` / `degradationPreference` /
  `contentHint` anywhere.
- No `setCodecPreferences`, no SDP munging.
- **The client's PeerConnection is constructed bare**:
  `new RTCPeerConnection({ iceServers: servers })`, or literally
  `new RTCPeerConnection()` in ICE-lite mode — `client/src/neko/base.ts:265-271`. It sets
  only `onconnectionstatechange`, `onsignalingstatechange`,
  `oniceconnectionstatechange`, `ontrack`, `onicecandidate`, `onnegotiationneeded`
  (`base.ts:273-343`). It does not use `addTransceiver` recvonly at all — it relies on
  the server's offer.

**Cody opportunity.** `playoutDelayHint = 0` and `jitterBufferTarget` are exactly the
knobs a remote-desktop use case wants and neko leaves on the table
([MDN: `RTCRtpReceiver.jitterBufferTarget`](https://developer.mozilla.org/en-US/docs/Web/API/RTCRtpReceiver/jitterBufferTarget),
[MDN: `RTCRtpReceiver.playoutDelayHint`](https://developer.mozilla.org/en-US/docs/Web/API/RTCRtpReceiver/playoutDelayHint)).
Likewise `contentHint = "text"`/`"detail"` is the standard signal for screen content
([MDN: `MediaStreamTrack.contentHint`](https://developer.mozilla.org/en-US/docs/Web/API/MediaStreamTrack/contentHint)).
Cody can beat neko on perceived latency with three lines of client code.

**Client ICE-connection-state policy worth copying** — `base.ts:296-305`: `disconnected`
triggers reconnect, but there is an explicit comment not to watch the *signaling*
disconnected state because it can recover:

> `// We don't watch the disconnected signaling state here as it can indicate temporary issues and may`
> `// go back to a connected state after some time. Watching it would close the video call on any temporary`
> `// network issue.`

---

## 2. Video pipeline

There are **two distinct pipeline systems** in this tree, and conflating them is the
easiest way to misread neko:

- **V3 (current):** `capture.video.pipelines` — a map of named streams, each either a
  literal GStreamer description (`gst_pipeline`) or a *composed* pipeline built from
  `gval` expressions over the live screen size. Composition lives in
  `server/pkg/types/capture.go:165-247`; the `ximagesrc … ! appsink` wrapper is added in
  `server/internal/capture/manager.go:40-56`.
- **V2 (legacy, deprecated):** `NewVideoPipeline(...)` in
  `server/internal/config/capture_pipeline.go:62-228`, whose file header literally says
  `// Legacy pipeline configuration for gstreamer.` (`capture_pipeline.go:1`). This is the
  **only place hardware-encoder pipelines are hardcoded**, reachable via the removed-in-v3
  `NEKO_HWENC` flag. Docs confirm removal —
  `webpage/docs/migration-from-v2/README.md:62`:
  > "`NEKO_HWENC` | **removed**, use custom pipeline instead"

Both matter: V3 is the architecture to copy; V2 is where the vetted VAAPI/NVENC property
sets are written down.

### 2.1 The capture prefix (identical in both systems)

V2 constant — `server/internal/config/capture_pipeline.go:34`:

```
ximagesrc display-name=%s show-pointer=true use-damage=false ! video/x-raw,framerate=%d/1 ! videoconvert ! queue !
```

V3 wrapper — `server/internal/capture/manager.go:52-55`:

```go
return fmt.Sprintf(
    "ximagesrc display-name=%s show-pointer=%v use-damage=false "+
        "%s ! appsink name=appsink", config.Display, pipelineConf.ShowPointer, pipeline,
), nil
```

Audio prefix — `capture_pipeline.go:35`:
`pulsesrc device=%s ! audio/x-raw,channels=2 ! audioconvert ! `

Three things to note:

1. **`use-damage=false` is hardcoded in every single path** — V3 (`manager.go:53`), V2
   (`capture_pipeline.go:34`), broadcast (`manager.go:104`), screencast
   (`manager.go:119`), and every documented example
   (`webpage/docs/configuration/capture.md:190`, `:209`, `:239`, `:263`, `:290`).
   neko does **not** use X damage events. It pulls a full framebuffer every frame and
   lets the encoder find the redundancy. For a mostly-static UI this is CPU-wasteful but
   latency-predictable and much simpler; the inter-frame codec recovers the bitrate.
2. **`show-pointer` is a per-stream boolean** (`VideoConfig.ShowPointer`,
   `server/pkg/types/capture.go:162`), and the default V3 config sets it **false** for
   `main` while creating a duplicate `legacy` stream with it **true**
   (`server/internal/config/capture.go:392-397`, and the string-replace hack at
   `:359-365` / `:519`). So modern clients get a **pointer-free video** and draw the
   cursor themselves from the DataChannel (§3.4); only the v2 legacy client gets a
   composited pointer.
3. `videoconvert ! queue` is unconditional — the CPU colour-conversion stage is always
   present, even on hardware paths (§2.4).

### 2.2 V3 composition — expressions and named elements

`VideoConfig` — `server/pkg/types/capture.go:152-163`:

```go
type VideoConfig struct {
    Width       string            `mapstructure:"width"`        // expression
    Height      string            `mapstructure:"height"`       // expression
    Fps         string            `mapstructure:"fps"`          // expression
    Bitrate     int               `mapstructure:"bitrate"`      // pipeline bitrate (not used currently)
    GstPrefix   string            `mapstructure:"gst_prefix"`   // pipeline prefix, starts with !
    GstEncoder  string            `mapstructure:"gst_encoder"`  // gst encoder name
    GstParams   map[string]string `mapstructure:"gst_params"`   // map of expressions
    GstSuffix   string            `mapstructure:"gst_suffix"`   // pipeline suffix, starts with !
    GstPipeline string            `mapstructure:"gst_pipeline"` // whole pipeline as a string
    ShowPointer bool              `mapstructure:"show_pointer"` // show pointer in the video
}
```

`GetPipeline(screen ScreenSize)` — `server/pkg/types/capture.go:165-247`. The mechanism,
which is the part worth copying wholesale:

- Variables bound for every expression: `width`, `height`, `fps` **from the live screen**
  (`capture.go:166-170`), plus one custom function `round(...)` registered into `gval`
  (`capture.go:172-176`).
- **Framerate stage** (`capture.go:178-192`): default
  `! video/x-raw ! videoconvert ! queue`; if `fps` is set, becomes
  `! capsfilter caps=video/x-raw,framerate=%d/100 name=framerate ! videoconvert ! queue`
  with the value multiplied by 100 — i.e. **fractional framerates are supported**.
- **Scale stage** (`capture.go:194-219`), only when both `width` and `height` are set:
  `! videoscale method=0 ! capsfilter caps=video/x-raw,width=%d,height=%d name=resolution ! queue`
  with the source comment
  `// element videoscale parameter method to 0 meaning nearest neighbor` (`capture.go:217`).
- **Encoder stage** (`capture.go:221-238`): `! <gst_encoder> name=encoder` followed by
  `key=value` for each `gst_params` entry, each value itself a `gval` expression.
- **Final join** (`capture.go:241-247`): `fps ▸ scale ▸ gst_prefix ▸ encoder ▸ gst_suffix`.

Every stage that might need runtime retuning is **named**: `name=framerate`,
`name=resolution`, `name=encoder`. That is deliberate and is what makes it possible to
poke properties on a live pipeline.

**Cody take-away:** this is a better design than a template string. Resolution/framerate/
bitrate become *derived* values, so one config survives arbitrary display resizes —
e.g. `width: (width / 3) * 2` from `webpage/docs/configuration/capture.md:133`.

Config keys (`server/internal/config/capture.go`): `capture.video.display` (`:78`),
`capture.video.codec` default `vp8` (`:83`), `capture.video.ids` (`:88`),
`capture.video.pipelines` default `{}` (`:93`), `capture.video.pipeline` — documented as
"shortcut for configuring only a single gstreamer pipeline, ignored if pipelines is set"
(`:98`). `ids` is ordered and the first is the default —
`webpage/docs/configuration/capture.md:42`.

**Hard constraint, stated as a limitation in the docs**
(`webpage/docs/configuration/capture.md:26-28`):

> ":::info Limitation
> All video pipelines must use the same video codec (defined in the `video.codec` setting).
> :::"

Enforced in code: the media engine registers `video.Codec()` once for the whole selector
(`server/internal/webrtc/manager.go:287-291`;
`StreamSelectorManagerCtx.Codec()` at `server/internal/capture/streamselector.go:65-67`).
**Consequence for Cody: you cannot offer VP8 to one client and H.264 to another from the
same capture manager.** Codec is a process-level decision in neko's model.

### 2.3 Every encoder pipeline, verbatim

#### VAAPI — the primary target per the owner's decision

**H.264** — `server/internal/config/capture_pipeline.go:159`, guarded by
`gst.CheckPlugins([]string{"va"})` at `:155`:

```
ximagesrc display-name=%s show-pointer=true use-damage=false ! video/x-raw,framerate=%d/1 ! videoconvert ! queue ! video/x-raw,format=NV12 ! vah264enc rate-control=cbr bitrate=%d key-int-max=60 target-usage=7 ! h264parse config-interval=-1 ! video/x-h264,stream-format=byte-stream,profile=constrained-baseline ! appsink name=appsink
```

**H.265** — `capture_pipeline.go:207`, guarded by `CheckPlugins(["va"])` at `:203`:

```
… ! video/x-raw,format=NV12 ! vah265enc rate-control=cbr bitrate=%d key-int-max=60 target-usage=7 ! h265parse config-interval=-1 ! video/x-h265,stream-format=byte-stream,profile=main ! appsink name=appsink
```

**VP8** — `capture_pipeline.go:85`, guarded by `CheckPlugins(["ximagesrc","vaapi"])` at `:79`:

```
… ! video/x-raw,format=NV12 ! vaapivp8enc rate-control=vbr bitrate=%d keyframe-period=180 ! appsink name=appsink
```

with the honest warning comment at `capture_pipeline.go:82-84`:

> `// vp8 encode is missing from gstreamer.freedesktop.org/documentation`
> `// note that it was removed from some recent intel CPUs: https://trac.ffmpeg.org/wiki/Hardware/QuickSync`

Property meanings for the H.264/H.265 VAAPI path:

| property | value | effect |
|---|---|---|
| `rate-control` | `cbr` | constant bitrate — predictable pacing, no VBV spikes |
| `bitrate` | kbit/s, passed through directly | note: **kbit/s**, unlike vp8enc |
| `key-int-max` | `60` | keyframe at most every 60 frames (~2 s at 30 fps) |
| `target-usage` | `7` | **1 = best quality … 7 = fastest**; neko picks the fastest/lowest-latency end of the VA scale |
| `h264parse config-interval=-1` | | re-inserts SPS/PPS **before every keyframe** — essential so a late joiner can decode |
| `profile=constrained-baseline` | | maximum decoder compatibility; no B-frames, no CABAC |

**The `config-interval=-1` + keyframe-on-join pair is the thing to copy.** Without
in-band parameter sets on each IDR, a joining WebRTC receiver cannot start.

**Memory path: neko does a CPU download, not DMA-BUF.** The caps immediately before the
encoder are plain `video/x-raw,format=NV12` (`capture_pipeline.go:159`, `:207`, `:85`) —
system memory. There is **no** `video/x-raw(memory:VASurface)`, no `vapostproc`, no
`vaapipostproc`, no `dmabuf` anywhere in the tree (grepped). So the frame path is:
`ximagesrc` (XGetImage → sysmem) → `videoconvert` (CPU BGRx→NV12) → `vah264enc`
(uploads to a VA surface internally). The GPU does the *encode* only; capture and colour
conversion stay on the CPU. Contrast with the NVENC docs, which **do** show an explicit
GPU-memory variant (`cudaupload ! cudaconvert` → `video/x-raw(memory:CUDAMemory)`,
`webpage/docs/configuration/capture.md:291-292`) — **neko has no VAAPI equivalent of
that.** That is genuine headroom for Cody, not something to inherit.

**Behaviour when the VA driver is missing:** `gst.CheckPlugins([]string{"va"})` returns an
error (`capture_pipeline.go:155`, implementation
`server/pkg/gst/gst.go:188-200` using `gst_registry_find_plugin`), `NewVideoPipeline`
returns `"", err`, and the V2 bridge logs
`"unable to create video pipeline, using default"` and **falls through to whatever the
default config is** — `server/internal/config/capture.go:512-515`. Note this checks that
the *plugin* is registered, **not** that a VA device actually opened; a container with
`gstreamer1.0-plugins-bad` installed but no `/dev/dri` passes `CheckPlugins` and then
fails later at pipeline start. In V3 there is no check at all beyond a
syntax/evaluation smoke test at boot (`server/internal/capture/manager.go:58-69`, which
`logger.Panic()`s on failure).

#### NVENC — the supported option

**H.264** — `capture_pipeline.go:160-171`, guarded by `CheckPlugins(["nvcodec"])` at `:161`.
Element chosen at runtime (`capture_pipeline.go:165-169`):

```go
// nvautogpuh264enc (GStreamer 1.22+) works better with NVIDIA drivers 590+; fall back to nvh264enc for older setups
nvencElem := "nvh264enc"
if err := gst.CheckElement("nvautogpuh264enc"); err == nil {
    nvencElem = "nvautogpuh264enc"
}
```

Pipeline (`capture_pipeline.go:171`):

```
… ! video/x-raw,format=NV12 ! %s name=encoder preset=2 gop-size=60 spatial-aq=true temporal-aq=true bitrate=%d vbv-buffer-size=%d rc-mode=6 ! h264parse config-interval=-1 ! video/x-h264,stream-format=byte-stream,profile=constrained-baseline ! appsink name=appsink
```

**H.265** — `capture_pipeline.go:213`:

```
… ! video/x-raw,format=NV12 ! nvh265enc name=encoder rc-mode=cbr preset=p2 tune=low-latency gop-size=60 bitrate=%d vbv-buffer-size=%d ! h265parse config-interval=-1 ! video/x-h265,stream-format=byte-stream,profile=main ! appsink name=appsink
```

Note the inconsistency in neko's own code: H.264 NVENC uses numeric `preset=2` and
`rc-mode=6`, while H.265 NVENC uses symbolic `preset=p2 tune=low-latency rc-mode=cbr`.
`vbvbuf` is `max(bitrate, 1000)` (`capture_pipeline.go:148-151`, `:196-199`).
`spatial-aq=true temporal-aq=true` on the H.264 path is adaptive quantisation — it
redistributes bits toward high-detail regions, which **helps text**; it is absent from
the VAAPI and x264 paths.

`CheckElement` (as opposed to `CheckPlugins`) exists only for this NVENC probe —
`server/pkg/gst/gst.go:202-207`, using `gst_element_factory_find`.

Documented NVENC pipelines (`webpage/docs/configuration/capture.md`) use different
numbers again — `preset=2 gop-size=25 spatial-aq=true temporal-aq=true bitrate=4096
vbv-buffer-size=4096 rc-mode=6` (`:266-274`), and the CUDA-memory variant at `:291-301`.
`webpage/docs/configuration/capture.md:310`:

> "`nvautogpuh264enc` (GStreamer 1.22+) is the recommended encoder for NVIDIA driver 590
> and newer. It auto-selects the correct memory path and replaces the older `nvh264enc`.
> On older GStreamer or driver versions, substitute `nvautogpuh264enc` with `nvh264enc`."

A regression note confirms NVENC parameter-set trouble is real —
`webpage/docs/release-notes.md:265`:
> "Fixed an issue where `nvh264enc` did not send SPS and PPS NAL units (by @mbattista)."

#### Software — the floor

H.264 tries **openh264 first**, then x264 — `capture_pipeline.go:176-188`:

```
# openh264 (capture_pipeline.go:177)
… ! openh264enc multi-thread=4 complexity=high bitrate=%d max-bitrate=%d ! video/x-h264,stream-format=byte-stream,profile=constrained-baseline ! appsink name=appsink
# bitrate*1000 and (bitrate+1024)*1000

# x264 (capture_pipeline.go:188)
… ! video/x-raw,format=NV12 ! x264enc threads=4 bitrate=%d key-int-max=60 vbv-buf-capacity=%d byte-stream=true tune=zerolatency speed-preset=veryfast ! video/x-h264,stream-format=byte-stream,profile=constrained-baseline ! appsink name=appsink
```

H.265 software — `capture_pipeline.go:221`:

```
… ! x265enc bitrate=%d key-int-max=60 tune=zerolatency speed-preset=veryfast option-string="vbv-maxrate=%d:vbv-bufsize=%d" ! video/x-h265,stream-format=byte-stream,profile=main ! appsink name=appsink
```

VP8 software — `capture_pipeline.go:94-110`, joined with spaces:

```
vp8enc target-bitrate=<bitrate*650> cpu-used=4 end-usage=cbr threads=4 deadline=1 undershoot=95 buffer-size=<bitrate*4> buffer-initial-size=<bitrate*2> buffer-optimal-size=<bitrate*3> keyframe-max-dist=25 min-quantizer=4 max-quantizer=20
```

VP9 — `capture_pipeline.go:120`:
`vp9enc target-bitrate=%d cpu-used=-5 threads=4 deadline=1 keyframe-max-dist=30 auto-alt-ref=true` (bitrate*1000).
**`cpu-used=-5` is a negative value** — for VP9 that is the *slower/higher-quality* end,
which contradicts the low-latency goal. Looks like an oversight; do not copy blindly.

AV1 — `capture_pipeline.go:130-142`:
`av1enc target-bitrate=<bitrate*650> cpu-used=4 end-usage=cbr undershoot=95 keyframe-max-dist=25 min-quantizer=4 max-quantizer=20`.
This is **`av1enc` (libaom, software)** and the plugin check is
`CheckPlugins(["ximagesrc","vpx"])` — the **wrong plugin name**, with an adjacent
`// TODO: check for plugin.` at `capture_pipeline.go:125`. There is **no VAAPI AV1 path**
anywhere in neko's code; the docs table marks vaapi/AV1 as `?`
(`webpage/docs/configuration/capture.md:324`). Consistent with the owner's constraint:
**AV1 is NVENC-only (`nvav1enc`, docs `:324`) and, on real silicon, Ada/RTX-40+ or Intel
Arc — never UHD 630 (Gen9.5).**

A second, independent set of default pipelines lives on the codec structs themselves
(`RTPCodec.Pipeline`) — e.g. H.264 `video/x-raw,format=I420 ! x264enc threads=4
bitrate=4096 key-int-max=15 byte-stream=true tune=zerolatency speed-preset=veryfast`
(`server/pkg/types/codec/codecs.go:134`), VP8 `vp8enc cpu-used=16 threads=4 deadline=1
error-resilient=partitions keyframe-max-dist=15 static-threshold=20`
(`codecs.go:96`). In the V3 path **only the audio one is actually used**
(`server/internal/capture/manager.go:140` splices `config.AudioCodec.Pipeline`); the
video ones are effectively dead defaults. Worth knowing so you don't chase them.

Also note `bitrate` unit chaos across encoders, all in one file: `vp8enc`/`av1enc` take
`bitrate*650`, `vp9enc`/`openh264enc` take `bitrate*1000`,
`x264enc`/`vah264enc`/`nvh264enc` take `bitrate` as kbit/s directly.

### 2.4 Chroma, and the text-sharpness question

**Every hardware and most software paths force 4:2:0.** The caps are explicit:

- `video/x-raw,format=NV12` — VAAPI H.264 (`capture_pipeline.go:159`), VAAPI H.265
  (`:207`), VAAPI VP8 (`:85`), NVENC H.264 (`:171`), NVENC H.265 (`:213`), and even
  **software x264** (`:188`).
- `video/x-raw,format=I420` — the codec-struct H.264 default (`codecs.go:134`) and the
  documented expression example (`webpage/docs/configuration/capture.md:136`).

NV12 and I420 are both **8-bit 4:2:0**: chroma is subsampled 2× horizontally *and*
vertically. There is **no `Y444`, no `NV24`, no 4:4:4 profile anywhere in the tree**
(grepped `Y444`, `4:4:4`, `444`).

**Direct comparison with Cody's current CDP JPEG.** Both are 4:2:0, so chroma resolution
is a wash in principle. What actually differs:

| | Cody today (CDP JPEG q90) | neko (H.264 CBR) |
|---|---|---|
| Chroma | 4:2:0 (libjpeg default) | 4:2:0 (NV12) |
| Redundancy exploited | **none** — every frame independent | inter-frame prediction |
| Static screen cost | full JPEG every frame | near-zero after the IDR |
| Bits available for a *changed* region | whole-frame budget split | almost the entire budget |
| Congestion response | none (TCP backs up, latency grows unboundedly) | CBR + GCC + stream switch |

So the honest conclusion, and it is the one that justifies the whole project: **a codec
path is not sharper than JPEG q90 per-frame — it is sharper per-bit and vastly cheaper
when the screen is static, which is what a desktop actually is.** At a fixed uplink,
inter-frame coding lets you spend 10–20× more bits on the pixels that actually changed,
so text edges survive. neko's own defaults are only ~2 Mbps
(`target-bitrate: round(3072 * 650)` ≈ 2.0 Mbps,
`webpage/docs/configuration/capture.md:93`) for a full desktop — a budget JPEG cannot
approach at any quality setting.

**Against the owner's "crisp and as close to native as possible" bar, neko's config is
NOT good enough as-is.** Four concrete deviations Cody should make:

1. **Do not ship `profile=constrained-baseline`.** neko uses it on every H.264 path
   (`capture_pipeline.go:159`, `:171`, `:177`, `:188`) for compatibility. It forbids
   CABAC and 8×8 transforms, which are worth real bitrate on text. `profile=main` or
   `high` is safe for any modern browser decoder; keep baseline only as a negotiated
   fallback. *(Cost: must be negotiated in the SDP `profile-level-id`, see §11.)*
2. **Raise the bitrate substantially.** 2 Mbps at 1080p is a videoconferencing budget.
   On LAN/WireGuard, 8–20 Mbps is free. Biggest sharpness lever, zero code.
3. **Turn on AQ where available.** neko sets `spatial-aq=true temporal-aq=true` only on
   the NVENC H.264 path (`capture_pipeline.go:171`), not on VAAPI or x264. For x264,
   `tune=zerolatency` **disables** psychovisual optimisation.
   *(`[INFERENCE]` — neko sets none of these on the VAAPI/x264 paths, so there is no
   source guidance here; this is my recommendation, not neko's.)*
4. **`videoscale method=0` (nearest neighbour) is the wrong default for text.**
   `server/pkg/types/capture.go:217-218`. If you ever downscale, nearest-neighbour
   aliases glyph stems badly. Better still: **never scale** — drive the X screen at the
   client's exact pixel size (§3), which neko can do and CDP cannot.

On 4:4:4: **UHD 630 (Gen9.5) VAAPI has no 4:4:4 H.264 encode entrypoint**
`[INFERENCE — not stated in neko's source]`. So the 4:4:4 lever is unavailable on the
primary target regardless; bitrate + profile + no-rescale are the levers that are.

### 2.5 Adaptive bitrate — yes, but by *stream switching*, and off by default

neko does **not** retune the encoder's bitrate. It runs **several complete pipelines at
different bitrates** and **moves a listener between them**.

- Enable: `webrtc.estimator.enabled`, **default `false`** —
  `server/internal/config/webrtc.go:112`. Also `webrtc.estimator.passive`
  ("passive estimator mode, when it does not switch pipelines, only estimates", `:117`)
  and `webrtc.estimator.debug` (`:122`).
- Signal: GCC send-side BWE (`gcc.NewSendSideBWE`,
  `server/internal/webrtc/manager.go:232-235`) with
  `webrtc.estimator.initial_bitrate` default `1_000_000` (`config/webrtc.go:127`), read
  every `webrtc.estimator.read_interval` (default 2 s, `config/webrtc.go:132`).
- Smoothing: `utils.NewTrendDetector` with `RequiredSamples: 8`,
  `DownwardTrendThreshold: -0.5`, `CollapseValues: true`
  (`server/internal/webrtc/manager.go:352-362`), yielding
  `TrendDirectionUpward|Neutral|Downward` (`server/pkg/utils/trenddetector.go:14-16`).
- Control loop — `server/internal/webrtc/peer.go:125-312`:
  - `diff = targetBitrate / streamBitrate` (`peer.go:188`), where `streamBitrate` is
    *measured* from the running pipeline, not configured
    (`StreamSinkManagerCtx.saveSampleBitrate`, 3-bucket rolling counter,
    `server/internal/capture/streamsink.go:349-368`).
  - **Downgrade** when trend is `Downward` **or** "stalled" (neutral for longer than
    `stalled_duration`, default 24 s — `config/webrtc.go:147`), subject to
    `downgrade_backoff` (10 s, `:152`), `unstable_duration` (6 s, `:142`) and
    `diff <= 1 + diff_threshold` (0.15, `:162`) — `peer.go:204-259`.
  - **Upgrade** when stable for `stable_duration` (12 s, `:137`), not upgraded within
    `upgrade_backoff` (5 s, `:157`), and `diff >= 1 + diff_threshold` — `peer.go:264-310`.
  - Both act by `peer.SetVideo(PeerVideoRequest{Selector: &StreamSelector{ID: streamId,
    Type: StreamSelectorTypeLower|Higher}})` — `peer.go:242-247`, `:295-300`.
- Selection semantics — `types.StreamSelectorType`:
  `Exact`, `Nearest`, `Lower`, `Higher` (`server/pkg/types/capture.go:51-60`), resolved
  against the **ordered** `capture.video.ids` list in
  `server/internal/capture/streamselector.go:69-158`.
- The switch itself is atomic and reference-counted:
  `StreamSinkManagerCtx.MoveListenerTo` takes source+target mutexes under a third global
  mutex to avoid deadlock, starts the target pipeline *before* removing from the source,
  and stops the source if it hits zero listeners —
  `server/internal/capture/streamsink.go:246-289` (see the comments at `:246-247`,
  `:258-261`).
- Streams excluded from ABR are simply left out of `VideoIDs` — the `legacy` pipeline is
  created but not listed, with the comment
  `// we do not add legacy to VideoIDs so that its ignored by bandwidth estimator`
  (`server/internal/config/capture.go:364`, `:396`, `:525`).

**Cost model, which is the important part for Cody's one-container-many-sessions
deployment:** N configured qualities means **up to N simultaneous encoders per desktop**,
but each runs only while it has ≥1 listener (`streamsink.go:153-171`). With `[hq, lq]`
and all viewers converged on `hq`, exactly one encoder runs.

### 2.6 appsink → pion

`Sample` — `server/pkg/types/capture.go:20-30`:

```go
type Sample struct {
    Timestamp time.Time
    Duration  time.Duration
    DeltaUnit bool // this unit cannot be decoded independently.
    Length    int
    Data      []byte
}
```

`DeltaUnit` is what drives the keyframe lobby (`streamsink.go:379`:
`// if is not delta unit -> it can be decoded independently -> it is a keyframe`).

Fan-out — `StreamSinkManagerCtx.onSample`, `streamsink.go:370-398`: metrics, keyframe
promotion, then the listener map is **copied into a slice before releasing the lock**
(`streamsink.go:388-393`, comment `// copy listeners before releasing lock to avoid
holding it during dispatch`) and `WriteSample` is called outside the lock. Good pattern:
one slow peer cannot stall the encoder thread's lock.

`Data []byte` is a Go slice handed to every listener — **shared, not copied per peer.**
That is the zero-copy fan-out. `UNCERTAIN:` I did not read `server/pkg/gst/gst.go`'s
appsink callback closely enough to say whether the GStreamer buffer is copied once into
Go memory at the boundary (almost certainly yes, via `C.GoBytes`) or mapped.

---

## 3. Screen capture

### 3.1 Real Xorg + dummy driver, NOT Xvfb

Decisive evidence — `runtime/supervisord.conf:12-21`:

```ini
[program:x-server]
environment=HOME="/home/%(ENV_USER)s",USER="%(ENV_USER)s"
command=/usr/bin/X %(ENV_DISPLAY)s -config /etc/neko/xorg.conf -noreset -nolisten tcp
autorestart=true
priority=300
user=%(ENV_USER)s
```

That is the **real X server** with a config file. `Xvfb` appears nowhere in the tree
(grepped). The config is `runtime/xorg.conf`, whose own header says
(`runtime/xorg.conf:1-4`):

> `# This xorg configuration file is meant to be used by xpra`
> `# to start a dummy X11 server.`
> `# For details, please see:`
> `# https://xpra.org/trac/wiki/Xdummy`

Key sections:

```
Section "ServerFlags"                       # runtime/xorg.conf:6-12
  Option "DontVTSwitch" "true"
  Option "AllowMouseOpenFail" "true"
  Option "PciForceNone" "true"
  Option "AutoEnableDevices" "false"
  Option "AutoAddDevices" "false"
EndSection

Section "Device"                            # runtime/xorg.conf:33-41
  Identifier "dummy_videocard"
  Driver "dummy"
  Option "ConstantDPI" "true"
  VideoRam 1024000
EndSection

Section "Monitor"                           # runtime/xorg.conf:43-98
  Identifier "dummy_monitor"
  HorizSync   5.0 - 1000.0
  VertRefresh 5.0 - 200.0
  Modeline "1920x1080_60.00" 172.80 1920 2040 2248 2576 1080 1081 1084 1118 -HSync +Vsync
  … 20 more modelines, up to "3840x2160_25.00" …
EndSection
```

- `VideoRam 1024000` (1 GB) is the hard ceiling on framebuffer size; the config even
  comments `# NOTE: the highest modes will not work without increasing the VideoRam`
  (`runtime/xorg.conf:49-50`).
- `HorizSync 5.0 - 1000.0` / `VertRefresh 5.0 - 200.0` are deliberately absurd ranges so
  that **any** runtime-generated modeline validates (§3.3).
- `Option "ConstantDPI" "true"` keeps DPI fixed as resolution changes — otherwise fonts
  would rescale on every resize.
- Input devices are `Driver "void"` for mouse and keyboard
  (`runtime/xorg.conf:14-24`) — real input arrives via XTEST, not a device.
- 21 modelines are pre-baked into `Screen`'s `Modes` list
  (`runtime/xorg.conf:108`) as the *advertised* set; anything else is created on demand.

**Why not Xvfb:** Xvfb has no RandR 1.2 CRTC/output model and cannot change screen size
at runtime (it takes `-screen WxHxD` at startup). Real Xorg + a RandR-capable dummy
driver can. That is the whole reason for this choice — and it is precisely the capability
CDP denies Cody.

### 3.2 The `xf86-video-dummy` patch

`utils/xorg-deps/xf86-video-dummy/` vendors upstream **v0.3.8**
(`utils/xorg-deps/xf86-video-dummy/README.md:1-2`: Debian
`xserver-xorg-video-dummy-1_0.3.8-2`) plus one patch,
`01_v0.3.8_xdummy-randr.patch` (316 lines).

What it adds — from the patch body:

- `#define DUMMY_MAX_SCREENS 4` and per-screen CRTC/output arrays in the driver record:
  `struct _xf86Crtc *paCrtcs[DUMMY_MAX_SCREENS];`,
  `struct _xf86Output *paOutputs[DUMMY_MAX_SCREENS];`, bracketed by
  `/* XRANDR support begin */` … `/* XRANDR support end */`
  — patch lines `9`, `18-23`.
- `#include "xf86Crtc.h"` — patch line `35`.
- A complete RandR 1.2 provider: `dummy_config_resize`, `DUMMYAdjustScreenPixmap`
  (patch lines `49-50`), an `xf86CrtcConfigFuncsRec` (`52`), a full `xf86CrtcFuncsRec`
  with `dpms`/`lock`/`mode_fixup`/`mode_set`/`commit`/`gamma_set`/`shadow_allocate`
  (`98-118`), and an `xf86OutputFuncsRec` with
  `mode_valid`/`mode_fixup`/`mode_set`/`detect`/`get_modes` (`131-191`).

**Why it is needed:** upstream dummy 0.3.8 exposes no CRTCs/outputs, so RandR cannot
add modes or resize the root framebuffer. With the patch, `XRRCreateMode` +
`XRRAddOutputMode` + `XRRSetScreenConfigAndRate` all work, and
`DUMMYAdjustScreenPixmap` reallocates the framebuffer to the new size.

Both custom X modules are compiled in a dedicated build stage and copied into the final
image — `Dockerfile.tmpl:14-15`:

```
COPY --from=xorg-deps /usr/local/lib/xorg/modules/drivers/dummy_drv.so /usr/lib/xorg/modules/drivers/dummy_drv.so
COPY --from=xorg-deps /usr/local/lib/xorg/modules/input/neko_drv.so /usr/lib/xorg/modules/input/neko_drv.so
```

`UNCERTAIN:` I read the patch's added-symbol list and hunk headers, not every line of the
new CRTC/output implementations. I did not verify how `DUMMY_MAX_SCREENS 4` interacts
with `VideoRam`.

### 3.3 Runtime resolution change — the capability that beats CDP

Full path, client → X:

1. Client sends WS `screen/set` (`event.SCREEN_SET`,
   `server/pkg/types/event/events.go:63`) with `message.ScreenSize{types.ScreenSize}`
   (`server/pkg/types/message/messages.go:159-161`).
2. Handler — `server/internal/websocket/handler/screen.go:11-26`. **Admin gate first:**
   ```go
   if !session.Profile().IsAdmin {
       return errors.New("is not the admin")
   }
   ```
   then `h.desktop.SetScreenSize(payload.ScreenSize)`, then
   `h.sessions.Broadcast(event.SCREEN_UPDATED, message.ScreenSizeUpdate{ID, ScreenSize})`.
3. `SetScreenSize` — `server/internal/desktop/xorg.go:88-104`. Takes a mutex, emits
   `"before_screen_size_change"`, calls `xorg.ChangeScreenSize`, caches the result, and
   emits `"after_screen_size_change"` from a `defer`.
4. `xorg.ChangeScreenSize` — `server/pkg/xorg/xorg.go:200-238`:
   - `s.Width = s.Width - (s.Width % 8)` with the comment
     `// round width to 8, because of Xorg` (`xorg.go:204-205`).
   - `if s.Rate == 0 { s.Rate = 60 }` (`:207-210`).
   - Try `XSetScreenConfiguration` (`:216`); **if it fails, create the mode and retry**
     (`:218-222`).
5. `XSetScreenConfiguration` — `server/pkg/xorg/xorg.c:284-311`: `XRRGetScreenInfo`,
   linear search `XRRConfigSizes` for an exact WxH match, then
   `XRRSetScreenConfigAndRate(display, conf, root, size_index, RR_Rotate_0, rate, CurrentTime)`.
6. `XCreateScreenMode` — `xorg.c:357-376`: builds an `XRRModeInfo`, `XRRCreateMode`,
   `XSync`, then **adds the mode to every output**:
   ```c
   XRRScreenResources *resources = XRRGetScreenResources(display, root);
   for (int i = 0; i < resources->noutput; ++i) {
     XRRAddOutputMode(display, resources->outputs[i], mode);
   }
   ```
7. **The modeline is generated by `libxcvt`** — `XCreateScreenModeInfo`, `xorg.c:379-409`:
   ```c
   mode_info = libxcvt_gen_mode_info(hdisplay, vdisplay, vrefresh, false, false);
   modeinfo->dotClock   = mode_info->dot_clock * 1000;
   modeinfo->hSyncStart = mode_info->hsync_start;   /* … etc … */
   ```
   guarded by `#ifdef _LIBCVT_H_` with a degraded fallback (width/height only, no timing)
   at `xorg.c:402-406`. Linked via `-lxcvt` in the cgo LDFLAGS
   (`server/pkg/xorg/xorg.go:4`) and the `libxcvt0` package in every runtime image
   (`runtime/Dockerfile.intel:23`, `runtime/Dockerfile.nvidia:95`).
   Mode name format: `"%dx%d_%d"` (`xorg.c:381`).

**So: ANY width/height/rate the client asks for, subject only to `%8` width rounding,
the dummy driver's `VideoRam`, and the deliberately-wide sync ranges in `xorg.conf`.**

Downstream reconfiguration — `server/internal/capture/manager.go:203-234`:

```go
manager.desktop.OnBeforeScreenSizeChange(func() {
    manager.video.destroyPipelines()
    if manager.broadcast.Started()  { manager.broadcast.destroyPipeline() }
    if manager.screencast.Started() { manager.screencast.destroyPipeline() }
})
manager.desktop.OnAfterScreenSizeChange(func() {
    err := manager.video.recreatePipelines()
    …
})
```

`destroyPipelines`/`recreatePipelines` only touch pipelines with listeners
(`server/internal/capture/streamselector.go:41-59`), and recreation re-runs
`pipelineFn()` (`streamsink.go:310`) → `GetPipeline(desktop.GetScreenSize())`
(`manager.go:46-47`) → all the `width`/`height`/`fps` expressions re-evaluate against the
**new** size.

**Critically: the PeerConnection and the tracks survive.** Only GStreamer pipelines are
torn down and rebuilt. There is no renegotiation, no ICE restart, no new SDP — the
encoded stream simply resumes at a new raster size, and the keyframe lobby
(`streamsink.go:173-196`) guarantees the first post-resize sample every listener sees is
an IDR. **This is exactly the behaviour Cody wants and cannot get from
`Page.startScreencast`.**

Advertised size list — `DesktopManagerCtx.ScreenConfigurations`,
`server/internal/desktop/xorg.go:69-86`, built from `xorg.ScreenConfigurations`
(populated by `XGetScreenConfigurations` → `XRRSizes`/`XRRRates` callbacks into Go,
`xorg.c:337-354`), filtered by:

```go
// filter out all irrelevant rates
if fps > 60 || (fps > 30 && fps%10 != 0) { continue }
```

Surfaced to admins only, as `SystemAdmin.ScreenSizesList`
(`server/pkg/types/message/messages.go:29`). Initial size comes from
`desktop.screen`, default `"1280x720@30"` (`server/internal/config/desktop.go:34`).

### 3.4 Cursor is out-of-band

Because `show-pointer=false` on the `main` stream (§2.1), the cursor is shipped separately
over the DataChannel:

- Position: `OP_CURSOR_POSITION = 0x01` with `CursorPosition{X,Y uint16}` —
  `server/internal/webrtc/payload/send.go:6`, `:11-14`. Interface
  `SendCursorPosition(x, y int)` — `server/pkg/types/webrtc.go:56`.
- Image: `OP_CURSOR_IMAGE = 0x02` with
  `CursorImage{Width,Height,Xhot,Yhot uint16}` + the pixel payload —
  `payload/send.go:7`, `:16-21`; interface
  `SendCursorImage(cur *CursorImage, img []byte)` — `types/webrtc.go:57`.
- Source: `XFixesGetCursorImage` (`server/pkg/xorg/xorg.c:426-429`), converted to RGBA in
  `xorg.GetCursorImage` — `server/pkg/xorg/xorg.go:273-299`, including the subtle
  correctness note at `xorg.go:283-284`:
  > `// Xlib stores 32-bit data in longs, even if longs are 64-bits on 64-bit systems.`
  (hence `ptrSize := strconv.IntSize / 8` — a trap worth remembering).
- Managers: `cursor.Image` with a **serial-keyed cache** and a listener set —
  `server/internal/webrtc/cursor/image.go:17-23` (`GetCurrent`, `AddListener`,
  `RemoveListener`), cache at `:85-119`, fetch at `:155-168`; `cursor.Position`
  constructed alongside it (`server/internal/webrtc/manager.go:89-90`).

**Why this is the right design and Cody should copy it:** the pointer is the one element
whose latency and sharpness the user judges continuously. Keeping it out of the video
means it stays crisp at 1:1 pixels and updates at DataChannel rate, independent of
encoder framerate, bitrate, or a congestion downgrade. It also lets non-hosts show ghost
cursors (`handler.go:50-56`, `event.SESSION_CURSORS`,
`server/pkg/types/event/events.go:33`).

### 3.5 Multiple clients of different sizes — neko punts. Bluntly.

Established from source:

1. **Resolution is global.** One X display (`config.Display`), one `DesktopManager`, one
   `CaptureManager`. `screen/set` mutates it for everyone and the result is
   **broadcast** to all sessions (`handler/screen.go:16-24`).
2. **Only an admin may change it** (`handler/screen.go:12-14`). A normal viewer cannot
   resize the desktop to fit their window at all.
3. **No per-client scaling or cropping.** `ximagesrc` is never given
   `startx/starty/endx/endy` (grepped — those properties appear nowhere). The only
   scaling is the per-*stream* `videoscale` in `GetPipeline`
   (`server/pkg/types/capture.go:194-219`), which is a property of the named quality, not
   of a viewer. Two viewers can sit on different `ids` (`hq`/`lq`) and therefore get
   different **encoded** sizes, but both are derived from the one display geometry.
4. **The client letterboxes in CSS.** `onResize` — `client/src/components/video.vue:882-887`:
   ```js
   const { offsetWidth, offsetHeight } = !this.fullscreen ? this._component : document.body
   this._player.style.width = `${offsetWidth}px`
   this._player.style.height = `${offsetHeight}px`
   this._container.style.maxWidth = `${(this.horizontal / this.vertical) * offsetHeight}px`
   this._aspect.style.paddingBottom = `${(this.vertical / this.horizontal) * 100}%`
   ```
   i.e. the classic aspect-ratio padding box plus a `maxWidth` clamp.
5. **Pointer coordinates are transformed client-side** —
   `client/src/components/video.vue:687-691`:
   ```js
   const { w, h } = this.$accessor.video.resolution
   const rect = this._overlay.getBoundingClientRect()
   this.$client.sendData('mousemove', {
     x: Math.round((w / rect.width) * (e.clientX - rect.left)),
     …
   ```
   Remote resolution ÷ CSS box size, offset by the box origin.

**Verdict: neko does not solve per-client density/resolution. It defines the problem
away** — one shared desktop at one admin-chosen size, letterboxed into each browser
window, with a linear coordinate transform.

**This is the same wall Cody hit with CDP, reached from the opposite direction.** CDP
forced a per-*process* density (`--force-device-scale-factor` at launch); neko has a
per-*desktop* resolution. Neither gives per-client sizing. The difference that matters:
**neko's constraint is a policy choice, Cody's is a hard API limit.** With one X display
per session (§8), "the display is whatever size this session's single client asked for"
becomes trivially true — and it can change mid-session, which CDP cannot. That is the
architectural win, and it only exists if each session owns its display.

### 3.6 Wayland

**Nothing.** Grepped `wayland`, `wlr`, `pipewire`, `waylandsink`, `xdg-desktop-portal`
across the tree: no hits outside the incidental `xwayland-cvt.c` URL in a source comment
(`server/pkg/xorg/xorg.c:378`, cited as the inspiration for the libxcvt modeline code).
neko is X11-only. Everything in §3 and §4 is `Xlib`/`XTEST`/`XRandR`/`XFixes` via cgo and
would need a complete second implementation (PipeWire + portals + libei/virtual-keyboard)
for Wayland. **Relevant to Cody's stated ambition to carry a Wayland desktop: neko offers
no help there whatsoever.**

---

## 4. Input injection

### 4.1 Two mechanisms, cleanly split

**Keyboard and pointer: XTEST via cgo.** `server/pkg/xorg/xorg.go:4` links
`-lX11 -lXrandr -lXtst -lXfixes -lXi -lxcvt`, and the implementations are
`XTestFakeButtonEvent`/`XTestFakeDeviceKeyEvent`/`XWarpPointer` in
`server/pkg/xorg/xorg.c`.

**Touch only: their own X input driver.** `utils/xorg-deps/xf86-input-neko`, wired in as
a third input device in `runtime/xorg.conf:26-31`:

```
Section "InputDevice"
  Identifier "dummy_touchscreen"
  Option "SendCoreEvents" "On"
  Option "SocketName" "/tmp/xf86-input-neko.sock"
  Driver "neko"
EndSection
```

Config confirms the scope explicitly — `server/internal/config/desktop.go:39`:

> `cmd.PersistentFlags().Bool("desktop.input.enabled", true, "whether custom xf86 input driver should be used to handle touchscreen")`

with `desktop.input.socket` defaulting to `/tmp/xf86-input-neko.sock`
(`server/internal/config/desktop.go:44`).

**Protocol: a plain Unix stream socket.** `server/pkg/xinput/xinput.go:1` —
`/* custom xf86 input driver communication protocol */`. `Connect()` is
`net.Dial("unix", d.socket)` (`xinput.go:27-34`); each event is a packed `Message`
written to the socket (`xinput.go:71-79`, `:92-99`, `:113-120`) with fields
`_type` (`XI_TouchBegin`/`XI_TouchUpdate`/`XI_TouchEnd`), `touchId`, `x`, `y`, `pressure`.
Touch IDs are tracked in `debounceTouchIds` so an `Update`/`End` for an unknown id is
rejected (`xinput.go:86-88`, `:107-109`) and a duplicate `Begin` is rejected
(`xinput.go:65-67`); `Debounce(duration)` reaps stale ones (`xinput.go:40-59`).
A no-op `dummy.go` implements the same interface when the driver is disabled.

**Why build a driver instead of using XTEST?** Because XTEST has no touch API — it
provides `XTestFakeKeyEvent`/`ButtonEvent`/`MotionEvent` only, with no XInput2 touch
support. `UNCERTAIN:` no source comment states this rationale in so many words; the
README (`utils/xorg-deps/xf86-input-neko/README.md`) only says it
"assumes you have only one virtual touchscreen device available" and "aims to make neko
easy to use and doesn't offer special configuration options." I did not read
`utils/xorg-deps/xf86-input-neko/src/neko.c`, so I cannot describe the driver's
server-side event dispatch.

### 4.2 Keysym → keycode: the part naive implementations get wrong

**What crosses the wire is an X11 KeySym**, as a `uint32`:
`payload.Key{Key uint32}` (`server/internal/webrtc/payload/receive.go:36-38`) → the
handler calls `manager.desktop.KeyDown(payload.Key)` (`server/internal/webrtc/handler.go:132`)
→ `xorg.KeyDown(code)` → `C.XKey(C.KeySym(code), C.int(1))`
(`server/pkg/xorg/xorg.go:128`). The WS variant is explicitly named:
`ControlKey{Keysym uint32}` (`server/pkg/types/message/messages.go:144-147`).

**The browser→keysym translation is done client-side by Guacamole's keyboard, vendored
into the repo.** `client/src/utils/guacamole-keyboard.ts:1` imports
`./guacamole-keyboard.js` — 1540 lines, 49 KB
(`client/src/utils/guacamole-keyboard.js`). Its header states the contract
(`guacamole-keyboard.js:26-27`):

> `* Browser and keyboard layout variation is abstracted away, providing events`
> `* which represent keys as their corresponding X11 keysym.`

Its resolution strategy, in order (`guacamole-keyboard.js:269-303`):

```js
this.keysym =  keysym_from_key_identifier(this.key, this.location)
            || keysym_from_keycode(this.keyCode, this.location);
…
// Use legacy keyIdentifier as a last resort, if it looks sane
if (!this.keysym && key_identifier_sane(this.keyCode, this.keyIdentifier))
    this.keysym = keysym_from_key_identifier(this.keyIdentifier, this.location, this.modifiers.shift);
```

plus `keysym_from_charcode` for keypress events (`:340`), a `recentKeysym[keyCode]` cache
so keyup can recover the keysym that keydown produced (`:317`), and named
browser-quirk flags — `quirks.capsLockKeyEventUnreliable` (`:295`),
`quirks.altIsTypableOnly` which rewrites Alt to keysym `0xFE03` i.e. `ISO_Level3_Shift`
(`:302-303`), and a Meta-key exception for `0xFFE7`/`0xFFE8` (`:291`). It also carries a
`reliable` flag on each key event (`:230-231`) distinguishing a known-good keysym from a
best guess.

**Server-side: three-tier resolution with dynamic keymap rewriting.** `XKey` —
`server/pkg/xorg/xorg.c:251-282`:

```c
void XKey(KeySym keysym, int down) {
  if (keysym == 0) return;
  Display *display = getXDisplay();
  KeyCode keycode = 0;

  if (!down)
    keycode = XKeyEntryGet(keysym);          // 1. remember what we pressed

  // Try to get keysyms from existing keycodes
  if (keycode == 0)
    keycode = XkbKeysymToKeycode(display, keysym);   // 2. search current map

  // Map non-existing keysyms to new keycodes
  if (keycode == 0)
    keycode = XkbAddKeyKeysym(display, keysym);      // 3. REWRITE the map

  if (down)
    XKeyEntryAdd(keysym, keycode);

  if (XTEST_KEYBOARD != NULL) {
    XTestFakeDeviceKeyEvent(display, XTEST_KEYBOARD, keycode, down, NULL, 0, CurrentTime);
  } else {
    XTestFakeKeyEvent(display, keycode, down, CurrentTime);
  }
  XSync(display, 0);
}
```

Tier 2 — `XkbKeysymToKeycode`, `xorg.c:158-194`, credited in the source to TigerVNC
(`xorg.c:157`). It walks `xkb->min_key_code … xkb->max_key_code` calling
`XkbTranslateKeyCode(xkb, keycode, mods, &out_mods, &cursym)` and matches `cursym`
**under the current modifier state**, which it computes manually because of a known Xkb
bug (`xorg.c:169-171`):

> `// XkbStateFieldFromRec() doesn't work properly because`
> `// state.lookup_mods isn't properly updated, so we do this manually`
> `mods = XkbBuildCoreState(XkbStateMods(&state), state.group);`

and it has a special case for the Shift+Tab / `ISO_Left_Tab` asymmetry
(`xorg.c:188-191`).

Tier 3 — `XkbAddKeyKeysym`, `xorg.c:197-249`, also from TigerVNC (`xorg.c:196`).
**This is the answer to the non-US-layout problem.** It:

1. Scans **downward** from `xkb->max_key_code` for a keycode with
   `XkbKeyNumGroups(xkb, key) == 0` — an unused scratch slot (`xorg.c:210-213`); bails if
   none (`:216-217`).
2. `XConvertCase(keysym, &lower, &upper)` to decide the key type:
   `XkbOneLevelIndex` when `upper == lower`, else `XkbAlphabeticIndex`
   (`xorg.c:223-228`), applied with `XkbChangeTypesOfKey` (`:230`).
3. Writes the syms — one for a caseless key, `{lower, upper}` for a cased one
   (`xorg.c:232-238`).
4. Commits with `XkbChangeMap` and returns the borrowed keycode (`xorg.c:240-246`).

Tier 1 — the `xkeyentry_t` linked list (`xorg.c:116-155`). `XKeyEntryAdd` pushes on
keydown (`:119-128`); `XKeyEntryGet` finds, **unlinks, frees, and returns** on keyup
(`:131-155`). This exists precisely because tier 3 may have moved the keysym onto a
scratch keycode that could be reassigned before the release arrives — so the release must
use the *recorded* keycode, not a fresh lookup.

**Dispatch subtlety worth its own callout.** `xorg.c:4-8`:

> `// XTEST virtual keyboard XInput1 device handle — cached so XKey() can dispatch`
> `// via XTestFakeDeviceKeyEvent (XI-aware) instead of XTestFakeKeyEvent (core-only).`
> `// GDK3 selects XI2 for the seat keyboard at startup and ignores core-protocol`
> `// KeyPress events, so core XTest silently drops every key into Firefox.`

and again at `xorg.c:272-275`. `openXTestKeyboardDevice` (`xorg.c:18`) caches the device
at display-open time, best-effort, with the fallback comment at `xorg.c:47-49`
(core XTest, "broken, but not a crash"). **Anyone reimplementing this against a
GTK3 app will hit exactly this bug; use `XTestFakeDeviceKeyEvent`.**

Modifiers are handled separately and *statefully*, not as synthetic key presses.
`KbdMod` maps to X mask bits — `server/pkg/xorg/xorg.go:26-35`:
`KbdModShift=ShiftMask`, `KbdModCapsLock=LockMask`, `KbdModControl=ControlMask`,
`KbdModAlt=Mod1Mask`, `KbdModNumLock=Mod2Mask`, `KbdModMeta=Mod3Mask`,
`KbdModSuper=Mod4Mask`, `KbdModAltGr=Mod5Mask`. Applied with
`XkbLockModifiers(display, XkbUseCoreKbd, mod, on ? mod : 0)`
(`xorg.c:411-415`) and read back with `XkbBuildCoreState(...)` (`xorg.c:417-424`).
Client→server sync is an explicit WS message `keyboard/modifiers`
(`server/pkg/types/event/events.go:72`), host-gated
(`server/internal/websocket/handler/keyboard.go:18-25`), fanned out field-by-field over
eight optional pointers in `SetKeyboardModifiers`
(`server/internal/desktop/xorg.go:142-174`). **Locks (caps/num) are set as X lock state,
not simulated keystrokes** — the correct approach.

Layout: `keyboard/map` (`events.go:73`), host-gated
(`handler/keyboard.go:10-16`), implemented by **shelling out to `setxkbmap`** —
`server/internal/desktop/xorg.go:110-115`:

```go
func (manager *DesktopManagerCtx) SetKeyboardMap(kbd types.KeyboardMap) error {
    // TOOD: Use native API.
    cmd := exec.Command("setxkbmap", "-layout", kbd.Layout, "-variant", kbd.Variant)
    _, err := cmd.Output()
    return err
}
```

and read back by regex-scraping `setxkbmap -query` (`xorg.go:117-140`), same `TOOD` typo.
There is **no `keyboard.layout` config key** — grepped `server/internal/config/desktop.go`
and `webpage/docs/configuration/desktop.md`: no hits. Layout is runtime-only, host-set.
`server/pkg/xorg/keysymdef.go` is generated (`//go:generate ./keysymdef.sh`,
`server/pkg/xorg/xorg.go:22`; generator at `server/pkg/xorg/keysymdef.sh`).
`UNCERTAIN:` I did not open `keysymdef.go`, so I cannot state its size, shape, or how it
is consumed — the live keysym→keycode path in `xorg.c` does not appear to need it.

### 4.3 Key repeat

**Client-side, by Guacamole.** The vendored keyboard's own documented contract —
`client/src/utils/guacamole-keyboard.ts:25-27`:

> `* Marks a key as pressed, firing the keydown event if registered. Key`
> `* repeat for the pressed key will start after a delay if that key is`
> `* not a modifier. …`

Server-side there is no autorepeat logic; instead there is a **debounce that rejects a
second keydown for an already-held keysym**: `xorg.KeyDown` returns
`fmt.Errorf("debounced key %v", code)` if `debounce_key[code]` exists
(`server/pkg/xorg/xorg.go:122-124`), and symmetrically `KeyUp` rejects an unheld key
(`xorg.go:150-152`). So repeat is *transported* as discrete down/up pairs from the
client. `UNCERTAIN:` I found no call to `XAutoRepeatOff`/`XkbSetAutoRepeatRate` anywhere,
so I cannot say whether server-side X autorepeat is explicitly suppressed — with
`Driver "void"` keyboards (`runtime/xorg.conf:20-24`) it may simply never engage.

Two safety nets worth copying:

- `ResetKeys()` releases **every** held key and button (`xorg.go:160-173`) — called
  around synthetic `KeyPress`/`ButtonPress` (`server/internal/desktop/xorg.go:41-63`)
  so a stuck modifier cannot poison an API-driven keystroke.
- `CheckKeys(duration)` (`xorg.go:175-197`) is a watchdog that force-releases anything
  held longer than `duration` — the fix for a client that disconnects mid-keypress and
  would otherwise leave a key latched forever. **Cody needs this; a dropped WebSocket
  with Ctrl held down is a real hazard.**

### 4.4 Pointer, drag, scroll

- **Move:** `XWarpPointer(display, None, DefaultRootWindow(display), 0, 0, 0, 0, x, y)`
  + `XSync` — `xorg.c:62-66`. Absolute warp, not relative motion; `OP_MOVE` carries
  `uint16` absolute coordinates already in remote-display space
  (`payload/receive.go:19-22`), converted client-side (§3.5).
- **Buttons:** `XTestFakeButtonEvent(display, button, down, CurrentTime)` — `xorg.c:107-114`,
  with `if (button == 0) return;`. Down/up are separate opcodes
  (`OP_BTN_DOWN`/`OP_BTN_UP`), so **multi-button drag works naturally**: any number of
  buttons can be held simultaneously, tracked in the `debounce_button` map
  (`xorg.go:104-116`, `:132-144`). Chorded drags are fine.
- **Scroll:** `XScroll` — `xorg.c:77-105`. Deltas are converted to **repeated button
  clicks**:
  ```c
  if (deltaY > 0) ydir = 4; else ydir = 5;   // button 4 up, 5 down   (xorg.c:81-85)
  if (deltaX > 0) xdir = 6; else xdir = 7;   // button 6 right, 7 left (xorg.c:87-92)
  for (int i = 0; i < abs(deltaY); i++) { press(ydir); release(ydir); }
  for (int i = 0; i < abs(deltaX); i++) { press(xdir); release(xdir); }
  ```
  Horizontal scroll is supported (buttons 6/7). **There is no smooth/pixel-precise
  scrolling** — no XInput2 valuator/axis path — so `deltaY = 40` becomes 40 discrete
  click pairs, i.e. 80 XTEST calls each with an implicit `XSync` at the end
  (`xorg.c:104`). This is a real weakness for trackpad users and a place Cody can improve.
- **Ctrl+scroll (zoom)** is special-cased: `Scroll(deltaX, deltaY, controlKey)` wraps the
  scroll in `XSetKeyboardModifier(ControlMask, 1)` / `defer ... 0`
  (`server/pkg/xorg/xorg.go:92-102`), driven by `Scroll.ControlKey` on the wire
  (`payload/receive.go:30-34`). Neat: it guarantees the modifier is released even if the
  scroll panics.

`UNCERTAIN:` I found no scroll inversion or sensitivity setting server-side. I did not
audit `client/src/components/video.vue` for client-side scroll scaling, so there may be a
UI-level multiplier I did not see.

### 4.5 Touch

Fully plumbed end to end: opcodes `OP_TOUCH_BEGIN/UPDATE/END = 0x08/0x09/0x0a`
(`payload/receive.go:14-16`), payload `Touch{TouchId uint32; X,Y int32; Pressure uint8}`
(`payload/receive.go:50-55`), handler dispatch to
`desktop.TouchBegin/TouchUpdate/TouchEnd` (`webrtc/handler.go:170-202`), WS equivalents
`control/touchbegin|touchupdate|touchend` (`event/events.go:51-53`) with
`ControlTouch{TouchId, Pressure}` (`messages.go:149-153`), and the Unix-socket driver
(§4.1). Capability is advertised to the client as `SystemInit.TouchEvents`
(`server/pkg/types/message/messages.go:23`) — a good pattern: **the client gates its UI on
an advertised capability rather than sniffing.** Cody's `DisplayStreamHello.input[]`
already does the same thing.

### 4.6 Rate limiting / coalescing

**None found in the input path.** Every `OP_MOVE` becomes an immediate `XWarpPointer` +
`XSync` (`webrtc/handler.go:48`, `xorg.c:62-66`). No throttle, no coalescing, no
requestAnimationFrame batching on the server side. The only rate-limit-shaped things are
the *debounce maps*, which are duplicate-suppression and stuck-key recovery, not rate
limiting. `UNCERTAIN:` I did not check whether `client/src/components/video.vue` throttles
`mousemove` before sending.

---

## 5. Clipboard

### 5.1 Host side — `xclip`, `CLIPBOARD` only

neko shells out to `xclip` for every operation —
`server/internal/desktop/clipboard.go`:

```go
// read  (:49)
cmd := exec.Command("xclip", "-selection", "clipboard", "-out", "-target", mime)
// write (:82)
cmd := exec.Command("xclip", "-selection", "clipboard", "-in", "-target", mime)
// enumerate (:133)
cmd := exec.Command("xclip", "-selection", "clipboard", "-out", "-target", "TARGETS")
```

- **Only the `CLIPBOARD` selection is touched.** `-selection clipboard` is hardcoded in
  all three call sites. `PRIMARY` (middle-click paste) is **never** read or written —
  grepped, no hits. Worth knowing: X11 selection-vs-clipboard confusion is a classic
  source of "paste doesn't work" reports.
- MIME targets: `UTF8_STRING` for plain text and `text/html` for rich text —
  `clipboard.go:13-19`:
  ```go
  clipboardTextPlainTarget = "UTF8_STRING"
  clipboardTextHtmlTarget  = "text/html"
  ```
- Read fetches plain text, then HTML **best-effort** — `clipboard.go:21-34`, with the
  comment `// Rich text must not always be available, can fail silently.` (`:27`).
- Write is **either/or, not multi-target** — `clipboard.go:36-46`, with an explicit
  admission (`:37-39`):
  > `// TODO: Refactor.`
  > `// Current implementation is unable to set multiple targets. HTML`
  > `// is set, if available. Otherwise plain text.`
  So pasting rich text into a plain-text-only app can fail. A real limitation.
- **Images are not handled.** No `image/png` handling anywhere (grepped);
  `ClipboardGetTargets` filters to targets containing `/` (`clipboard.go:152-154`), so
  `image/png` would be *listed* but there is no code path to fetch or set it.

The write path is subtle and worth understanding, because `xclip -in` must **stay
running** to own the selection:

- `replaceClipboardCommand` (`clipboard.go:64-79`) keeps a single live `*exec.Cmd` in an
  atomic and **kills the previous one** when a new write arrives — otherwise you'd leak
  an `xclip` per copy, each fighting for selection ownership.
- The write **blocks until X confirms**: it registers
  `xevent.Emmiter.Once("clipboard-updated", ...)` *before* starting the command, writes
  stdin, closes it, then selects on that channel or on shutdown —
  `clipboard.go:96-118`. So change notification is **event-driven, not polled**.
- `cmd.Wait()` is reaped on a background goroutine (`clipboard.go:120-127`).

The `clipboard-updated` event comes from the X event loop
(`server/pkg/xevent/xevent.go` + `server/internal/desktop/xevent.go`), and given the
`-lXfixes` link flag (`server/pkg/xorg/xorg.go:4`) this is almost certainly
`XFixesSelectionNotify`. `UNCERTAIN:` I did not read `server/pkg/xevent/xevent.go` or
`server/internal/desktop/xevent.go`, so I cannot confirm the exact X event or state
whether there is any polling fallback.

WS surface: `clipboard/updated` and `clipboard/set`
(`server/pkg/types/event/events.go:67-68`), payload
`ClipboardData{Text string}` (`messages.go:172-174`) — note the WS
message carries **text only**, no HTML field, even though the desktop layer supports HTML.
`UNCERTAIN:` I did not read `server/internal/websocket/handler/clipboard.go` or
`server/internal/api/room/clipboard.go`, so I cannot state the permission gate
(`CanAccessClipboard`?) or any size limit. **No size limit was found**, but I did not
search exhaustively for body-size middleware.

### 5.2 Browser side — the permission problem, and the textarea escape hatch

neko uses the **async Clipboard API** with careful feature detection, and keeps a manual
UI fallback.

Feature detection — `client/src/components/video.vue:335-349`:

```js
get clipboard_read_available() {
  return (
    'clipboard' in navigator &&
    typeof navigator.clipboard.readText === 'function' &&
    // Firefox 122+ incorrectly reports that it can read the clipboard but it can't
    // instead it hangs when reading clipboard, until user clicks on the page
    // and the click itself is not handled by the page at all, also the clipboard
    // reads always fail with "Clipboard read operation is not allowed."
    navigator.userAgent.indexOf('Firefox') == -1
  )
}
get clipboard_write_available() {
  return 'clipboard' in navigator && typeof navigator.clipboard.writeText === 'function'
}
```

**That is a hard user-agent block on Firefox for clipboard *read*, with a four-line
comment explaining exactly why.** This is real-world knowledge Cody should just inherit:
`navigator.clipboard.readText()` is Chromium-only in practice.
([MDN: `Clipboard.readText()`](https://developer.mozilla.org/en-US/docs/Web/API/Clipboard/readText)
documents that read requires the `clipboard-read` permission, which Firefox does not
grant to web content.)

Usage:

- **Host → browser** (`writeText`): `await navigator.clipboard.writeText(clipboard)`
  inside a try/catch that logs on failure — `video.vue:463-467`.
- **Browser → host** (`readText`): `const text = await navigator.clipboard.readText()`,
  compared against the last known value and only sent if changed —
  `video.vue:674-679`.

Note neither is wrapped in a `navigator.permissions.query({name:'clipboard-read'})`
call — grepped `permissions.query`: no hits. And `document.execCommand` is **not** used
anywhere (grepped). So there is no legacy fallback path; it is async-API-or-manual.

**The manual fallback is a floating textarea** — `client/src/components/clipboard.vue:1-5`:

```html
<div class="clipboard" v-if="opened" @click="$event.stopPropagation()">
  <textarea ref="textarea" v-model="clipboard" @focus="$event.target.select()" />
</div>
```

bound two-way to the shared clipboard state (`clipboard.vue:50-60`), with a typing
debounce, positioned `absolute; bottom: 10px; right: 10px`, `max-width: 320px`
(`clipboard.vue:14-24`). So when the async API is unavailable (Firefox, insecure context,
denied permission), the user gets a box they can Ctrl+C / Ctrl+V into — a **real user
gesture**, which is exactly what the spec requires.

**Cody take-away.** Cody's `DisplayStreamClipboard` / `{type:"clipboard", action:"read"|"write"}`
(`lib/display/types.ts:63-66`, `:77-78`) already models both directions. What neko adds:
(a) capability-detect **read and write separately** — write is broadly available, read is
not; (b) hard-exclude Firefox from read; (c) **ship the textarea fallback**, because
without it Firefox users have no clipboard at all; (d) note that Cody's
`input: [... "clipboard"]` advertisement should reflect what the *provider* supports,
while the *client* must additionally gate on `navigator.clipboard` availability — two
independent capability checks.

---

## 6. Audio

- **Source:** `pulsesrc device=%s ! audio/x-raw,channels=2 ! audioconvert ! queue max-size-buffers=5 leaky=downstream ! <codec pipeline> ! appsink name=appsink`
  — `server/internal/capture/manager.go:134-141`. The `queue max-size-buffers=5
  leaky=downstream` is the latency guard: **drop old audio rather than build a backlog.**
  Default device `audio_output.monitor` (`server/internal/config/capture.go:62`).
- **Virtual devices** are created by PulseAudio config — `runtime/default.pa`:
  ```
  load-module module-null-sink sink_name=audio_output sink_properties=device.description="Virtual_Audio_Output"   # :4
  load-module module-null-sink sink_name=audio_input  sink_properties=device.description="Virtual_Audio_Input"    # :7
  load-module module-virtual-source source_name=microphone master=audio_input.monitor …                           # :10
  load-module module-native-protocol-unix socket=/tmp/pulseaudio.socket auth-anonymous=1                          # :13
  load-module module-always-sink                                                                                  # :16
  ```
  So capture is from a **null sink's monitor** — no hardware needed. `module-always-sink`
  (`:16`) guarantees a sink exists so apps never fail to open audio.
  `PULSE_SERVER=unix:/tmp/pulseaudio.socket` (`runtime/Dockerfile.intel:102`).
- **Codec:** default `opus` (`server/internal/config/capture.go:67`), encoder
  `opusenc inband-fec=true bitrate=128000` (`server/pkg/types/codec/codecs.go:192`), SDP
  `useinbandfec=1;stereo=1`, 48 kHz, 2 channels (`codecs.go:185-187`). The legacy path
  uses `opusenc inband-fec=true bitrate=%d` with `bitrate*1000`
  (`server/internal/config/capture_pipeline.go:248`). Alternatives: `g722`
  (`avenc_g722`), `pcmu` (`mulawenc`), `pcma` (`alawenc`) — `codecs.go:196-247`,
  `capture_pipeline.go:249-275`.
  **`inband-fec=true` + `useinbandfec=1` is the notable latency/loss choice** — recover
  from loss without retransmission.
- **Same PeerConnection**, separate track: `audioTrack` and `videoTrack` are both created
  on the one `connection` (`server/internal/webrtc/manager.go:313`, `:329`).
- **Disabled by default**, deliberately: `audioTrack.SetPaused(true)` with
  `// we disable audio by default manually` (`manager.go:318-319`) and
  `audioDisabled: true` (`manager.go:374`). Toggled per-peer via
  `signal/audio` → `PeerAudioRequest{Disabled *bool}`
  (`server/pkg/types/webrtc.go:38-40`, `:53`).
- Only **one** audio pipeline is possible — `webpage/docs/configuration/capture.md:331`:
  > "Only one audio pipeline can be defined in neko."
- Client media sharing (mic/webcam) comes back **on the same PC** via `OnTrack` into
  `capture.Microphone()` / `capture.Webcam()` `StreamSrcManager`s
  (`manager.go:413-430`), gated on `CanShareMedia` (`manager.go:385`).

---

## 7. Containerization & GPU

### 7.1 Image structure

`Dockerfile.tmpl` (15 lines total) is **not a real Dockerfile** —
`Dockerfile.tmpl:1`:

> `# This Dockerfile is pre-processed by the ./utils/docker script, it is not meant to be used directly.`

```dockerfile
FROM ./server/     AS server                        # :3
FROM ./client/     AS client                        # :4
FROM ./utils/xorg-deps/ AS xorg-deps                # :5
FROM ./runtime/$RUNTIME_DOCKERFILE AS runtime        # :6

LABEL net.m1k1o.neko.api-version=3                   # :9  (comment :8: "tells neko-rooms which version of the API to use")

COPY --from=server /src/bin/plugins/ /etc/neko/plugins/                                                  # :11
COPY --from=server /src/bin/neko /usr/bin/neko                                                           # :12
COPY --from=client /src/dist/ /var/www                                                                   # :13
COPY --from=xorg-deps /usr/local/lib/xorg/modules/drivers/dummy_drv.so /usr/lib/xorg/modules/drivers/dummy_drv.so  # :14
COPY --from=xorg-deps /usr/local/lib/xorg/modules/input/neko_drv.so    /usr/lib/xorg/modules/input/neko_drv.so     # :15
```

`FROM ./dir/` is the custom syntax the preprocessor rewrites. `$RUNTIME_DOCKERFILE`
selects the flavour — this is the single switch between software / intel / nvidia.
`UNCERTAIN:` I did not read `utils/docker/main.go` or the root `build` script, so I cannot
describe the substitution mechanics or the tagging scheme.

### 7.2 Supervision

`runtime/supervisord.conf` — three programs plus an include:

| program | command | priority | autorestart | user |
|---|---|---|---|---|
| `x-server` | `/usr/bin/X %(ENV_DISPLAY)s -config /etc/neko/xorg.conf -noreset -nolisten tcp` | 300 | true | `%(ENV_USER)s` |
| `pulseaudio` | `/usr/bin/pulseaudio --log-level=error --disallow-module-loading --disallow-exit --exit-idle-time=-1` | 300 | true | `%(ENV_USER)s` |
| `neko` | `/usr/bin/neko serve --server.static "/var/www"` | 800 | true (`stopsignal=INT`, `stopwaitsecs=3`) | `%(ENV_USER)s` |

Citations: `runtime/supervisord.conf:12-21`, `:23-32`, `:34-45`. Top-level
`nodaemon=true`, `user=root`, `logfile=/dev/null` (`:1-7`);
`[include] files=/etc/neko/supervisord/*.conf` (`:9-10`) is how app layers and the Intel
render-group hook inject themselves; `[unix_http_server] file=/var/run/supervisor.sock
chmod=0770 chown=root:neko` (`:47-50`) lets neko drive `supervisorctl` as the `neko`
group.

Priority ordering: X and PulseAudio at 300, neko at 800 — so the display and audio exist
before the server starts. The Intel render-group hook runs at **priority 10**, i.e. before
everything (`runtime/intel/supervisord.rendergroup.conf:7`). PulseAudio's
`--exit-idle-time=-1` and `--disallow-exit` make it un-killable-by-idle, which matters
because the null sink has no consumer until a client connects.

Everything runs as an unprivileged user (`ENV USER=$USERNAME`, default `neko`, UID/GID
1000 — `runtime/Dockerfile.intel:6-8`, `:100`), added to `audio`, `video` and `pulse`
groups (`runtime/Dockerfile.intel:42-44`).

`UNCERTAIN:` I did not read `apps/*/Dockerfile` or any app supervisord snippet, so I
cannot document the app-layer pattern or what happens when the *application* dies. I also
did not check for `--shm-size` / `/dev/shm` requirements.

### 7.3 Flavour diff (three-way)

| | software (`runtime/Dockerfile`) | intel (`runtime/Dockerfile.intel`) | nvidia (`runtime/Dockerfile.nvidia`) |
|---|---|---|---|
| base | `debian:trixie-slim` (`:1`) | `debian:trixie-slim` (`:1`) | `nvidia/cuda:${CUDA_VERSION}-runtime-ubuntu${UBUNTU_RELEASE}`, CUDA `12.5.1`, Ubuntu `24.04` (`:1-5`) |
| apt repos | default | **adds `contrib non-free`** for Intel drivers (`:16-18`) | NVIDIA/CUDA repos from base + VirtualGL repo (`:34-39`) |
| GPU driver pkgs | none | `intel-media-va-driver-non-free libva2 vainfo` (`:26`) | `mesa-va-drivers mesa-vulkan-drivers libglvnd0 libgl1 libglx0 libegl1 libgles2 libglu1 libvulkan-dev vainfo vdpauinfo vulkan-tools mesa-utils mesa-utils-extra` (`:23-28`) |
| GStreamer pkgs | `-plugins-base -good -bad -ugly -pulseaudio` (`:31-33`) | same **+ `gstreamer1.0-vaapi`** (`:35-37`) | same as software — **no extra GStreamer package** (`:104-106`) |
| extra ENV | — | `NEKO_HWENC=VAAPI` (`:107`), `RENDER_GID=` (`:108`) | `NVIDIA_VISIBLE_DEVICES=all` (`:9`), `NVIDIA_DRIVER_CAPABILITIES=all` (`:11`), `VGL_DISPLAY=egl` (`:13`), CUDA on `LD_LIBRARY_PATH` (`:75`) |
| extra files | — | `intel/add-render-group.sh` → `/usr/bin/`, `intel/supervisord.rendergroup.conf` → `/etc/neko/supervisord/` (`:89-90`) | `nvidia/entrypoint.sh` → `/bin/entrypoint.sh` (`:79`) |
| X config | `runtime/xorg.conf` (dummy) | **same `runtime/xorg.conf`** (`:91`) | **same `runtime/xorg.conf`** (`:162`) |
| other | ships Widevine installer | Widevine removed | Widevine removed; VirtualGL `3.1.3-20250409`; manual EGL/Vulkan ICD JSON (`:50-67`); user *renamed* rather than created, since the CUDA base already has UID 1000 (`:108-115`) |

**Three findings that matter more than the rest:**

1. **`NVIDIA_DRIVER_CAPABILITIES=all` — so NVENC IS enabled.** `runtime/Dockerfile.nvidia:11`,
   with the adjacent comment (`:10`):
   > `# All NVIDIA driver capabilities should preferably be used, check NVIDIA_DRIVER_CAPABILITIES inside the container if things do not work`

   `all` is a superset of `video`, so the classic `compute,utility` trap that silently
   omits NVENC is avoided. **Confirmed, not inferred.** `NVIDIA_VISIBLE_DEVICES=all` at
   `:9`.
2. **Neither GPU flavour ships a distinct *pipeline*.** The Intel image sets
   `NEKO_HWENC=VAAPI` (`:107`), which reaches the **V2 legacy** synthesiser
   (`server/internal/config/capture.go:488-528` → `NewVideoPipeline`), and the nvidia
   image sets **no `NEKO_HWENC` at all** (grepped: `NEKO_HWENC` appears only in
   `runtime/Dockerfile.intel:107`, `runtime/intel/add-render-group.sh:4`,
   `server/internal/config/capture.go:510`, and docs). So on the nvidia image **the user
   must write `NEKO_CAPTURE_VIDEO_PIPELINE` themselves** — which is precisely why the
   docs carry NVENC examples (`webpage/docs/configuration/capture.md:262-305`,
   `webpage/docs/installation/examples.md:129-192`). And since `NEKO_HWENC` is
   *removed* in v3 (`webpage/docs/migration-from-v2/README.md:62`), the Intel image is
   relying on a deprecated compatibility path.
3. **The Intel image installs `gstreamer1.0-vaapi` (legacy plugin) but the H.264 pipeline
   needs the `va` plugin (`vah264enc`)**, checked as
   `gst.CheckPlugins([]string{"va"})` (`capture_pipeline.go:155`).
   **VERIFIED against the Debian trixie package index** (neko's base is
   `debian:trixie-slim`, `runtime/Dockerfile.intel:1`) — the two packages ship disjoint
   plugins:

   | package (trixie/amd64) | ships | provides |
   |---|---|---|
   | `gstreamer1.0-plugins-bad` | `/usr/lib/x86_64-linux-gnu/gstreamer-1.0/libgstva.so` **and** `libgstnvcodec.so` | `vah264enc`, `vah265enc`, `nvh264enc`, `nvautogpuh264enc` |
   | `gstreamer1.0-vaapi` 1.26.2-1 | `/usr/lib/x86_64-linux-gnu/gstreamer-1.0/libgstvaapi.so` only | the legacy `vaapi*` elements, of which neko uses exactly one: `vaapivp8enc` |

   (file lists: <https://packages.debian.org/trixie/amd64/gstreamer1.0-plugins-bad/filelist>,
   <https://packages.debian.org/trixie/amd64/gstreamer1.0-vaapi/filelist>)

   So `gstreamer1.0-plugins-bad` — already installed in **all three** flavours
   (`runtime/Dockerfile:32`, `runtime/Dockerfile.intel:36`, `runtime/Dockerfile.nvidia:105`)
   — single-handedly satisfies **both** `CheckPlugins(["va"])` *and*
   `CheckPlugins(["nvcodec"])` (`capture_pipeline.go:161`). That explains why the nvidia
   flavour adds no extra GStreamer package at all, and it means the explicit
   `gstreamer1.0-vaapi` on the Intel image is needed **only** for the legacy
   `vaapivp8enc` path (`capture_pipeline.go:85`) — a path neko's own comment says is
   disappearing from Intel silicon (`capture_pipeline.go:83`).

   **Package sizes (trixie/amd64), for anyone costing the image layer:**

   | package | download | installed |
   |---|---|---|
   | `intel-media-va-driver-non-free` 25.2.3+ds1-1 (iHD) | 6,568.8 kB | **40,457 kB (~40 MB)** |
   | `gstreamer1.0-plugins-bad` | 3,261.5 kB | 11,980 kB (~12 MB) |
   | `gstreamer1.0-vaapi` 1.26.2-1 | 310.5 kB | **906 kB** |
   | `libva2` | 77.5 kB | 250 kB |
   | `libva-drm2` | 17.9 kB | 44 kB |
   | `vainfo` | 16.3 kB | 50 kB |

   **Conclusion for Cody:** the VAAPI layer's cost is dominated by the iHD driver at
   ~40 MB installed, which is unavoidable. Minimal H.264-VAAPI enablement on top of an
   image that already has `gstreamer1.0-plugins-bad` is
   `intel-media-va-driver-non-free` + `libva2` + `libva-drm2` + `vainfo` ≈ **40.8 MB
   installed / ~6.7 MB download**. **Do NOT copy neko's `gstreamer1.0-vaapi`** — it buys
   only `vaapivp8enc`, which Cody will never use.

### 7.4 Intel/VAAPI requirements — and the render-GID mechanism

Packages: `intel-media-va-driver-non-free libva2 vainfo`
(`runtime/Dockerfile.intel:26`) — i.e. the **iHD** driver, not `i965`.
**`LIBVA_DRIVER_NAME` is never set** (grepped: zero hits anywhere in the tree). libva
autodetects from the PCI ID, which works for UHD 630 with iHD. Setting
`LIBVA_DRIVER_NAME=iHD` explicitly is still the safer move for Cody, but neko does not.

**The render-GID problem and its solution.** This is the single most practically useful
thing in the container section. `runtime/intel/add-render-group.sh`:

```bash
#!/bin/bash
# if no hwenc required, noop
[[ -z "$NEKO_HWENC" ]] && exit 0                                       # :3-4

if [[ -z "$RENDER_GID" ]]; then
  RENDER_GID=$(stat -c "%g" /dev/dri/render* | tail -n 1)              # :7
  # is /dev/dri passed to the container?
  [[ -z "$RENDER_GID" ]] && exit 1                                     # :9
fi

# note that this could conceivably be a security risk...
cnt_group=$(getent group "$RENDER_GID" | cut -d: -f1)                  # :13
if [[ -z "$cnt_group" ]]; then
  groupadd -g "$RENDER_GID" nekorender                                 # :15
  cnt_group=nekorender
fi
usermod -a -G "$cnt_group" "$USER"                                     # :18
```

Step by step, because this is reimplementable:

1. If `NEKO_HWENC` is unset, do nothing (`:3-4`) — hardware encode is opt-in.
2. `stat -c "%g" /dev/dri/render*` reads the **host's** numeric GID off the passed-in
   device node (`:7`). Docker preserves the numeric owner, so this is the host's
   `render` GID (commonly 104 or 105 — varies by distro, which is the whole problem).
3. Empty result ⇒ `/dev/dri` was not passed in ⇒ exit 1 (`:9`).
4. Look up whether *any* container group already has that numeric GID (`:13`).
5. If not, create one named `nekorender` with exactly that GID (`:15`).
6. Add the runtime user to it (`:18`).

Run as **root, priority 10, one-shot** — `runtime/intel/supervisord.rendergroup.conf`:

```ini
[program:rendergroup-init]
environment=RENDER_GID="%(ENV_RENDER_GID)s",USER="%(ENV_USER)s"
command=/usr/bin/add-render-group.sh
startsecs=0
startretries=0
autorestart=false
priority=10
user=root
```

`RENDER_GID` can also be supplied explicitly via the env var declared empty in the image
(`runtime/Dockerfile.intel:108`), skipping the `stat`.

Device requirement: the script globs `/dev/dri/render*`, so **passing the whole `/dev/dri`
directory is what neko expects.** `renderD128` appears nowhere in the repo (grepped).

### 7.5 NVIDIA requirements

- ENV set by the image: `NVIDIA_VISIBLE_DEVICES=all` (`:9`),
  `NVIDIA_DRIVER_CAPABILITIES=all` (`:11`), `VGL_DISPLAY=egl` (`:13`),
  `LD_LIBRARY_PATH` extended with `/usr/local/cuda/lib` and `/usr/local/cuda/lib64`
  "for gstreamer cuda plugins" (`:74-75`).
- `runtime/nvidia/entrypoint.sh` — 12 lines, and it is **VirtualGL, not encode**:
  ```bash
  export PATH="${PATH}:/opt/VirtualGL/bin"                                  # :4
  if [ -n "$(nvidia-smi --query-gpu=uuid --format=csv | sed -n 2p)" ]; then # :7
      exec vglrun "$@"                                                      # :8
  else
      echo "No GPU detected"                                                # :10
      exec "$@"
  fi
  ```
  So it probes for a GPU with `nvidia-smi` and wraps the command in `vglrun` to give the
  *application* hardware OpenGL. Note it **degrades gracefully** rather than failing.
- Manual EGL and Vulkan ICD JSON are written at build time (`:50-56`, `:58-67`) and a
  `libnvrtc.so` symlink is created "needed for cudaconvert" (`:46-47`) — that last one
  directly supports the documented `cudaupload ! cudaconvert` pipeline.
- X is configured **identically** to the other flavours — the same dummy
  `runtime/xorg.conf` is copied (`:162`). **There is no `nvidia-xconfig`, no BusID
  probing, no NVIDIA X driver.** The GPU is used for GL and encode; the display is still
  the dummy framebuffer. `[INFERENCE]` but strongly implied: this is why VirtualGL is
  needed at all.
- Container runtime: `UNCERTAIN:` I did not find `--gpus`, `runtime: nvidia`, or
  `deploy.resources.reservations.devices` — I grepped `NVIDIA_*` and `/dev/dri` but did
  not read `docker-compose.yaml` or `webpage/docs/installation/*` in full. The
  `nvidia-container-runtime` requirement is standard `[INFERENCE]` given
  `NVIDIA_VISIBLE_DEVICES`, but I cannot cite neko for it.

### 7.6 What `/dev/dri` passthrough buys on an Intel UHD 630 — and what it doesn't

**Container-side requirements (cited from neko):** pass `/dev/dri`
(`runtime/intel/add-render-group.sh:7` globs `/dev/dri/render*`); install
`intel-media-va-driver-non-free libva2 vainfo` (`runtime/Dockerfile.intel:26`) and
`gstreamer1.0-plugins-bad` for the `va` plugin (`:36`, needed by
`CheckPlugins(["va"])` at `capture_pipeline.go:155`); reconcile the render GID
(`add-render-group.sh:13-18`) as a root one-shot before X
(`supervisord.rendergroup.conf:7-8`).

**Silicon capability — `[INFERENCE]`, not from neko's source.** UHD 630 is Coffee Lake,
Gen9.5:

| codec | encode on UHD 630 | note |
|---|---|---|
| H.264 | **yes**, 8-bit 4:2:0 | the workhorse; `vah264enc` |
| HEVC | **yes**, 8-bit 4:2:0 | `vah265enc`; poor browser support for WebRTC |
| VP8 | encode was dropped on later Intel parts | neko's own comment flags this: `capture_pipeline.go:83` cites <https://trac.ffmpeg.org/wiki/Hardware/QuickSync> |
| VP9 | decode yes; **encode no** on Gen9.5 | |
| AV1 | **no** — neither encode nor decode | AV1 encode needs Arc (Alchemist+) or NVIDIA Ada/RTX-40+ |
| 4:4:4 | **no** encode entrypoint | so the 4:4:4 text-sharpness lever is unavailable here |

Verify on the host, not from docs: `vainfo` lists the actual entrypoints
(`vainfo` is installed by `runtime/Dockerfile.intel:26`); look for
`VAProfileH264*` with `VAEntrypointEncSlice`.

**What it buys:** the H.264/HEVC *encode* step moves off the CPU. On a 9900K encoding
1080p30 with `x264enc speed-preset=veryfast`, that is roughly a core-and-change reclaimed
per stream, and — more importantly for Cody — it makes **many concurrent sessions**
plausible, because Intel's encode block has no artificial session cap (see §7.7).

**What it does NOT buy:**

1. **Not capture.** `ximagesrc` is `XGetImage` from the dummy driver's software
   framebuffer (`server/pkg/xorg/xorg.c:440` uses `XGetImage` for screenshots; the
   GStreamer element does the same). It stays on the CPU.
2. **Not colour conversion.** `videoconvert` is unconditional in every pipeline
   (`server/internal/capture/manager.go:53`, `capture_pipeline.go:34`) and neko has no
   VAAPI-memory path (§2.3), so BGRx→NV12 is CPU work at full resolution every frame.
   With `use-damage=false` that is a *lot* of memory traffic — and it is the next
   bottleneck after encode.
3. **Not X rendering.** The dummy driver is software; `/dev/dri` does not accelerate the
   desktop itself. (The NVIDIA flavour needs VirtualGL precisely because of this.)
4. **Nothing at all for the current JPEG path.** CDP's `Page.startScreencast` encodes
   inside Chromium; `/dev/dri` changes nothing there unless Chromium itself is given GPU
   rasterization — a separate concern being handled by the `GpuPassthrough` agent.
5. **Not AV1**, per the table above.

### 7.7 Concurrency and contention — the part that decides architecture

**NVENC session caps.** `[INFERENCE] — neko's source has no handling for this
whatsoever.` I grepped the tree for session-limit handling, retry-on-encoder-create, and
encoder fallback: there is none. The only encoder-availability logic is the
`CheckPlugins`/`CheckElement` probes at *pipeline-string construction* time
(`capture_pipeline.go:155`, `:161`, `:167`, `:176`, `:184`, `:203`, `:209`, `:217`), which
check that a plugin is *registered* — not that a session can be *opened*. When the driver
refuses a new encode session, `gst.CreatePipeline` (`streamsink.go:320`) fails and
`CreatePipeline` returns an error, which in the resize path is escalated to
`logger.Panic()` (`server/internal/capture/manager.go:216-219`). **So on neko, exhausting
NVENC sessions is an unhandled failure, and in one path a panic.** Do not copy that.

Consumer GeForce drivers cap simultaneous NVENC sessions per *process-visible GPU*
(historically 2, later 3, then 5, and 8 on recent drivers; unrestricted on
Quadro/datacenter parts). Cody's shape — **one container, many sessions** — walks
straight into this if the encoder is per-session.

**Does neko hit it?** Not in its own model, because of §2.5/§8: **one encoder per named
quality per desktop, shared by all viewers** (`streamsink.go:153-171`, `:370-398`). With
`ids: [hq, lq]` a room needs at most 2 encode sessions no matter how many people watch.
But **Cody's model is different**: N independent desktops means N × (qualities in use)
encoders. At 8 sessions with one quality each, a consumer GeForce is already at or past
its ceiling.

**Therefore: VAAPI-first is not merely the owner's preference, it is the architecturally
correct choice for Cody.** Intel's encode block has no comparable per-process session
cap; it saturates on throughput, degrading gracefully (frame rate falls) rather than
refusing to start. NVENC's failure mode is binary and abrupt. For one-container-many-
sessions, a soft ceiling beats a hard one.

**Contention.** On an Unraid box both GPUs are typically already claimed — Plex/Jellyfin
transcoding overwhelmingly uses the iGPU via QuickSync, precisely because it is "free".
Recommendation, stated plainly:

- **Claim the Intel iGPU for Cody's encode** as the documented default: it is what the
  owner wants, it has no session cap, and Cody's per-session bitrates are modest.
- **But check for a Plex/Jellyfin `/dev/dri` mapping first.** If the iGPU is already the
  transcode target, the two workloads contend on the same fixed-function block, and a
  4K HDR tonemap will visibly starve interactive encode. In that case, either move media
  transcoding to the dGPU (NVENC is well-suited to batch transcode and its session cap is
  irrelevant there) or claim the dGPU for Cody instead.
- **Keep NVENC as a runtime-selectable encoder**, not an architectural assumption —
  exactly as neko does with `gst.CheckElement` (`capture_pipeline.go:167`).
- **Always keep the x264 `tune=zerolatency` floor** (`capture_pipeline.go:188`) so a box
  with no passthrough still works. This is the fallback chain:
  **VAAPI → NVENC → x264 zerolatency → today's JPEG.**

**Determining the actual NVIDIA card** (the model is unknown, and the codec answer
branches on it). On the Unraid host:

```
nvidia-smi --query-gpu=name,driver_version --format=csv
```

Branch:

- **Pascal (GTX 10xx)** — H.264 NVENC fine; HEVC 8-bit; **no** AV1; older session cap (2–3).
- **Turing (GTX 16xx / RTX 20xx) or newer** — materially better H.264/HEVC low-latency
  encode quality; this is the generation where NVENC becomes genuinely good for
  remote-desktop.
- **Ada (RTX 40xx)** — adds **AV1 encode** (`nvav1enc`,
  `webpage/docs/configuration/capture.md:324`). Only here is an AV1 recommendation valid,
  and it is **NVIDIA-only and Ada-only** — never UHD 630.

`[INFERENCE]` on every generational claim in that list; neko's source says nothing about
GPU generations. The only card-capability statement neko makes is a docs link:
"requires Nvidia GPU with NVENC support"
(`webpage/docs/configuration/capture.md:280`, `:436`).

### 7.8 Prerequisite checklist — hardware encode from a container that has none

Cody's container today: no `/dev/dri`, no `/dev/nvidia*`, `NVIDIA_VISIBLE_DEVICES` and
`NVIDIA_DRIVER_CAPABILITIES` unset, no `ffmpeg`/`vainfo`/`nvidia-smi`. So this is a
**prerequisite, not an assumption**. Two paths; do the VAAPI one first.

> A sibling agent (`GpuPassthrough`) is implementing the `/dev/dri` template entry, the
> iHD driver, a boot-time capability probe, and Chromium GPU rasterization in
> `docker/unraid-template.xml`, `docker/Dockerfile`, `docker/entrypoint.sh` and
> `docs/unraid.md`. The list below is the *neko-derived requirement set* to check that
> work against — I have not read those files and am not duplicating them.

**Path A — VAAPI on UHD 630 (primary).**

*Unraid container template:*
- Add device: `/dev/dri` → `/dev/dri`.
  (Derived from `runtime/intel/add-render-group.sh:7`, which globs `/dev/dri/render*`.)
- Optionally add env `RENDER_GID=<host render gid>` to skip autodetection
  (`runtime/Dockerfile.intel:108`).
- No `--runtime` change, no extra parameters.

*Image:*
- `intel-media-va-driver-non-free libva2 vainfo` — `runtime/Dockerfile.intel:26`.
- `gstreamer1.0-plugins-bad` for the `va` plugin providing `vah264enc` —
  `runtime/Dockerfile.intel:36`, required by `CheckPlugins(["va"])`
  (`capture_pipeline.go:155`).
- `gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-plugins-ugly
  gstreamer1.0-pulseaudio` for the rest of the graph and the x264 fallback
  (`runtime/Dockerfile.intel:35-37`).
- Recommended beyond neko: `ENV LIBVA_DRIVER_NAME=iHD` (neko relies on autodetect and
  sets this nowhere).

*Entrypoint, as root before the server starts* — port `add-render-group.sh` verbatim
(`runtime/intel/add-render-group.sh:1-18`), gated on your own "hwenc wanted" flag,
running at the equivalent of priority 10
(`runtime/intel/supervisord.rendergroup.conf:7`).

*Verify, one line, inside the container:*
```
vainfo 2>&1 | grep -E 'VAProfileH264.*EncSlice'
```
Non-empty ⇒ H.264 VAAPI encode is available. Second check: `gst-inspect-1.0 vah264enc`.

**Path B — NVENC (option).**

*Unraid template:*
- Unraid **Nvidia Driver plugin** installed on the host.
- Extra parameter: `--runtime=nvidia`.
- Env `NVIDIA_VISIBLE_DEVICES=<GPU-UUID>` — prefer the UUID over `all` so Cody cannot
  accidentally claim a GPU that Plex is using. (neko itself uses `all`,
  `runtime/Dockerfile.nvidia:9`.)
- Env **`NVIDIA_DRIVER_CAPABILITIES=all`** (or at minimum a list that **includes
  `video`**) — `runtime/Dockerfile.nvidia:11`. **This is the trap: the common
  `compute,utility` default silently omits NVENC.**

*Image:*
- `gstreamer1.0-plugins-bad` supplies the `nvcodec` plugin required by
  `CheckPlugins(["nvcodec"])` (`capture_pipeline.go:161`).
- For the CUDA-memory pipeline, CUDA runtime libs on `LD_LIBRARY_PATH`
  (`runtime/Dockerfile.nvidia:75`) and the `libnvrtc.so` symlink "needed for cudaconvert"
  (`:46-47`).

*Verify:*
```
nvidia-smi --query-gpu=name,driver_version --format=csv && gst-inspect-1.0 nvcodec | grep -E 'nvh264enc|nvautogpuh264enc'
```

---

## 8. Multi-session model

### 8.1 Cardinality: ONE desktop per container

The managers are process-wide singletons, constructed once and passed by reference:

- `DesktopManagerCtx` — one, holding one X display and one cached `screenSize`
  (`server/internal/desktop/xorg.go:100`).
- `CaptureManagerCtx` — one, holding one `broadcast`, one `screencast`, one `audio`
  sink, one `video` selector, one `webcam`, one `microphone`
  (`server/internal/capture/manager.go:17-31`).
- `WebRTCManagerCtx` — one, holding the single `desktop` and `capture` references plus
  one shared `curImage`/`curPosition` cursor manager
  (`server/internal/webrtc/manager.go:94-111`, constructed `:80-91`).

The display is a single scalar from config: `capture.video.display`, falling back to the
`DISPLAY` env var (`server/internal/config/capture.go:322-327`), plus `desktop.display`
(`server/internal/config/desktop.go:29`). There is **no per-session display allocation
anywhere** — a session never names a display.

Confirmed at the deployment layer too: `Dockerfile.tmpl:8-9` labels the image
`net.m1k1o.neko.api-version=3` with the comment "tells **neko-rooms** which version of
the API to use", and the README delegates multi-room entirely:

- `README.md:64` — "request rooms using API with neko-rooms."
- `README.md:151` — "For neko room management software, visit neko-rooms."

**So neko's answer to "many desktops" is "many containers, orchestrated externally."**

### 8.2 What a session is

A **viewer** of the one shared desktop. Permissions are consulted by name throughout;
the ones I verified in code:

- `IsAdmin` — gates resolution changes (`server/internal/websocket/handler/screen.go:12`).
- `CanShareMedia` — gates inbound webcam/mic tracks
  (`server/internal/webrtc/manager.go:385`).
- `IsHost()` — gates all real input, both on the DataChannel
  (`server/internal/webrtc/handler.go:21`, `:94-97`) and on WS keyboard messages
  (`server/internal/websocket/handler/keyboard.go:11`, `:19`).

`UNCERTAIN:` I did not read `server/pkg/types/member.go` or
`server/internal/session/session.go`, so I cannot enumerate the full
`MemberProfile`/`SessionState` field lists or verify names like `CanLogin`,
`CanConnect`, `CanWatch`, `CanHost`, `CanAccessClipboard`. They are referenced from
`message.SessionData{Profile types.MemberProfile, State types.SessionState}`
(`server/pkg/types/message/messages.go:103-107`).

Host/control model: `control/host`, `control/release`, `control/request`
(`server/pkg/types/event/events.go:37-39`), state broadcast as
`ControlHost{ID, HasHost, HostID}` (`messages.go:118-122`). Related config keys exist for
`implicit_hosting`, `control_protection`, and locks — visible via the V2 deprecation
warnings at `server/internal/config/session.go:187-198` (`NEKO_SESSION_LOCKED_CONTROLS`,
`NEKO_SESSION_LOCKED_LOGINS`, `NEKO_SESSION_IMPLICIT_HOSTING`,
`NEKO_SESSION_CONTROL_PROTECTION`). `UNCERTAIN:` I did not read the enforcement code for
these.

### 8.3 Auth

- Session tokens are random 64-char UIDs held in an **in-memory** map
  `tokens map[string]string` → session id (`server/internal/session/manager.go:73`,
  minted at `:93`, collision-checked at `:104-106`, indexed at `:117`, looked up by
  `GetByToken` at `:201-203`, deleted at `:155`). **Not signed, not persisted** — a
  restart invalidates every session. Contrast with Cody's HMAC capability tokens, which
  are stateless and survive restarts.
- A separate `session.api_token` (`server/internal/config/session.go:83`) grants an
  API-only session (`manager.go:45`, `:211`).
- Cookie name `NEKO_SESSION`, configurable — `server/internal/config/session.go:94`.
- Cookie attributes — `server/internal/session/auth.go:12-27`:
  ```go
  sameSite := http.SameSiteDefaultMode
  if manager.config.Cookie.Secure {
      sameSite = http.SameSiteNoneMode
  }
  http.SetCookie(w, &http.Cookie{
      Value:    token,
      Expires:  time.Now().Add(manager.config.Cookie.Expiration),
      Secure:   manager.config.Cookie.Secure,
      SameSite: sameSite,
      HttpOnly: manager.config.Cookie.HTTPOnly,
      Domain:   manager.config.Cookie.Domain,
      Path:     manager.config.Cookie.Path,
  })
  ```
  Note `Secure ⇒ SameSite=None` — chosen so neko can be embedded cross-site in an iframe.
  Logout clears by setting `Expires = time.Unix(0, 0)` (`auth.go:36-38`).
  Login returns the token in the body **only when cookies are disabled** —
  `server/internal/api/session.go:50-52`.
- `UNCERTAIN:` I did not determine how the **WebSocket** connection authenticates
  (cookie vs `?token=` query), nor did I read `server/internal/http/manager.go` /
  `router.go` for CORS, `server.proxy`, path-prefix, or `X-Forwarded-*` trust. Those are
  directly relevant to Caddy-in-front and should be checked before relying on any claim
  here.

### 8.4 Per-session footprint — shared encoder, definitively

**Per session/peer:**
- one `webrtc.PeerConnection` (`manager.go:267`) with its own DTLS/SRTP/ICE agent,
- one audio `Track` + one video `Track` (`manager.go:313`, `:329`),
- one DataChannel (`manager.go:340`),
- one `cc.BandwidthEstimator` + `TrendDetector` when the estimator is on
  (`manager.go:351-362`),
- one `estimatorReader` goroutine (`peer.go:125`),
- registration as a cursor-image listener (`cursor.Image.AddListener`,
  `server/internal/webrtc/cursor/image.go:135-143`).

**Shared across all sessions:**
- the X display, the desktop manager, the capture manager,
- **the GStreamer pipelines.**

**Definitive answer: ONE encode feeds ALL viewers on the same stream id.** The evidence
is unambiguous:

- A `StreamSinkManagerCtx` holds exactly one `gst.Pipeline` and a **map** of listeners
  (`server/internal/capture/streamsink.go:36`, `:40-41`).
- `start()` creates the pipeline only when the listener count is zero, logging
  `"first listener, starting"` (`streamsink.go:153-161`).
- `stop()` destroys it when the count returns to zero, logging
  `"last listener, stopping"` (`streamsink.go:166-171`).
- `onSample` dispatches **the same `types.Sample`** — including the same underlying
  `Data []byte` — to every listener in a loop (`streamsink.go:370-398`).
- `Started()` is literally `ListenersCount() > 0` (`streamsink.go:298-300`).

Docs agree: "The Gstreamer pipeline is started when the first client requests the video
stream and is stopped after the last client disconnects."
(`webpage/docs/configuration/capture.md:30`, repeated for audio at `:333`).

So encode cost scales with **distinct qualities in use**, not viewers. That is the single
most important number in neko's whole cost model.

### 8.5 Compatibility with Cody's one-container-many-INDEPENDENT-sessions

**Verdict: neko's *process model* fights Cody's requirement head-on. neko's *component
design* fits it well. Take the components, reject the process model.**

The conflict is concrete: neko's wiring assumes one display, one desktop manager, one
capture manager, one cursor manager, one codec (§8.1, plus the codec constraint at
`webpage/docs/configuration/capture.md:26-28`). Cody needs N isolated desktops in one
container, each with its own resolution — which is the whole point, since per-session
resolution is exactly what §3.5 shows neko cannot do.

Three ways to reconcile, in order of preference:

1. **N supervised process groups in one container, one per session.** Each session gets
   its own `Xorg :N` (with the patched dummy driver), its own PulseAudio sink, and its own
   encoder process; Cody's Next.js server stays the single front door and owns auth. This
   preserves *all* of neko's technique while giving per-session resolution for free —
   each display has exactly one client, so "resize the display to the client" becomes
   trivially correct and the admin-gate problem evaporates. Cost is ~1 Xorg + 1 encoder
   per active session, comparable to one Chromium per session today.
2. **Sidecar containers, one per session, orchestrated by Cody** — the `neko-rooms`
   model (`README.md:64`, `:151`). Clean isolation, but it needs Docker socket access
   from inside Cody's container and it multiplies the auth surface (§10).
3. **Refactor neko's singletons into per-session instances.** Possible — the manager
   types are already dependency-injected (`capture.New(desktop, config)`,
   `webrtc.New(desktop, capture, config)`) — but it is a fork, and the process-wide
   `prometheus` metric registration with `ConstLabels` per video id
   (`streamsink.go:74-119`) and the package-level mutable state in
   `server/pkg/xorg/xorg.go:43-47` (`ScreenConfigurations`, `debounce_button`,
   `debounce_key`, `mu` — all package globals) would both need untangling. **Those
   package globals are a hard blocker for running two desktops in one process.**

Note also that the shared-encoder win (§8.4) **does not transfer** to Cody's model:
independent desktops cannot share an encode. Cody's encode cost is inherently
per-session, which is precisely why §7.7's session-cap analysis lands on VAAPI.

---

## 9. Known limitations & deliberate omissions

### 9.1 WebCodecs: none. At all.

Grepped the entire tree (`--include='*.ts' --include='*.vue' --include='*.js'
--include='*.go' --include='*.md'`, excluding `.git`) for
`webcodecs|WebCodecs|VideoDecoder|VideoFrame|MediaSource|SourceBuffer|EncodedVideoChunk`:
**zero hits.**

neko is pure `<video srcObject=MediaStream>` + WebRTC. The element is a plain
`<video ref="video" playsinline />` (`client/src/components/video.vue:5`) and the track
arrives via `ontrack` (`client/src/neko/base.ts:312`, handler at `:442`). **Confirmed, not
inferred.** There is no discussion of WebCodecs in the docs either.

**Implication for Cody:** neko provides no prior art for a WebCodecs path. If Cody wants
`VideoDecoder` (which would let it decode H.264 into a canvas and sidestep WebRTC's
jitter buffer entirely), it is charting new ground relative to neko — and it must handle
its own de-jitter, packet loss and reordering, which WebRTC gives away free.

### 9.2 TCP/WS fallback: ICE-over-TCP only, no WebSocket video path

There is **no** WebSocket or HTTP video fallback for the WebRTC stream. Evidence:

- The only transports pion is allowed are the network types assembled from `udpmux`/`epr`
  and `tcpmux` (`server/internal/webrtc/manager.go:196-223`). No other path exists.
- The client refuses to run at all without WebRTC —
  `client/src/neko/base.ts:40`:
  ```js
  return typeof RTCPeerConnection !== 'undefined' && typeof RTCPeerConnection.prototype.addTransceiver !== 'undefined'
  ```
  and `base.ts:62`: `this.onDisconnected(new Error('browser does not support webrtc (RTCPeerConnection missing)'))`.
- The docs state the reverse-proxy consequence bluntly
  (`webpage/docs/configuration/webrtc.md:147`, quoted in §1.5).

What *does* exist as a degraded path is **`tcpmux`** — ICE candidates over TCP, positioned
explicitly as a fallback for UDP-blocked networks
(`webpage/docs/configuration/webrtc.md:190`, quoted in §1.5). Still DTLS/SRTP, still
WebRTC; just TCP-framed.

Separately, a **JPEG screencast** exists as a *non-WebRTC* still-image endpoint —
`capture.screencast.enabled` (default `false`), `rate` `"10/1"`, `quality` `"60"`
(`server/internal/config/capture.go:135-148`), pipeline
`ximagesrc … ! jpegenc quality=%s ! appsink name=appsink`
(`server/internal/capture/manager.go:118-125`), exposed via
`ScreencastManager.Image() ([]byte, error)` (`server/pkg/types/capture.go:43-47`) and
advertised as `SystemInit.ScreencastEnabled` (`messages.go:24`). **This is interesting for
Cody**: it is an acknowledgement that a low-rate MJPEG path has value when WebRTC cannot
be established — essentially what Cody already has, kept as a floor. But it is
still-image polling, not a video transport, and it is off by default.

### 9.3 Mobile and iOS Safari

- `playsinline` is set statically on the element — `client/src/components/video.vue:5`.
  Required or iOS Safari takes the video fullscreen
  ([MDN: `playsinline`](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/video#playsinline)).
- **Autoplay is handled with a mute-and-retry ladder** — `video.vue:431-449`, and the
  comments are the useful part:
  ```js
  // if autoplay is disabled, play() will throw an error
  // and we need to properly save the state otherwise we
  // would be thinking we're playing when we're not
  try {
    await this._video.play()
  } catch (err: any) {
    if (!this._video.muted) {
      // video.play() can fail if audio is set due restrictive
      // browsers autoplay policy -> retry with muted audio
      try {
        this.$accessor.video.setMuted(true)
        this._video.muted = true
        await this._video.play()
      } catch (err: any) {
        // if it still fails, we're not playing anything
        this.$accessor.video.pause()
  ```
  So: try unmuted → on failure mute and retry → on second failure give up and record
  paused state. **Copy this exactly**; it is the correct shape for
  [autoplay policy](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Autoplay).
- A **click-to-unmute overlay** is the user-gesture escape hatch — `video.vue:35`:
  `<div v-else-if="mutedOverlay && muted" class="player-overlay" @click.stop.prevent="unmute">`
  with `mutedOverlay = true` initially (`video.vue:254`) and cleared on unmute
  (`video.vue:409-411`); `playAndUnmute()` at `video.vue:623-626`.
- Apple-platform detection exists: `/(Mac|iPhone|iPod|iPad)/i.test(navigator.platform)`
  — `video.vue:546`. `UNCERTAIN:` I did not read the surrounding code to determine what
  this gates (plausibly a keyboard-modifier remap of Cmd↔Ctrl, but I did not verify).
- The **server-side** iOS fix is the DTLS role pin, §1.2 —
  `settings.SetAnsweringDTLSRole(webrtc.DTLSRoleServer)` with the comment
  "otherwise iOS renegotiation fails with: Failed to set SSL role for the transport."
  (`server/internal/webrtc/manager.go:192-194`). **This one is easy to miss and expensive
  to rediscover.**
- Historical iOS pain, from the release notes:
  - `webpage/docs/release-notes.md:328` — "Audio on iOS works now! Apparently only for
    15+ though [#62]."
  - `webpage/docs/release-notes.md:411` — "**iOS compatibility!** Fixed really strange CSS
    bug, which prevented iOS from loading the video."
  - `webpage/docs/release-notes.md:386` — "Fullscreen support for iOS devices."
  - `webpage/docs/release-notes.md:304` — "Fixed fullscreen incompatibility for Safari [#121]."

`UNCERTAIN:` I did not read `client/src/components/unsupported.vue`, so I cannot report
what it detects or displays.

### 9.4 Firefox and browser-specific quirks

- **Clipboard read is hard-disabled on Firefox** by user-agent string, with a four-line
  justification — `client/src/components/video.vue:335-345`, quoted in full in §5.2:
  > "Firefox 122+ incorrectly reports that it can read the clipboard but it can't /
  > instead it hangs when reading clipboard, until user clicks on the page / and the click
  > itself is not handled by the page at all, also the clipboard / reads always fail with
  > "Clipboard read operation is not allowed.""
- **Keyboard injection into Firefox needed the XI2 fix** — `server/pkg/xorg/xorg.c:4-8`:
  > "GDK3 selects XI2 for the seat keyboard at startup and ignores core-protocol
  > KeyPress events, so core XTest silently drops every key into Firefox."
  This is arguably the single highest-value bug report in the whole repository for anyone
  reimplementing X input.
- **Codec availability** is called out as client-dependent —
  `webpage/docs/configuration/capture.md:41`: "Supported video codecs are dependent on the
  WebRTC implementation used by the client, `vp8` and `h264` are supported by all WebRTC
  implementations." Same for audio at `:342`.
- Safari-the-browser is explicitly out of scope as a *streamed app* for legal reasons —
  `webpage/docs/installation/docker-images.md:136`:
  > "Safari is **not available** and will never be officially supported. Apple's macOS and
  > Safari EULA prohibits running Safari outside of Apple hardware and macOS."
  (Not a streaming limitation; noted so it isn't misread as one.)

### 9.5 Why `server/internal/http/legacy/` exists

A full v2-protocol shim: `legacy/handler.go`, `legacy/session.go`,
`legacy/wstobackend.go`, `legacy/wstoclient.go`, `legacy/event/events.go`,
`legacy/message/messages.go`, `legacy/types/types.go`, plus
`server/internal/webrtc/legacyhandler.go`. It **translates v2 WebSocket messages to and
from the v3 protocol** (the file names `wstobackend`/`wstoclient` say it directly).

The v2→v3 churn is visible everywhere else too: `InitV2`/`SetV2` config paths
(`server/internal/config/capture.go:193`, `:439`), a wall of deprecation warnings
(`capture.go:450`, `:461`, `:468`, `:473`, `:478`, `:483`, `:531`, `:544`, `:555`, `:562`;
`session.go:187-203`), a dedicated migration doc listing removals such as `NEKO_HWENC`
(`webpage/docs/migration-from-v2/README.md:62`), and the `legacy` video pipeline
duplicated purely so v2 clients get a composited pointer
(`server/internal/config/capture.go:359-365`, `:392-397`, `:519-524`).

**Warning for Cody: neko's WS message contract is not stable across major versions, and
was broken hard enough between v2 and v3 to require a translation layer.** Anything Cody
builds against neko's wire protocol — as opposed to against its *techniques* — is
volunteering for that maintenance. This is a substantive argument against the sidecar
option in §10.

### 9.6 Other honest limitations

- **All pipelines share one codec** — `webpage/docs/configuration/capture.md:26-28`
  (quoted §2.2). Blocks per-client codec negotiation.
- **One audio pipeline only** — `capture.md:331`.
- **Resolution is global and admin-only** — §3.5.
- **`use-damage=false` everywhere** — §2.1. Full-frame capture regardless of activity.
- **Clipboard cannot set multiple targets** — `server/internal/desktop/clipboard.go:37-39`
  (`// TODO: Refactor.`).
- **Keyboard layout is set by shelling out to `setxkbmap`**, twice marked
  `// TOOD: Use native API.` — `server/internal/desktop/xorg.go:111`, `:118`.
- **Bandwidth estimator is off by default** — `server/internal/config/webrtc.go:112`.
- **Scroll has no smooth/pixel precision** — §4.4.
- **VP8 hardware encode is disappearing from Intel silicon**, flagged in a source comment
  — `server/internal/config/capture_pipeline.go:83`.
- **`av1enc` checks the wrong plugin** (`"vpx"` instead of `"aom"`), with an adjacent
  `// TODO: check for plugin.` — `capture_pipeline.go:125-128`.
- **Session tokens are in-memory only** — a restart logs everyone out (§8.3).
- **X11 only; no Wayland** — §3.6.

---

## 10. Judgement — embed vs implement

**Recommendation: (b) implement neko's techniques inside Cody's own `DisplayProvider`
seam. Do not run neko as a sidecar.**

I hold this with high confidence, and the decisive reasons are structural rather than
aesthetic.

### 10.1 Why the sidecar loses

1. **The auth model does not compose, and cannot be made to.** Cody gates the display
   socket with a signed session cookie / HMAC capability token
   (`lib/display/access.ts`, `lib/display/capability.ts`). neko has its own orthogonal
   auth: an in-memory random token in a `NEKO_SESSION` cookie
   (`server/internal/session/manager.go:73`, `:93`; `server/internal/config/session.go:94`;
   `server/internal/session/auth.go:12-27`). Bridging them means Cody must mint a neko
   session per user via neko's login API and then proxy or hand over that cookie. That is
   a second, weaker credential system with different lifetime semantics — **neko's tokens
   die on restart, Cody's HMAC tokens don't** — living behind the same Caddy origin. Every
   authorisation question (can this user resize? can this user access the clipboard?) now
   has two answers that must be kept in sync, and neko's answers are enforced by
   `IsAdmin`/`IsHost` checks Cody cannot see
   (`handler/screen.go:12`, `webrtc/handler.go:94-97`).
2. **Caddy cannot proxy the media, so the sidecar leaks a second network surface.** Per
   `webpage/docs/configuration/webrtc.md:147`, WebRTC cannot go through an HTTP reverse
   proxy. Cody's single clean story — "everything arrives over 443 at Caddy, authenticated
   by a signed cookie" — becomes "everything except the video, which arrives on UDP
   59000 at a container Caddy doesn't know about, authorised by a DTLS fingerprint in an
   SDP that a *different* auth system issued." The capability-token gate stops being the
   single chokepoint. That is a real security regression, not a configuration
   inconvenience.
3. **neko's process model is one desktop per container** (§8.1, §8.5), so the sidecar is
   not *a* sidecar — it is **one container per session**, spawned on demand. Cody would
   have to become a container orchestrator (Docker socket access from inside its own
   container, lifecycle, GC of leaked containers, port allocation per session, image
   distribution) — reimplementing `neko-rooms` (`README.md:151`) as a prerequisite to
   showing a preview pane. That is a categorically larger project than writing a
   provider, and it lands squarely on Cody's one-container deployment constraint.
4. **The wire contract is unstable.** §9.5: the v2→v3 transition needed a whole
   translation subsystem (`server/internal/http/legacy/*`). Coupling Cody's client to
   neko's WS protocol buys a permanent upgrade tax.
5. **Cody's ladder cannot rank what it cannot probe.** `lib/display/ladder.ts` filters
   candidates on facts the *document* knows — mixed content, loopback semantics, page
   hostname (`lib/display/ladder.ts:14-27`). A neko candidate's actual viability depends
   on whether a UDP path exists between this client and the container, which is
   unknowable from the page and unprobeable without attempting a full ICE exchange. It
   would have to be ranked optimistically and fail late — exactly the failure mode the
   ladder exists to prevent.
6. **The features Cody most needs are the ones neko punts on.** Per-client resolution and
   density (§3.5) are *the* requirement, and neko's answer is "admin sets it globally."
   Embedding neko means inheriting the limitation Cody is trying to remove.

### 10.2 Why implementing wins

1. **Cody already owns the right seam.** `DisplayProvider` is
   `{ descriptor, requestId, attach(socket), dispose() }`
   (`lib/display/provider.ts:6-11`) and `DisplayProviderDescriptor` already anticipates
   this exact case: `renderer: "raster" | "webrtc" | "native"`
   (`lib/display/types.ts:83`). The comment above it is already correct about the
   destination — `lib/display/types.ts:81`:
   > `/** Future providers (Android/X11/Wayland) implement this seam, commonly with WebRTC. */`
   The abstraction was designed for this. Use it.
2. **Auth stays exactly as it is.** A codec provider attaches to the *same* authenticated
   `/api/display/socket?sessionId=` upgrade in `bin/cody-server.js`, gated by the same
   `access.ts`/`capability.ts`. The WebSocket carries signalling; only DTLS/SRTP media
   takes the separate UDP path, and its keys are exchanged over the already-authenticated
   socket. One credential, one chokepoint, Caddy still in front of everything that speaks
   HTTP.
3. **The valuable parts of neko are techniques, not code** — and most are small. The
   `libxcvt` + `XRRCreateMode` resize (§3.3) is ~50 lines of C. The keysym→keycode
   three-tier lookup (§4.2) is ~90 lines, and TigerVNC's original is cited in neko's own
   comments (`xorg.c:157`, `:196`) so it can be taken from the upstream source directly.
   The keyframe lobby (§1.7) is ~20 lines. The `add-render-group.sh` GID reconciliation
   (§7.4) is 18 lines. None of this requires adopting neko's process model, its Vue
   client, its plugin system, its chat/emote features, or its protocol.
4. **One-container-many-sessions is achievable directly** (§8.5, option 1): N supervised
   `Xorg :N` + encoder groups inside Cody's existing container, with Cody's Next.js
   server as the single front door. Since each display has exactly one client,
   **per-session resolution — the thing CDP forbids and neko declines — becomes trivially
   correct.** That is the actual prize.
5. **Cody can be better than neko where it matters**, cheaply: `playoutDelayHint` /
   `jitterBufferTarget` / `contentHint` (§1.7, all absent from neko), `profile=main`
   instead of `constrained-baseline` (§2.4), a real bitrate, no nearest-neighbour
   rescale, and a graceful VAAPI→NVENC→x264→JPEG ladder instead of neko's
   panic-on-failure (§7.7).
6. **The JPEG rung survives as the floor.** Cody's ladder already guarantees a
   `{kind:"stream"}` candidate that always works (`lib/display/types.ts:32`:
   `/** Ranked best-fidelity-first. ALWAYS ends with { kind: "stream" }. */`). A codec rung
   slots in *above* it, and when UDP is blocked the existing path still serves. neko has
   no equivalent graceful degradation (§9.2) — this is a place where Cody's existing
   architecture is genuinely better and must not be given up.

### 10.3 The honest cost, stated plainly

Implementing means owning: a real Xorg + patched dummy driver in the image, a GStreamer
(or ffmpeg) encode graph, a pion-equivalent WebRTC server in Node (`werift`, or a Go/Rust
sidecar *process* — not container — speaking to Cody over a Unix socket), XTEST input via
FFI, and the keysym mapping. That is substantially more than a JPEG screencast loop.

Two things make it tractable. First, it is **incremental**: the provider seam means the
codec rung can land alongside the JPEG rung and be ranked below it until it is proven,
with zero risk to the working path. Second, the hard parts are **already solved in
public source with citations above** — this document is the specification.

**Where the sidecar would win, for the record:** if the requirement were "one shared
desktop that several people watch together" rather than "one private desktop per user,"
neko's model would fit almost perfectly, its shared-encoder fan-out (§8.4) would be a
large efficiency win, and the correct answer would flip. It is worth re-checking that
assumption with the owner before committing, because it is the single hinge on which this
recommendation turns.

---

## 11. Direct mapping — neko learning → concrete Cody change

Grounded in Cody's real symbols, read read-only from `/data/home/Cody`. I did not modify
anything.

### 11.1 `lib/display/types.ts` — descriptor and handshake

`DisplayProviderDescriptor` today (`lib/display/types.ts:82-87`) is
`{ renderer, media, audio, interactive }` — enough to *name* a codec provider
(`renderer: "webrtc"`, `media: ["h264"]`) but not enough to *negotiate* one. What a
codec-based provider needs beyond `media: "jpeg"`:

| field | why | neko evidence |
|---|---|---|
| `codecs: readonly { mime, profile, level }[]` | H.264 needs a profile/level, and `constrained-baseline` vs `main` is the single biggest text-sharpness lever | neko pins `profile-level-id=42e01f` in SDP (`codecs.go:129`) and `profile=constrained-baseline` in every pipeline (`capture_pipeline.go:159`, `:171`, `:188`) |
| `transport: "websocket" \| "webrtc"` | the media path is no longer the signalling path | neko's media never traverses the WS (`webrtc.md:147`) |
| `resolutionOwner: "client" \| "server"` | **the crux.** CDP forces server-owned density; a capture provider can hand it to the client | neko is server-owned and admin-gated (`handler/screen.go:12`); Cody's whole gain is flipping this |
| `maxResolution` / `supportedRates` | so the client cannot request an unencodable mode | neko filters rates `fps > 60 \|\| (fps > 30 && fps%10 != 0)` (`desktop/xorg.go:74`) and rounds width to 8 (`xorg.go:205`) |
| `hardware: "vaapi" \| "nvenc" \| "software"` | observability: the owner must be able to see which encoder actually engaged | neko only logs it (`streamsink.go:315-318`); docs tell users to grep logs (`versioned_docs/version-v2/README.md:304`) |
| `audio: true` + codec | already a bool; needs the codec | `opus`, `inband-fec=true` (`codecs.go:192`) |

`DisplayStreamHello` (`lib/display/types.ts:47-60`) is where negotiation must happen. It
currently asserts `renderer: "raster"`, `media: "jpeg"` and an `input[]` capability array
— and its existing comment already states the right principle
(`lib/display/types.ts:52-57`): the client must gate on the array, not the renderer.
Extend that principle to the codec:

- **Server → client in `hello`:** chosen `codec` + `profile` + `level`, the transport,
  `resolutionOwner`, current `width`/`height`/`deviceScaleFactor`, and whether the cursor
  is **in-band or out-of-band** (neko's `show_pointer` per stream,
  `server/pkg/types/capture.go:162`) — the client must know whether to draw its own
  pointer.
- **Client → server, before `hello` is finalised:** decoder capabilities. The right
  primitive is
  [`RTCRtpReceiver.getCapabilities("video")`](https://developer.mozilla.org/en-US/docs/Web/API/RTCRtpReceiver/getCapabilities_static)
  (and `navigator.mediaCapabilities.decodingInfo()` for a power/smoothness hint). This is
  the step neko skips entirely — it registers exactly one codec server-side
  (`webrtc/manager.go:176-181`) and lets SDP negotiation fail if the client disagrees.
  Cody should not copy that.
- **Density/resolution ownership must be settled in the handshake, not assumed.** Today
  `{ type: "resize", width, height, deviceScaleFactor }`
  (`lib/display/types.ts:74`) is a *request* the raster provider partly ignores —
  `provider.ts:29-40` documents that capture density is a launch-time property and the
  first resize only arrives after attach, forcing a grace period. A capture provider
  inverts this: resize becomes **authoritative and repeatable**, implemented as
  §3.3's create-mode-then-set-mode. The `hello` must therefore say which regime is in
  force, so `PreviewPanel.tsx` knows whether to letterbox a fixed raster (neko-style,
  `video.vue:882-887`) or to drive the display to its own size.

### 11.2 `lib/display/provider.ts` — the new provider

`RasterWebProvider` (`lib/display/provider.ts:121`) stays untouched. Add a sibling
implementing the same `DisplayProvider` interface (`provider.ts:6-11`):

- `attach(socket)` runs signalling over the **existing authenticated socket**, mirroring
  neko's event names as a proven shape (`server/pkg/types/event/events.go:17-25`):
  server-offers-first (`webrtc/manager.go:271`, `:594`), trickle ICE by default
  (`config/webrtc.go:64`), candidates as `webrtc.ICECandidateInit` JSON
  (`messages.go:69-71`). **Do not** copy the double-JSON-encoding of candidates
  (`client/src/neko/base.ts:326`).
- `dispose()` must include neko's stuck-key watchdog equivalent —
  `xorg.ResetKeys()` / `CheckKeys(duration)` (`server/pkg/xorg/xorg.go:160-197`).
  A client that vanishes mid-keypress must not leave a modifier latched.
- Input moves to a DataChannel with a binary header. Copy the *shape* of
  `payload.Header{Event uint8; Length uint16}` (`payload/types.go:3-6`) and the opcode
  set (`payload/receive.go:5-17`), but **use one opcode space for both directions** —
  neko's overlap (§1.6) is a wart.
- Cursor out-of-band: `OP_CURSOR_POSITION`/`OP_CURSOR_IMAGE`
  (`payload/send.go:6-7`) plus a serial-keyed image cache
  (`webrtc/cursor/image.go:85-119`). This is a large perceived-quality win for modest
  effort.
- Encoder selection with graceful degradation. neko probes with
  `gst.CheckPlugins`/`CheckElement` (`server/pkg/gst/gst.go:188-207`,
  `capture_pipeline.go:167`) but then **panics** on pipeline failure
  (`capture/manager.go:216-219`). Cody must instead walk
  **VAAPI → NVENC → x264 zerolatency**, and report the outcome in the descriptor's
  `hardware` field. A probe that only checks plugin registration is insufficient —
  §2.3 notes a registered `va` plugin with no `/dev/dri` passes the check and fails at
  start, so the probe must attempt a real short-lived encode.

### 11.3 `lib/display/native-gateway.ts` and `lib/display/ladder.ts`

- `DisplayCandidateKind` is `"direct" | "native" | "stream"`
  (`lib/display/types.ts:2`). A codec rung is a **fourth kind** ranked between `native`
  and `stream` — better than raster JPEG, worse than a real origin.
- The `{kind:"stream"}` floor invariant (`lib/display/types.ts:32`) must be preserved
  verbatim. This is Cody's answer to §9.2, and it is better than neko's — neko simply
  fails when WebRTC is blocked (`client/src/neko/base.ts:40`, `:62`).
- Add the one client-side fact the ladder cannot currently express: a codec candidate is
  only viable if the browser can *decode* the offered codec. That is a document-side fact
  in exactly the sense `ladder.ts:12-27` describes, so it belongs in
  `orderDisplayCandidates` alongside the mixed-content and loopback rules — filter, don't
  probe.

### 11.4 `components/PreviewPanel.tsx`

- Replace the `<canvas>` blit with a `<video>` carrying **`playsinline`** and the
  mute-and-retry autoplay ladder from §9.3 (`client/src/components/video.vue:5`,
  `:431-449`) plus a click-to-unmute overlay (`video.vue:35`).
- Set the three knobs neko omits (§1.7): `playoutDelayHint` ≈ 0, a small
  `jitterBufferTarget`, and `contentHint`.
- Coordinate transform: neko's `Math.round((w / rect.width) * (e.clientX - rect.left))`
  (`video.vue:687-691`) is needed only when the raster is a fixed size. If Cody takes
  `resolutionOwner: "client"`, the transform degenerates to identity — **which is the
  whole point**, and eliminates a class of off-by-one input bugs.
- Keyboard: adopt Guacamole's keyboard (`client/src/utils/guacamole-keyboard.js`,
  Apache-2.0 upstream) rather than sending `KeyboardEvent.code`. Cody's current
  `{ type:"keyboard", action, key, code, text, modifiers }`
  (`lib/display/types.ts:76`) is workable for CDP, which accepts `code` — but note that a
  `code`-keyed table can never be complete for non-US layouts, which is exactly why neko
  converts to keysyms in the browser (§4.2) and dynamically remaps server-side. An
  X11/Wayland provider needs **keysyms**, so the control message needs a keysym field for
  that provider, advertised through `input[]`.

### 11.5 Container and docs

Requirements derived in §7.8 (`/dev/dri` mapping, iHD driver, `gstreamer1.0-plugins-bad`
for `vah264enc`, the render-GID one-shot ported from
`runtime/intel/add-render-group.sh:1-18` running as root before the display starts, and
`vainfo | grep VAProfileH264.*EncSlice` as the verification line) belong in
`docker/unraid-template.xml`, `docker/Dockerfile`, `docker/entrypoint.sh` and
`docs/unraid.md`. **A sibling agent (`GpuPassthrough`) owns those files and is editing
them now** — I have not read or touched them. Treat §7.8 as the requirement set to check
that work against, and §7.7's NVENC-session-cap analysis as the reason the default must be
VAAPI rather than NVENC.

---

## 12. Confidence and gaps

**High confidence (read the code line by line):** the GStreamer pipeline strings and
their composition; the VAAPI/NVENC/software encoder properties; chroma formats; the
adaptive-bitrate loop; encoder/listener fan-out and the keyframe lobby; the pion setting
engine and interceptor wiring; the DataChannel wire format and opcodes; the keysym→keycode
three-tier algorithm and the XI2 dispatch fix; the RandR/libxcvt resize path and its
downstream pipeline rebuild; `xorg.conf` and the dummy patch's added symbols; the
`xclip` clipboard mechanics; the browser clipboard feature detection; the three Docker
flavours and the render-GID script; the absence of WebCodecs/MSE/Wayland; the
one-desktop-per-container cardinality and shared-encoder fan-out.

**Explicit gaps** (each flagged `UNCERTAIN:` in place, collected here):

1. `server/pkg/xorg/keysymdef.go` — not opened; size/shape/consumers unknown.
2. `utils/xorg-deps/xf86-input-neko/src/neko.c` — not read; the driver's server-side
   dispatch is undocumented here.
3. The dummy-driver patch was read as hunk headers + added-symbol list, not line by line.
4. `server/pkg/xevent/xevent.go` and `server/internal/desktop/xevent.go` — not read;
   `clipboard-updated` is *presumed* `XFixesSelectionNotify` from the `-lXfixes` link
   flag, not confirmed.
5. Clipboard **permission gating** (`CanAccessClipboard`?) and any **size limit** — the
   WS/HTTP clipboard handlers were not read.
6. WebSocket **authentication** mechanism (cookie vs query token), and all of
   `server/internal/http/manager.go`/`router.go`: CORS, `server.proxy`, path prefix,
   `X-Forwarded-*` trust. **Directly relevant to Caddy; verify before relying on §8.3.**
7. Full `MemberProfile`/`SessionState` field lists — `server/pkg/types/member.go` and
   `server/internal/session/session.go` not read; permission names beyond `IsAdmin`,
   `CanShareMedia`, `IsHost()` unverified.
8. Enforcement code for `implicit_hosting`, `control_protection`, locks — only the
   deprecation warnings were seen.
9. `utils/docker/main.go` and the root `build` script — templating and tagging mechanics
   unknown.
10. `apps/*/Dockerfile` and app supervisord snippets — the app-layer pattern and
    app-death behaviour not documented; no `--shm-size`/`/dev/shm` check performed.
11. `docker-compose.yaml` — not read; the `--gpus` / `runtime: nvidia` requirement is
    `[INFERENCE]`.
12. `client/src/components/unsupported.vue` — not read.
13. Whether X server-side autorepeat is explicitly suppressed — no
    `XAutoRepeatOff`/`XkbSetAutoRepeatRate` found, but not exhaustively searched.
14. Client-side `mousemove` throttling and scroll scaling in `video.vue` — not audited.
15. What `/(Mac|iPhone|iPod|iPad)/i.test(navigator.platform)` (`video.vue:546`) gates.
16. Whether the GStreamer appsink buffer is copied once into Go memory at the cgo
    boundary — `server/pkg/gst/gst.go` appsink callback not read closely.

**All silicon-capability claims** (UHD 630 Gen9.5 encode entrypoints, NVENC generational
features, NVENC session caps) are labelled `[INFERENCE]` — neko's source contains no
statements about GPU generations or session limits, and I verified that its code has **no
handling for encode-session exhaustion** anywhere.
