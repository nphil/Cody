# Cody HTTP + streaming API

Status: **contract document for consumers outside this repository.** The first
such consumer is the native Android client (`docs/android.md`), whose
`RemoteBackend` is written against this surface.

Everything below was verified against a running server; the examples are real
responses with ids and hostnames replaced. Where a shape is passed through from
the underlying agent engine rather than owned by Cody, it is labelled
**Incidental** and you should treat it as unversioned.

## Stability

| Label | Meaning |
| --- | --- |
| **Stable** | Cody owns this shape. Fields may be added; existing fields will not change meaning or disappear without a migration path. |
| **Incidental** | The shape originates in the active engine (or in a passthrough library) and Cody only forwards it. Parse defensively, ignore unknown fields, and never branch on the absence of one. |

Two rules make the difference concrete:

- The **envelope** of every response is Stable — status code, the error shape,
  and the top-level keys named here.
- The **agent event vocabulary** on the SSE stream is Incidental in its
  entirety, except for the few frames documented as Stable below. It is the
  engine's vocabulary; a different engine emits a different subset.

There is no `/api/version` and no API version prefix. `GET /api/info` reports
the server build, and `capabilities` there is the supported way to discover what
the deployment can actually do.

## Authentication

Three credentials are accepted. All of them resolve through one function
(`lib/auth/guard.ts`), so every route and both WebSocket endpoints accept any of
them identically, and all of them attach the same account identity — including
session ownership.

| Credential | Header / mechanism | Intended client |
| --- | --- | --- |
| Session cookie | `Cookie: cody_session=<signed token>` | browsers |
| **Personal access token** | `Authorization: Bearer cody_pat_<secret>` | native and scripted clients |
| HTTP Basic | `Authorization: Basic <base64 cody:CODY_PASSWORD>` | health probes, pre-account scripts |

Authentication is **required** once any account exists, or `CODY_PASSWORD` is
set, or `CODY_REQUIRE_ACCOUNTS=1` (the container entrypoint sets this). A bare
local `npm run dev` with none of those is open, and `GET /api/accounts/state`
reports which situation you are in.

### Unauthenticated responses — Stable

An unauthenticated request to anything under `/api/` gets `401` and this body:

```
HTTP/1.1 401 Unauthorized
cache-control: no-store

{"error":"Authentication required","code":"auth_required"}
```

Two deliberate properties:

- **There is never a `WWW-Authenticate` header.** A challenge would summon the
  browser's native Basic dialog over the login screen. Do not wait to be
  challenged; send your credential proactively.
- Unauthenticated **HTML** navigation redirects instead: `307` to
  `/login?next=<encoded path>`. Only `/api/**` and `/_next/**` answer JSON.

An invalid, revoked, expired or deleted-account credential is indistinguishable
from no credential at all — the same `401 auth_required`. A client should treat
any `401` on `/api/**` as "this credential is dead, re-authenticate", and not
try to parse a reason out of it.

Public paths that never require a credential: `/login`,
`/api/accounts/state`, `/api/accounts/login`, `/api/accounts/signup`, the PWA
manifest and icons, and `/_next/static`.

### Personal access tokens

A token is `cody_pat_` followed by 43 URL-safe base64 characters (32 random
bytes). It belongs to exactly one account, carries that account's full
authority, and is **shown once, at creation** — the server stores only a
SHA-256 digest, so a lost secret is revoked and replaced, never recovered.

Revocation works two ways:

1. `DELETE /api/accounts/me/tokens/<id>` removes that one token.
2. Anything that bumps the account's `tokenVersion` — notably a password change
   — invalidates every token **and** every session cookie for that account at
   once. This is the same mechanism the cookie uses; tokens are not a side door
   around it.

Minting a token requires an *interactive* credential (cookie or Basic). A
bearer credential is refused with `403 bearer_forbidden`, because a leaked token
that could issue a successor would outlive its own revocation and make the
revoke button a lie. Listing and revoking do work with a bearer, so a native
client can show and forget its own token.

Recommended onboarding for a native client, which needs no web detour:

```bash
# 1. sign in, keep the cookie in memory only
curl -sS -c jar -X POST https://cody.example/api/accounts/login \
  -H 'content-type: application/json' \
  -d '{"username":"nitin","password":"…"}'

# 2. mint a token named after the device
curl -sS -b jar -X POST https://cody.example/api/accounts/me/tokens \
  -H 'content-type: application/json' -d '{"name":"Pixel tablet"}'
# → {"token":{"id":"…","name":"Pixel tablet","preview":"xTedAU",
#     "createdAt":"…","lastUsedAt":null},
#    "secret":"cody_pat_xTedAUIjoU5MWjH4HKJXDUTLZfF6H8_hXHnDUatPRL4"}

# 3. persist `secret`, discard the cookie, use bearer from here on
curl -sS -H "Authorization: Bearer $SECRET" https://cody.example/api/accounts/me
```

