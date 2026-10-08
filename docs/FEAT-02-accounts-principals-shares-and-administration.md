# FEAT-02: Accounts, Principals, Shares, and Host-Local Administration

**Status:** Proposed implementation subtask
**Owner:** Rust server
**Parent:** [FEAT-01](FEAT-01-multi-user-shares-and-composite-vault-sync.md)
**Dependencies:** None. This is the foundational identity and authorization primitive for FEAT-03 through FEAT-05.

## Problem

The server has one built-in password user in `auth/password.json` and authorizes native requests by URL namespace.
It has no durable principal, share, membership, or safe local-administration model.

## Desired Behavior

An operator with direct host/container access to `/data` can create the first local account, later manage accounts,
shares, memberships, and scoped device credentials. There is no network registration, bootstrap token, web admin UI,
or external identity-provider requirement. A share has opaque stable ID and mutable label; membership grants `read`
or `read-write`. Local and OIDC identities have a stable principal ID.

## Requirements

- Replace the single-account store with a small atomically written JSON store under `data/auth`, retaining Argon2
  hashes, generic login errors, and throttling. Never store/log plaintext credentials.
- Create the first account through a host-local command with direct `/data` access; no prior app account or secret.
- Provide host-local account create/disable/list, share create/rename/list, membership grant/revoke/list, and device
  credential create/rotate/revoke/list. Print a newly created secret once only and never in list output.
- Use immutable local account IDs as `AuthContext.subject`; retain login/display name as `user`. OIDC membership
  uses verified `sub`, not a mutable username claim. Disabled local accounts cannot login or refresh.
- Centralize share membership/capability lookup for all successor routes. Establish models needed by FEAT-03 but do
  not migrate or serve share data here.
- Create a distinct, scoped Harmony read-write device/service credential record for later use, never a household
  user's credential; support its folder restriction, rotation, and revocation.

## Proposed Implementation

Add a Rust account/share/access module that owns validation, opaque IDs, locks, JSON persistence, and capability
decisions. Refactor `PasswordAuth`, `AuthVerifier`, and `AppSessionStore` so local sessions carry immutable account
IDs; retain OIDC and development behavior. Add an admin binary or pre-server subcommand that opens the existing
data directory without an HTTP listener. Prompt/read secrets without process arguments, logs, or persistent setup
material. No database, groups, invitation flow, reset email, or public admin API.

Affected components: `rust-server/src/password_auth.rs`, `auth.rs`, `app_session.rs`, `auth_throttle.rs`, `main.rs`;
new share/account/access and admin modules; `device_passwords.rs` migration-ready credential records; focused Rust
tests; `README.md` host-local usage documentation.

## Acceptance Criteria

- An empty store permits first-account creation solely through direct host/container `/data` access.
- Correct local credentials issue a session with stable subject; wrong/disabled accounts fail generically, and a
  disabled account cannot refresh while another account remains usable.
- OIDC continues to preserve verified `sub` as the membership subject.
- The admin command manages account/share/membership lifecycle and Harmony credentials without exposing hashes or
  existing secrets, and corrupt stores fail closed without replacing the prior valid file.
- No public registration/admin endpoint, bootstrap token, web UI, database, or production-vault migration exists.

## Testing and Validation

- Unit-test login/hash/normalization, opaque IDs, disabled refresh, store corruption/atomic persistence, membership
  capabilities, and OIDC-shaped subjects.
- Command-fixture test first account, account disable, share/membership lifecycle, Harmony credential rotation and
  revocation, plus redacted output.
- Local completion is Rust implementation and focused tests passing. Deployment/live account creation is a separate
  Marvin/operator action.

## Documentation and Completion

Document local-account mode and host-local command invocation. Completion means reviewed local code/tests pass; it
does not mean a production account, share, or Marvin deployment has changed.

## Out of Scope

- Share storage/v2 routes/WebDAV enforcement/migration (FEAT-03), client UX (FEAT-04), and composite mounts
  (FEAT-05).
