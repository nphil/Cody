# Design tokens and UI kit

← Back to [AGENTS.md](../../AGENTS.md) · Full text of the sections AGENTS.md summarizes, moved verbatim; AGENTS.md keeps a short summary of each.

Sections in this file:
- Design Tokens & UI Kit (`app/globals.css`, `components/ui/`)
- One dropdown, and a placeholder is not a choice
- Standalone immersion and the safe-area variables
- Phone composer: one row, nothing wraps

## Design Tokens & UI Kit (`app/globals.css`, `components/ui/`)

Warm-paper (light) / warm-ember (dark) palettes; every text/background pair is
WCAG AA-verified (measured ratios noted in `globals.css` comments). Components
must consume these variables — no hardcoded colors.

```
color:  --bg --bg-panel --bg-hover --bg-selected --border --bg-subtle
        --text --text-muted --text-dim
        --accent --accent-strong --accent-hover   (links / filled buttons / hover)
        --user-bg --tool-bg
type:   --font-serif (display headings, class .display-serif)  --font-mono
shape:  --radius-control (8) --radius-card (12) --radius-modal (16)
depth:  --shadow-card --shadow-pop --shadow-modal
motion: --dur-fast (150ms) --dur-med (220ms) --dur-slow (320ms) --ease-out-warm
edges:  --safe-top --safe-right --safe-bottom --safe-left
```

`components/ui/` holds the shared primitives (built on `@base-ui/react`):
`primitives.tsx` (Dialog/Tooltip/Collapsible), `field.tsx` (form fields +
ConfirmDialog), `Select.tsx` (**the** dropdown), `toast.tsx`
(`toast.success/error/info`, mounted in AppShell).
Icons come from `lucide-react` — do not add new inline SVGs. The command
palette (`components/CommandPalette.tsx`, ⌘K/Ctrl+K) is built on `cmdk`.

### One dropdown, and a placeholder is not a choice
- **`components/ui/Select.tsx` is the only dropdown.** A native `<select>` is
  painted by the browser — a different popup per platform, ignoring the theme
  — so there are ZERO of them left in `components/`/`app/` and a new one is a
  regression. It renders on the same `dropdown-surface` / `dropdown-item`
  classes the composer's own menus use, so every menu in the app looks alike,
  and it inherits keyboard nav, typeahead, edge flipping, focus return and a
  portal that escapes `overflow: hidden` from base-ui's Select.
- **`placeholder` is NOT selectable — an "unset / default / all" row is a real
  option.** `<option value="">All providers</option>` is a value the user can
  come back to; a placeholder is only the empty state of a control whose
  choices are all real (a "Add a model…" action trigger, say). Translating the
  first kind into `placeholder` silently deletes the reset: the migration did
  exactly that to eight controls (All providers, All marketplaces, No
  override, Model default, Distill's engine/model default, local routing's
  unset, the model-level API override), each of which is now an explicit
  `{ value: "", label }` at the head of its option list. When a `""` value
  must persist as absent, keep the transform (`onChange={(v) => set("api", v
  || undefined)}`) — the sweep dropped that too and would have written `""`
  into `models.yml`.

### Standalone immersion and the safe-area variables
- An installed Cody uses the WHOLE screen: `appleWebApp.statusBarStyle` is
  `"black-translucent"` and the viewport is `viewportFit: cover`, so the web
  view extends under the iOS status bar and home indicator.
- The price is that **every viewport-anchored edge pads itself back out**, and
  it does so through the `--safe-*` variables defined once on `:root`
  (`env(safe-area-inset-*, 0px)`) — never by writing `env()` at the call site.
  One definition means one thing to override when verifying the plumbing in a
  browser that reports no insets (`:root{--safe-top:47px}` in a test
  stylesheet reproduces a notch exactly).