### Cross-origin and WebSocket credentials

Browser cross-site API requests are rejected with `403` when the request
carries an `Origin` or `Sec-Fetch-Site` header that does not match. A client
that sends neither header (any non-browser client) is not subject to that check.

The WebSocket upgrade gate is stricter, and the rule matters for native clients:

| Handshake | Result |
| --- | --- |
| `Origin` matches the server origin, any credential | upgrade proceeds |
| `Origin` present but foreign, any credential | `403 Forbidden` |
| **no `Origin`, `Authorization: Bearer …`** | **upgrade proceeds** |
| no `Origin`, cookie or Basic | `403 Forbidden` |
| any origin, no valid credential | `401 Unauthorized` |

Browsers always send `Origin` on a handshake, so a missing one means a
non-browser client. Ambient credentials stay refused there because a cookie
rides along on a cross-site upgrade the page never consented to; a bearer token
is never attached automatically, so it cannot be replayed from someone else's
page. Native clients therefore **must** authenticate sockets with a bearer
token and **must not** send an `Origin` header.

## Error conventions — Stable

Failures are JSON: `{"error": "<human-readable message>"}`, plus
`"code": "<machine-readable token>"` wherever a client might reasonably branch.
Branch on `code`, never on `error`, which is prose and is not localized.

Codes you will meet across the surface:

| Code | Status | Meaning |
| --- | --- | --- |
| `auth_required` | 401 | no valid credential |
| `no_accounts` | 409 | account route on an instance with no accounts at all |
| `admin_required` | 403 | route needs `role: "admin"` |
| `bad_credentials` | 401 | wrong username or password on login |
| `bad_password` | 403 | wrong current password on a password change |
| `signup_disabled` | 403 | `CODY_ALLOW_SIGNUP=0` and a human account already exists |
| `env_managed` | 400 | mutating the `CODY_PASSWORD` bootstrap account's password |
| `bearer_forbidden` | 403 | a bearer credential tried to mint a token |
| `token_limit` | 403 | 32 tokens per account already exist |
| `invalid_token_name` | 400 | empty, over 60 characters, or containing control characters |
| `token_not_found` | 404 | no such token on **this** account |
| `access_denied` | 403 | path outside the workspace allow-list |
| `cwd_must_be_absolute`, `path_must_be_absolute` | 400 | a path parameter was relative |
| `directory_not_found`, `not_a_directory`, `file_not_found`, `not_a_file` | 404 / 400 | filesystem shape mismatch |
| `invalid_action` | 400 | unknown `action` in a mutation body |
| `invalid_json`, `invalid_body` | 400 | unparseable request body |
| `internal_error` | 500 | unexpected server failure |

Two conventions that are easy to get wrong:

- **A resource you may not see answers `404`, not `403`.** Someone else's
  session is indistinguishable from a session that does not exist. This is
  deliberate; do not treat `404` as "definitely deleted".
- Most routes send `Cache-Control: no-store`. `GET /api/sessions` additionally
  sends a strong `ETag` and honours `If-None-Match` with `304` — the intended
  way to poll the session list cheaply.

## Session ownership

Every agent session has at most one owning account, stamped when the session is
created or imported.

- A session **with** an owner is visible only to that owner.
- A session with **no** owner — created before accounts existed, from a
  terminal, or by a since-deleted account — is visible to everyone.

Ownership is enforced on read and on write, so a session list is already
filtered and a direct fetch of an invisible session is a `404`. Ownership is not
affected by which credential you used.

## `GET /api/info` — Stable

Read-only runtime facts. No workspace, no path checks, cheap.

```json
{"codyVersion":"0.7.1","ompVersion":"17.3.5","nodeVersion":"v22.23.2",
 "platform":"linux x64","agentDir":"/data/agent",
 "harness":{"id":"omp","name":"OMP runtime"},
 "capabilities":{"liveSessions":true,"models":true,"skills":true,"plugins":true,
                 "mcp":true,"nativeSettings":true,"updates":true,"chatExtras":true},
 "engine":{"id":"omp","displayName":"OMP runtime","shortName":"OMP","experimental":false},
 "platformInfo":{"desktop":false}}
```

`capabilities` is the discovery mechanism: **gate your UI on it**, exactly as
the web client does. A deployment running a lesser engine reports fewer
capabilities and the corresponding routes will refuse or return empty. The set
of capability keys grows over time; an unknown key means a newer server, and a
missing key must be read as `false`.

`ompVersion` is a runtime probe of the engine binary and is `null` when absent.
Error: `500` with `code: "info_unavailable"`.

