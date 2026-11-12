# User accounts and auth

← Back to [AGENTS.md](../../AGENTS.md) · Full text of the sections AGENTS.md summarizes, moved verbatim; AGENTS.md keeps a short summary of each.

## User accounts & auth (`lib/auth/`)

Cody has app-level user accounts: a login screen (`/login`,
`components/LoginScreen.tsx`), signed-cookie sessions, per-account profiles
(Settings → Account), and per-account chat sessions.
Accounts are **identities, not OS users** — terminals and the harness run as
the container's single user regardless of who is signed in; `UserRecord.osUser`
is a reserved seam if per-uid isolation is ever wanted.

- `lib/auth/users.ts` — JSON store at `<agent dir>/cody-accounts/accounts.json`
  (override: `CODY_ACCOUNTS_DIR`), atomic 0600 writes, scrypt password hashes
  (`lib/auth/password.ts`, node:crypto only — no new dependency). The
  env-managed bootstrap account `cody` materializes whenever `CODY_PASSWORD`
  is set; its password lives in the environment, never in the store, and it is
  always an admin. First account ever created becomes the administrator.
- `lib/auth/session.ts` — stateless HMAC-signed cookie (`cody_session`,
  30 days). Secret persisted 0600 beside the store. Revocation = bump the
  user's `tokenVersion` (password changes do this).
- `lib/auth/guard.ts` — the one "who is this request" answer: cookie first,
  then HTTP Basic with `CODY_PASSWORD` (kept for scripts/healthcheck; resolves
  to the bootstrap account). **Auth is required iff a password is set or any
  account exists** — bare `npm run dev` stays open until the first account.
- `proxy.ts` — perimeter: unauthenticated HTML → redirect `/login`, API →
  401 JSON (deliberately no `WWW-Authenticate`: it would summon the browser's
  native dialog over the login screen). Public paths: `/login`,
  `/api/accounts/{state,login,signup}`, hashed `_next` assets. The WS upgrade
  gate in `bin/cody-server.js` accepts the same two credentials.
  The cross-site guard (`lib/request-security.ts`, applied to every route)
  rejects cross-site `fetch()`/XHR and non-GET navigations (form-post CSRF)
  but ALLOWS cross-site GET/HEAD navigations — links into Cody, the preview
  gateway's iframe, detach-to-tab. Navigating is how browsers arrive
  anywhere, mutating GETs are bugs by contract, and the SameSite=Lax session
  cookie stays off cross-site iframe loads regardless. Before this exemption,
  ANY cross-site link into Cody answered a bare 403 JSON.
- Session privacy: `lib/auth/session-owners.ts` sidecar maps omp session id →
  account id (omp owns the JSONL files, so ownership cannot live inside them).
  Owned sessions are visible only to their owner (admins included); unowned
  ones (pre-account, terminal-created, orphaned by account deletion) are
  visible to all. Enforced in `resolveSessionPathOr404` (which now REQUIRES the
  request — every per-session route passes it), the SSE events route, and the
  session list. Blocked = the same 404 as missing.
- Signup policy: `CODY_ALLOW_SIGNUP=0` hides self-service signup, but the
  first HUMAN signup is always allowed and becomes the admin — the
  env-managed bootstrap account never uses up that slot. The container needs
  no password: docker/entrypoint.sh sets `CODY_REQUIRE_ACCOUNTS=1` (unless
  `CODY_ALLOW_NO_AUTH=1`), which makes `isAuthRequired()` true even with zero
  accounts, so a fresh instance shows only the first-run setup screen until
  the opener creates the admin account.

---

