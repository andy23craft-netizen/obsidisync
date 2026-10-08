# FEAT-02: Accounts, Principals, Shares, and Host-Local Administration

**Status:** Proposed implementation subtask
**Owner:** Rust server; limited plugin login-state handling
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

## Current Behavior

- `PasswordAuth` reads `auth/password.json`, validates its owner against the configured normalized user, and
  issues sessions whose `user` and `subject` are both that namespace. `auth/sessions.json` contains hashed access
  and refresh tokens. Access tokens last 24 hours; refresh tokens last 180 days and are single-use/rotating.
- Native v1 authorization compares `AuthContext.user` to the URL user. Vault storage still uses `(user, vault)`.
  The plugin records the session user without resetting its head, manifest, or registration during login.
- `/v1/auth/config` reports `passwordConfigured` and `setupTokenRequired`. Both the plugin and browser offer
  public setup when no password exists. Runtime password mode currently requires a configured user/setup token.
- Browser login uses an access-token cookie, safe local redirects, and the same server verifier. OIDC supports
  plugin device authorization and browser authorization-code/PKCE login; sessions preserve verified `sub`.
- Device records contain user/vault/folder, a password hash, kind, usage timestamps, and optional Saber settings.
  Basic and bearer device authentication share this store. Authentication periodically writes `last_used_at`.
- JSON stores use temp-file/rename writes and process-local mutexes. These do not coordinate a separate admin CLI.
  The container ships one binary with a fixed entrypoint and UID 10001; administration needs packaging support.

## Requirements

- Replace the single-account store with a small atomically written JSON store under `data/auth`, retaining Argon2
  hashes, generic login errors, and throttling. Never store/log local passwords or newly generated device secrets.
  Preserve existing Saber encryption settings, including their documented recoverable secret; never expose them.
- Create the first account through a host-local command with direct `/data` access; no prior app account or secret.
- Provide host-local account create/disable/list, share create/rename/list, membership grant/revoke/list, and device
  credential create/rotate/revoke/list. Print a newly created secret once only and never in list output.
- Use immutable local account IDs as `AuthContext.subject`; retain login/display name as `user`. OIDC membership
  uses verified `sub`, not a mutable username claim. Disabled local accounts cannot login or refresh.
- Centralize share membership/capability lookup for all successor routes. Establish models needed by FEAT-03 but do
  not migrate or serve share data here.
- Create a distinct, scoped Harmony read-write device/service credential record for later use, never a household
  user's credential; support its folder restriction, rotation, and revocation.

### Legacy authentication migration

FEAT-02 owns an explicit offline `admin auth import-legacy` command, independent of FEAT-03 storage migration.
Startup must never automatically import, replace, or discard an account. With a legacy account but no completed
import, password-mode startup fails with an actionable offline-import diagnostic; it must not treat this as an
empty installation. OIDC and development startup remain unchanged, apart from acquiring the data-directory lock.

1. Stop the old server and disable automatic restart. Take and verify a protected filesystem-consistent backup
   of the complete data directory. Inspect a redacted import dry run before applying it.
2. Validate the legacy store, its Argon2 hash, and exact normalized namespace. Import one enabled account with a
   newly generated immutable opaque ID and the unchanged hash and username. Never rehash without the password,
   reset the password, move vaults, or derive a new namespace. Reject corrupt/mismatched input and username/ID
   collisions without overwriting either account. A legacy store without a hash contains no configured account;
   report that explicitly and require host-local account creation, preserving the source file.
3. Persist the account and an import-completed marker together in versioned `auth/accounts.json`. Keep
   `auth/password.json` unchanged as protected recovery material; the new password verifier never authenticates
   against it. Re-running import reports the completed mapping without creating another account or invalidating
   newly issued sessions. Refuse conflicting pre-existing destination state rather than silently merge it.
