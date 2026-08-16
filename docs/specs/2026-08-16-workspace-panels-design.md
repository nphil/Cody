# Workspace panels — porting pi-web's right sidebar to Cody

Design for porting the missing right-panel features from
[jmfederico/pi-web](https://github.com/jmfederico/pi-web) (Files | Git |
Terminal | Tasks | Updates | Info) into Cody. Written from a six-way source
sweep of both codebases (pi-web plugin sources under `pi-web-plugins/`, client
shell under `src/client/src/`; Cody's `AppShell`/`FileViewer`/`TerminalPanel`,
`lib/git-*`, update routes).

## What Cody already has (do not duplicate)

- **Files**: explorer in the left sidebar with git decorations, open-file tabs
  + `FileViewer` (source/preview/diff modes, images, PDF, markdown, mermaid) in
  the right panel. pi-web's tree-above-preview layout is NOT ported — Cody's
  split (explorer left, viewer right) is equivalent or better. Only genuine
  gaps from the sweep get ported (metadata bar).
- **Terminal**: persistent server-side ptys (`lib/terminal-manager.ts`),
  multi-tab xterm UI. Equivalent to pi-web; keep.
- **Git (partial)**: `/api/git/status` (porcelain v1 `-z`, classified) feeds
  tree decorations; `/api/git/diff` feeds FileViewer's per-file diff mode with
  `parseUnifiedPatch` (lib/patch.ts) + a folding `DiffView`.
- **Updates (partial)**: `/api/app-update`, `/api/omp-update`,
  `/api/omp-version`, `/api/skills/check` all exist and render inside
  Settings → System & Updates, plus a sidebar-gear badge.

## Architecture

### Panel shell (components/AppShell.tsx)

`rightPanelMode` widens from `"file" | "terminal"` to
`WorkspacePanelId = "file" | "git" | "terminal" | "tasks" | "updates" | "info"`.
A `WORKSPACE_PANELS` descriptor array drives the tab strip:

```ts
{ id, icon: LucideIcon, labelKey: string, badge?: number | "!" | null }
```

- Tab buttons render icon + label (pi-web style; Cody's current two tabs are
  icon-only), horizontal scroll on overflow, roving tabindex with
  Left/Right/Home/End.
- Badges: pill after the label. `git` = changed-file count (from a lightweight
  status fetch keyed on `[activeCwd, explorerRefreshKey]`), `updates` = count
  of update kinds available (Cody app / OMP runtime / skills — AppShell
  already tracks the first two), `tasks` = "!" on config error (reported by
  the panel via callback).
- Each panel's tabpanel div stays mounted once first shown (`display:none`
  when inactive) — existing Cody pattern. New panels load via `next/dynamic`.
- Selected panel persists in `localStorage` under `cody:workspace-panel`
  (registered in `lib/storage-keys.ts`). No URL routing for tool selection
  (deviation from pi-web: Cody's URL carries session identity only; panel
  choice is a device preference).
- Mobile keeps the existing full-width overlay behavior; the tab strip already
  scrolls.

### Git panel (components/GitPanel.tsx) — read-only, like pi-web

Server (additive, non-breaking):
- `getGitStatus()` response gains `branch`, `upstream`, `ahead`, `behind`,
  `detached` (via `git rev-parse --abbrev-ref HEAD` +
  `git rev-list --left-right --count @{upstream}...HEAD`, each with graceful
  fallback) and `hash` (sha1 of raw porcelain output for cheap change
  detection). Existing consumers (FileExplorer) ignore the new fields.
- `/api/git/diff` unchanged: one combined HEAD→worktree patch per file,
  untracked files synthesized as added-file patches.

Client:
- Layout: header (branch · ↑ahead ↓behind · refresh · count) above a vertical
  split — file list (minmax ~34%) over diff pane (rest), like pi-web.
- File list: flat rows in git order — colored status letter (existing
  `--status-*` tokens; letter = worktree status if not clean else index
  status, per pi-web), path with dimmed directory prefix, `old → new` for
  renames (improves on pi-web, which drops oldPath). Selection highlight;
  click loads the diff below. Optional list/tree toggle
  (`cody:git-file-view`) ports `gitFileTree`'s path→tree builder if time
  allows; list view is the default and ships first.
