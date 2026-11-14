# Approvals: ACP permission prompts and HomeLabber in the chat

← Back to [AGENTS.md](../../AGENTS.md) · Full text of the sections AGENTS.md summarizes, moved verbatim; AGENTS.md keeps a short summary of each.

Sections in this file:
- Approval prompts: inline, and the agent owns the buttons
- HomeLabber approvals in the chat (`lib/homelabber-approval.ts`, `components/HomelabberApproval.tsx`, `/api/homelabber`)

### Approval prompts: inline, and the agent owns the buttons
- An ACP engine (`lib/harness/acp-session.ts`) can stop mid-turn and ask
  permission. The turn GENUINELY blocks on the answer, so the card is not a
  notification — it is the only way that turn ever finishes.
- Frames: `permission_request` {requestId, toolCall, options} adds a card,
  `permission_resolved` {requestId, outcome} removes it. Resolution is emitted
  for EVERY settlement — this browser, another tab, an abort, the turn ending,
  the session dying — so it is the single removal path.
  `respond_permission` answers; `{answered:false}` means it was already gone.
- **`get_state.pendingPermissions` is the reload path, and it is not optional.**
  The request event fired before the reloaded page existed, so state is the
  only place the open approval can still be found; without adopting it a
  blocked turn renders as a session that waits forever with nothing to click.
  It is adopted in `loadSession` (which needs no run in flight) AND in
  `reconcileAgentState` — there it must be read BEFORE the busy early-return,
  because a turn blocked on an approval is precisely a busy turn.
- **Render the agent's own options, in its order. `kind` is a styling hint,
  never an identity.** An agent can send five options with TWO sharing
  `kind: "allow_always"` ("Allow for session" and "Allow always") — ACP has no
  session-scoped kind. Deduping, grouping or reordering by kind deletes a real
  grant. `optionId` is the identity (and the React key), `name` is the label
  and is passed through untranslated: it is the only thing separating two
  options that share a kind.
- Styling says two things and no more: allow vs refuse (allow_once is the one
  filled primary; refusal is the quiet secondary, because refusing is safe),
  and durable vs one-shot (`*_always` carries a "Remembered" badge and is
  never the filled button, so a lasting grant cannot be a one-click accident).
- The double-click latch is a **ref**, not the `disabled` state: two clicks
  dispatched inside one task both read the pre-render state, and `disabled`
  only reaches the DOM after React commits — measured sending three answers
  through a state-only guard.
- `toolCall` is whatever the agent sent. One engine builds a different payload
  for a shell command than for a file edit, and `title`/`kind` are both
  optional, so every field is read defensively (`lib/permission-request.ts`)
  and an unrecognised kind renders verbatim rather than as a missing i18n key.
- **omp 18.4 - 18.18.2: the `ask` dialog is ONE form, not a series.** From 18.18.3
  this `ask` request is sent only for an EXTENSION's `ui.askDialog`. After the wrapper
  sends `set_ask_dialog`, omp emits `extension_ui_request` `method:"ask"` with
  `questions[]` (`recommended` is an INDEX; omp never sends an "Other" option,
  so the form always adds a free-text field). `components/AskDialogForm.tsx`
  renders every question together inside InputDock; the answer builder and
  validity rules live in `lib/ask-dialog.ts` (tested). omp THROWS on a bad
  answer set (wrong count/id, unknown or repeated label, single-select with
  more than one answer), which fails the agent's tool call — so the form keeps
  every draft valid by construction and Submit stays disabled until every
  question has a selection or non-blank custom text. Reply is
  `{answers:[{id,selectedOptions,customInput?}]}` in question order, or
  `{cancelled:true}`. Typing "Other" on a single-select clears the radio and
  picking a radio clears the text; multi-select keeps both. A reconnect replays
  the request with the same id, so the InputDock-keyed form keeps its draft.
