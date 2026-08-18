# Cody Android — tablet UX specification

Status: **binding UX spec for the Compose client.** Companion to
[`docs/android.md`](android.md), which owns the product shape (one UI, two
swappable backends) and the phasing. That document decides *what* the app is;
this one decides *what it looks like, how it behaves, and how it stays at
frame rate*. Where the two disagree, `docs/android.md` wins on architecture and
this document wins on presentation.

Primary target: a Snapdragon 8 Elite tablet **held in landscape**. Phone
portrait must work; it is not what the layout is tuned for.

The web client is the design reference, not a thing to transliterate. Every
section below names the web file it derives from so a developer can open both
and diff them. Where Android's idiom and Cody's design language conflict, the
conflict is resolved explicitly and the reason is written down.

---

## 0. Non-negotiables

1. **Cody's tokens are the theme contract.** Material 3 supplies structure,
   components and motion vocabulary. It does not supply colour. Dynamic colour
   (`dynamicLightColorScheme`) is **off** — it would replace a hand-verified,
   WCAG-AA-measured palette with wallpaper extraction.
2. **`tonalElevation = 0.dp` everywhere.** M3 tints elevated surfaces with
   `surfaceTint`; Cody's elevation is *explicit surface tokens* plus a warm
   shadow. Leaving tonal elevation on silently tints every card toward the
   accent hue and destroys the palette. `surfaceTint = Color.Transparent`.
3. **The UI is written against the backend interface, never a transport.**
   Same rule as `docs/android.md`. No screen imports Ktor.
4. **Capability gating hides, never breaks.** A `false` capability removes the
   rail item / panel / composer control. It never renders a disabled or
   erroring surface. This mirrors `HarnessCapabilities` in the web UI
   (`lib/harness/`, consumed via `/api/info`), and it is how local mode reports
   a smaller feature set without a second UI.
5. **No AI model identifiers in UI copy.** Model names come from the backend
   (`/api/models`) and are rendered as data, never hard-coded.

---

## 1. Token mapping

Source of truth: `app/globals.css`. Semantic token **names** are the contract;
the values are per-theme data. Cody ships ten families × light/dark
(`lib/theme-catalog.ts`, `THEMES`, default `catppuccin-light`), and
`app/globals.css` restates the full semantic set for every one of the twenty
ids. The Android side therefore **must not hard-code a palette**: it loads a
`CodyPalette` data class and builds a `ColorScheme` from it at runtime.

The columns below give the default light (Catppuccin Latte) and default dark
(Catppuccin Mocha) values, and the design-language origin from
`docs/specs/2026-07-27-warm-ui-ux-redesign-design.md` — the warm-paper /
warm-ember pair those tokens were designed against, whose *role assignments*
still govern even though the shipped default palette has moved.

### 1.1 Colour → `ColorScheme`

| Cody token | Light (paper) | Dark (ember) | M3 `ColorScheme` slot | Notes |
|---|---|---|---|---|
| `--bg` | `#EFF1F5` | `#1E1E2E` | `surface`, `background`, `surfaceContainerLowest` | the page |
| `--tool-bg` | `#EAEDF2` | `#232335` | `surfaceContainerLow` | half a step off the page |
| `--bg-panel` | `#E6E9EF` | `#272739` | `surfaceContainer`, `surfaceVariant` | rails, panels, toolbars |
| `--bg-hover` | `#DCE0E8` | `#313244` | `surfaceContainerHigh` | see §1.2 on state layers |
| `--bg-selected` | `#CCD0DA` | `#3E4055` | `surfaceContainerHighest` | selected row / active tab |
| `--border` | `#BCC0CC` | `#3B3D52` | `outline`, `outlineVariant` | 1px hairlines; both slots take the same value because Cody has one border tier |
| `--text` | `#4C4F69` | `#CDD6F4` | `onSurface`, `onBackground` | AA-verified against `--bg` |
| `--text-muted` | `#5C5F77` | `#A6ADC8` | `onSurfaceVariant`, `secondary` | ≥3:1 on the surfaces it sits on |
| `--text-dim` | `#6C6F85` | `#9399B2` | **none** → `CodyColors.textDim` | M3 has two on-surface tiers; Cody has three |
| `--accent`, `--accent-strong` | `#8839EF` | `#CBA6F7` | `primary` | links, filled buttons, focus |
| `--accent-hover` | `#7526DC` | `#DDC2FF` | **none** → `CodyColors.primaryHover` | M3 expresses hover as a state layer over `primary`; Cody names a distinct hue. Use this token, not an overlay, on filled controls |
| `--on-accent` | `#FFFFFF` | `#1E1E2E` | `onPrimary` | |
| `--user-bg` | `#E9E2F7` | `#2B2A42` | `primaryContainer`, `tertiaryContainer` | user bubble; `onPrimaryContainer` = `--text` |
| `--bg-subtle` | `rgba(76,79,105,.05)` | `rgba(205,214,244,.05)` | **none** → `CodyColors.inkWash` | 5% ink wash: expanded tool-call args, inline chips |
| `--overlay-backdrop` | `onSurface @ 24%` | `onSurface @ 24%` | `scrim` | M3's default scrim is black 32%; Cody's is ink-tinted 24% |
| `--status-error` | `#D20F39` | `#F38BA8` | `error`; `onErrorContainer` | `errorContainer` = `error @ 9%` over surface, matching the web's `color-mix(... 9%, var(--bg-panel))` |
| `--status-success` | `#2F7D1E` | `#A6E3A1` | **none** → `CodyColors.success` | tool-call frames, git added/untracked |
| `--status-warning` | `#9C6500` | `#F9E2AF` | **none** → `CodyColors.warning` | quota/context ≥70% |
| `--status-modified` | `#C4510A` | `#FAB387` | **none** → `CodyColors.modified` | git modified |
| `--status-renamed` | `#1E66F5` | `#89B4FA` | **none** → `CodyColors.renamed` | git renamed |

Slots M3 requires that Cody has no design for — assigned deliberately rather
than left to the M3 defaults, which would inject foreign hues:

| M3 slot | Assignment | Why |
|---|---|---|
| `secondary` / `onSecondary` | `--text-muted` / `--bg` | Cody has no second accent. Filled-tonal buttons therefore read as neutral chips — which is exactly what the composer control shelf looks like today. |
| `secondaryContainer` / `onSecondaryContainer` | `--bg-hover` / `--text` | |
| `tertiary` | `= primary` | Cody has no third accent. Do **not** invent one. |
| `inverseSurface` / `inverseOnSurface` | `--text` / `--bg` | |
| `inversePrimary` | the paired theme's accent | `getAlternateTheme(id)` in `lib/theme-catalog.ts` already pairs each family's light and dark ids, so this is real data, not a guess. |
| `surfaceTint` | `Color.Transparent` | See non-negotiable #2. |
| `surfaceBright` / `surfaceDim` | `--bg` / `--bg-panel` | |
| `errorContainer` | `error @ 9%` over `--bg-panel` | matches `PreviewPanel.tsx` / `InfoPanel.tsx` error banners |

### 1.2 State layers — the one real conflict

M3 draws interaction state as a translucent `onSurface` overlay (hover 8%,
focus 10%, pressed 10%). Cody names **literal surface tokens** for the same
states (`--bg-hover`, `--bg-selected`). Running both stacks two effects and
produces a muddy, off-palette result.

**Decision:** literal tokens win. For any surface whose resting colour is a
Cody token:

- supply a custom `Indication` (`ripple(color = CodyColors.inkWash)`) or
  `LocalIndication provides null` plus an explicit
  `background(if (pressed) bgSelected else if (hovered) bgHover else bgPanel)`;
- keep the ripple **only** where the target is a genuinely transient press
  (composer send, dialog buttons), where it reads as tactile rather than as a
  second hover colour.

Rationale: `--bg-hover` and `--bg-selected` are AA-verified against
`--text-muted` and `--text`. An 8% overlay on top of them is not.

### 1.3 Shape

| Cody token | Value | M3 `Shapes` slot | Notes |
|---|---|---|---|
| `--radius-control` | 8px | `small` (8.dp) | exact M3 default |
| `--radius-card` | 12px | `medium` (12.dp) | exact M3 default |
| `--radius-modal` | 16px | `large` (16.dp) | exact M3 default |
| — | 6px | `extraSmall` (6.dp) | M3 default is 4.dp; Cody's small chips/thumbnails sit at 5–7px (`MessageView.tsx` image and action-button radii). 6.dp is the honest middle. |
| — | 16px | `extraLarge` (16.dp) | **Clamped down from M3's 28.dp.** Otherwise any stray M3 component (bottom sheet, extended FAB) invents a rounder corner than the design language permits. Bottom sheets will read at 16dp, matching modals. |
| tool-call frame | 7px | `CodyShapes.toolCard` (7.dp) | `ToolCallBlock` in `MessageView.tsx` uses `borderRadius: 7` and recurs on every turn; it earns its own token. |

`--control-height-sm/–/-lg` (28 / 32 / 36px) and `--control-padding-inline`
(10px) become `CodyDimens`. See §8.2 — these are *paint* sizes, not touch
targets.

### 1.4 Elevation

Compose's `shadowElevation` draws one blurred black shadow. Cody's shadows are
**two-layer and warm**, and in dark mode they are a shadow *plus* a 1px warm
hairline ring:

```
--shadow-card  light: 0 1px 2px rgba(60,50,35,.05), 0 2px 8px  rgba(60,50,35,.06)
               dark:  0 1px 2px rgba(0,0,0,.35),    0 0 0 1px rgba(235,225,210,.03)
--shadow-pop   light: 0 2px 6px + 0 8px 24px        dark: 0 2px 8px  + 1px ring @4%
--shadow-modal light: 0 4px 12px + 0 16px 48px      dark: 0 8px 32px + 1px ring @5%
```

**Decision:** a custom `Modifier.codyShadow(level)` modifier, not
`shadowElevation`:

| Token | Ambient | Dark-mode addition |
|---|---|---|
| `--shadow-card` | 2.dp | 1.dp border, `onSurface @ 3%`, same shape |
| `--shadow-pop` | 8.dp | 1.dp border, `onSurface @ 4%` |
| `--shadow-modal` | 16.dp | 1.dp border, `onSurface @ 5%` |

`spotColor`/`ambientColor` on the `Modifier.shadow` call take the warm brown
(`rgb(60,50,35)`) in light and black in dark. The hairline is a real `border`,
because Compose has no spread-only shadow.

`--focus-ring` (`0 0 0 2px accent@22%`) plus the global
`:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px }` →
`CodyFocus.ring`: a 2.dp `primary` border at `outline-offset` 2.dp, applied via
`Modifier.indication(interactionSource, CodyFocusIndication)`. Keyboard/D-pad
focus only, never on touch — matching `:focus-visible` semantics.

### 1.5 Motion