- Diff pane: the DiffView extracted from FileViewer into
  `components/DiffView.tsx` (shared, not duplicated), showing the combined
  patch. Deviation from pi-web: no separate staged/unstaged stacked diffs —
  Cody shows one HEAD→worktree diff (staging state still visible via the
  two-letter codes in the list). Read-only: no stage/commit/discard (pi-web
  is read-only too).
- Refresh: manual button + `explorerRefreshKey` bumps (agent turn end) +
  window focus. No interval polling (deviation from pi-web's 8 s timer —
  matches Cody's event-driven idiom).
- Edge cases preserved from pi-web: selected file vanishing from status
  clears selection; "Not a git repository." empty state; binary-diff message;
  truncated flag surfaced; stale responses discarded via request sequence.

### Tasks panel (components/TasksPanel.tsx)

- Config file: `.cody/tasks.json` at the workspace root, schema
  `{ version: 1, tasks: [{ id, title, command, description?, group?, confirm? }] }`
  — pi-web's schema with per-field validation errors ported to
  `lib/workspace-tasks.ts` (pure, unit-tested; id regex
  `/^[a-z][a-z0-9.-]*$/u`, unique ids, hard-pinned version 1).
- `GET /api/tasks?cwd=` → `{ state: "missing" | "invalid" | "loaded", tasks?,
  error? }` (allow-listed cwd, like every file route).
- `POST /api/tasks/run` `{ cwd, taskId }` → server re-reads + validates the
  config, looks the task up **by id**, creates a terminal
  (`TerminalManager.create(cwd, title)`) and writes `command + "\n"` into the
  pty. Returns `{ terminalId }`. Security improvement over pi-web: the
  browser never sends a command string, so the API cannot run anything that
  is not in the on-disk config.
- UI (ported from tasksPanelElement): toolbar (Refresh · Open Terminal),
  status banners (missing/invalid/loaded/empty), groups in first-seen order,
  task cards (title, muted description, `code` command chip), Run button with
  single-in-flight guard, `window.confirm` for `confirm: true` tasks,
  "task no longer available" guard after refresh. On dispatch, the shell
  switches to the Terminal tab with the new terminal selected
  (`TerminalPanel` gains an optional `focusTerminalId` prop).
- Badge: `"!"` when the config exists but is invalid.

### Updates panel (components/UpdatesPanel.tsx)

Client-only consolidation of existing routes (no new server code):
- Cards: **Cody app** (`/api/app-update`: current vs available, copyable
  update command), **OMP runtime** (`/api/omp-version` +
  `/api/omp-update` check; copyable `omp update`, restart-sessions action),
  **Skills** (`/api/skills/check`: count + link into Settings → Skills).
- Deep management stays in Settings (no duplication) — the panel is the
  glanceable dashboard pi-web's Updates tab is, with copy/run affordances.
- Badge: number of sources reporting an available update; feeds the same
  state as the sidebar gear badge.

### Info panel (components/InfoPanel.tsx)

- Sections (mirrors pi-web's Info plugin, adapted): **Cody** (version,
  package, update one-liner), **OMP runtime** (installed version, binary
  origin), **Environment** (Node version, platform, agent dir), **Workspace**
  (cwd, repo root, branch, worktree flag). Read-only, renders instantly with
  whatever is loaded.
- `GET /api/info` returns the server-side facts (cody version, omp version,
  node version, platform, agent dir); workspace facts come from the git
  status already fetched client-side.
- **Copy diagnostics** button: plaintext block for bug reports (pi-web's
  `diagnosticsSummary` shape).

## Out of scope (deliberate)

- Machines/relays/multi-runtime, the plugin contribution system itself,
  session/project management differences — different product shape.
- Stage/unstage/commit from the UI (upstream is read-only as well).
- URL deep-links for panel/tool/diff selection.
- pi-web's 8 s git poll and its staged/unstaged dual diff fetch.

## Verification

- Unit tests: workspace-tasks config validation, porcelain v2/branch-info
  parsing additions, tree builder (if ported).
- `npm run typecheck`, `npm run lint`, `npm test` green.
- Adversarial review workflow over the full diff before final push
  (correctness, path-allow-listing on new routes, unmount/race guards, both
  themes, mobile).