## Accounts

| Route | Method | Auth | Notes |
| --- | --- | --- | --- |
| `/api/accounts/state` | GET | public | what flows exist; safe to call signed-out |
| `/api/accounts/login` | POST | public | `{username, password}` → `Set-Cookie` |
| `/api/accounts/signup` | POST | public | `{username, fullName?, password}`; first human account becomes admin |
| `/api/accounts/logout` | POST | any | clears the cookie; not on the public list, so a signed-out call is `401` |
| `/api/accounts/me` | GET, PATCH | any | read profile (includes `theme`); `PATCH {fullName?, theme?}` — the theme is a `lib/theme-catalog` id, saved per account so it follows the user to every device |
| `/api/accounts/me/password` | POST | any | `{currentPassword, newPassword}`; bumps `tokenVersion` |
| `/api/accounts/me/avatar` | POST, DELETE | any | upload / clear avatar image |
| `/api/accounts/avatar/<id>` | GET | any | an account's avatar bytes |
| `/api/accounts/me/tokens` | GET, POST | any / non-bearer | list / mint access tokens |
| `/api/accounts/me/tokens/<id>` | DELETE | any | revoke one token |
| `/api/accounts/users` | GET, POST | admin | roster; create an account |
| `/api/accounts/users/<id>` | PATCH, DELETE | admin | role change; delete |

All **Stable**.

### `GET /api/accounts/state`

```json
{"authRequired":true,"firstRun":false,"signupAllowed":true,"user":null}
```

`firstRun: true` means no account exists at all and the login screen should
present first-run setup. `user` is the `PublicUser` when the request carried a
credential, else `null` — which makes this the cheapest "am I signed in" probe,
and the only one that is safe to call without a credential.

### The `PublicUser` shape — Stable

Returned by `login`, `signup`, `state`, `accounts/me` and the admin roster. It
never contains a password hash.

```json
{"id":"7ab8b0fc-…","username":"nitin","fullName":"Nitin Philip","role":"admin",
 "envManaged":false,"hasAvatar":false,"avatarKey":null,
 "createdAt":"2026-08-18T04:25:49.319Z"}
```

`role` is `"admin"` or `"member"`. `envManaged` marks the `CODY_PASSWORD`
bootstrap account, whose password lives in the container environment and cannot
be changed through the API (`400 env_managed`). `avatarKey` changes on every
upload, so `GET /api/accounts/avatar/<id>?v=<avatarKey>` is immutably cacheable.

`GET /api/accounts/me` is the recommended connectivity-and-identity check for a
native client: it is the cheapest authenticated route, does no session or engine
work, and returns the account behind whatever credential you sent.

### `GET /api/accounts/me/tokens`

```json
{"tokens":[{"id":"eb212e62-…","name":"Pixel tablet","preview":"xTedAU",
            "createdAt":"2026-08-18T04:25:55.673Z",
            "lastUsedAt":"2026-08-18T04:26:06.839Z"}]}
```

`preview` is the first six characters of the secret — enough to tell two tokens
apart in a list, useless as a guess. `lastUsedAt` is recorded at five-minute
resolution (verification runs on every request; the write does not) and is
`null` until first use. **The secret never appears here.**

### `POST /api/accounts/me/tokens`

Body `{"name": "<1–60 characters, no control characters>"}`. Returns `201`:

```json
{"token":{"id":"…","name":"Pixel tablet","preview":"xTedAU","createdAt":"…","lastUsedAt":null},
 "secret":"cody_pat_…"}
```

`secret` appears in this response and never again. Errors: `400
invalid_token_name`, `403 bearer_forbidden`, `403 token_limit`.

### `DELETE /api/accounts/me/tokens/<id>`

`{"success":true}`, or `404 token_not_found` — which is also the answer for a
token id that belongs to a different account, so the route cannot be used to
probe other accounts. Revocation takes effect on the next request.

## `GET /api/engines` — Stable

The engine roster, in one authenticated round trip.

```json
{"engines":[{"id":"omp","name":"OMP runtime","shortName":"OMP",
             "tagline":"…","experimental":false,"installed":true,
             "installing":false,"version":"17.3.5","installable":true,
             "authHint":null,"binaryName":"omp"}],
 "active":"omp","onboarded":true,"setupDone":true,"canManage":true}
```

`canManage` mirrors `role === "admin"`; the install/select routes
(`/api/engines/install`, `/api/engines/install/events`, `/api/engines/select`,
`/api/engines/setup-complete`, `/api/engines/updates`) are admin-only. The
roster itself — the set of engine ids — is **Incidental**: engines come and go.