| Cody token | Value | M3 token | Notes |
|---|---|---|---|
| `--dur-fast` | 150ms | `DurationShort3` (150ms) | exact |
| `--dur-med` | 220ms | **none** → `CodyMotion.med` | M3 jumps 200 → 250 |
| `--dur-slow` | 320ms | **none** → `CodyMotion.slow` | M3 jumps 300 → 350 |
| `--dur-theme` | 450ms | `DurationLong1` (450ms) | exact |
| `--ease-out-warm` | `cubic-bezier(.22,1,.36,1)` | **none** → `CodyEasing.outWarm` | M3's `EmphasizedDecelerate` is `(.05,.7,.1,1)`, visibly different. Cody's curve wins; use it as the app-wide default and do not mix in M3 easings. |

The 220/320ms values are a deliberate three-step system
(`docs/specs/2026-07-27-warm-ui-ux-redesign-design.md` §3.3). Snapping them to
the nearest M3 token would collapse two steps into one.

Theme switch: the web animates a circular clip-path wipe through the View
Transitions API (`hooks/useTheme.ts`, `::view-transition-*` in `globals.css`).
Android has no equivalent. **Decision:** `Crossfade` over the whole content
root at `--dur-theme` (450ms) with `CodyEasing.outWarm`, degrading to instant
under reduce-motion. Do not attempt to reproduce the wipe; a hand-rolled
`RenderEffect` capture of the previous frame costs a full-screen bitmap on
every toggle.

### 1.6 Typography

| Role | Cody source | Android |
|---|---|---|
| Display / headings / session titles / modal titles / empty-state copy | `--font-serif` (Source Serif 4 + Noto Serif SC), `.display-serif` = w600, `letter-spacing: .005em` | bundled Source Serif 4 variable + Noto Serif SC fallback → `CodyType.serif`, applied to `displayLarge…titleMedium` |
| Body and controls | system sans stack | `FontFamily.SansSerif` (Roboto) — this *is* the system sans on Android, so it satisfies the original intent natively |
| Code, paths, telemetry, terminal | `--font-mono` (Noto Sans Mono, JetBrains Mono, …) | bundled JetBrains Mono → `FontFamily.Monospace`. Bundle it: a fallback chain that resolves differently per OEM makes code-block column widths unpredictable. |

Scale (from the redesign spec: 12 / 13 / 14 body / 16 / 20 / 28px, line-height
1.5–1.6), mapped 1:1 into `sp`:

| M3 slot | Size / line-height | Family | Used by |
|---|---|---|---|
| `headlineMedium` | 28 / 1.35 | serif w600 | empty states |
| `titleLarge` | 20 / 1.35 | serif w600 | modal + session titles |
| `titleMedium` | 16 / 1.4 | serif w600 | section headings |
| `bodyLarge` | 16 / 1.5 | sans | composer input |
| `bodyMedium` | 14 / 1.6 | sans | message text (`fontSize: 14, lineHeight: 1.6` in `UserMessageView`) |
| `bodySmall` | 12 / 1.5 | sans | tool-call bodies, panel text |
| `labelMedium` | 12 / 1.45 | mono | chips, telemetry |
| `labelSmall` | 11 / 1.45 | mono w600 | tool names, status letters, panel subtitles |

Every numeric readout that can change in place — durations, token counts,
percentages, relative timestamps, git counts — carries
`fontFeatureSettings = "tnum"`. The web sets `fontVariantNumeric: tabular-nums`
in exactly those places (`ToolCallBlock` duration, `GitPanel` change count,
`AppShell` stats chip, session-row relative time) and it is load-bearing: a
proportional digit set makes a live-updating counter jitter horizontally.

---

## 2. Adaptive layout

### 2.1 What the web actually does

One breakpoint and one capability query:

| Query | Effect |
|---|---|
| `min-width: 641px` | sidebar and workspace panel animate their **width**; sidebar 260px default (`SIDEBAR_MIN_WIDTH` 200, `MAX` 520, persisted at `cody:sidebar-width`); workspace panel `42%`, floor `300px`, ceiling `78vw`, persisted at `cody:workspace-width` |
| `max-width: 640px` (`useIsMobile`) | sidebar becomes `position: fixed`, 280px / `max-width: 85vw`, `translateX(-100%)` overlay; workspace panel becomes `width: 100%` and `display: none` when closed; top bar grows 36 → 44px |
| `(hover: none), (pointer: coarse)` | toolbar buttons 40×40, composer controls 38px, directory rows 44px, `touch-action: manipulation`, hover-revealed actions forced visible (`.touch-reveal`) |

Plus two JS guards in `AppShell.tsx`: `CHAT_MIN_WIDTH = 320` protects the chat
column when the workspace panel is resized, and a **portrait-tablet relief**
rule collapses the sidebar outright when
`innerWidth - sidebarWidth - 300 < CHAT_MIN_WIDTH` on the panel's opening
transition. The chat column itself is centred and capped at
`CHAT_COLUMN_MAX_WIDTH = 960` (`lib/chat-layout.ts`), with a 36px minimap
gutter (`CHAT_MINIMAP_WIDTH`) reserved on the trailing side.

Note that the `(pointer: coarse)` branch is the *entire* touch story, because
the comment in `globals.css` is right: a width query classifies a 1024px
tablet as a desktop. On Android every device is coarse-pointer, so **that
branch is the Android baseline, not an exception.**

### 2.2 Window size classes

`currentWindowAdaptiveInfo(supportLargeAndXLargeWidth = true)`.

| Class | Width | Where the tablet lands |
|---|---|---|
| Compact | < 600dp | phone portrait |
| Medium | 600–839dp | phone landscape, small tablet portrait |
| Expanded | 840–1199dp | target tablet in **portrait** (~850–900dp) |
| Large | 1200–1599dp | target tablet in **landscape** (~1300–1450dp at 2.0 density) — **the primary case** |
| Extra-large | ≥ 1600dp | tablet + external display |

Height classes matter for the composer only: compact height (<480dp, i.e. a
phone in landscape with the IME up) collapses the composer control shelf into
an overflow button, because otherwise the shelf plus the IME leaves no
transcript.

### 2.3 Pane structure

`ListDetailPaneScaffold` (from `androidx.compose.material3.adaptive`) with all
three panes used, driven by
`calculatePaneScaffoldDirective(currentWindowAdaptiveInfo(...))`:

- **list pane** → session list (`SessionSidebar.tsx`)
- **detail pane** → chat surface (`ChatWindow.tsx`)
- **extra pane** → the selected workspace tool (the right panel in `AppShell.tsx`)

| Class | List | Detail | Extra | Tool selector |
|---|---|---|---|---|
| Compact | `ModalNavigationDrawer` | full width | full-screen destination, back returns to chat | bottom sheet from a top-bar action |
| Medium | `DismissibleNavigationDrawer` | full width | **overlays** detail | trailing tool rail, 56dp |
| Expanded | fixed 280dp, dismissible | flexible | splits detail, floor 360dp | trailing tool rail, 56dp |
| Large / XL | fixed, resizable 200–520dp | flexible, content capped at 960dp with symmetric gutters | splits detail, 42% preferred, floor 360dp | trailing tool rail, 56dp |

Ported guards:

- **`CHAT_MIN_WIDTH` → 320.dp.** The extra pane may not squeeze the detail
  pane below it. Encode as `PaneScaffoldDirective` custom pane preferences, and
  when the arithmetic fails, **collapse the list pane** rather than crush the
  chat — the same relief `AppShell` applies. This is the rule that keeps
  portrait usable on the target device: at ~876dp with a 280dp list and a
  360dp tool pane, chat would get 236dp.
- **`CHAT_COLUMN_MAX_WIDTH` → 960.dp** on the transcript and composer content,
  centred. At Large width the detail pane is ~700–900dp so the cap rarely
  binds, but on an external display it is what stops a 40-word measure.
- **Pane width persistence** → `Preferences DataStore`, keys mirroring
  `lib/storage-keys.ts`: `sidebar_width`, `workspace_width`, `workspace_panel`,
  `tool_calls_collapsed`, `theme`, `git_file_view`,
  `terminal_soft_keys`. URL state has no analogue; session identity lives in
  the nav back stack, panel choice is a device preference (exactly the
  deviation `docs/specs/2026-08-16-workspace-panels-design.md` records).

**Two-pane first is a legitimate staging point.** Until there are tool screens
to put in the extra pane, a plain list/detail split carrying the same two
guards — `CHAT_MIN_WIDTH = 320.dp` and collapse-the-list-not-the-chat — is the
right amount of structure, and moving to `ListDetailPaneScaffold` afterwards is
a swap of the container, not a rewrite of the screens. What must be true from
the first commit is that **the screens never read the window size class
themselves**: they receive their pane role and available width from the
container. A screen that branches on `currentWindowAdaptiveInfo()` internally is
the thing that turns the later swap into a rewrite.

### 2.4 Navigation: why no bottom bar, anywhere

**There is one app-level destination — the workspace.** Sessions, chat and
tools are panes of it; Settings is a modal. That is why there is no
`NavigationBar` and no `NavigationRail` in the M3 "switch destinations" sense
at any size class.

- **No bottom navigation bar.** The composer owns the bottom edge, and
  `WindowInsets.ime` lifts it. A bottom bar would either stack under the
  composer (two bars competing for the thumb) or sit below the IME (invisible
  when it matters most). On the landscape tablet the bottom edge is also the
  farthest point from either thumb. Rejected deliberately, not overlooked.
