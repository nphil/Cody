# Provider Account Lifecycle Restoration

## Problem

The current Cody 0.29 integration lost the Cody-local account naming and permanent-removal work that existed in the provider-account lifecycle snapshot. The UI currently exposes engine-derived labels and the older account-removal path, so removing an account can leave a disabled OMP history record and friendly names are unavailable.

## Scope

Restore only:

- Cody-local friendly names for individual OMP provider accounts.
- Editing and clearing those names from the provider settings UI.
- Explicit permanent deletion of one selected provider credential, including its dependent quota/block rows.
- Separate visibility and permanent removal of disabled account history.

Keep out of scope:

- Preferred/named account routing.
- Changes to OMP automatic rotation or fallback behavior.
- Changes to OMP itself.
- Re-enabling Hermes or unrelated upstream changes.

## Design

### Cody-local names

Store sanitized names in `cody-provider-account-names.json` beneath the configured agent directory. Entries contain only the provider ID, OMP account ID, optional reported identity, and name. Writes are atomic and use restrictive file permissions. OAuth identity is preferred as a stable key when available; anonymous credentials remain tied to their OMP row ID. Successful permanent removal and provider-wide disconnect remove matching name entries.

### Permanent removal

The isolated Bun credential bridge continues to enumerate active and disabled OMP credentials without exposing credential material. For per-account removal it opens only an existing absolute local SQLite database, validates the expected `auth_credentials` schema and dependent tables, then performs a guarded transaction that deletes the selected credential and related block/lease rows. It verifies the selected row was deleted, reloads AuthStorage, and reports whether the provider has remaining credentials. Unsupported or broker-backed stores fail closed with an actionable error; Cody never silently falls back to OMP's soft-delete API for a permanent-removal request.

### API and UI

- `PATCH /api/auth/account/[provider]` saves or clears a Cody-local account name.
- `POST /api/auth/logout/[provider]` with `accountId` permanently removes only that credential and returns `permanent: true`.
- Active account rows show the friendly name/identity, a rename control, and a permanent-removal control.
- Disabled history is rendered separately, is not renameable, and remains permanently removable.
- The confirmation dialog uses explicit permanent-removal wording and explains that a later sign-in creates a new connection.
- Successful changes invalidate provider/model caches and refresh the UI.
- No named-routing or preferred-account controls are restored.

## Error handling and verification

Add focused tests for name persistence/normalization/clearing, cleanup after deletion, SQLite schema guards and dependent-row deletion, unsupported-store refusal, and active versus disabled-history UI behavior. Run focused account tests, typecheck, ESLint, and the production build. Report environment-only test failures separately from feature failures.

## Rollback

The change is isolated to the Cody integration worktree and can be reverted without changing OMP or the live provider credential database. Deployment, commit, and push require separate authorization.