`/api/engines/updates` rows also carry `latestBeyondVerified` /
`installedBeyondVerified`: whether that version's MAJOR is past the newest one
this Cody build was audited against, so clients can warn that a brand-new
engine major may hold features Cody does not surface yet.

### `GET /api/engines/changelog?id=omp` — Incidental

Any signed-in user. Release notes for an engine: while the npm registry knows a
newer version than the installed binary the entries come from the **latest
published package** (fetched from the registry tarball, cached per version) —
that is what an update would install — otherwise from the installed package's
own `CHANGELOG.md`.

```json
{"entries":[{"heading":"[18.0.0] - 2026-08-22","body":"…","isNew":true}],
 "reason":null,"source":"latest","updatePending":true,
 "installedVersion":"17.4.2","latestVersion":"18.0.0"}
```

`isNew` marks sections strictly newer than the installed version. `source` is
`"installed"` when up to date — or when the registry fetch failed and the
installed file is the honest fallback; `source:"installed"` together with
`updatePending:true` is the payload's own admission that the pending release's
notes are missing, and is what clients should key any "stale" caveat off.
`entries` is `null` with a `reason` when no changelog is available at all.

## Sessions

| Route | Method | Notes |
| --- | --- | --- |
| `/api/sessions` | GET | list; ownership-filtered; `ETag` + `304` |
| `/api/sessions/<id>` | GET | transcript, tree and context |
| `/api/sessions/<id>` | PATCH | `{name}` — rename |
| `/api/sessions/<id>` | DELETE | delete session and artifacts |
| `/api/sessions/<id>/state` | GET | `{running}` (+ `state` when live) |
| `/api/sessions/<id>/context` | GET | context window accounting |
| `/api/sessions/<id>/export` | GET | transcript export |
| `/api/sessions/<id>/auto-name` | POST | name a session: engine title, else a short model-written name, else a first-message truncation |
| `/api/sessions/<id>/subagents` | GET | subagent roster |
| `/api/sessions/<id>/subagents/<subagentId>` | GET | one subagent's transcript |
| `/api/sessions/<id>/media` | GET | attachments referenced by the transcript |
| `/api/sessions/<id>/entries/<entryId>/thinking` | GET | expanded reasoning for one entry |
| `/api/sessions/<id>/archive` | POST | archive the session and its artifacts |
| `/api/sessions/import` | POST | `{fileName, content}` (≤10 MB); the imported session becomes yours |

### `GET /api/sessions` — Stable envelope

```json
{"sessions":[{"path":"/data/agent/sessions/…jsonl","id":"01a00e5c-…",
              "cwd":"/data/home/Cody","name":"Cody",
              "created":"2026-08-17T06:15:28.558Z",
              "modified":"2026-08-18T04:22:19.384Z",
              "messageCount":444,"firstMessage":"…",
              "projectRoot":"/data/home/Cody"}],
 "runningSessionIds":[]}
```

`runningSessionIds` is the subset with a live agent process and changes on every
turn, which is why the response is `no-store`; poll with `If-None-Match`.

Engines that keep their transcripts privately cannot supply `messageCount` or
`firstMessage`; those degrade to `0` and the title rather than being guessed.
Do not compute anything load-bearing from them.

### `GET /api/sessions/<id>` — Stable envelope, Incidental contents

Top-level keys: `sessionId`, `filePath`, `info`, `leafId`, `tree`, `context`.

- `info` is the same row shape as a `sessions` list entry.
- `tree` is the branch-navigation tree: nodes of `{entry, children}` where
  `entry` carries at least `{type, id, parentId, timestamp}`. **Incidental** —
  entry types are the engine's transcript vocabulary.
- `context` is `{messages, entryIds, thinkingLevel, model, todoPhases}`;
  `messages` is the rendered transcript. **Incidental.**
- `leafId` is the current head entry, which is what a client resumes from.

`404` when the session does not exist *or* is owned by another account.

## Agent and the event stream

| Route | Method | Notes |
| --- | --- | --- |
| `/api/agent/new` | POST | create a session, optionally send the first prompt |
| `/api/agent/<id>` | POST | send a command to a session |
| `/api/agent/<id>` | GET | `{running}` (+ `state` when live) |
| `/api/agent/<id>/events` | GET | **SSE stream** |
| `/api/agent/<id>/bash-output` | GET | tail a long-running command's output |
| `/api/agent/<id>/display` | GET, POST | the preview/display request for a session |
| `/api/agent/running/events` | GET | SSE: which sessions are running |

### `POST /api/agent/new`

Body `{cwd, type, message?, …}`. `type: "prompt"` creates the session and sends
the first message; `type: "ensure_session"` only creates the runtime, which is
what you want before querying available commands.

```json
{"success":true,"sessionId":"01a01320-5f8a-7000-b61a-6c288d285aa7","data":null}
```

