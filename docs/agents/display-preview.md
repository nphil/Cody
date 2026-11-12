# Preview and display surface, screenshots, the shared browser

← Back to [AGENTS.md](../../AGENTS.md) · Full text of the sections AGENTS.md summarizes, moved verbatim; AGENTS.md keeps a short summary of each.

Sections in this file:
- Agent-driven Preview panel (`lib/preview-url.ts`, `lib/preview-autoopen.ts`)
- Preview screenshots (`lib/preview-screenshot.ts`)
- Universal display/preview surface (`lib/display/`)
- The shared browser (`lib/display/shared-browser.ts`)

### Agent-driven Preview panel (`lib/preview-url.ts`, `lib/preview-autoopen.ts`)
- The agent reaches the Preview tab two ways. Deliberately: the `open_preview`
  host tool settles SERVER-side (rpc-manager `SERVER_HOST_TOOLS`) — it
  publishes on the display-request bus (`lib/display/bus.ts`), the panel
  auto-opens via the display SSE, and the tool result reports server-probed
  reachability back to the model. `open_url` host-tool calls carrying a
  loopback URL funnel into the same bus from the browser (a host_tool_call
  arrives outside any user gesture, so `window.open` would be
  popup-blocked). Implicitly: loopback URLs in **live**
  assistant replies (`message_end` frames only — history loads and reconnect
  hydration never trigger) are offered to `createPreviewAutoOpener`, which
  opens the panel only once a no-cors probe confirms something answers,
  retrying briefly so a still-booting dev server is not missed.
- Auto-open policy: once per (session, url) pair; explicit host-tool opens
  mark the pair handled so follow-up prose cannot re-open a panel the user
  closed; a session switch abandons pending probes. URL rules are shared in
  `normalizePreviewUrl` — loopback only (an agent may only publish its own dev
  server; candidate resolution widens it afterwards), with 0.0.0.0 / [::] /
  [::1] canonicalized to localhost.
- Every trigger — host tool, URL sniffing, manual URL bar — POSTs to
  `/api/agent/[id]/display`, so one pipeline feeds `PreviewPanel`: it consumes
  the latest `DisplayRequestV1` from `useDisplayRequests` (SSE snapshot + live
  events), and a live event both opens the panel and marks the (session, url)
  pair handled for the auto-opener.
- Host tools exist only on omp's rpc-ui protocol; every other engine gets the
  assistant-text detection path here, plus the bundled display MCP server (see
  `lib/display/` below) — as `--mcp-config` on a per-turn CLI's argv, or as an
  ACP `McpServerStdio` named at `session/new`.

### Preview screenshots (`lib/preview-screenshot.ts`)
- `preview_screenshot` is a SERVER-implemented host tool (rpc-manager
  `SERVER_HOST_TOOLS`): registered at wrapper initialize, merged into every UI
  `set_host_tools` (omp replaces the roster per call, so a reconnect
  re-register must never drop it), and settled in `handleFrame` with
  `sendFrame` — no attached browser required. The result carries the image as an
  image content block plus a text line, so vision models see their own work.
- **Every capture must fit one RPC frame.** The image rides to omp as base64
  inside a single NDJSON line (1 MiB, no outbound chunking), and a dropped
  result hangs the tool call forever — so captures walk a ladder against
  `SCREENSHOT_MAX_BYTES` (600 KiB raw ≈ 800 KiB base64): PNG at the requested
  size → WebP same size → WebP capped to 1280 long edge → WebP capped to 800.
  First rung within budget wins, so an ordinary capture stays crisp PNG; the
  extension in `--screenshot=out.<ext>` is what selects the encoder (verified on
  Chromium 151). `ScreenshotResult.mimeType` reports what was actually produced
  (sniffed from the bytes) and width/height report what was actually rendered.
  Nothing over budget is ever returned: the last rung throws
  `ScreenshotError("too_large")`, which the API maps to 413 and the host tool
  answers as a normal tool error.
- Rendering shells out to a headless Chromium in one-shot `--screenshot` mode
  (no CDP, no new dependency). Binary resolution: `CODY_CHROMIUM_BIN` →
  Playwright caches → PATH → common install paths; the Docker image bundles
  Debian chromium and pins `CODY_CHROMIUM_BIN=/usr/bin/chromium` (smoke test
  asserts it). Loopback-only via `normalizePreviewUrl` — that rule is the SSRF
  guard, do not widen it casually. `--no-sandbox` only when running as root.