- **Trailing tool rail (Medium and up), 56dp.** A vertical strip of the seven
  workspace tools, replacing the web's horizontal tab strip in the right
  panel's head. It is on the **trailing** edge because that is where the panel
  it controls lives, and because a landscape tablet's right thumb rests there.
  It is *not* a `NavigationRail` — name it `ToolRail` so nobody adds
  destination semantics to it. Icons and badges come straight from the web
  descriptor array (`AppShell.tsx`, ~line 1750):

  | id | Icon (lucide → Material) | Badge |
  |---|---|---|
  | `file` | `Files` → `Description` | — |
  | `git` | `GitBranch` → `AccountTree` | changed-file count |
  | `terminal` | `Terminal` → `Terminal` | — |
  | `preview` | `AppWindow` → `Web` | — |
  | `tasks` | `ListTodo` → `Checklist` | `!` when the config is invalid |
  | `updates` | `CircleArrowUp` → `Upgrade` | count of update sources |
  | `info` | `Info` → `Info` | — |

  Tapping a tool opens/focuses the extra pane; tapping the **active** tool
  collapses it (the web's corner toggle behaviour). Labels are icon-only at
  56dp with a tooltip on long-press; the web drops its labels on mobile the
  same way.
- **Leading drawer for sessions.** `ModalNavigationDrawer` (compact) /
  `DismissibleNavigationDrawer` (medium) / fixed pane (expanded+). Directly
  mirrors `.sidebar-container`'s `translateX` overlay → animated-width
  progression, and mirrors the web's habit of closing the drawer whenever a
  full-screen surface opens (`if (isMobile) setSidebarOpen(false)`, seven
  call sites in `AppShell.tsx`).
- **Top app bar.** `TopAppBar` at 56dp (compact) / 48dp (medium+), carrying,
  leading to trailing: drawer toggle, session title (serif, ellipsized),
  branch/fork affordance, session-stats chip, backend badge
  (**remote** / **local**, per `docs/android.md`'s no-silent-fallback rule),
  overflow. The web's 36px bar is below Android's comfortable minimum; 48dp is
  the coarse-pointer equivalent of its 44px mobile height.
- **Predictive back**: `enableOnBackInvokedCallback=true`. Back collapses the
  extra pane, then the list pane, then leaves the session. `BackHandler` on
  the composer only when a slash/mention menu is open.

---

## 3. Screen specs

Each screen lists **layout → states → Compose primitives**. "Loading /
empty / error / offline" are enumerated because the web has all four
everywhere and losing them is the classic port regression.

### 3.1 Onboarding

New surface; the closest web analogue is `components/LoginScreen.tsx` plus the
`.login-*` rules in `globals.css` (centred card, `--shadow-modal`, serif
wordmark, `login-card-in` entrance at `--dur-slow`).

Four steps in a `HorizontalPager` with a stepper, not four destinations — the
user must be able to go back without losing typed state.

**Step 1 — Server.** A single URL field (`bodyLarge`, mono), keyboard type
`Uri`, autofill off. Placeholder shows the Tailscale-shaped default. A
"discover on this network" affordance is explicitly **out of scope**: the
server is reached over Tailscale, and mDNS probing would just fail slowly.

**Step 2 — Token.** Cody mints personal access tokens for exactly this purpose
(`lib/auth/tokens.ts`; full contract in `docs/api.md`): prefix `cody_pat_`
followed by 43 characters (32 secret bytes, base64url), max 32 per account,
name ≤60 chars. Only a SHA-256 digest is stored server-side.

| Operation | Route |
|---|---|
| mint | `POST /api/accounts/me/tokens` |
| list | `GET /api/accounts/me/tokens` → `name` + `preview` (first 6 chars) + `lastUsedAt`, recorded at **5-minute resolution** and `null` until first use |
| revoke | `DELETE /api/accounts/me/tokens/<id>` |
| validate + identify | `GET /api/accounts/me` |

The app pastes a token; it does not manage them (that surface is the web UI's).
But if a device list is ever added here, two rules come with `lastUsedAt`: a
just-used token can legitimately show a timestamp up to five minutes old, so a
stale-looking value is not a fault and must not be flagged as one; and
**"Never used" is genuinely `null`, not merely old** — the two must render
differently or a freshly minted token reads as a broken one.

- Layout: a paste-first field. A large **Paste from clipboard** button is the
  primary action (the token arrives via the web UI, so paste is the real
  gesture); manual typing is possible but secondary. Masked by default with a
  reveal toggle, mirroring `.login-reveal`.
- Validate the prefix and length client-side before any request and say so
  inline — "that does not look like a Cody token (`cody_pat_…`)" — rather than
  round-tripping a typo.
- **The secret is shown exactly once.** There is no "show it again" and there
  cannot be, because the server keeps only a digest. So the failure copy must
  never say "check your token": a lost secret is unrecoverable and the only fix
  is to mint a new one. Every dead end in this flow routes to *mint a new
  token in the web UI*, not to *re-read the old one*.
- Store in `EncryptedSharedPreferences`/`DataStore` backed by a Keystore key.
  Never in plain `DataStore`, never logged, never included in the Info panel's
  copy-diagnostics block.
- Transport: `Authorization: Bearer cody_pat_<43 chars>` on every request, set
  once in the Ktor `Auth`/`defaultRequest` block. Screens never see it.

**Step 3 — Connectivity check.** A checklist that runs top to bottom, each row
resolving to ✓ / ✗ with a one-line reason:

| Row | Probe | Failure copy |
|---|---|---|
| Server reachable | `GET /api/info` | distinguish DNS failure, connection refused, TLS error, and timeout — four different fixes |
| Token accepted | `GET /api/accounts/me` | 401 → "this token was rejected or has been revoked", offering **Paste a different token** and **Mint a new token** (never "check your token" — see above). This probe is also the moment the token's `lastUsedAt` first becomes non-null, which is what turns the web UI's token row from "Never used" into a paired device. |
| Engine ready | `/api/info` → engine + capabilities | engine absent → link the server-side engine picker; this is information, not a blocker |
| Event stream | open then close the session SSE stream | a proxy that buffers SSE is the single most likely deployment failure; catching it here saves an hour of "chat looks frozen" |

States: `Idle` → `Running(row)` → `Passed` / `Failed(row, reason)`. A failed
row never blocks **Continue** except the first two; the app is useful with a
degraded engine and says which parts are off.

**Re-pairing is a first-class state, not an error path.** Changing an account's
password revokes *every* token on that account along with every browser
session, so a 401 arriving mid-session is expected behaviour rather than a
bug. The app must therefore treat a 401 on any authenticated request as
**"this device was unpaired"** — clear the stored secret, drop to a dedicated
re-pair screen that keeps the server URL, and say why in one line ("the account
password changed, or this token was revoked"). What it must not do is retry, sit
on a stale token, or surface a generic auth failure: all three leave the user
staring at an app that looks broken when the fix is thirty seconds of pasting.
**There is no reason code, by design.** Revoked, expired, password-changed and
account-deleted all return an identical `401 auth_required`. So do not go
looking for something to branch on and do not build four copy variants: the
server deliberately does not say which happened, and the one-line phrasing
above is the honest maximum available.

**And do not add a backoff retry.** "There is nothing to branch on" is not the
whole argument, because a developer can still reason that a 401 *might* be
transient and add a retry defensively. It cannot be: nothing about a revoked
token, a bumped `tokenVersion`, or a deleted account ever becomes true again on
its own. A retry is therefore guaranteed waste, and worse, it *delays the one
screen that can actually fix the problem*. Fail to the re-pair screen on the
first 401.

Clearing the secret while **keeping the server URL** is the right split: the URL
is the part the user had to discover, the token is the part that is cheap to
replace.

The matching "you will need to re-pair your devices" warning on the web UI's
password screen is `NativeAuth`'s to place, not this document's.

**Step 4 — Backend choice.** Two cards, `RemoteBackend` and `LocalBackend`,
each stating what it gives and what it lacks (verbatim from `docs/android.md`'s
comparison table). Remote is preselected and labelled *default*. Local is
selectable but, in Phase 1, shows its prerequisites unmet (Termux, a model)
and routes to the local-mode setup screen rather than pretending to work.
Choice is explicit and reversible in Settings — never silent
(`docs/android.md`: "No silent fallback").

Primitives: `Scaffold` + `HorizontalPager` + `OutlinedTextField` (mono
`bodyLarge`) + `LinearProgressIndicator` for the checklist + `Card` for the
backend choice. First-run only; re-enterable from Settings.

### 3.2 Session list

Web: `components/SessionSidebar.tsx` (2.6k lines — read it before building
this) and `components/FileExplorer.tsx`.

Layout, top to bottom, matching the web's pinned/scrolling split:

1. **Pinned header** — wordmark (`CodyTitle`, with its scramble animation
   suppressed under reduce-motion), new-session action.
2. **Pinned "Workspaces" row** — label, search toggle, running-only filter,
   add-project. Search expands an inline field below it (`searchOpen`,
   Escape clears); filtering is client-side over both project and session
   names, and a project with no matching sessions is hidden while a filter is
   active so the list reads as a genuine result set.
3. **Scrolling body** — `LazyColumn`. Managed projects as cards; each expands
   to its session tree, capped at 5 roots with a show-more toggle; the active
   project's worktree selector renders directly beneath its row.
4. **Pinned footer** — settings row with an update dot.

Session row anatomy (`SessionItem`): title (ellipsized, serif at expanded
widths), relative time (tabular, right-aligned, min 30dp — refreshed from one
shared minute-tick, never a timer per row), a running dot, an unread dot, a
fork-expand chevron when the session has children, and an overflow menu
(archive — leaf only, rename, delete). The web reserves the overflow slot
invisibly so rows never reflow on hover; on Android there is no hover, so the
slot is **always visible** — this is the `.touch-reveal` rule
(`globals.css`: hover-revealed actions must be visible where hover does not
exist).

- **Row interaction:** tap selects. Long-press opens the overflow as a
  `ModalBottomSheet` (not a dropdown — a 24dp dropdown item is not a touch
  target). Swipe gestures are **not** used: the list scrolls vertically inside
  a horizontally-pane-swiping scaffold, and a third gesture axis makes both
  unreliable.
- **Rename** is inline in the web; on Android it is a small dialog, because an
  inline `BasicTextField` inside a `LazyColumn` row loses focus on any
  recomposition that recycles the row.
- **Destructive actions** (`delete`, project `remove`) use `--status-error` and
  a confirm step, matching `ConfirmDialog` in `components/ui/field.tsx`.

States: `Loading` (warm shimmer skeleton rows — a static dimmed fill under
reduce-motion, exactly as `.skeleton` degrades); `Empty` (serif headline +
step guidance + primary action, per the redesign spec's empty-state rule);
`Error` (inline banner, keeps any previously loaded list on screen — the web's
GitPanel pattern, and correct here too); `Offline` (banner plus the list
served from the local cache, marked stale).

Running state arrives over the running-sessions SSE stream
(`/api/agent/running/events`) and is the source of truth once the first frame
lands — a late list response must not overwrite it. Keep that ordering rule.

**FileExplorer** lives below the session tree in the same drawer, collapsible.
Git decorations use the `--status-*` tokens per state (added/untracked
`success`, modified `modified`, deleted/conflict `error`, renamed `renamed`).
Directories load lazily on expand; the whole tree refreshes on an
`explorerRefreshKey` bump (agent turn end) and on window focus, never on a
timer.

### 3.3 Chat surface

See §4 — it is the heart and gets its own section.

### 3.4 Composer

Web: `components/ChatInput.tsx` (3k lines) + `components/ComposerPanels.tsx`.
Pinned to the bottom of the detail pane, content capped at 960dp, `imePadding()`
+ `navigationBarsPadding()`.

Stack, bottom-up:

1. **Input shell** — rounded `--radius-card`, 1px `--border`, gaining an accent
   glow on focus (`.chat-input-shell:focus-within`:
   `border-color: accent@45%`, `box-shadow: shadow-card, 0 0 0 3px accent@14%`).
   `BasicTextField2` with `maxLines = 8` — **not** a dp cap. The web caps at
   `Math.min(scrollHeight, 200)`px; a dp cap breaks under dynamic type (at
   fontScale 2.0, 200dp is two lines). Capping by lines is both the native
   idiom and dynamic-type-correct.
2. **Attachment strip** — image thumbnails and text-file chips above the input,
   each with a remove affordance. Caps ported verbatim from
   `lib/image-attachments.ts` / `lib/chat-attachments.ts`
   (`MAX_ATTACHED_IMAGES`, `MAX_ATTACHED_IMAGE_BYTES`,
   `MAX_ATTACHED_TEXT_FILES`, `MAX_ATTACHED_TEXT_BYTES`), and binary content is
   rejected with the same message. An `attachError` row uses
   `role="alert"` semantics → `liveRegion = Assertive`.
   Port the **attachment revision guard**: an in-flight file read whose
   composer has since been sent or cleared must drop its result, not append it.
   In Compose this is a `snapshotFlow`/`collectLatest` on a revision counter,
   or a `Job` cancelled on send.
3. **Control shelf** — attachment, model picker, tools/settings, reasoning
   level, fast-mode, **context ring**, **plan-quota ring**, send/stop. 38dp
   painted (the coarse-pointer height), 48dp touch. Under compact height it
   collapses to an overflow.
4. **Queued follow-up bar** — a thin strip on the composer's top edge, present
   only when something is queued, with edit/delete/steer per entry.
5. **Composer-attached panels** (`ComposerPanels.tsx`) — the live todo plan and
   the subagent roster, **pinned above the composer, not inside the transcript**.
   Both start collapsed; both headers always show live progress even collapsed.
   This placement is deliberate in the web design and must be preserved: these
   panels describe *now*, and burying them in a scrolling history hides them
   the moment the agent produces output.
   - Todo header: current phase name + `done/total`. Expanded: the phase grid
     with preview/show-all.
   - Subagent chips: status icon (pulsing dot while `started`; check / alert /
     ban for terminal states), label, and a live activity line — current
     tool + intent, or `⟳ retrying N/M` which takes precedence, plus
     icon-first telemetry (tokens, cost, duration, model, context gauge,
     nested-subagent count, `⤴` async marker). Tap opens the transcript dialog
     (`SubagentTranscriptDialog.tsx`) — on Android a full-screen dialog at
     compact width, a wide dialog at expanded.

**Two rings, two meanings — do not merge them.** The composer carries both
(`ChatInput.tsx`, post-`aba2ff1`):

| Ring | Source | Thresholds | Absence |
|---|---|---|---|
| **Context** | `contextUsage` from `useAgentSession` → percent of the active model's context window | `primary` <70, `warning` ≥70, `error` ≥90 | unknown usage keeps an **empty ring mounted** — never removes the control |
| **Plan quota** | `useUsage()` → `GET /api/usage` → `buildQuotaView` over `UsageSnapshot` (`lib/usage/types.ts`), binding window chosen by `selectBindingWindow` | **identical** tones and cut-points via `quotaToneColor`: `primary` <70, `warning` ≥70, `error` ≥90 — **but the engine's own `UsageWindowState` overrides the number** | four distinct states, and `buildQuotaView` exists precisely so they are never conflated |

The state override is not a detail. `deriveUsageWindowState`
(`lib/usage/omp-usage.ts`) marks a window `exhausted` when the engine reports
status `exhausted`/`rejected` **whatever the percentage says**, and Cody warns
at `USAGE_WARNING_THRESHOLD = 70` rather than the engine's own 90 because 90 is
too late to be useful in a composer. So the ring must be driven by
`(percent, state)` together, never by `percent` alone: a window the engine
calls exhausted reads red at 4%, and a window it calls warning keeps the
warning tone even when the number looks calm. Colour-from-percentage is the
obvious implementation and it is wrong.

The quota ring's absence vocabulary is a spec requirement, not a nicety:
`usage.checking` (a first read in flight) → `QUOTA_UNAVAILABLE` (never loaded,
or the last read failed) → `usage.notReported` (the engine answered and
exposes no quota) → `usage.unlimitedTitle` (every account unmetered, e.g. a
local runtime). Only the third may say anything *about the engine*. A machine
reason code (`engine_unsupported`) must never surface as prose — port
`readableReason`'s filter (must contain a space, ≤200 chars).

Polling cadence ports directly and matters on battery: 90s while the app is
resumed and focused, 5 minutes when backgrounded, skip a tick if one is still
in flight. On Android, drive it from `Lifecycle.repeatOnLifecycle(RESUMED)`
rather than a raw timer, and let it stop entirely when the process is cached.
Keep the deliberate offset past the server's 60s cache TTL — polling *at* the
TTL makes every other read stale and the footer flickers forever.

Tapping either ring opens its summary popover (`ModalBottomSheet` at compact,
anchored `Popup` at expanded): context shows used / available / limit plus
per-model rows; quota shows every window sorted by utilization with reset
times, each row keyed by `accountIndex:provider:windowId` because window ids
are unique only *within* an account.

**Input affordances.** Slash commands (`/`) and file mentions (`@`) open
anchored lists above the composer with keyboard and touch selection; `!` and
`!!` prefixes switch to bash mode (excluded-from-context for `!!`); Enter
sends, Shift+Enter newlines on a hardware keyboard, and on-screen the send
button is the only send path (an IME Enter must insert a newline — a chat app
that sends on the soft Enter is unusable for multi-line prompts). Escape /
Back aborts a running agent when no menu is open.

### 3.5 Tool panels

All seven share a shell: a 25dp-equivalent subtitle bar
(`.workspace-subtitle-bar`: title, then trailing actions) over a scrolling
body, `--bg` background, `--bg-panel` bar. Panels mount on first activation and
stay mounted — the web keeps them in the DOM with `display: none`; on Android
that is a `SaveableStateHolder` keyed by panel id, so a panel's scroll position
and expansion state survive tab switches without keeping seven trees composed.

**Files** — `FileViewer.tsx` in a tab strip (`TabBar.tsx`) alongside a Chat
tab. Source / preview / diff modes; images, PDF, markdown, mermaid. Tabs
scroll horizontally, close buttons always visible (no hover), inline rename
becomes a dialog for the same focus reason as session rename.
States: loading skeleton; "select a file"; unreadable/binary; too-large.

**Git** — `GitPanel.tsx`. Header: branch name (or `detached at <hash>`),
`↑ahead ↓behind` when an upstream exists, changed count, list/tree toggle
(`cody:git-file-view`), checkpoints toggle, refresh. Body: a changed-file list
capped at `maxHeight: 38%` over a diff pane taking the rest — port that
ratio; a 50/50 split makes both halves useless on a tablet.
Rows: coloured status letter (`--status-*` per state), path with a dimmed
directory prefix, `old → new` for renames. Staged and unstaged sections when
both exist; a commit-message field with a "commit N staged" button; per-row
stage / unstage / discard, one mutation in flight at a time, every outcome
ending in a status refresh. Discard confirms (distinct copy for untracked).
Checkpoints list with create + restore, restore confirms.
States: no workspace; loading; **"Not a git repository."**; no changes (check
icon + copy); select-a-file; no-diff; deleted; unsupported/binary; truncated;
error banner that **keeps the last good list on screen**. Refresh on manual
tap, on `explorerRefreshKey`, and on app resume — never a poll.
Compose: `LazyColumn` list + a `DiffView` equivalent (folding hunks, line-number
gutters, add/remove tinting from `--status-success`/`--status-error`) in a
vertically-scrolling, horizontally-scrolling pane.

**Terminal** — `TerminalPanel.tsx`. In remote mode: the server PTY, tab model
preserved, themed from the active palette (the web reads CSS vars off the DOM
at construction; Android passes the `CodyPalette` directly, which is strictly
simpler). A soft-key row (Esc/Tab/Ctrl/arrows, configurable via
`cody:terminal-soft-key-ids`) sits above the IME — this matters far more on a
tablet than in a browser. Paste must bypass bracketed-paste wrapping, for the
same reason the web does: the tracked DECSET 2004 state survives a reconnect
replay while the live program's does not, so the markers reach a program that
never enabled them. In local mode: see §5.1 — over `RUN_COMMAND` this is a
command runner, not a shell, and it says so.
States: disconnected / connecting / connected; no workspace; PTY exited.

**Preview** — `PreviewPanel.tsx`. Header: a mono URL field, a resolved-mode
chip, clipboard copy/paste (when the streamed rung is live), reload, capture-
to-composer, detach, pop-out. Body walks the fidelity ladder from
`lib/display/`: `direct` (a real WebView against the dev server's own origin)
→ `native` (the wildcard-subdomain gateway) → `stream` (the canvas surface with
input, `StreamedDisplay.tsx`).
**Android-specific and load-bearing:** the loopback rung is dropped
structurally for any non-co-located client (`lib/display/ladder.ts`), and the
tablet is never co-located with the Unraid server in remote mode. A remote
device probing `127.0.0.1` can get an opaque success from an unrelated local
app and frame the wrong thing. The Android client must therefore send the
same client-locality signal the web client does and must not "helpfully" retry
loopback. In *local* mode the tablet **is** co-located and the loopback rung is
correct — that difference is a property of the backend, not of the panel.
The direct/gateway rungs are a `WebView` (with `mixedContentMode` off,
JavaScript on, its own `WebViewClient`); the streamed rung is a
`Canvas`/`SurfaceView` fed by the display socket. Capture-to-composer posts the
PNG into the attachment path.
States: resolving; no candidate; each rung's own failure; manual-URL error
(`aria-invalid` → an error-tinted field plus an assertive live region).

**Tasks** — `TasksPanel.tsx`. Toolbar (refresh, open terminal), then status
banner, then groups in first-seen order with task cards (title, muted
description, mono command chip, Run button). Single-in-flight run guard;
`confirm: true` tasks show a confirm dialog; a task that vanished after a
refresh reports "task no longer available" instead of running the wrong thing.
On dispatch, switch to the Terminal panel with the new terminal focused.
States: `none` / `loading` / `missing` (with the config example) / `invalid`
(field-level errors, rail badge `!`) / `loaded` / empty.

**Updates** — `UpdatesPanel.tsx`. Cards for the Cody app, the engine runtime,
and skills; each shows current vs available and a **copyable** command. Nothing
self-updates. Badge = number of sources reporting an update.
On Android the app-update card is different in kind: distribution is sideloaded
APK / GitHub releases, so the card links a release and states the installed
`versionName`/`versionCode`; it never attempts an in-app install.

**Info** — `InfoPanel.tsx`. A two-column definition grid
(`minmax(96px, auto) minmax(0, 1fr)`), sections: Cody, engine runtime,
environment, workspace. A missing probe renders "unknown", not a blank row.
**Copy diagnostics** produces a plaintext block for bug reports — and on
Android it also carries device facts (model, Android version, `versionCode`,
window size class, density, `fontScale`, backend mode, Termux/Shizuku
availability) plus the app's own log ring buffer (§5.2). It must never carry
the access token.

---

## 4. The chat surface, in detail

Web sources: `components/ChatWindow.tsx`, `components/MessageView.tsx`,
`components/MarkdownBody.tsx`, `components/MarkdownCode.tsx`,
`hooks/useAgentSession.ts`, and the `.chat-*` rules in `app/globals.css`.

### 4.1 Grouping

The web builds render units *without building elements*
(`buildTranscriptUnits`), then renders them. Three kinds:

- `message` — one message rendered standalone
- `answer` — the final assistant answer, **split off** its assistant message
- `group` — the collapsed `ProcessDetailsGroup`: everything between a turn
  anchor and its final answer, folded behind one row showing message count and
  tool-call count

A turn is anchored by a user message **or a compaction summary**
(`isGroupAnchor`). That second case is not an edge case: when compaction fires
mid-turn the original prompt is gone and the summary takes its place, and
without treating it as an anchor every post-compaction message renders
standalone and never collapses again.

Tool-result **images** produced inside a collapsed group are hoisted out and
stay visible (`collectGroupResultImages`) — a screenshot the agent took of its
own work is the point of the turn, not a detail of it.

Android: build the same unit list in the ViewModel, as a read-only
`List<TranscriptUnit>`, off the main thread. `LazyColumn` renders one
item per unit with `contentType = unit.kind` so Compose reuses subcompositions
of matching shape.

**Keys.** `entryIds[]` is a parallel array to `messages[]` mapping each
displayed message to its `.jsonl` entry id (`SessionContext`, see `AGENTS.md`).
Use it:

- `message` / `answer` → `"$entryId"` / `"$entryId:answer"`
- `group` → `"$anchorEntryId:group"`
- the streaming tail → the constant `"live"`

These keys are stable across recomposition, across a history prepend, and
across a reconnect that re-delivers the same entries. They are the single
most important fluidity decision in this document.

### 4.2 History paging

Web: 50 messages per page (`VISIBLE_PAGE_SIZE`), an `IntersectionObserver` on a
sentinel banner with `rootMargin: "400px 0px 0px 0px"` so the next page loads
*before* the user reaches the top, and `captureScrollDistance` /
`restoreScrollTop` to keep the viewport anchored across the prepend.

Android: same page size. The sentinel becomes
`snapshotFlow { lazyListState.layoutInfo }` watching for the first visible
index falling within a prefetch distance of the top. **The manual scroll
restore is not needed**: with stable item keys, `LazyColumn` anchors on the
first visible item's key and a prepend does not move it. That is a genuine
simplification — but it holds *only* while keys are stable, which is why §4.1
is non-negotiable. Auto-load only on a genuine upward scroll, never on first
open (the web guards this explicitly; on fresh open the sentinel is visible and
would otherwise page the entire history immediately).

### 4.3 Containment — and the minimap

The web deliberately does **not** virtualize. `.chat-turn` uses
`content-visibility: auto` with `contain-intrinsic-size: auto 320px` (96px for
compact turns), and the comment says why: find-in-page, select-across-turns,
native scroll anchoring, and the minimap's per-message
`getBoundingClientRect()` all require the whole transcript in the DOM. The
last six units (`LIVE_TAIL_UNITS`) opt out of containment because the
follow-scroll measures the end sentinel and a skipped ancestor would report a
placeholder height.

`LazyColumn` *is* virtualization, and it inverts those trade-offs:

| Web behaviour | Android |
|---|---|
| off-screen turns cost no style/layout/paint | off-screen items are not composed at all — strictly better |
| `contain-intrinsic-size` keeps total scroll height stable | no analogue and none needed; `LazyColumn` does not compute a total extent |
| select across turns, find-in-page | **lost.** Accept it; per-message copy (already present) plus a session-export path covers the real need |
| `ChatMinimap` maps pixels to messages across the whole transcript | **not portable.** LazyColumn cannot report off-screen geometry |

**Decision:** drop the minimap. Replace it with a **turn-index rail** — a
fixed-height column of one tick per *turn* (not per pixel), each tick coloured
by turn outcome (plain / had-errors / running), tappable to
`animateScrollToItem`, with the current turn marked. It answers the question
the minimap actually answers ("where am I in this conversation, and where were
the interesting bits") without needing geometry Compose will not give. Shown at
Expanded width and up, in the 36dp gutter the web reserves
(`CHAT_MINIMAP_WIDTH`); hidden at Compact and Medium, exactly as the web hides
it on mobile.

### 4.4 Tool-call blocks

`ToolCallBlock` in `MessageView.tsx`. Collapsed by default
(`toolCallsDefaultCollapsed`, persisted at `cody:tool-calls-collapsed`).

Frame: `CodyShapes.toolCard` (7dp), border `success @ 25%` / background
`success @ 4%`; on error `error @ 45%` / `error @ 5%`.

Header row (always visible, the whole row is the toggle):
mono w600 tool name tinted success/error → dim one-line argument preview,
ellipsized, taking the remaining width → duration in tabular figures →
chevron, rotating 90° over `--dur-fast`.

Expanded adds, in order: pretty-printed JSON arguments on `--bg-subtle`
(**skipped for edit tools**, whose arguments are the diff), then either a
paired diff view, or a per-subagent task summary (`TaskResultPanel`) followed
by the raw result text.

Tool-result images render **outside the collapse**, always visible, max
440×260dp, on a white backplate.

Android specifics:

- **Expansion state must not live in `remember`.** `LazyColumn` disposes
  off-screen items; a `remember { mutableStateOf(false) }` inside the item
  resets the user's expansion when they scroll away and back. Hoist it into a
  `SnapshotStateMap<String, Boolean>` keyed by `toolCallId`, owned by the
  screen's state holder. This is the most likely single bug in a naive port.
- Body reveal: `AnimatedVisibility` with `expandVertically`/`shrinkVertically`
  at `--dur-fast` / `CodyEasing.outWarm`; instant under reduce-motion.
- Chevron: `Modifier.graphicsLayer { rotationZ = angle }` — draw phase only.
- Semantics: `mergeDescendants = true` on the header, `stateDescription` =
  expanded/collapsed, `onClick(label = "expand tool call")`. Mirrors the web's
  `CollapsibleTrigger` + `aria-expanded`.

### 4.5 Streaming

The single most important structural fact: **the streaming message is not part
of the committed transcript.** `ChatWindow` renders a memoised
`CommittedTranscript`, and then, as a *sibling*, one `MessageView` for
`streamState.streamingMessage`. Per-token updates therefore cannot invalidate
the history.

Android: the streaming message is its own `item(key = "live")` at the tail.
Nothing else in the list may read the streaming state. Concretely: if the
`items()` content lambda closes over `streamingText`, every visible item
subscribes to it, and 60 batches/second × ~12 visible items × a markdown
re-parse each drops frames on any hardware.

**Markdown throttling.** `MarkdownBody` re-parses a growing block at **≤10 Hz**
(`STREAMING_PARSE_INTERVAL_MS = 100`) because
"normalizeDisplayMath + the whole remark→rehype→react pass over the
accumulated answer is a 10–40ms task on a long one — the frame budget is gone
before layout." It never withholds the final text: `isStreaming` goes false the
moment the message settles.

Port that exactly:

- `snapshotFlow { streamingText }.sample(100.milliseconds)` on
  `Dispatchers.Default` feeds the markdown → `AnnotatedString` converter.
- Between samples, the **tail after the last parsed offset renders as plain
  text** in the same `bodyMedium` style, so tokens still appear at frame rate
  while structure lands at 10 Hz. The user sees continuous motion; the parser
  runs ten times a second.
- On settle, one final full parse, unconditionally.

Per-block memoisation matters too: the web's block memos compare *content*
(text and thinking strings, tool-call ids) rather than object identity, because
every update frame delivers freshly parsed block objects. Settled blocks of a
streaming message therefore skip their re-parse and only the growing block
re-renders. On Android this falls out of stable block models with correct
`equals` — but only if the block types are construct-only data classes over
collections that nothing mutates afterwards (§6.3).

Live indicator: while running and before any text arrives, a single status row
with a pulsing accent dot and a phase label composed of phase · subagent count
· current todo phase. It is the app's one polite live region (§8.3).

### 4.6 Code blocks

`markdownCodeRenderer` dispatches: `mermaid` → a diagram block, everything else
→ `CodeBlock(code, lang, isStreaming)`. The web highlights with
`react-syntax-highlighter`; math is `remark-math` + `rehype-katex`; HTML is
`rehype-raw` + `rehype-sanitize`.

Android:

- **Highlighting off the main thread, cached on the model.** Tokenize once,
  produce an `AnnotatedString` with spans, cache it keyed by
  `(codeHash, lang, themeId)`. Never tokenize in composition. Under the
  `--dur-fast` budget this is the difference between a smooth expand and a
  visible hitch on a 300-line block.
- **While streaming, do not highlight at all.** Render mono unstyled until the
  block closes. A partially-received block cannot be tokenized correctly
  anyway, and re-tokenizing it ten times a second is pure waste.
- **Horizontal scroll, never wrap.** `Modifier.horizontalScroll()` per block,
  with the block's vertical extent bounded by content. Wrapping code is worse
  than scrolling it. The block must **not** be nested in a horizontally
  scrolling ancestor; the transcript scrolls vertically only.
- **Header row** per block: language label (mono, dim), copy action, and for
  long blocks a collapse. Line numbers at Expanded width and up only — they
  cost ~4 columns and a tablet in portrait needs the columns.
- **Font scale clamp:** code text scales with `fontScale` only up to 1.3×.
  Beyond that a 100-column line becomes unreadable even with scrolling, and
  the clamp is the lesser harm. Prose is not clamped.
- Mermaid: render to a bitmap off the main thread, display with pinch-zoom.
  Do not attempt a live-editing diagram surface.
- Math: a KaTeX-equivalent renderer, same treatment — render to
  `AnnotatedString`/bitmap once, cache.

### 4.7 Images

Deferred media is the fluidity story. History loads pass `deferThinking=1` and
`deferMedia=1`; each image becomes a URL block pointing at
`/api/sessions/[id]/media?entryId=&index=` which streams the bytes.

Android: Coil with that URL and a stable memory/disk cache key. **Never put
base64 into a message model** — a transcript with twenty screenshots inlined as
data URIs is tens of megabytes of `String` on the heap, and every one of them
gets copied on every snapshot read.

- `AsyncImage`, **not** `SubcomposeAsyncImage` (§6.5).
- Reserve space with the known aspect ratio so a late decode does not reflow
  the transcript under the reader.
- Tap opens a lightbox (`ImageLightbox.tsx` equivalent): full-screen dialog,
  pinch-zoom, double-tap, swipe-to-dismiss.
- Thinking blocks defer the same way, fetched on expand, with a bounded cache
  (`MAX_THINKING_CACHE_ENTRIES = 100`). Port the bound; an unbounded cache of
  expanded reasoning is a slow leak.

### 4.8 Scroll-follow and the manual-scroll-up escape

The web implementation (`hooks/useAgentSession.ts`) is careful and worth
reading in full before porting. Its shape:

- The follow effect depends on both `messages` (boundaries) and `streamState`
  (every token batch), and is throttled to **one `requestAnimationFrame`**
  while a run is active (`followScrollFrameRef`).
- `completionScrollAllowedRef` gates following. A manual scroll-up clears it,
  and it stays clear until the next prompt.
- `scrollToBottom()` marks a window during which its own scroll events are
  ignored (`ignoreProgrammaticScrollUntilRef`) — but **user intent wins over
  that window**, because during a busy stream the window is refreshed every
  frame and checking it first would trap the user at the bottom. That ordering
  is a bug fix, not a style choice.
- User intent is marked from window `keydown`/`pointerdown` and container
  `wheel`/`touchstart`.
- "At bottom" is `end.bottom - container.bottom <= 24` — 24px of slack.
- Sending resets `completionScrollAllowedRef = true`, clears the intent
  timestamp (the send click itself must not read as a request to stop
  following), and queues a scroll that puts the new user message at the top.
- `.chat-scroll-region { scroll-behavior: auto }` so imperative scroll writes
  are not turned into UA-eased animations that lag the pointer.

Android is **cleaner**, because Compose reports the gesture source directly and
both timers disappear:

```kotlin
val followConnection = remember {
  object : NestedScrollConnection {
    override fun onPreScroll(available: Offset, source: NestedScrollSource): Offset {
      if (source == NestedScrollSource.UserInput && available.y > 0f && !atBottom) {
        followEnabled = false          // upward drag = toward older content
      }
      return Offset.Zero
    }
  }
}
```

`NestedScrollSource.UserInput` distinguishes a drag or fling from a
programmatic `scrollToItem`, which is precisely what
`markUserScrollIntent` + `ignoreProgrammaticScrollUntil` were emulating.
Delete both.

The rest, ported literally:

- `atBottom` = last visible item is the last item **and** its bottom is within
  24.dp of the viewport end. Wrapped in `derivedStateOf` (§6.4).
- While following during a run, use **`scrollToItem`, never
  `animateScrollToItem`** — the web's exact reason: an eased animation
  restarted every frame lags the content and fights the user.
- Throttle to one frame with `snapshotFlow { tailRevision }.conflate()`, which
  is the idiomatic one-per-frame collapse.
- On settle (turn end), a single `animateScrollToItem` — unless reduce-motion,
  then `scrollToItem`.
- Sending re-enables following and scrolls the new user message to the top.
- **Jump-to-bottom pill**: an `AnimatedVisibility` capsule above the composer
  whenever `!followEnabled`, carrying a count of turns arrived since the user
  left the bottom. Tapping it re-enables following. This is the visible half of
  the escape hatch, and the redesign spec already calls for it ("回到底部按钮 →
  悬浮胶囊"). It must be a real affordance, not a bare arrow: the user needs to
  know they are behind, not just that they can move.

---

## 5. Platform surfaces

### 5.1 Termux companion (`RUN_COMMAND`)

Phase 2, local mode. Integration depth 1 from `docs/android.md`: companion app,
driven by intent. Nothing is forked and nothing is embedded, so no GPL
question arises yet.

**Manifest:**

```xml
<uses-permission android:name="com.termux.permission.RUN_COMMAND" />
<queries><package android:name="com.termux" /></queries>
```

The `<queries>` entry is **mandatory** at `targetSdk ≥ 30`. Without it package
visibility hides Termux, `getPackageInfo` throws, the intent silently fails,
and the failure looks like a Termux bug. It is the single most common way this
integration is broken.

**Intent:**

```kotlin
Intent().apply {
  setClassName("com.termux", "com.termux.app.RunCommandService")
  action = "com.termux.RUN_COMMAND"
  putExtra("com.termux.RUN_COMMAND_PATH", "$PREFIX/bin/bash")
  putExtra("com.termux.RUN_COMMAND_ARGUMENTS", arrayOf("-lc", script))
  putExtra("com.termux.RUN_COMMAND_WORKDIR", workspaceDir)
  putExtra("com.termux.RUN_COMMAND_BACKGROUND", true)
  putExtra("com.termux.RUN_COMMAND_COMMAND_LABEL", label)
  putExtra("com.termux.RUN_COMMAND_PENDING_INTENT", resultPendingIntent)
}
```

Results arrive on the `PendingIntent` in the plugin result bundle:
`…_STDOUT`, `…_STDERR`, `…_EXIT_CODE`, `…_ERR`, `…_ERRMSG`, plus
`…_STDOUT_ORIGINAL_LENGTH` / `…_STDERR_ORIGINAL_LENGTH`. Prefer the
`TermuxConstants` symbols from `termux-shared` over string literals.

**Hard limits that shape the UX, not just the code:**

| Limit | Value | Consequence |
|---|---|---|
| total intent extras | ~500 KB | never pass a file's contents as an argument; write to the shared workspace and pass a path |
| stdout + stderr returned | truncated to 100 KB combined | the transcript card must show "output truncated (N KB of M)" using the `ORIGINAL_LENGTH` extras, never silently clip |
| `errmsg` | 25 KB | fine |
| argv / command length | ~128 KB | fine for scripts, not for data |
| `PendingIntent` requestCode | must be unique per execution | a reused code means only the first result ever arrives; use a monotonic counter, `FLAG_ONE_SHOT` + `FLAG_MUTABLE` on S+ |

**`RUN_COMMAND` is a one-shot RPC, not a PTY.** Therefore the local-mode
Terminal tool in Phase 2 is a **command runner**: a transcript of
(command, exit code, stdout, stderr) cards with re-run and copy actions, an
input field, and a header that says so plainly — "Termux command runner. An
interactive shell needs the embedded terminal (not yet available)." Promising
an interactive shell here and delivering a request/response loop is the kind of
gap that makes the whole app feel dishonest. The real PTY is Phase 3
(embedded `terminal-view`/`terminal-emulator`, GPLv3 boundary decided first,
per `docs/android.md`).

Background vs foreground: Cody uses `EXTRA_BACKGROUND = true` for everything it
drives, because that is the only mode that returns separated stdout and stderr,
and because foreground execution needs Termux to hold Draw-Over-Apps or the
user must tap a notification before anything runs. `EXTRA_BACKGROUND = false`
with a `SESSION_ACTION` is used *only* for the explicit "open a shell in
Termux" escape hatch, which hands the user to Termux and does not expect a
result.

**Permission UX.** `com.termux.permission.RUN_COMMAND` is a dangerous custom
permission owned by another app, and Termux's own documentation expects the
user to grant it from App Info → Permissions → Additional permissions. So:

1. An explainer sheet first — what Cody will run, where, and that Termux stays
   independently useful. Never a bare system dialog.
2. `ActivityResultContracts.RequestPermission`. If it resolves, done.
3. If it is denied and `shouldShowRequestPermissionRationale` is false, the
   dialog will not appear again: deep-link with
   `Settings.ACTION_APPLICATION_DETAILS_SETTINGS` and show the exact path to
   tap. Do not loop the request.

**Setup checklist screen** (local mode), three rows, each with its own Fix
action, because two of the three are things the app cannot do:

| Row | Check | Fix |
|---|---|---|
| Termux installed | `getPackageInfo("com.termux")` | link the F-Droid / GitHub release page, and state the signature-source rule — mixing sources fails to install |
| `RUN_COMMAND` granted | `checkSelfPermission` | the flow above |
| `allow-external-apps=true` | attempt a trivial background command; a refusal means the property is unset | copy the exact line for `~/.termux/termux.properties` to the clipboard and offer "Open Termux" |

**When Termux is absent:** the Terminal tool is capability-gated off in local
mode and shows one card ("Terminal needs Termux" + install link) — the same
discipline as a `false` capability hiding a panel in the web UI. It is never a
broken terminal. In **remote** mode Termux is irrelevant: the Terminal tool is
the server PTY and works regardless.

**One more warning worth surfacing:** Android 12+ kills phantom processes
beyond a system-wide cap and kills processes using sustained CPU — which is
exactly what a long-running local inference server in Termux looks like. The
local-mode setup screen carries a health note about this with a link to the
device-specific opt-out, because the failure mode ("the model server just
disappeared") is otherwise unexplainable to the user.

### 5.2 Shizuku

Phase 2, optional, and it buys exactly **one** capability in this spec:
`READ_LOGS` for on-device logcat in the Info panel. Do not scope-creep it.

**Setup.** `dev.rikka.shizuku:api` + `dev.rikka.shizuku:provider`, and the
provider declaration:

```xml
<provider
  android:name="rikka.shizuku.ShizukuProvider"
  android:authorities="${applicationId}.shizuku"
  android:multiprocess="false"
  android:enabled="true"
  android:exported="true"
  android:permission="android.permission.INTERACT_ACROSS_USERS_FULL" />
```

**Four-state capability**, surfaced in Settings → Diagnostics:

| State | Detection | UI |
|---|---|---|
| `Unsupported` | `Shizuku.isPreV11()` | "requires Shizuku v11+" |
| `NotInstalled` | provider absent / binder never received | explain what Shizuku is and link it. Do not nag; this is an optional power feature |
| `NotRunning` | installed but binder dead | "Shizuku is installed but not started" + the wireless-debugging steps, and the honest note that it must be restarted after every reboot on a non-rooted device |
| `Ready` | binder alive | show the permission row |

Track it with `Shizuku.addBinderReceivedListener` /
`addBinderDeadListener`, because calling any `Shizuku` method on a dead binder
throws `IllegalStateException` — the state must be observed, never assumed.

**Permission** mirrors the runtime-permission shape:
`Shizuku.checkSelfPermission()`; if `shouldShowRequestPermissionRationale()` is
true the user chose "deny and don't ask again", so route to Shizuku's own app;
otherwise `Shizuku.requestPermission(code)` and listen via
`addRequestPermissionResultListener`.

**Granting `READ_LOGS`.** It is `signature|privileged|development`; the
*development* flag is why `pm grant` works for it at all. Through Shizuku: wrap
`IPackageManager` in `ShizukuBinderWrapper` and call
`grantRuntimePermission(packageName, "android.permission.READ_LOGS", userId)`,
using `HiddenApiRefinePlugin` or `AndroidHiddenApiBypass` for the non-SDK
interface. Use `ShizukuBinderWrapper` for this, not `Shizuku.newProcess` — that
API is being removed and has no tty; a `UserService` is the sanctioned route
for anything more involved.

**The grant does not take effect in the running process.** So the UX is
explicitly two-step: **Grant device log access** → then **Restart Cody to
enable it**, with the restart offered as a button. A silent grant that appears
to do nothing is worse than no feature.

Note also that ADB-backed Shizuku (`Shizuku.getUid() == 2000`) and root-backed
Shizuku (`0`) have materially different reach — shell cannot read other apps'
private data. Nothing in this spec depends on that reach, and nothing added
later should assume it without checking `getUid()`.

**Degrading when unavailable — the part that must be built first.** The app
keeps its **own** bounded in-memory log ring buffer (last ~2000 lines, no
token, no message bodies) at all times. That is what Copy diagnostics uses.
System-wide logcat is strictly additive on top. Without this, "diagnostics"
would be a feature that only works for users who set up Shizuku, which is
backwards: an app cannot reliably read even its own logs without `READ_LOGS`,
so depending on logcat for basic diagnosability is a design error.

---

## 6. Fluidity, concretely

Performance is the owner's first-named priority. This section is the contract.

### 6.1 Frame budget

The target is a 120 Hz tablet, so the budget is **8.3 ms per frame**. Allocation:

| Phase | Budget |
|---|---|
| composition (recomposition of invalidated scopes) | ≤ 2 ms |
| layout + measure | ≤ 2 ms |
| draw / record | ≤ 2 ms |
| headroom (GPU, system, jank absorption) | ≥ 2.3 ms |

Streaming is the sustained-load case: the transcript must hold this budget with
a token stream arriving, a tool-call card expanding, and the composer autosizing
— simultaneously. Measure with Macrobenchmark `FrameTimingMetric`, gate on
P99 < 8.3 ms and **zero** frames > 16.6 ms during a 60-second streamed turn.
`R8` full mode, baseline profiles for the transcript and composer, and
`StrictMode` with `detectAll()` in debug.

### 6.2 Stable keys

`LazyColumn` items keyed by `.jsonl` entry id per §4.1. Also key every
`AnimatedContent`, `Crossfade`, and `key {}` in the transcript by entry id.
Never index-key anything in the transcript: an index key turns a history
prepend into a full re-composition *and* loses scroll anchoring, converting the
one thing LazyColumn does for free into a bug.

### 6.3 Stability of the message models

The requirement is an **outcome**, not a specific annotation: every
transcript-reachable model must be reported **stable** by the Compose compiler,
so an unrelated state change cannot invalidate a committed item. How you get
there depends on where the models live, and the binding architecture decision
(a Compose-Multiplatform-ready `:shared` module, thin `:app`) makes that choice
for us.

Compose treats `List<T>` as **unstable**, so this is unstable even though it
looks like a value:

```kotlin
// WRONG — content is List<T>; every AssistantMessage recomposes unconditionally
data class AssistantMessage(val content: List<ContentBlock>)
```

Two mechanisms produce the same stable outcome:

**A — stability configuration file (use this when the model module is
androidx-free).** `:shared` deliberately carries *zero* androidx dependencies —
that is what makes the `LocalBackend` and the later CMP/iOS port real rather
than aspirational — so `androidx.compose.runtime.@Immutable` cannot be applied
there at all, and neither can `kotlinx.collections.immutable` be justified. The
models stay plain Kotlin, and `:app` declares them stable:

```
# app/compose-stability.conf
dev.cody.shared.model.*
```

```kotlin
composeCompiler { stabilityConfigurationFiles.add(/* app/compose-stability.conf */) }
```

**B — annotation (only where the models already depend on the Compose
runtime).** `@Immutable` on the data class over `ImmutableList`/`PersistentList`
and primitives.

**The trade-off, stated plainly:** the configuration file is a *promise*. It
suppresses the inference; it does not enforce immutability. A `List` field
declared stable that someone later mutates in place will silently fail to
recompose — a missing-update bug, which is far harder to find than an
over-recomposition one. So route A carries two obligations:

- models are **construct-only**: no `var`, no mutating members, no exposed
  builders;
- the mapper that builds them **copies** every incoming collection
  (`toList()`), so no model ever aliases a list the network layer still holds.

Route A is otherwise the better answer, because it keeps the portable module
portable and drops a dependency.

Rules, mechanism-independent:

- every message, content block, tool-call, todo phase and subagent model is a
  `data class` over collections and primitives only, reported stable by one of
  the two routes;
- `@Stable` (not `@Immutable`) for the `:app`-side holders whose contents change
  but whose identity is observable — the tool-call expansion map, the scroll
  state holder. These live in `:app`, so the annotation is available and should
  be used.
- run the **Compose compiler stability report** in CI and fail the build on any
  transcript-reachable class reported unstable. **This is the gate**, not the
  annotation — an annotation cannot exist in an androidx-free `commonMain`, and
  a configuration file entry can rot silently when a class is renamed or moved
  out from under its wildcard. Only the report catches both.
- callbacks passed into items (`onOpenFile`, `onFork`, `onNavigate`,
  `onEditContent`) must be stable references — `remember`ed lambdas or method
  references on a stable holder. The web already depends on this: its memo
  comparators literally compare `prev.onOpenFile === next.onOpenFile`.

### 6.4 `derivedStateOf`

Wrap every value computed from high-frequency state, so readers invalidate on
the *result* changing, not the input:

```kotlin
val atBottom by remember {
  derivedStateOf {
    val info = listState.layoutInfo
    val last = info.visibleItemsInfo.lastOrNull()
    last != null &&
      last.index == info.totalItemsCount - 1 &&
      last.offset + last.size <= info.viewportEndOffset + slackPx
  }
}
```

Required for: `atBottom`, the jump-to-bottom pill's visibility and count, the
turn-index rail's current marker, the context-ring percentage, the quota-ring
tone, the phase label string, and the composer's send-enabled flag.

The rule: **never read `listState.firstVisibleItemIndex`,
`firstVisibleItemScrollOffset`, or `layoutInfo` directly in composition.** Each
is written on every scroll pixel; an unwrapped read recomposes its scope
~120 times a second while a finger is down.

### 6.5 Why the whole list must not recompose per token

Three independent mechanisms, all required:

1. **Structural** — the streaming message is a separate `item(key = "live")`;
   no committed item reads streaming state (§4.5).
2. **Stability** — committed items read only stable models with correct
   `equals`, so an unrelated state change (a git badge poll, an update check, a
   usage refresh) cannot invalidate them. The web solves the same problem by
   memoising `CommittedTranscript` against an `AppShell` holding ~60 state
   values, and its comment says exactly that.
3. **Work placement** — markdown parsing, highlighting, diff parsing and
   `AnnotatedString` construction happen in the ViewModel, not in composition,
   so even a recomposition that *does* happen is cheap.

Miss any one and the others do not save you. Miss all three and the transcript
drops frames on the second paragraph.

### 6.6 `Modifier.graphicsLayer` for cheap animation

Animate **draw-phase** properties inside a `graphicsLayer` lambda — the lambda
reads the animation state, so composition and layout do not re-run at all:

```kotlin
Modifier.graphicsLayer {
  rotationZ = chevronAngle          // tool-call chevron
  alpha = entranceAlpha             // chat-message-in
  translationY = entranceOffsetPx   // chat-message-in
  scaleX = pulseScale               // live dot
}
```

Use it for: the tool-call chevron, message entrance
(`chat-message-in` at `--dur-med`), the pulsing live dot
(`live-dot-pulse`, 1.6s), the panel-open fade, toast entrance, the skeleton
shimmer.

Do **not** animate via `Modifier.rotate()`, `Modifier.padding(animatedDp)`,
`Modifier.height(animatedDp)`, or `Modifier.offset(animatedDp)` — each runs in
the layout phase and invalidates the parent, so a pulsing dot inside a
transcript item re-lays-out the item every frame.

The one legitimately-layout animation is the pane width transition (the web's
`transition: width var(--dur-med)`). Do it with `Modifier.layout { }` reading
the animation value inside the measure lambda, so only layout re-runs, not
composition. And follow the web's discipline: **no easing while the user is
dragging the resize seam** (`.sidebar-resizing { transition: none }`) — a drag
must track the finger 1:1.

### 6.7 `SubcomposeLayout` — when, and when not

**Never inside a transcript item.** `SubcomposeLayout` composes during layout,
which defeats `LazyColumn`'s prefetch (the prefetcher composes the next item
ahead of time; a subcomposition moves that cost back into the layout pass where
it cannot be amortised) and makes each item's cost land in the wrong phase.

This ban includes the disguises:

- `BoxWithConstraints` — a `SubcomposeLayout`. Use `Modifier.layout {}` or
  `onSizeChanged` + state, or better, decide from the window size class which
  is known before composition.
- `SubcomposeAsyncImage` (Coil) — a `SubcomposeLayout`. Use `AsyncImage` with
  explicit `placeholder`/`error` painters.
- `Scaffold`-in-item, nested lazy layouts.

**Warranted** only where a child's *existence* genuinely depends on measured
size and the size class cannot answer it: the git panel's list/tree density
decision, and a code block choosing between line numbers and none at a
borderline width. Both are outside the transcript and both are cheap. If a
third case appears, the correct answer is almost always the window size class.

### 6.8 Text layout caching

Long transcripts are dominated by text measurement, not by drawing.

- **Build each message's `AnnotatedString` once**, in the mapper, off the main
  thread, and store it on the immutable model. Markdown must never be parsed in
  composition.
- **Cache `TextLayoutResult`** keyed by
  `(annotatedString identity, constraints.maxWidth, fontScale, themeId)` — a
  pane resize or a font-scale change legitimately invalidates it; a
  recomposition does not.
- Use a hoisted `TextMeasurer` (`rememberTextMeasurer()`) for anything measured
  outside a `Text` composable (the turn-index rail's tick heights, height
  estimates).
- **Port both size caps** from `MessageView.tsx`: `MAX_MARKDOWN_CHARS =
  100_000` (above it, render mono plain text — do not attempt to parse) and
  `MAX_INLINE_RESULT_CHARS = 200_000` (above it, a "view full output" reveal).
  Also port `formatMessageSize`'s KB/MB label so the user knows *why* they are
  looking at unstyled text.
- Keep the deferred-content caches bounded (`MAX_THINKING_CACHE_ENTRIES = 100`).
- Do not enable `includeFontPadding`-era compatibility behaviour; measure with
  the modern metrics so line heights match the 1.5–1.6 ratios in §1.6.

### 6.9 What must never run on the main thread

| Work | Where |
|---|---|
| SSE/NDJSON frame parsing, session `.jsonl` decode | `Dispatchers.Default`, streaming `kotlinx.serialization` |
| markdown → `AnnotatedString` | `Dispatchers.Default` |
| code tokenizing / syntax highlighting | `Dispatchers.Default` |
| unified-diff parsing and hunk folding | `Dispatchers.Default` |
| mermaid and math rasterisation | `Dispatchers.Default` |
| image decode and downsampling | Coil's own dispatcher — do not override it onto Main |
| PNG encode for capture-to-composer | `Dispatchers.Default` |
| file-tree enumeration, git status parsing | `Dispatchers.IO` |
| DataStore reads (token, theme, pane widths, panel choice) | `Dispatchers.IO`; read once into state, never per-frame |
| Ktor/OkHttp I/O | its own dispatcher; **no `runBlocking` on Main, ever** |
| transcript unit building (`buildTranscriptUnits` equivalent) | `Dispatchers.Default` |
| log ring-buffer writes, logcat reads | `Dispatchers.IO` |

The only transcript work that *must* be on Main: `LazyListState.scrollToItem` /
`animateScrollToItem`, and Compose state writes that drive them.

---

## 7. Motion

- `CodyEasing.outWarm` is the app default. Do not mix in M3 easings.
- Durations only from `--dur-fast` / `--dur-med` / `--dur-slow` / `--dur-theme`
  (§1.5). A one-off duration is a bug.
- Entrance animations run **only on the live tail**. The web is explicit: a
  lazy-loaded page of history must not animate in, because forty simultaneous
  entrance animations mid-scroll look like a glitch
  (`.chat-turn:not(.chat-turn--live) .chat-message { animation: none }`).
  On Android, gate the entrance on `unit.isLiveTail`.
- Pane transitions use `ListDetailPaneScaffold`'s built-in motion at
  `--dur-med`; drawer at `--dur-slow` (matching the mobile sidebar's 320ms
  slide).
- No parallax, no shared-element transitions into the transcript, no spring
  overshoot on scroll. The transcript is a reading surface.

## 8. Accessibility

### 8.1 Reduce motion

Android has no `prefers-reduced-motion`. The real signal is
`Settings.Global.ANIMATOR_DURATION_SCALE == 0f`. Read it, **observe it** with a
`ContentObserver`, and expose it as `LocalReduceMotion`.

When set:

- all entrance/exit animations become instant (the web's
  `animation-duration: .001ms !important` equivalent);
- `animateScrollToItem` → `scrollToItem`; jump-to-bottom jumps;
- the pulsing live dot becomes a static filled dot, and the subagent chip's
  pulse likewise — these are the analogue of the web's SMIL problem, which CSS
  alone could not stop and which is why `usePrefersReducedMotion` exists;
- the theme crossfade becomes an instant swap;
- the skeleton shimmer becomes a **static dimmed fill** — it must still read as
  "loading", exactly as `.skeleton` degrades rather than disappearing;
- the session-title scramble effect (`useScramble`) is skipped entirely.

### 8.2 Touch targets

Every interactive element carries `Modifier.minimumInteractiveComponentSize()`
(48dp), while **painting** at its design size. This is the whole trick: the web
already paints toolbar buttons at 40px and composer controls at 38px on coarse
pointers; Android keeps those paint sizes and expands only the touch region, so
the layout stays as dense as the design intends and nothing is under-sized.

- list rows (session, git file, task, file tree): `heightIn(min = 48.dp)`
- icon buttons: 40dp painted / 48dp touch
- composer controls: 38dp painted / 48dp touch
- tool rail items: 56dp × 48dp
- the tool-call header is a full-width row, so it is comfortably over minimum
- **all hover-revealed affordances are permanently visible** — the
  `.touch-reveal` rule generalised: message copy/fork, session-row overflow,
  git-row actions. There is no hover on this device.

### 8.3 TalkBack on the chat surface

This is the part most ports get wrong, because a naive transcript is a swipe
maze of forty leaf nodes per turn.

- **One merged node per turn** for the chrome. `semantics(mergeDescendants =
  true)` on the turn container, with a `contentDescription` composed as:
  role → author → relative time → "N tool calls, collapsed" → outcome. The
  message **text** stays its own traversable node so it can be read, selected
  and copied; decorative rows (the live dot, telemetry lines, the pulsing
  indicator) get `clearAndSetSemantics {}` and vanish from traversal.
- **Exactly one polite live region** for run state:
  `liveRegion = LiveRegionMode.Polite` on the status row carrying the phase
  label. This is the direct port of the web's
  `role="status" aria-live="polite"` on the running indicator.
- **The streaming answer is never a live region.** A live region on growing
  text makes TalkBack restart the whole answer on every token — the surface
  becomes unusable. Announce transitions only: "responding", "running
  <tool name>", "done", "failed". The web already does exactly this: the status
  node holds the phase, not the answer.
- **Tool-call blocks**: `stateDescription` expanded/collapsed, an `onClick`
  semantics action with a real label, and the result text as a child node.
- **Tool rail**: `Modifier.selectableGroup()` on the rail plus
  `role = Role.Tab` and `selected = …` per item — the equivalent of the web's
  `role="tab"` / `aria-selected` / `aria-controls` plus roving tabindex, which
  Compose expresses as a selectable group rather than a tabindex dance.
- **Panes**: `isTraversalGroup = true` per pane and explicit `traversalIndex`
  ordering (list → detail transcript → composer → tool pane), so the composer
  is reachable without swiping through the entire history. Without this, a long
  transcript makes the input unreachable in practice.
- **Headings**: `semantics { heading() }` on turn anchors and on tool-panel
  section titles, giving TalkBack's heading navigation something to jump
  between.
- Every icon-only control has a real `contentDescription`. Every purely
  decorative icon is `null`/cleared — the web's `aria-hidden="true"`
  discipline, which it applies consistently and which must survive the port.

### 8.4 Dynamic type

- All text in `sp`. Support `fontScale` to **2.0**.
- **No `Modifier.height()` on anything containing text** — `heightIn(min = )`
  only. The web's fixed 25px/28px/36px bars must become minimums, or text
  clips at scale.
- The composer caps by `maxLines`, not dp (§3.4).
- Code and terminal text clamp at `fontScale ≤ 1.3` (§4.6). Prose does not
  clamp.
- Panel definition grids (`InfoPanel`'s `minmax(96px, auto) minmax(0, 1fr)`)
  reflow to stacked label-over-value above `fontScale 1.5`, rather than
  squeezing the value column to nothing.
- Test matrix: fontScale × {1.0, 1.3, 2.0} × size class × {light, dark}. The
  web's manual checklist is light/dark × desktop/mobile; dynamic type is the
  axis Android adds, and it is the one that breaks layouts.
- `sp`-scaled minimum touch targets still hold at 48dp — they are physical, not
  typographic.

---

## 9. Phase 1 versus later

Phase 1 is the online thin client over `RemoteBackend` (`docs/android.md`
phasing). This table is what `AndroidScaffold` builds first.

| Area | Phase 1 | Phase 2 | Phase 3 |
|---|---|---|---|
| **Theme** | full token system, `ColorScheme` builder, default light + dark palette, `codyShadow`, `CodyEasing`, typography | all ten families as data + picker | — |
| **Layout** | `ListDetailPaneScaffold`, all five size classes, `CHAT_MIN_WIDTH`/960dp caps, pane persistence | — | — |
| **Navigation** | tool rail, leading drawer, top app bar, predictive back | — | — |
| **Onboarding** | server URL, token paste, four-row connectivity check, backend choice (local shown as unavailable) | local-mode setup: Termux checklist, model manager | — |
| **Session list** | list, tree, search, running-only, running SSE, rename/delete/archive, projects, worktree selector | — | offline-session sync-back |
| **File explorer** | tree, lazy expand, git decorations, open-to-tab | — | — |
| **Chat transcript** | grouping, collapsed process groups, tool-call blocks, streaming with 10 Hz parse, code blocks with off-main highlighting, deferred images + lightbox, scroll-follow + escape + jump pill, 50-message paging | turn-index rail; thinking-block deferral | — |
| **Composer** | input, attachments (image + text, all caps), slash + mention menus, bash mode, model/reasoning/fast controls, **context ring**, **plan-quota ring** with all four absence states, queued follow-ups, todo panel, subagent roster + transcript dialog | local-assist routing badge | inline completions |
| **Tool panels** | files + viewer, git (read + stage/unstage/discard/commit + checkpoints), terminal (server PTY), preview (all three rungs), tasks, updates, info + diagnostics | terminal = Termux command runner in local mode | embedded PTY (GPL boundary) |
| **Backends** | `RemoteBackend` only; the interface exists and the UI is written against it | `LocalBackend`, explicit mode switch, persistent remote/local badge | real engines under proot |
| **Termux** | absent; Terminal is server-only | `RUN_COMMAND`, permission UX, setup checklist, command runner | embedded `terminal-view` |
| **Shizuku** | absent; **in-app log ring buffer ships in Phase 1** because diagnostics must not depend on it | four-state capability, `READ_LOGS` grant + restart flow, logcat in Info | — |
| **On-device inference** | none | model manager, local endpoint as "just another provider" | NPU path |
| **Accessibility** | all of §8 — reduce-motion, 48dp targets, TalkBack semantics, dynamic type to 2.0 | — | — |
| **Perf gates** | stability report in CI, Macrobenchmark frame gate, baseline profiles | — | — |

Accessibility and the performance gates are **Phase 1**. Both are structural:
retrofitting semantics onto a merged transcript, or stability onto models with
`List` fields, means rewriting the transcript.

---

## 10. Web → Android file map

For diffing an Android screen against its original.

| Android surface | Web source |
|---|---|
| theme, `ColorScheme`, shapes, motion | `app/globals.css`, `lib/theme-catalog.ts`, `hooks/useTheme.ts` |
| pane scaffold, tool rail, top bar, pane persistence | `components/AppShell.tsx`, `hooks/useIsMobile.ts`, `lib/storage-keys.ts`, `lib/chat-layout.ts` |
| session list, projects, worktrees | `components/SessionSidebar.tsx`, `lib/project-ordering.ts`, `lib/worktree.ts` |
| file explorer | `components/FileExplorer.tsx` |
| transcript, grouping, paging, scroll-follow | `components/ChatWindow.tsx`, `lib/chat-lazy-load.ts`, `hooks/useAgentSession.ts` |
| message, tool-call block, thinking, task summary | `components/MessageView.tsx` |
| markdown, code, mermaid, math | `components/MarkdownBody.tsx`, `components/MarkdownCode.tsx`, `lib/markdown.ts` |
| turn-index rail (replaces minimap) | `components/ChatMinimap.tsx` |
| composer, rings, slash/mention, attachments | `components/ChatInput.tsx`, `lib/chat-attachments.ts`, `lib/image-attachments.ts`, `lib/web-slash-commands.ts` |
| quota ring data | `hooks/useUsage.ts`, `lib/usage/{types,select,cache}.ts`, `app/api/usage/route.ts` |
| todo + subagent panels | `components/ComposerPanels.tsx`, `components/TodoList.tsx`, `components/SubagentTranscriptDialog.tsx`, `lib/subagent-{types,history,format}.ts` |
| file tabs | `components/TabBar.tsx`, `components/FileViewer.tsx` |
| git panel, diffs | `components/GitPanel.tsx`, `components/DiffView.tsx`, `lib/patch.ts` |
| terminal | `components/TerminalPanel.tsx`, `lib/terminal-preferences.ts` |
| preview, streamed surface | `components/PreviewPanel.tsx`, `components/StreamedDisplay.tsx`, `lib/display/*` |
| tasks | `components/TasksPanel.tsx`, `lib/workspace-tasks.ts` |
| updates, info, diagnostics | `components/UpdatesPanel.tsx`, `components/InfoPanel.tsx` |
| lightbox | `components/ImageLightbox.tsx` |
| onboarding card styling | `components/LoginScreen.tsx`, `.login-*` in `app/globals.css` |
| token auth | `docs/api.md` (authoritative contract), `lib/auth/tokens.ts`, `app/api/accounts/me/tokens/route.ts`, `app/api/accounts/me/route.ts` |
| capability gating | `lib/harness/*`, `app/api/info/route.ts` |
| shared primitives (dialog, tooltip, collapsible, field, toast) | `components/ui/` |

Design lineage: `docs/specs/2026-07-27-warm-ui-ux-redesign-design.md` (the
warm-paper / warm-ember language, the three-step motion system, the empty-state
and feedback rules) and `docs/specs/2026-08-16-workspace-panels-design.md`
(the seven-tool workspace panel, its badges, and its per-panel states). This
document extends both; it does not replace them.