4. Deliberately retire pre-import password sessions. The local verifier accepts only enabled-for-refresh account
   IDs as refresh subjects and existing account IDs as access subjects; a legacy username subject is invalid.
   Use explicit identity typing/versioning for newly issued local sessions, and reject old local session records
   without that type. Do not translate tokens or rewrite/delete unrelated OIDC sessions in `sessions.json`.
   Legacy token hashes and the old password store remain recoverable from the backup/source.
5. Restart the upgraded server and log in again using the existing username/password. Old password access tokens
   and refresh tokens return `401`; stale password browser cookies follow the existing sign-in redirect. The
   plugin's refresh/re-login path must retain vault slug, registration, server head, manifest, and conflicts.
   Re-login must not trigger force-push, overwrite-local, or a new initial-sync decision.

Document the re-login window before deployment. Rollback before resumed writes restores the complete pre-import
backup and old image/configuration under stopped-server conditions. After resumed writes, do not blindly restore
the old snapshot: take a fresh backup and reconcile newer document/auth changes before recovery. FEAT-02 changes
no vault directory, Git history, binary object, upload, device record, or client sync identity during import.

### Stable identities and namespace compatibility

- Local usernames are immutable and unique after the existing namespace normalization. Validate uniqueness after
  normalization (including email-prefix/case/space aliases); do not add rename/reuse of disabled usernames.
  Preserve an imported namespace exactly. `AuthContext.user` and session `user` remain the v1 namespace, never
  the opaque principal ID. A separate mutable display label must not change authorization or storage routing.
- Local `AuthContext.subject` is the opaque account ID. Membership keys are typed identities:
  `local(account_id)` or `oidc(verified_issuer, verified_sub)`. OIDC `AuthContext.subject` remains verified `sub`;
  derive its typed key from verifier provenance, not a caller-supplied kind or normalized username. Do not
  normalize `sub`. Distinct kinds/issuers cannot collide even when their string identifiers match.
- Persist OIDC membership identities through host-local grant commands with explicit issuer/subject. Preserve
  OIDC token validation, discovery, exchange, PKCE, device login, refresh, and existing session compatibility.
  Do not require local account creation or a new identity provider for OIDC. Runtime auth modes remain exclusive;
  this ticket does not introduce simultaneous local/OIDC login or identity linking.
- Disabled accounts cannot log in or refresh. Existing typed access tokens may remain usable until their original
  24-hour expiry; do not renew them on use. Restart does not extend expiry. State this limitation in CLI/docs.
  Existing legacy device passwords are independently revocable; account disable does not silently revoke them.
- Keep v1 user authorization and storage behavior until FEAT-03. New memberships do not grant access to another
  v1 namespace; creating an account must not attach it to another account's vaults.

### Login/discovery contract and retirement of public bootstrap

Public password bootstrap is the intentional compatibility exception. Password authentication remains at the
existing endpoints with unchanged successful session fields and token lifetimes. New proposed discovery fields:

```json
{
  "type": "password",
  "passwordConfigured": true,
  "setupTokenRequired": false,
  "accountProvisioning": "host-local",
  "loginAvailable": false
}
```

Here `passwordConfigured: true` is the legacy compatibility signal to choose login instead of public setup,
even for an empty new store. `loginAvailable` means at least one enabled local account exists, and is the new
readiness signal; expose no account names/counts. `accountProvisioning` identifies the operator-only workflow.
With enabled accounts, `loginAvailable` is true. Document this compatibility meaning rather than treating
`passwordConfigured` as a count of accounts. Corrupt stores return a service error, never an empty-store response.

- The upgraded plugin recognizes these additive fields. With login unavailable it displays "Ask the server
  operator to create or enable a local account" without password/setup controls. With login available it offers
  ordinary username/password login. Against older servers lacking the fields, retain their existing behavior.
- Old plugins receive the login-form signal, so they never offer unavailable setup. Empty-store password login
  returns `503` with a safe operator-action message; other unknown/disabled/wrong-password logins remain generic
  `401` with existing throttling and `429`/Retry-After behavior. No account-specific existence diagnostics.