`sessionId` is the engine's real id and is the id every other route takes. Note
that some engines only reveal their true id once the first turn starts; Cody
re-keys the session and carries ownership across the rename, so **re-read the id
from the event stream rather than assuming the one you were handed is final.**

Errors are `400` with a `code`: `invalid_json`, `command_type_required`, or an
engine-supplied code (`rpc_command_failed`, `session_busy`, `unsupported`, …).
The engine-supplied set is **Incidental**.

### `POST /api/agent/<id>` — Stable envelope, Incidental commands

Body must be a JSON object with a non-empty string `type`. The response is
`{"success":true,"data":<command result>}`.

The command vocabulary (`prompt`, `interrupt`, `get_state`, `set_model`,
`set_thinking_level`, `reload`, `set_session_name`, `get_session_stats`, …) and
every `data` payload are the **engine's** RPC vocabulary, forwarded verbatim.
Treat the whole of it as Incidental; discover what a session supports by
creating it with `ensure_session` and asking, rather than hardcoding a list.

A `type: "prompt"` command takes a workspace checkpoint before the agent runs,
so "restore to before that message" works. Checkpoint failure never blocks a
send.

### `GET /api/agent/<id>/events` — SSE

```
HTTP/1.1 200 OK
content-type: text/event-stream
cache-control: no-cache

data: {"type":"connected","sessionId":"01a01320-5f8a-7000-b61a-6c288d285aa7","running":false}

```

Wire format, all **Stable**:

- Every frame is a bare `data: <json>\n\n`. **There are no named SSE events**,
  so `EventSource.onmessage` (or the equivalent) sees everything; do not
  register per-type listeners.
- A comment line `:\n\n` arrives every 30 seconds as a heartbeat. Ignore it —
  but do use it as your liveness signal, and do not set a read timeout below
  ~60 seconds.
- The **first** frame is always
  `{"type":"connected","sessionId":"<id>","running":<bool>}`, sent before the
  engine is spawned. It means "the stream is open", not "the agent is ready":
  a cold start takes seconds, and commands sent immediately afterwards queue
  behind the same startup lock rather than failing. `running` is the engine's
  actual turn state at connect time — a freshly resumed session is always
  `false`, so a client that believed a turn was in flight must treat it as
  lost rather than keep waiting (additive field: absent means unknown, infer
  nothing).
- `{"type":"notice","level":"error"|"warn"|"info","message":"…"}` reports
  failures that are not tied to a message, including a failed engine spawn.
- Opening this stream **starts the session** if it is not already running. It is
  not a passive observer.
- Backpressure: while a consumer is behind, consecutive `message_update` frames
  collapse to the latest one. This is safe because each carries the full
  accumulated message rather than a delta — so **always replace, never append**,
  on `message_update`. Control frames are never dropped.

The event `type` vocabulary beyond `connected` and `notice` is **Incidental** —
it is the engine's. For reference, what the web client currently handles:

`agent_start`, `agent_end`, `prompt_result`, `prompt_error`, `command_output`,
`message_start`, `message_update`, `message_end`, `tool_execution_start`,
`tool_execution_update`, `tool_execution_end`, `thinking_level_changed`, `model_changed`,
`config_update`, `available_commands_update`, `todo_reminder`,
`todo_auto_clear`, `auto_retry_start`, `auto_retry_end`,
`retry_fallback_applied`, `retry_fallback_succeeded`,
`auto_compaction_start`, `auto_compaction_end`, `subagent_lifecycle`,
`subagent_progress`, `subagent_event`, `host_tool_call`, `host_uri_request`,
`extension_ui_request`.

Ignore unknown types silently — that is the only forward-compatible policy, and
a lesser engine simply never emits most of them. Two shapes worth knowing
because they are easy to mishandle: `agent_end` with `isTerminal: false` means
an async delivery will resume the run, so do not clear the running state; and
`message_end` may arrive for a message you already loaded from the transcript,
so key on entry id rather than appending blindly.

## Files

Paths are **absolute filesystem paths encoded as URL segments**: the file
`/data/home/Cody/docs/api.md` is
`/api/files/data/home/Cody/docs/api.md`. Every path is checked against the
workspace allow-list; outside it is `403 access_denied`.

### `GET /api/files/<path>?type=…` — Stable

| `type` | Result |
| --- | --- |
| `list` (default) | `{"entries":[{"name","isDir","size","modified"}]}` |
| `read` | text: `{"content","language","size"}`; image/audio/document: the bytes, with `Range` support |
| `download` | the bytes with `Content-Disposition: attachment` |
| `meta` | `{"size","language","mime","previewKind"}` |
| `preview` | rendered preview (e.g. document → HTML) |
| `watch` | change notification for the path |