- Consumers: `.shell-topbar` (content-box, so its inline 44/32px stays the
  CONTROL height), the mobile `.sidebar-container`, `.settings-level-header`
  (shared by MobileStack's levels and a pushed Drawer), `.login-page`, the
  toast viewport, the workspace-panel toggle, ChatInput's fixed dropdowns and
  its bottom padding, the terminal toolbar and soft keys.
- **A padded parent owns the inset for its subtree.** Panels anchored to a
  measured rect (the top-panel dropdown, BranchNavigator) inherit the offset
  for free and must not add it again; the composer is the only element that
  adds the bottom inset, so ChatWindow's docks contribute plain `8px`.
- **theme-color is the theme's `--bg-panel`, not its `--bg`** — the browser and
  OS chrome touch the TOP BAR, and a `--bg`-coloured status bar read as a band
  above it. `preview.surface` in `lib/theme-catalog.ts` IS each theme's
  `--bg-panel` (and `preview.background` its `--bg`); `useTheme`, the pre-paint
  bootstrap, `layout.tsx`'s themeColor pair and the manifest's `theme_color`
  all read it, and `lib/theme-catalog.test.mjs` reads `globals.css` and fails
  on drift. The manifest's `background_color` stays `--bg` (splash, not chrome).
- **iOS's `black-translucent` status-bar glyphs are UNCONDITIONALLY WHITE** —
  confirmed against Apple's own developer-forum threads and every
  black-translucent writeup that has actually tested it: glyph colour does
  NOT adapt to system appearance, `theme-color`, or anything else. (0.17.1
  assumed the opposite — system dark meaning white glyphs, system light
  meaning dark glyphs — and keyed the strip off `prefers-color-scheme`. That
  left a light Cody theme paired with a light system with white glyphs
  sitting directly on its own light `--bg-panel` (unprotected), and
  needlessly repainted a dark Cody theme's strip a light colour whenever the
  system merely happened to be light (a visible, avoidable band on a theme
  that was already fine).) The one fact that matters is the THEME's own
  mode, full stop: `.shell-topbar` never touches a dark theme's own
  `--bg-panel` (already legible for permanently-white glyphs, regardless of
  the system), and always forces a light theme's inset strip alone to
  `--status-strip-dark` (never legible otherwise) via a hard gradient stop
  at `--safe-top` — `@media (display-mode: standalone) { html:not(.dark)
  .shell-topbar {...} }`, `globals.css`, no `prefers-color-scheme` in sight.
  A light Cody theme under a dark-mode phone (the case 0.17.1 was built to
  protect) looks exactly as before: a dark strip, white glyphs legible on
  it, the bar's own light `--bg-panel` starting right below. That is why the
  top bar's background lives in the stylesheet, not inline — an inline
  `background` would beat the media rule. A REAL Chromium (not CDP's
  `Emulation.setEmulatedMedia`, which cannot fake `display-mode`) launched
  with `--app=<url>` DOES report `display-mode: standalone` — puppeteer-core
  + `CODY_CHROMIUM_BIN`, `--remote-debugging-port`, connect over CDP — so the
  rule verifies end-to-end instead of with the clause removed: fake the
  inset via an inline style PROPERTY (`documentElement.style.setProperty
  ("--safe-top", "47px", "important")`, applied on `DOMContentLoaded` too —
  an appended `<style>` element risks CSP and can throw if run before
  `documentElement` exists this early, silently skipping any code after it
  in the same callback), emulate `prefers-color-scheme` either way with
  `Emulation.setEmulatedMedia` (that part does work), and read the strip's
  computed background or screenshot it.
- **`html, body` are `overflow: hidden`.** Every scrollable region in this
  app (chat, sidebar, settings, dropdowns) is its own nested `overflow-y:
  auto` pane, so html/body never need to scroll — but leaving them
  scrollable is not neutral on iOS: Safari's elastic rubber-band at the
  document edges is a separate, hardcoded behavior that `overscroll-behavior`
  does not suppress (that property only stops scroll CHAINING) and that
  fires on any vertical drag near the top even with zero overflow content,
  revealing whatever is behind the scrolled-away content — `html, body`'s own
  `background: var(--bg)` — right above `.shell-topbar`. `overflow: hidden`
  is the only mitigation that actually works for that, and costs nothing
  here since nothing scrolls at that level to begin with.

### Phone composer: one row, nothing wraps
- Below 640px the controls row is `flex-wrap: nowrap`. Every fixed control is
  38px and `flex-shrink: 0` (attach, reasoning, agent mode, the quota
  ring's box, Stop); Send is the one wider piece — a 38px arrow plus its 24px ▾
  zone (scheduled send), 62px in a single pill, also `flex-shrink: 0`; the model
  selector is the ONLY item that shrinks and it ellipsises.
- The arithmetic lives in `phoneBudget()` (`lib/scheduled/ui.ts`, tested) and
  was checked against a real Chromium at each width: the row is the viewport
  minus 60px (the 16px gutters, the shell's border and its 14/12px padding),
  every box costs 38px plus a 4px gap, the row's zero-width spacer costs one
  more gap, the ring's box keeps 4px to its right, and the model button spends
  51px of its own on chrome before a letter of the name fits. With reasoning and
  the ring beside attach and Send, the name gets 49px at 360px, 79px at 390px
  and 101px at 412px — 24px less than before the ▾ zone, which is its whole
  cost: nothing else gave up space for it. Add the agent-mode button and a
  360px phone is down to 7px (the row still fits; it does not wrap), so a new
  control on this row needs the budget redone first.
- Controls an icon can speak for drop their labels there — Fast included: its
  glyph carries the state the words did (accent + filled bg = requested,
  `TriangleAlert` = inactive/unavailable, `ZapOff` = off, `Zap` = unverified,
  spinner = checking), and the full sentence stays in `title`/`aria-label`.
- The Slow switch (`slow-mode-toggle`) lives in the model dropdown, not on the
  row. The only phone cost of slow mode is the 12px turtle glyph INSIDE the
  model button while it is on (17px with its gap, `PHONE_COMPOSER.stateGlyph`,
  taken from the name — no new box). The usage-limit stage is a 7px dot inside
  the quota ring's existing box (`usage-limit-dot`): it adds no width.
  A signed-out login (no usable account for the selected model's provider)
  wears the same dot in the warning colour (`signed-out-dot`).
- The daily-limit circle (`DailyLimitRing`, only while that limit is on) is one
  more 38px box on the row, as tall as Send, with nothing kept to its right: it
  costs 38 + 4px like reasoning (`phoneBudget(…, { timer: true })`). With
  reasoning and the quota ring beside it the name gets 7px at 360px, 37px at
  390px and 59px at 412px; Chromium measured the model button at 390px at
  exactly the computed 88px, the row 330px wide on one line. Add the agent-mode
  button too and a 360px row spills, as it already did.
- ChatInput's own 16px sides ARE the chat column's gutter. Neither dock may
  wrap it in a second one.