- Retain `POST /v1/auth/password/setup` solely as a `410 Gone` response explaining host-local provisioning. It
  never creates an account/session or mutates files. Browser `/login` POST is login-only and cannot fall through
  to setup, including when all accounts are disabled. Empty-store GET displays operator-action guidance.
- Preserve browser `obsidisync_session`, HttpOnly, SameSite=Lax, HTTPS Secure handling, safe `next` redirects,
  cookie lifetime, and expired-session behavior. No browser refresh mechanism is added: its current cookie is an
  access token. Plugin/API refresh remains rotating and single-use; browser OIDC redirects must not loop.
- Introduce explicit `OBSIDIAN_GIT_SYNC_AUTH_MODE=password|oidc|dev` selection; absent it, preserve existing
  mode-selection precedence and password-user aliases for compatibility. Explicit password mode needs neither
  a configured username nor setup token. Legacy username settings select mode, never restrict all logins to one
  account. Ignore obsolete setup-token settings with a value-free retirement notice; never log their values.
  Explicit OIDC/dev modes still validate their required settings; no fallback on corrupt/missing auth state.

### Enforced exclusive offline administration

Use one stable `data/.obsidisync.lock` file and a nonblocking OS exclusive advisory lock (`flock` on Linux).
Both server and admin entrypoints acquire it before reading mutable stores or starting workers/listeners and
retain the descriptor for their complete lifetime. This excludes another server or CLI, including read/list and
dry-run commands, without adding concurrent administration machinery. Keep process-local store locks for runtime
requests. Use one small shared lock helper; unsupported/unreliable locking fails closed with an actionable error.