- **omp 18.18.3+: the model's `ask` is one HTML `<form>` that RPC walks field by field** with ordinary `select` / `input` / `editor` requests (`select` "Which color?" [..., "Other (type your own)"]; notes are an `editor` titled "Notes", no timeout). Cody has no form dialog over RPC, so every engine walks. `lib/ask-walk.ts` (`createAskWalkTracker`: `observe`, `reply`, `withdrawn`) marks each walk-step `select` with a `walk` view (`question`, `context`, `rows`, `radio`, `selected`, ...). `useAgentSession` feeds every dialog through the tracker; a tick keeps the dialog up in a "settling" state (`ASK_WALK_SETTLE_MS`, 5 s fallback) because omp asks again under a new request id. `InputDock` keys a walk card by `walk:<context>\n<question>` so a whole checkbox field is one card that keeps its focus and scroll position. `ExtensionDialog` shows radios (`role="radio"`, a dot on the chosen row) and checkboxes (`role="checkbox"`, `aria-checked`), a hint line, "Done" as the primary button (it answers with omp's exact Done row) and an "Other" row that shows the line typed behind it. Every answer is the exact row string omp offered; the screen wording is localised, omp's text is not. A dialog counts as the model's own (`fromAsk`) when it arrives while the `ask` tool is running and is not a tool approval (`dialogBelongsToAsk`).
- **omp 18.20.0 frames** (recorded from a real rpc-ui child; `lib/ask-walk.test.mjs` replays them). Title = `"<form text>\n\n[(N selected) ]<question>"`: paragraphs, `- ` / `N. ` list lines, `pre` text verbatim and tables as `a | b` rows come first, the question is the LAST line, and `(N selected) ` sits at the start of that last line, only when N > 0 (`parseAskWalkTitle` → `{context, question, selected}`; `isAskSelectedTitle` tests the last line). 18.19 and older send the question alone and no form text.
  - Radio: `selectionMarker:"radio"`, `initialIndex` = the row to show as chosen (first row, or the previous pick after a blank "Other"). Picking a row answers the field; there is no `checkedIndices`.
  - Checkbox: `selectionMarker:"checkbox"`, `checkedIndices` = every ticked row, `markableCount` = how many leading rows are boxes (labels plus Other when there is one; the Done row comes after). Picking a box row toggles it and omp asks again under a new id; picking Other opens an `input` (or clears it when already ticked); picking Done finishes. Done is absent while a required field has nothing ticked. Preselected boxes are already in the first frame's `checkedIndices`.
  - Cody never guesses ticks on 18.20: `computeMarked` takes them from `checkedIndices` (the optimistic toggle in `reply()` only bridges the moment until omp's next frame). Rows at or beyond `markableCount` (Done or any extra row) are plain actions (`kind: "action"`, no box). A `select` with no `selectionMarker` (18.19, 18.8) takes the unchanged mirror path: ticks remembered from the user's own taps, `(N selected) ` at the title start.
  - Any `select` that carries `selectionMarker` is treated as a walk step, also from a non-ask extension (marks drawn, the title's LAST line is the question). omp only sets the marker in the ask tool and its own TUI.
  - Omp's frames do not carry the typed Other text: after a page reload the Other row shows ticked without its text.
- **The dock shows the whole prompt.** `extensionPrompt(request, fromAsk)` (lib/extension-title.ts) returns `{headline, details, ask, inBody}`. For an ask the header is the question (wraps to 2 lines; `HEADER_LINE_CHARS = 34`, CJK counts double), the form text is `details` (shown in full, `pre-wrap`, `overflow-wrap: anywhere`, `data-testid="ask-context"`), and the question repeats in the body (`data-testid="ask-question"`) only when there is form text or it is longer than the header line. Any other extension dialog keeps the one-line header + `splitExtensionTitle`. The dock has exactly ONE scroller (`scrollRef` in InputDock): `max-height` is `ASK_SCROLL_MAX` = `max(120px, min(58% of --app-height - 56px, --app-height - 340px))` for an ask and `calc(40vh - 56px)` otherwise; the rows have no scroller of their own. Cancel/Done live in a footer inside that scroller: `position: sticky; bottom: -3px; margin: -4px -4px 0; padding: 10px 4px 2px` with a transparent-to-`var(--bg)` fade (`-3px` lets the solid band reach the clip edge: at fractional device pixels a row's text would peek under it, and the footer is as wide as the scroller so a row's focus ring cannot show beside it). `scroll-padding-bottom: 64px` keeps focused rows above the footer; ArrowUp/ArrowDown call `scrollIntoView({block: "nearest"})` (focus uses `preventScroll`); a new question scrolls back to the top.
- **The model's `ask` is `write xd://ask`** on engines that mount it under `xd://` (seen on omp 18.19.0 and 18.20.0; only Cody's local-model profile sets `tools.xdev: false` and keeps a plain `ask`). `tool_execution_start` then carries `toolName: "write"`, `args.path: "xd://ask"`. `isAskToolCall(toolName, args)` (lib/ask-walk.ts) is the one test (`ask`, or `write` to `xd://ask`, trimmed and case-insensitive); `RunningToolInfo.ask` is set from it, and `askToolRunning` in `useAgentSession` is true for a running tool with `ask === true`, or when the agent is running AND `askCallPending(messages)` (the last assistant message holds an ask tool call with no result yet). The second half is the reload path: a page opened mid-ask never sees `tool_execution_start`. It is gated on `agentRunning` so the transcript of a cut-off run never labels a later dialog as the ask's. NEVER compare `toolName === "ask"` alone; the transcript card uses `askCallInput` (below).
- **A message sent while an ask is open withdraws it (omp 18.14.2+).** omp sends a `cancel` for the open dialog and the tool result is "Ask interrupted by message". The tracker drops the walk on that `cancel`; `InputDock` shows a warning (`inputDock.askWithdrawn`) on engines where `askWithdrawnByMessage(version)` is true (version via `hooks/useEngineVersion.ts`, unknown version = no warning). A half-typed answer is not kept.
- **`secret: true` inputs (omp 18.13.2+).** An `input` request with `secret: true` renders as `type="password"` with `autoComplete="new-password"`, autocapitalize/autocorrect/spellcheck off and the `data-1p-ignore` / `data-lpignore` / `data-bwignore` hints. Only extensions issue it today (omp refuses secret provider logins over RPC). Types: `secret?: boolean` on the input request in `lib/types.ts` and `lib/pi-types.ts`.
- Text fields (input / editor, masked or not) take the focus when the dock opens (`data-input-autofocus`).
- **The `ask` transcript card.** An ask call renders its answers as question/answer rows (components/AskResultPanel.tsx, pure helpers in lib/ask-result.ts) instead of the raw args JSON. The call is a plain `ask` or `write xd://ask` (omp 18.19+): `askCallInput(toolName, input)` is the one test and returns the ask's own args, or null for any other call. For the write they are the JSON text in `content` (the write's own `i` stands in as the intent when the content has none; `{}` while a streaming call's JSON is still cut off). MessageView draws the header label `ask` and the preview from it, and the unwrapped args as the JSON of an errored or cancelled card. `askAnswersFromDetails` normalises omp 18.19+ `details.answers/notes/timedOut` (one HTML form in `args.html`) and omp 18.8 `details.question|results` (`args.questions[]`), and unwraps a `write xd://ask` result, whose details nest the ask's own as `{xdev: {tool: "ask", mode, args, tier, inner}}` (`inner` exists only when the ask ran: a help read or a failed dispatch has none). A `<input type="password" name=…>` field found in `args.html` has its answer shown as bullets (max 12), as omp's own TUI does; the result text (which carries the raw JSON) is hidden while the panel shows. History loads keep a BOUNDED whitelist of ask details (lib/session-reader.ts stripToolResultDetails → `keepAskToolResultDetails`: ≤50 rows, strings ≤4000 code points); extend that whitelist if the panel ever reads more. The history message has no path, so a `write` result is recognised by its details (`isAskXdevDetails`: `xdev.tool === "ask"` with an `inner`) and keeps `{xdev: {tool: "ask", inner: <that whitelist>}}`, none of the envelope (its `args` repeat the whole form). An errored or cancelled ask keeps the plain args + result text. Header preview: `askCallPreview` (first 18.8 question, else `i`, else the form's tag-stripped text). Tests replay real session entries of omp 18.20.0 and 18.19.0 (`lib/fixtures/omp-*-ask-xdev-entries.json`).