Limits: text preview `413 file_too_large_preview` above 256 KB, images
`413 image_too_large` above 10 MB. An unknown `type` is
`400 invalid_request_type`.

`?sessionId=<id>` widens access to files *referenced by that session* for
non-`list` types, so a transcript can link to a file outside the allow-list.
This is the only path that escapes the roots, and it needs a session you own.

### Mutations

`POST /api/files/<directory>?type=upload` — multipart upload, ≤25 MB per file
and ≤100 MB per request (`413 upload_total_too_large`);
`?conflict=` selects the collision strategy.
`POST /api/files/<directory>?type=upload-check` with `{fileNames:[…]}` reports
collisions before you send bytes.

`POST /api/files/ops` with `{action, path, name?, newName?, recursive?}` where
`action` is `mkdir`, `create-file`, `rename` or `delete`. Returns
`{"ok":true,"path":"<result>"}` (no `path` for `delete`). An authorized root can
never itself be deleted. Unknown action: `400 invalid_action`.

There is **no route that overwrites an existing file's contents.** Editing goes
through the agent. Do not expect a `PUT`.

## Git — Stable

All three take an absolute `cwd` inside the allow-list.

`GET /api/git/status?cwd=…`:

```json
{"isGitRepository":true,"repositoryRoot":"/data/home/Cody",
 "files":[{"filePath":"/data/home/Cody/bin/cody-server.js","status":"modified",
           "code":"M","indexStatus":" ","worktreeStatus":"M"}]}
```

`status` is a friendly word; `code`/`indexStatus`/`worktreeStatus` are git's own
porcelain letters. A non-repository answers `isGitRepository: false` rather than
an error.

`GET /api/git/diff?cwd=…&path=…` — unified diff for one file.

`POST /api/git/mutate` with `{cwd, action, path?, message?}` where `action` is
`stage`, `unstage`, `discard` or `commit`. `path` is required for everything but
`commit`; `message` is required for `commit` and capped at 4000 characters.

One sharp edge, by design: **`path` is not trimmed.** A filename may legitimately
end in whitespace, and trimming would retarget the operation at a different real
file — catastrophic for `discard`, which deletes. Send the path exactly as
`status` reported it.

## Terminals

| Route | Method | Notes |
| --- | --- | --- |
| `/api/terminals?cwd=…` | GET | `{"terminals":[…]}` for that cwd |
| `/api/terminals` | POST | `{cwd, name?, cols?, rows?}` → `201` |
| `/api/terminals/<id>` | PATCH | `{name}` — rename |
| `/api/terminals/<id>` | DELETE | `{"closed":true}` |
| `/api/terminals/<id>/socket` | WS | the PTY |

```json
{"terminals":[{"id":"322adaee-0e30-4b0f-a191-cd5b53eb248e","cwd":"/data/home/Cody",
               "name":"bearer-proof","createdAt":"2026-08-18T04:26:17.855Z",
               "exited":false}]}
```

Terminal names are restricted to `/^[\w .:+-]{1,80}$/`.

### The terminal WebSocket — Stable

`ws(s)://<host>/api/terminals/<uuid>/socket?cols=<n>&rows=<n>`