- Chat display: `ToolCallBlock` renders tool-result image blocks as
  always-visible thumbnails (not behind the collapse). History loads defer
  those images (`deferMedia`) — the reader replaces each with a url-source
  block minted by `toolResultImageUrl` pointing at
  `/api/sessions/[id]/media?entryId=&index=`, which streams the bytes with
  blob resolution on. The media route MUST enumerate images with the same
  predicate the deferral used (`isDeferrableToolResultImage`) or indexes
  drift.
- The Preview panel's camera button posts `/api/preview/screenshot` and
  attaches the image to the composer via `ChatInputHandle.addFiles`, carrying
  the mime type the server actually produced (never an assumed PNG) — the
  screenshot rides the existing image-attach path into whichever engine is
  active (turn engines currently reject image prompts with
  `images_unsupported`, same as a manual attach).

### Universal display/preview surface (`lib/display/`)
- **Session-scoped request bus** (`bus.ts`): `DisplayRequestV1` per session in a
  `globalThis` map (latest + listeners, hot-reload safe). Engines that rekey a
  session mid-run (`session_info_update`) call `aliasDisplaySession(old, new)` —
  the alias chain, latest request, and listeners all move to the new id.
- **Loopback-only publication**: `validation.ts` accepts http(s) URLs on
  localhost/127.0.0.1/[::1] and rejects credentials. The preview surface is for
  dev servers the agent started, not a general browser. Resolution then
  rewrites that loopback URL into the candidates below.
- **Fidelity ladder** (`native-gateway.ts`): resolution returns
  `candidates: DisplayCandidate[]`, ranked best-fidelity-first, and the client
  uses the first one that works. There is no single `transport` any more, and
  streaming is NOT the default — it is the floor.
  1. `direct` — a real iframe against the dev server's own origin, ranked
     **local-first**: the loopback URL we were handed leads the group, then one
     candidate per non-loopback IPv4 interface (`os.networkInterfaces()`) that
     answers a probe, so a dev server bound to `0.0.0.0` is framed straight
     from the tablet over LAN/Tailscale. Highest fidelity: real DOM, real
     fonts, real input, no re-encode.
     The loopback rung is what makes a co-located install (Windows desktop
     shell, on-device Android, plain `npm run dev`) render natively with zero
     configuration and no Chromium — but it is only usable by a browser on this
     machine, so `lib/display/ladder.ts` **drops it structurally** for any
     other client. That gate cannot be a probe: a remote device probing
     `127.0.0.1` may get an opaque success from an unrelated local app and
     frame the wrong thing.
  2. `native` — the `CODY_PREVIEW_BASE_URL` wildcard-subdomain HTTP+WS reverse
     proxy. It strips credentials in BOTH directions (cookie/authorization on
     the way in, set-cookie on the way out) so the iframe never carries Cody
     credentials into the dev server and the dev server can never plant
     cookies on the preview domain — and it strips `X-Frame-Options` + the
     `frame-ancestors` directive from responses it re-serves under its token
     origin, so ANY target (a frame-guarded Cody dev server included) is
     frameable through it, like any port-forwarding preview proxy. Only
     present when configured, and only minted when a server-side cookie-less
     probe gets a 2xx (`gatewayRenderable`): an auth-gated target could at
     most render a login form whose session cookie the gateway discards — a
     dead end, so it rides the streamed rung instead. **Do NOT "fix"
     auth-gated gateway targets by passing set-cookie through** (cookie
     tossing / session fixation against Cody itself); run the dev server
     without auth instead — a bare `npm run dev` with no accounts is already
     open. Covered by `lib/native-gateway.test.mjs`.
  3. `stream` — always last, always present: a server-side Chromium
     (`CODY_CHROMIUM_BIN`, puppeteer-core, CDP screencast) renders the URL and
     ships JPEG frames + pointer/keyboard input over the
     `/api/display/socket?sessionId=` WS handled in `bin/cody-server.js`.
     Needs nothing of the client's network, so it cannot fail to be available.
- **Client-side ranking** (`lib/display/ladder.ts`): `orderDisplayCandidates()`
  is pure and shared (the panel imports it; future native clients can too). It
  encodes the three facts only the document knows — mixed content is
  hard-blocked, loopback means *this* machine, and our own hostname provably
  routes here so it outranks the rest of the direct group. Unit-tested in
  `lib/display.test.mjs`; there is deliberately no "remote mode" flag, because
  one server can serve a local webview and a remote tablet at the same time and
  each resolves correctly from the same candidate list.