### HomeLabber approvals in the chat (`lib/homelabber-approval.ts`, `components/HomelabberApproval.tsx`, `/api/homelabber`)
- **What it is.** HomeLabber (the owner's homelab admin server, an MCP server
  named `homelabber`) answers a tool call that needs his Face ID with a PENDING
  request instead of acting; the HomeLabber app pings his phone, and after he
  approves, HomeLabber runs the stored action itself. The agent follows with
  `approval_wait {id}` until the request settles (`pending → approved →
  executing → executed`, or `failed`, `denied`, `expired`, `cancelled`).
  This is NOT the ACP approval prompt above: nothing here blocks the turn, no
  button answers it, and Cody never approves anything. The card only shows the
  state and links to where he approves.
- **The pending answer arrives flagged as an error** (`ok:false` becomes the
  MCP `isError`, so omp prefixes `Error: `), and so do `failed`, `denied`,
  `expired` and `cancelled`. `ToolCallBlock` asks `useApprovalCard(block,
  result)` first: a recognised approval draws its own tone (warning while
  waiting or expired, accent while running, success when done, error for
  denied or failed, neutral when cancelled or lapsed) and is never
  auto-expanded as a failure. Everything else, a refusal such as "approvals
  are paused" included, keeps the red error card. The raw JSON and result stay
  one chevron away.