The id must be a UUID; the query dimensions are applied before the upgrade
completes, so the first output already has the right geometry. Authenticate as
described under [Cross-origin and WebSocket credentials](#cross-origin-and-websocket-credentials).

Both directions are **text JSON frames**. Binary frames are rejected
(close `1009`), and the server's `maxPayload` is 1,100,000 bytes with an
additional 1,000,000-byte per-frame check on input.

Client → server:

```json
{"type":"input","data":"ls -la\r"}
{"type":"resize","cols":120,"rows":40}
```

`cols`/`rows` must be integers. Any other `type`, or a malformed frame, comes
back as `{"type":"error","message":"…"}` — the socket is **not** closed, so a
bad frame is recoverable.

Server → client: PTY events, the important one being
`{"type":"output","data":"<bytes as a string, ANSI escapes included>"}`. Feed
`data` straight to a terminal emulator. A real first frame:

```json
{"type":"output","data":"Cody: starting omp — exit the engine to drop to a shell.\r\n\u001b[?2004h…"}
```

Opening a terminal drops into the active engine's CLI; `exit` falls back to a
plain shell. A `{"type":"error"}` frame followed by close `1011` means the
terminal is gone.

## Tasks — Stable

`GET /api/tasks?cwd=…` reads the workspace's task config:

```json
{"state":"loaded","tasks":[{"id":"typecheck","title":"Typecheck",
  "command":"npm run typecheck","description":"tsc --noEmit over the whole app",
  "group":"Checks","confirm":false}]}
```

A malformed config is reported as **data**, not as a request failure:
`state: "invalid"` with the validation message, so a client can show the problem
instead of an error toast. Handle `state` before reading `tasks`.

`POST /api/tasks/run` with `{cwd, taskId}` runs a task in a new terminal and
returns that terminal, which you then attach to over the terminal WebSocket.
`confirm: true` on a task means the UI is expected to ask first.

## Models — Stable envelope, Incidental contents

`GET /api/models`:

```json
{"models":{"<provider>/<model-id>":"<display name>"},
 "modelList":[{"id":"…","name":"…","provider":"…","thinkingLevels":["off","…"],
               "supportsFastMode":true,"contextWindow":200000}],
 "defaultModel":{"provider":"…","modelId":"…"},
 "thinkingLevels":{"<provider>/<model-id>":["off","…"]},
 "connectedProviders":[{"id":"…","name":"…","disabled":false}],
 "catalogSource":"global"}
```

**Read `catalogSource` before you trust `modelList`.** Engines differ in where
their models live, and an empty list is not an error:

- `"global"` — the engine has a registry Cody can enumerate up front (omp, pi).
  `modelList` is the catalogue.
- `"session"` — the models belong to the SESSION, not to a registry (any ACP
  engine: Claude Code, Codex, Hermes). `modelList` is `[]` and there is
  deliberately no `modelError`, because nothing failed. Read the models from
  the session instead: `GET /api/sessions/{id}/state` carries
  `availableModels`, the current `model`, and `modelSelectable`; switch with
  `POST /api/agent/{id}` `{"type":"set_model", …}`.

A client that treats `modelList: []` as "this engine has no models" will hide
its picker forever on three of the five engines Cody ships.

The `"global"` registry is global rather than per-workspace; `?cwd=` is still
accepted and ignored. Every id, provider name and effort level in here comes from the
engine's own catalogue and changes without notice — enumerate it at runtime and
never hardcode an entry. `defaultModel` may be `null` (it is cosmetic; the list
is still usable). `thinkingLevels` always starts with `"off"`.

Related, all admin-gated and all **Incidental**: `/api/model-roles`,
`/api/models-config`, `/api/models-config/{catalog,discover,test}`,
`/api/providers/enable`, `/api/auth/all-providers` (omp's configured API-key
providers).

## `/api/auth/providers`, `/api/auth/login/{provider}`, `/api/auth/logout/{provider}` — Incidental

Provider SIGN-IN with the active engine's own login (a Claude Pro/Max or
ChatGPT subscription, Nous Portal, …) — unrelated to Cody accounts, do not
confuse the two. Served for every engine whose `capabilities.providerLogin`
is true; refused `400 unsupported` otherwise. The roster is readable by any
signed-in user; starting a login and logging out are **admin-only**, since
the credential is shared by every user's sessions.

- `GET /api/auth/providers` → `{"engine":{"id","shortName"},
  "providers":[{"id","name","authenticated","kind":"oauth"|"device",
  "canLogout","hint"?}],"reason"?}`. `reason` explains an empty roster (the
  engine is not installed).
- `GET /api/auth/login/{provider}` is an SSE stream of the flow: `auth
  {url, instructions, token}` (open the URL), `device_code {userCode,
  verificationUri, expiresInSeconds}` (type the code there), `prompt_request
  {message, placeholder, token}` (paste the code or redirect URL),
  `progress {message}`, then `success`, `error {message}` or `cancelled`.
  `POST /api/auth/login/{provider}` with `{"token","code"}` hands the pasted
  value back; a value posted before the engine asks is held for it.
- `POST /api/auth/logout/{provider}` → `{"ok":true}`; `400 unsupported` for
  an engine whose only logout is interactive (omp).

## `GET|PUT /api/provider-keys` — Incidental

Provider API keys Cody hands to every engine child process — the ACP agents,
the omp/pi RPC processes and the terminal — as environment variables, so one
key works the same under every engine. `GET` (any signed-in user) reports the
catalogue for the active engine with `stored` / `fromEnvironment` flags and
never a value; `PUT {"name","value"}` (admin) stores one variable from the
catalogue, and an empty value clears it. Keys live in the instance data dir
(`cody-provider-keys.json`, mode 0600) and therefore survive engine switches
without touching any engine's own config.

```json
{"engine":{"id":"hermes","shortName":"Hermes"},
 "providers":[{"id":"openai","name":"OpenAI",
   "variables":[{"name":"OPENAI_API_KEY","label":"API key","secret":true,
                 "stored":true,"fromEnvironment":false}]}]}
```

## The display socket

The streamed preview: a headless browser rendered server-side and delivered as
video, with input forwarded back. Reach it in two steps.