- **Capability tokens** (`capability.ts`): engine-side MCP servers post to
  `/api/internal/display` with an HMAC session-scoped token.
  `CODY_INTERNAL_DISPLAY_SECRET`/`CODY_INTERNAL_DISPLAY_ORIGIN` are minted by
  `bin/cody-server.js` at boot and live only in the environment, never persisted.
- **Per-engine wiring**: omp gets a Cody-owned `open_preview` host
  tools. `lib/rpc-manager.ts` sends `set_host_tools` at session start, merges them
  into any browser-registered tool list, and routes their `host_tool_call`s to their
  server implementations. Every other engine gets the bundled stdio MCP server
  (`bin/cody-display-mcp.js`) via `lib/display/engine-tools.ts`: `claudeDisplayMcpConfig`
  for a per-turn CLI's `--mcp-config`, `displayMcpAcpServer` for an ACP session's
  `mcpServers`. The ACP builder mints a capability token, so it throws when the server's
  internal display origin/secret are absent; an adapter's `mcpServers` hook must catch
  that and report an empty list. `scripts/engine-bringup.mjs` drives adapters with no
  server behind them, and a throw there aborts `session/new`: no bridge is a missing
  Preview button, a throw is a chat that will not open.

- **The project To-do list is human-only; agents have no access to it.** `.cody/todo.json`
  sits at the resolved project root so it is visible in the project and survives session
  or engine changes. Cody writes it atomically and preserves unknown top-level keys,
  and only the human does so, through `/api/todo` (the sidebar panel). Agents have no
  tool, prompt, MCP bridge or internal route for it, so it behaves as if it did not
  exist from their side. The file is NOT hidden: an agent listing the project's files
  can still see `.cody/todo.json` (and could read or edit it with ordinary file tools),
  which is accepted. Do not add an agent-facing path back: "update your todo list" means
  the agent's OWN plan (omp `todo` → the composer's Tasks list), and a tool named after
  the sidebar list made the wrong tool the obvious pick. The To-do tab (panel id
  `tasks`) calls this section To-do; the legacy `.cody/tasks.json` runner is its
  collapsed Commands section only when that file exists.
- **Client**: `hooks/useDisplayRequests.ts` subscribes to the SSE route;
  `AppShell` auto-opens the right panel in `preview` mode on live requests —
  the explicit, server-driven trigger alongside the client-side URL sniffing
  in `lib/preview-autoopen.ts` above. `PreviewPanel` then walks `candidates`
  in order and commits to the first usable rung, subject to two gates:
  - **Mixed content**: an `http:` candidate is skipped outright when the page
    is on `https:` — the browser hard-blocks it, no probe can save it.
  - **Current hostname wins**: a candidate whose `host` equals
    `window.location.hostname` moves to the front of the direct group. That
    host is provably routable from this device — it is how the page loaded.
  A `direct`/`native` rung is confirmed with a no-cors probe (an opaque
  response proves something answered; a network error falls through to the
  next rung); `stream` needs no probe.
- **The active rung is visible**: a quiet persistent badge in the subtitle bar
  plus a transient pill naming the method (Direct / Gateway / Streamed) once
  per resolved request. On the streamed rung the badge also names the CODEC —
  `Streamed · H.264` vs `Streamed · JPEG stills` — because those are the same
  rung and would otherwise look identical. A silent downgrade is the whole thing
  we are preventing, and it has two flavours now: falling to the streamed rung at
  all, and falling from video to stills inside it. If fidelity drops, the user
  sees why. The pop-out window has no subtitle bar, so it carries the same label
  in `document.title` and flashes a pill on every change.