- **Recognising the call** (`homelabberCall`): `mcp__homelabber_<tool>` (omp),
  `mcp__homelabber__<tool>` (Claude Code), and omp's `write` to
  `xd://mcp__homelabber_<tool>` with the JSON arguments in `content` — omp
  mounts MCP tools as `xd://` devices, so that is the usual spelling in a
  Cody chat. Any HomeLabber tool can be gated, so the tool id is no allow-list.
- **Reading the answer** (`parseHomelabberApproval`): live `structuredContent`
  is authoritative, including nested device results. Reloaded transcripts retain
  flattened data JSON; its outer object is parsed without treating command output
  or prose as an approval. Untrusted fenced data must be one complete JSON object.
  Diagnostic section output is never treated as an approval. Shapes:
  pending `data.approval = {id, status, expiresAt}`; `approval_wait`
  `data = {id, status, expiresAt?, items[{seq, tool, status, message,
  changeId}]}`. Any `waitSeconds` is fine — the answer's `status` decides,
  never the arguments. An id is `[A-Za-z0-9_-]{8,64}` because it goes into URLs.
  A replay of a gated call may carry a later durable state including `uncertain`;
  list tools are not request cards. `uncertain` means inspect state, never repeat.
- **`items[].data` is never read.** HomeLabber returns a tool's own result
  data once in that field (an issued SSH certificate, say). The parser does not
  copy it, so no card can print a secret; the expanded raw result shows what
  any tool's result shows.
- **One state per request id, shared by context.** `buildApprovalIndex`
  folds every HomeLabber call into the latest `ApprovalState` per id (a request
  only moves forward: a late `pending` poll never undoes `approved`), and
  `HomelabberApprovalProvider` (ChatWindow, around the transcript) publishes it
  with the SAME identity until a request really changes — a chat with no
  approvals, nearly every chat, never re-renders for it. The gated call's card
  follows the index; an `approval_wait` poll only labels itself (a header chip)
  with what it saw, so five polls are not five cards. It is a context, not a
  prop, because `MessageView`'s memo re-renders a message only for ITS OWN tool
  results and the poll that says "done" lives in a later message. The subagent
  transcript has its own provider, scoped to its own rows; the sidebar has none.