1. `POST /api/agent/<sessionId>/display` with `{url, title?, mode?}` publishes a
   display request (`202`, `{"accepted":true,"requestId":"…","request":{…}}`).
   `GET` returns `{"request": <latest or null>}`.
   The request carries ranked `candidates`, best fidelity first, and **always
   ends with `{"kind":"stream"}`** — the fallback that always works. A client
   should prefer a `direct` or `native` candidate's `url` when it can reach it,
   and only then open the socket.
2. `ws(s)://<host>/api/display/socket?sessionId=<id>` for the `stream`
   candidate.

The gate answers `401` without a valid credential and `404` when the session is
unknown *or* not yours — a `404` here therefore does **not** mean the socket is
unsupported. Authenticate as described under
[Cross-origin and WebSocket credentials](#cross-origin-and-websocket-credentials);
`maxPayload` is 64 KiB for client control frames.

### Frames

Mixed: **JSON text frames carry control and state; binary frames carry media.**
Never JSON-parse a binary frame.

The first frame is always `hello` — **Stable**:

```json
{"type":"hello","version":1,"renderer":"raster","media":"jpeg",
 "input":["pointer","keyboard","resize","reload","clipboard"],"requestId":"…"}
```

- `renderer`/`media` are `"raster"`/`"jpeg"` or `"h264"`/`"video/H264"`.
- **Gate your UI on the `input` array, not on `renderer`.** A future provider
  advertises a different subset, and an older one simply omits a channel.
- `version: 1` is the protocol version. Refuse anything you do not know.

Then, server → client:

- `{"type":"state","state":"connecting"|"ready"|"error","message"?}`.
- `{"type":"video","codec":"avc1.4D4028","codedWidth":N,"codedHeight":N}` —
  sent immediately before the first access unit and again after **every**
  encoder restart (resize, forced recovery). `codec` is parsed out of the real
  SPS, so it always describes the bitstream actually on the wire.
  There is deliberately **no `description` field**: the bitstream is Annex-B,
  which the WebCodecs AVC registration signals by the *absence* of an
  `AVCDecoderConfigurationRecord`. A client that sets `description` from this
  message configures the wrong format and will fail to decode.
  `codedWidth`/`codedHeight` are the macroblock-aligned coded size; page
  content occupies the top-left `viewport × deviceScaleFactor` pixels and the
  client crops to it.
- `{"type":"clipboard","text":"…"}` — the answer to a clipboard read, always
  sent even when empty.
- **Binary** frames are the media: a whole JPEG image in raster mode, or H.264
  Annex-B access units in `h264` mode. On connect, the most recent raster frame
  is replayed immediately so a new client is not staring at nothing.

Client → server (send only what `hello.input` advertised):

```json
{"type":"resize","width":1280,"height":800,"deviceScaleFactor":2}
{"type":"pointer","action":"move"|"down"|"up"|"wheel","x":0,"y":0,
 "button":"left"|"middle"|"right","deltaX":0,"deltaY":0}
{"type":"keyboard","action":"down"|"up"|"text","key":"…","code":"…","text":"…","modifiers":0}
{"type":"clipboard","action":"read"}
{"type":"clipboard","action":"write","text":"…"}
{"type":"capabilities","decoders":["avc1.4D4028"]}
{"type":"keyframe"}
{"type":"reload"}
```

- `capabilities` must be sent **once, on receipt of `hello`**, listing the RFC
  6381 codec strings you verified with a real decoder probe. An empty list means
  "I cannot decode video" and the server stays on the raster path. Getting this
  wrong is the one way to end up with a black window.
- `{"type":"keyframe"}` is the recovery request after a decoder error: it asks
  the server to stop sending deltas until the next IDR. Send it instead of
  reconnecting.
- Invalid control frames are **silently ignored** — input racing a navigation is
  normal and non-fatal. You will not get an error back, so do not wait for one.

A resize never downgrades the stream: the provider clamps and re-encodes rather
than falling back to raster, so a viewport change does not silently cost you
hardware video.

## Not covered here

These exist and are reachable, but are **not** part of the contract this
document offers: `/api/skills/*`, `/api/plugins`, `/api/mcp`,
`/api/omp-settings*`, `/api/omp-update`, `/api/omp-version`, `/api/checkpoints`,
`/api/worktrees`, `/api/projects`, `/api/cwd/*`, `/api/default-cwd`,
`/api/home`, `/api/file-index`, `/api/local-ai`, `/api/app-update`,
`/api/preview/screenshot`, and `/api/internal/display` (an internal
loopback-only endpoint with its own secret — never call it).

Most are thin passthroughs to engine configuration whose shapes are the
engine's, or workspace-picker helpers that only make sense to the web client.
If you need one of them, read the route and expect it to move.