Do not delete, rename, or replace the lock file, and do not use PID files/stale-file deletion as the authority.
Prevent descriptor inheritance by Git/renderer subprocesses. A competing process exits nonzero without store
changes or listener startup. The kernel releases the lock when the owning process exits, including a crash;
restart reopens stores rather than retaining stale in-memory accounts/grants. Require a local Linux filesystem
with working lock semantics for `/data`; network filesystems are not assumed safe.
See [Linux flock(2)](https://man7.org/linux/man-pages/man2/flock.2.html) for lock lifetime and advisory semantics.

The first upgrade must stop the old binary, which does not participate in this lock. Document this boundary:
the new CLI cannot enforce exclusion against old binaries or arbitrary host tools. Subsequent supported server
and CLI invocations always participate. Operators must not delete the lock file or run an old server concurrently.

Ship an `admin` subcommand in the existing image entrypoint, dispatched before HTTP/OIDC runtime configuration.
Proposed operator invocation (placeholders must use the actual Marvin-managed volume/image):

```text
docker run --rm -it --network none --user 10001:10001 \
  -v <existing-volume>:/data <pinned-image> admin --data-dir /data <command>
```

Marvin owns stopping/restarting its managed service and suppressing automatic restart; use its actual container
runtime equivalent. A one-shot admin container mounts the same volume and needs no HTTP listener, server secrets,
or network access. Do not use a second unrelated volume or recursive ownership changes. Prompt for passwords via
TTY or protected stdin, never argv/environment; do not echo them. Output safe IDs and newly generated secrets once.

Persist versioned account/share/membership state in one `auth/accounts.json`; stage share device records in
`auth/share-device-passwords.json`. Validate references and schemas before writing. Use restrictive file modes,
same-directory temporary files, flush/sync, atomic rename, and directory sync. Corrupt/unknown schemas fail closed;
never reset them to defaults. A leftover temp file is not committed state and must not be auto-promoted. Multi-file
commands must avoid partial grants: validate first and create a staged credential only against an already durable
share. Recovery uses redacted validation and protected backups; secrets/notes never appear in diagnostics.

### Legacy and staged device credentials

- Keep `auth/device-passwords.json` and its existing live user/vault/folder semantics. Preserve hashes, IDs,
  timestamps, kinds, Saber encryption/PDF settings, and folder restrictions across reads/writes. Reject unknown
  schemas/fields that cannot be preserved rather than dropping them. No automatic conversion or retargeting.
- New share credentials live only in `auth/share-device-passwords.json` with explicit share ID, folder, capability,
  owner/creator identity, kind/metadata, hashed secret, and staged lifecycle. No fallback user/vault fields.
  Share labels never select a legacy namespace/vault. Harmony has a dedicated read-write staged record.
- Legacy Basic and bearer device authentication searches only the legacy store. Staged credentials must fail on
  direct DAV, Nextcloud/OCS, Saber DAV, native v1 bearer routes, and token-based Saber browser connection paths.
  Admin output labels them "staged: network access unavailable until FEAT-03" and gives no usable legacy DAV URL.
- CLI credential commands require an explicit legacy/share target. Legacy create/rotate/revoke retain the existing
  scope/kind/Saber behavior. Rotation changes only the secret hash, preserves ID and grants, and invalidates the
  old secret; revocation never reissues or broadens access. Staged rotation/revocation remains staged. Legacy
  network create/list/revoke endpoints remain compatible and never return staged records or Saber secrets.
- Stage membership/capability validation for FEAT-03 without activating share routing. Missing/revoked members
  fail lookup; a read-only member cannot authorize a write-capable grant. Share membership and credential state
  remain isolated from the current v1 authorization model.

## Proposed Implementation

Add a Rust account/share/access module that owns validation, opaque IDs, locks, JSON persistence, and capability
decisions. Refactor `PasswordAuth`, `AuthVerifier`, and `AppSessionStore` so local sessions carry immutable account
IDs; retain OIDC and development behavior. Add an admin binary or pre-server subcommand that opens the existing
data directory without an HTTP listener. Prompt/read secrets without process arguments, logs, or persistent setup
material. No database, groups, invitation flow, reset email, or public admin API.

Affected components:

- `rust-server/src/password_auth.rs`, `auth.rs`, `app_session.rs`: multi-account lookup, stable/typed identity,
  explicit legacy import and session rejection, disabled refresh, preserved OIDC sessions.
- `http.rs`, `auth_throttle.rs`, `main.rs`: discovery/login-only browser behavior, retired setup, mode selection,
  admin dispatch and lifetime lock before runtime initialization. Preserve generic auth error/status handling.
- New account/share/access, admin/import, and data-directory lock modules: persistence and local command lifecycle.
- `device_passwords.rs`: lossless legacy handling and separate staged records; `webdav.rs`, `nextcloud.rs`, and
  `oidc_login.rs` are compatibility integration points to verify, changing only where needed to honor this contract.
- `src/gitService.ts`, `src/authLoginModal.ts`: additive discovery fields and operator-required UI without changing
  sync configuration/state; existing TypeScript auth/service tests and Rust integration/command fixtures.
- `Dockerfile`: ship the admin entrypoint and its supported invocation. `README.md`: login, import/re-login,
  configuration, account-disable limits, credentials, exclusivity, backup/recovery and operator runbooks.

## Acceptance Criteria

- An empty store permits first-account creation solely through direct host/container `/data` access.
- Correct local credentials issue a session with stable subject; wrong/disabled accounts fail generically, and a
  disabled account cannot refresh while another account remains usable.
- OIDC continues to preserve verified `sub` as the membership subject.
- The admin command manages account/share/membership lifecycle and Harmony credentials without exposing hashes or
  existing secrets, and corrupt stores fail closed without replacing the prior valid file.
- No public registration/admin endpoint, bootstrap token, web UI, database, or production-vault migration exists.
- Legacy import preserves the exact password hash/namespace, retains recovery material, is repeatable without
  duplicate accounts, and rejects corrupt/colliding state without replacement. No vault/client sync state changes.
- Pre-import password sessions require re-login with `401`/browser redirect behavior; fresh sessions refresh once
  and survive restart. OIDC sessions remain compatible. Disable blocks login/refresh with bounded access expiry.
- Empty/all-disabled stores provide operator guidance, no setup UI, and no public account creation. Old plugins
  choose login; updated plugins retain compatibility with old servers. Password and OIDC browser flows work.
- Two accounts keep stable distinct subjects/namespaces and cannot use v1 content, metadata, or credentials in
  each other's namespaces. Creating/granting shares does not grant legacy namespace access.
- Running server/CLI contention fails before mutations/listeners; abrupt exit releases exclusivity, and corrupt
  or interrupted persistence never silently erases account/grant state.
- Existing legacy DAV/Nextcloud/Saber credentials and settings work unchanged; staged share credentials fail every
  legacy authentication path, remain excluded from public lists, and rotation/revocation never changes scope.

## Testing and Validation

- Unit-test login/hash/normalization, opaque IDs, disabled refresh, store corruption/atomic persistence, membership
  capabilities, and OIDC-shaped subjects.
- Command-fixture test first account, account disable, share/membership lifecycle, Harmony credential rotation and
  revocation, plus redacted output.
- Fixture-test legacy import with unchanged hash/namespace/source file, pre-import tokens/cookies, successful
  re-login, repeated import, collision/corruption rejection, interrupted import, and documented rollback rehearsal.
- Exercise password discovery/login, generic failures/throttling, retired setup (API and browser), empty/all-disabled
  stores, old/new plugin discovery, safe cookie/redirect attributes, OIDC device/exchange/PKCE/refresh, and expiry.
  Include matching local/OIDC subject strings and distinct issuers to verify typed membership keys cannot collide.
- Extend `service_tests.rs` for two-account v1 positive/negative namespace access, upload chunks/completion and
  restart/retry, conflict resolution/concurrent edits, text/deleted history, binary blobs/references, feeds, devices,
  version metadata, and unchanged client registration/manifest/head after re-login. Reuse representative fixtures.
- Run existing `webdav_tests.rs`, `nextcloud_tests.rs`, and `inkvault_tests.rs` regressions: PROPFIND, ranges,
  conditional writes, traversal, COPY/MOVE, legacy credential lifecycle, Saber login/rendering, and InkVault flows.
  Add lossless credential round trips and negative staged-secret tests for Basic/bearer DAV, OCS, Saber connect,
  and native v1 auth. Test rotation/revocation preserving the granted folder/kind/Saber settings.
- Process-fixture test server-versus-admin and admin-versus-admin contention, a second server, abrupt termination,
  lock-file persistence, and restart reload. Fault-test writes before/after rename and leftover temp files; corrupt
  committed state must fail closed. Rehearse the packaged admin invocation on a disposable shared volume.
- During implementation run focused tests, then `npm test` (plugin tests/build and complete Rust suite) and
  `npm run test:e2e` for existing plugin/server sync. Record exact results and any environment limitations.
  FEAT-03 owns share-scoped data authorization, v2/read-only sync, cross-share DAV and storage migration tests;
  FEAT-02 owns the staged denial and legacy namespace preservation checks above.

## Documentation and Completion

Document local-account mode and host-local command invocation, explicit import/re-login, stopped-write backup,
rollback and post-write recovery limits, staged credentials, and the public-bootstrap exception. No unresolved
product decisions block local implementation under these contracts. The actual production volume/runtime and
inventory remain deployment inputs for Marvin, not permission to edit or deploy there.

Human verification after implementation should use disposable fixtures: import and re-login without first-sync
reconciliation; browser/plugin and OIDC login; two-user v1 isolation; CLI refusal while server runs; legacy tablet
access and staged Harmony rejection. Completion requires reviewed local implementation and the relevant suites;
it does not mean a production account/share changed, deployment occurred, or live behavior was verified.

## Out of Scope

- Share storage/v2 routes/WebDAV enforcement/migration (FEAT-03), client UX (FEAT-04), and composite mounts
  (FEAT-05).
- Client share selection, production vault/storage migration, activation of share network credentials, Marvin or
  Harmony repository edits, and live deployment/data changes. FEAT-02 includes only the authentication import and
  limited login/setup-state UI changes specified above.