- **Agent procedure:** `lib/omp/extensions/cody-homelabber-gate.ts` is loaded by
  Cody on main omp launches and inherited by delegated omp sessions. Its
  `before_agent_start` gives each agent the same gate procedure as one hidden
  message (`cody-gate-guidance`, added once per live context, never a
  system-prompt change: docs/agents/disk.md "Model-only notes").
  Caller tokens may be shared; listing a grant is not proof of agent ownership.
  Guidance grants no authority and does not override Principle 0.
- **The row** (`ApprovalStatusRow`, under the header, outside the collapsible
  panel): a lock, "Waiting for your Face ID in HomeLabber", a live countdown to
  `expiresAt` (one 1 s ticker per WAITING card, nothing else ticks), "Open
  HomeLabber" → `homelabber://approve/<id>` (opens the app when Cody is open on
  the phone; filled on touch devices, outlined elsewhere) and "Details in HomeLabber"
  → `<base>/approvals/<id>` in a new tab. When `expiresAt` passes with no later
  answer the card flips ONCE (a single timer) to a neutral "approval window has
  closed": Cody cannot know whether he answered after the agent stopped
  polling, so only HomeLabber's own `expired` ever says expired.
- **Hidden activity** keeps the gated call (its raw result is an error, which
  that mode already shows) and hides quiet polls like any other call.
- **A folded turn stays open while an answer is owed.** Once a turn ends, its
  tool calls fold into the collapsed "Process details" group, which would bury
  a request still waiting on his Face ID together with the link that answers
  it (seen in the first browser pass: a settled chat showed the user message
  and one closed group). `ProcessDetailsGroup` takes `waitingUntil`
  (`latestWaitingDeadline`: the latest `expiresAt` among the group's requests
  whose state is still `pending`, null when none or when no epoch is known)
  and opens while that is in the future. It STAYS open when the window closes
  or he answers — the card changing under a reader is the news, a group
  vanishing is not — until he toggles it or the page reloads; a reload folds
  it again, because a closed window holds nothing open. A manual toggle always
  wins.
- **Trap — "has the deadline passed" must not re-arm itself.**
  `useDeadlinePassed` keeps the last time it looked in state and arms ONE
  timer for the deadline (`deadlineCheckDelay`, null once the look is past the
  deadline). The first version re-read the clock in an effect keyed on that
  same state, so a card whose window had already closed set state on every
  run and React threw "Maximum update depth exceeded" — no unit test and no
  static render shows an effect loop; a real browser's console did.
- **The base URL** is `GET /api/homelabber`: `CODY_HOMELABBER_URL`, else the
  ORIGIN of the `homelabber` server in omp's user-level `mcp.json` (omp only;
  never headers, path, query or userinfo — an MCP URL can itself be a
  credential), else `https://homelabber.nateshome.net`. An IP address or
  `localhost` is rejected (`homelabberBaseFromMcpUrl`): it is a
  machine-to-machine address, not where his phone is signed in. **Trade-off:**
  that default is the owner's own hostname, chosen by him, against "never ship
  the owner's environment" above. It is only reached by a chat that already has
  a `homelabber` MCP tool call, and `CODY_HOMELABBER_URL` (or a hostname-based
  MCP URL) replaces it, but another install with a HomeLabber of its own MUST
  set one of those or its backup-code link would point at the owner's server.
- **Trap — MCP timeout.** omp gives every MCP `tools/call` a 30 s deadline
  (`OMP_MCP_TIMEOUT_MS`, else the server's `timeout` in mcp.json, default
  30 000 ms; `src/mcp/timeout.ts`, applied by `transports/http.ts` to the whole
  POST), so a 45–50 s `approval_wait` dies with "Request timeout after
  30000ms". HomeLabber's `approval_wait` therefore takes `waitSeconds` 0..28
  (default 25). Cody does not touch MCP configuration.
- Strings are `homelabberApproval.*` in all three locales. Tests:
  `lib/homelabber-approval.test.mjs` (parser, index, links, base rules),
  `components/HomelabberApproval.test.mjs` (the card),
  `lib/homelabber-route.test.mjs` (the route).