- **Streamed-rung client** (`components/StreamedDisplay.tsx`): one implementation
  of the socket protocol, shared by the panel and the pop-out route. It presents
  two ways over one socket, with the same controls and the same geometry: JPEG
  stills and H.264. The canvas **backing store is `cssSize × devicePixelRatio`**
  (capped at 3) with the CSS box untouched, and that same factor rides every
  `resize` as `deviceScaleFactor` — the provider renders at that density, so the
  frame lands 1:1 and nothing resamples at either end. The first `resize` goes out
  on `socket.onopen`, not on `ready`: the provider reads its launch density from
  it and waits only briefly.
  - **Stills**: frames decode off-thread via `createImageBitmap` and present
    through an `ImageBitmapRenderingContext` (`transferFromImageBitmap`), which
    also skips a blit; Chromium leaves the canvas's intrinsic size alone, so the
    backing store stays authoritative. A `new Image()` + `drawImage` path covers
    engines without `createImageBitmap`, and a binary frame is accepted as a
    `Blob` or an `ArrayBuffer`.
  - **H.264 negotiation**: `hello` is answered with
    `{type:"capabilities",decoders:[…]}` — RFC 6381 strings this engine actually
    verified with `VideoDecoder.isConfigSupported`, and `[]` when it has no
    `VideoDecoder` at all, which keeps the session on stills. The probe walks
    levels DESCENDING per profile (High, Main, Constrained Baseline) and
    advertises ONE ceiling string per profile. That is deliberate: a level in a
    capability string is a ceiling and H.264 levels are nested, so the highest
    accepted level states the entire answer for that profile, and probing
    downward can never advertise a level below what the engine decodes — which
    matters because the encoder derives `level_idc` from frame size (5.0 at
    2560×1600, 5.1 at 2880×1800). Do not "simplify" it into advertising every
    string. The codec in the provider's `video` message is opaque input to
    `configure`: it is parsed from the real SPS and its level need not appear in
    the advertised list, so never require an exact match against it.
  - **H.264 frames**: one binary message is exactly one access unit. `key` vs
    `delta` comes from scanning every Annex-B start code for NAL type 5 — no AUD
    is emitted, so there is nothing else to key off — and deltas are DISCARDED
    until the first key, because a decoder handed a delta first throws and the
    throw kills the decoder, not the frame. Every IDR repeats its SPS/PPS, which
    is what lets a late joiner and a just-reset decoder recover. A decoder error
    closes the decoder, reopens it, reports `H.264 — recovering` and sends
    `{type:"keyframe"}`; four consecutive faults stop and say so rather than
    cycling keyframe requests forever. A second `hello` is authoritative: tear the
    decoder down and go back to stills, mid-stream if need be.
  - **Trap — one context kind per canvas**: `getContext` refuses a second kind
    forever, and stills hold a `bitmaprenderer` while video needs a 2d context.
    The negotiated renderer therefore keys the canvas **ELEMENT**, and each
    context is cached against the element it came from; presenting into the
    swapped-out canvas paints something nobody is showing.
  - **Trap — Annex-B means no `description`**: the WebCodecs AVC registration
    signals Annex-B by the ABSENCE of an `AVCDecoderConfigurationRecord`, so
    `configure` must be called without one. Filling it in from the `video` message
    configures the wrong format outright.
  - **Trap — close every `VideoFrame`**: in a `finally`, superseded frames
    included. A frame pins a decoder buffer, the pool is a handful deep, and
    leaking one per frame stalls the stream within a second — the classic
    WebCodecs bug, and it looks like a network fault.
  - **Trap — crop the alignment padding**: coded axes are macroblock-aligned, so
    up to 15 px of the right and bottom edge is padding, not content.
    `visibleRect` is honored first (for a provider that sets SPS cropping), then
    an axis is cropped to `round(viewport × deviceScaleFactor)` when it overshoots
    by less than a macroblock; a bigger difference is a resize the encoder has not
    caught up with and is presented whole so CSS scales it, exactly as a
    wrong-sized JPEG behaves. Crop, never letterbox, never stretch. And
    `codedWidth`/`codedHeight` on a decoded frame are no substitute for either
    bound — a decoder can report 1026 rows for a 1008-row picture.
  - **Trap — pointer space is the viewport's CSS pixels**: NOT the backing store
    and NOT the coded size. Remote input space is CSS px, so scaling by
    `canvas.width / rect.width` sends every click at `deviceScaleFactor`× too far,
    and folding in macroblock padding skews it by a few pixels that get blamed on
    everything else.
- **Clipboard bridge**: `hello.input` may advertise `"clipboard"`. Only then does
  the panel show copy/paste controls, and only then does the surface intercept
  Ctrl/Cmd+C and Ctrl/Cmd+V rather than forwarding them (every other key,
  Ctrl+A and Tab included, is forwarded untouched). Copy is a round-trip —
  `{type:"clipboard",action:"read"}` → `{type:"clipboard",text}` →
  `navigator.clipboard.writeText`; paste reads the local clipboard on the click
  gesture and sends `{type:"clipboard",action:"write",text}`, clamped to 8192
  chars to match the provider's `insertText` slice and stay inside the socket's
  64 KiB frame cap. The gate is the advertised capability, NEVER
  `renderer === "raster"` — a surface that cannot bridge the clipboard offers no
  clipboard UI, which is what keeps the protocol usable for X11/Android later.
- **Pop-out window** (`app/display/[id]/page.tsx` → `components/DisplayWindow.tsx`):
  the streamed surface at full viewport on the same authenticated socket, auth-
  gated by `proxy.ts` like any page. It follows the display SSE, so a newly
  published request re-targets it instead of going dark when the server recycles
  the provider. The point is size: a real window measures larger and reports its
  own size and density, so the remote surface renders at that size natively
  instead of being upscaled from a sidebar. Distinct from the panel's detach
  button, which hands a direct/gateway URL to the browser. Every client of a
  session shares ONE remote surface, so the panel re-asserts its own viewport
  when focus returns and the pop-out is gone.
- **CSP**: `proxy.ts` builds `Content-Security-Policy` dynamically via
  `lib/display/csp.ts`. `frame-src` and `connect-src` (the probe fetch and HMR
  sockets need the latter) allow loopback, this host's own RFC1918/CGNAT
  interface addresses on any port, and the `CODY_PREVIEW_BASE_URL` wildcard when
  configured — nothing else, since candidates are minted as raw interface IPs.
  **Trap**: CSP has no CIDR notation and permits a wildcard only as the leftmost
  label, so ranges are emitted as exact per-interface hosts — Chromium silently
  discards `http://192.168.*.*:*` as an invalid source, which would collapse
  `frame-src` and block every direct preview. Public origins stay unframeable.
  The page CSP is applied to rendered pages only, NOT `/api/` responses: the
  two HTML-serving API routes (session export, docx preview) author their own
  stricter document CSP with `frame-ancestors 'self'` so the app can iframe
  them (top-bar history panel, file viewer) — a middleware `set()` would
  clobber exactly those headers, and per spec `frame-ancestors` is also what
  overrides the global `X-Frame-Options: DENY`.
  The session-export policy additionally allows `https://cdnjs.cloudflare.com`
  in `script-src`: the exporter of omp 18.8.3 renders the transcript client-side with
  SRI-pinned `marked`/`highlight.js` from that CDN, and blocking it renders an
  empty transcript. omp 18.19's exported viewer loads its script from stencil.so
  instead, so the policy also allows `stencil.so` and `build.stencil.so`; opening an
  export now needs internet access.
- The Docker image installs `chromium` and sets `CODY_CHROMIUM_BIN` so both
  `preview_screenshot` captures and the `stream` rung — the fallback that must
  never be missing — work out of the box.
- **Trap**: the display bus and the capability secret are process-local. A
  multi-process deployment (multiple Next.js workers or replicas) would need a
  shared store for both before display requests survive crossing processes.

### The shared browser (`lib/display/shared-browser.ts`)

A browser the agent drives and the human watches at the same time. The
streamed rung already renders a URL in a server-side Chromium and carries
real pointer/keyboard input back; `shared_browser` hands the agent the
DevTools endpoint of THAT Chromium, so automation acts on the exact surface
on screen. The alternative it replaces — the agent launching its own headless
browser and posting screenshots afterwards — means the human watches a copy
that never moves, which was the complaint that produced this.

- **Streamed, never auto.** The ladder's higher rungs frame the dev server in
  the human's OWN browser, which by construction cannot show them anything
  the agent's browser does. A shared request is published with
  `mode: "stream"`, so there is exactly one candidate and it is the one Cody
  renders.
- **Raster, never H.264.** The H.264 rung degrades into a *different*
  Chromium when a client turns out to have no decoder — which would strand
  the agent on a browser nobody streams any more, with a CDP endpoint that
  still answers. An endpoint handed to automation has to stay valid for the
  whole run, and JPEG stills are plenty for watching a test drive itself.
- **Handing out the endpoint IS the share**, and it lengthens the idle window
  (`SHARED_IDLE_DISPOSE_MS`, 10 min, vs `IDLE_DISPOSE_MS`, 30 s). A human
  closing the panel or switching tabs is not a reason to kill a browser an
  agent is mid-run on; it would fail the automation with a dead endpoint and
  no explanation.
- **Discoverability is the whole feature.** A capability nothing reaches for
  does not exist, so the instruction rides three places: the tool
  DESCRIPTION (always in the schema, for every engine), the MCP declaration
  in `bin/cody-display-mcp.js` (so an ACP engine gets the same tool through
  `POST /api/internal/display` with `shared: true`), and a standing rule in
  the operator's user-level `RULES.md`, which reaches every session and
  subagent rather than only sessions that happen to read this file.
- **The automation adopts the open tab.** `browser.open({app:{cdp_url}})`
  connects to the provider's Chromium and takes over the page it is already
  streaming; a second tab is fine too, since the provider streams the browser
  the human is watching either way.

