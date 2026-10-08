# FEAT-01: Multi-User Shares and Composite Vault Synchronization

**Status:** Approved for decomposition; implementation not started
**Owner:** Full stack
**Dependencies:** Implementation tickets FEAT-02 through FEAT-05; Marvin deployment work for the host-local
administration workflow, production inventory, backup runbook, and maintenance-window migration.

## Problem

ObsidiSync currently isolates data by a URL user namespace and vault slug. It supports multiple vaults
for one authenticated user, but it cannot safely give two users access to one collection. The built-in
password login is also a single-account implementation.

The household needs Andy and Liz to use private collections and the shared Harmony collection without
private filenames, content, history, or metadata becoming visible to the other person. The eventual
Obsidian experience is one local vault per person that combines independently authorized collections
under local directories. The server must remain the security boundary; local directory visibility is not
authorization.

## Desired Behavior

The system supports these independently stored shares:

| Share label | Members | Initial access |
| --- | --- | --- |
| Andy Private | Andy | read/write |
| Liz Private | Liz | read/write |
| Harmony | Andy, Liz | read/write |

An authenticated user can discover and synchronize only shares for which they have membership. A caller
without membership receives no information that an inaccessible share exists. In particular, Liz cannot
list, retrieve, inspect history for, download a blob from, create a device password for, or infer the
existence of Andy's `Gifts for Liz.md` in Andy Private.

The first usable release lets a local Obsidian vault select one authorized server-side share. Separate
local Obsidian vaults are acceptable at this stage. The later composite release lets a person map multiple
shares into one local Obsidian vault, for example:

```text
Andy's local vault                 Liz's local vault
Personal/ -> Andy Private          Personal/ -> Liz Private
Harmony/  -> Harmony               Harmony/  -> Harmony
```

Each composite mount retains independent remote identity, server head, manifest, initial-sync decision,
conflicts, and recovery state. A cross-share rename is not an atomic rename and is initially rejected;
users use an explicit copy/import workflow followed by a separately confirmed delete.

## Current Behavior

- `rust-server/src/http.rs` exposes the native v1 surface at
  `/v1/users/:user/vaults/:vault/...`. `authorize` authenticates a bearer token and compares the token
  user to the URL user. It has no membership concept.
- `rust-server/src/vault.rs` stores each vault at `data/users/{user}/vaults/{vault}` with `repo`,
  `binary`, `uploads`, and `state.json`. Git history, conflict records, binary manifests, device records,
  and version metadata are therefore user-vault scoped today.
- `rust-server/src/vault/dav.rs` implements WebDAV storage operations against the same user-vault key.
- `rust-server/src/webdav.rs` authenticates a device password into a `{ user, vault, folder }` grant and
  checks it before operations including PROPFIND, GET/HEAD, PUT, DELETE, MKCOL, MOVE, and COPY.
- `rust-server/src/device_passwords.rs` persists grants in `auth/device-passwords.json`; credentials are
  scoped to the current user, vault, and folder.
- `rust-server/src/nextcloud.rs` provides the limited Nextcloud/Saber compatibility surface. Its login
  flow lists vaults registered in the signed-in user's namespace and its WebDAV routes delegate to the
  same device-password grant handling.
- `rust-server/src/password_auth.rs` persists exactly one configured username and one Argon2 password
  hash in `auth/password.json`. Password sessions are issued by `app_session.rs`. OIDC sessions preserve
  both a normalized display/user name and the OIDC `sub` subject.
- `src/settings.ts` and `src/gitService.ts` persist one `userSlug`, one `vaultSlug`, one `serverHead`, and
  one local manifest for each local Obsidian vault. `src/vaultState.ts` scans and reconciles the whole
  local vault. The current client cannot route prefixes to separate server collections.
- There is no separate server search index or trash API. Git history is the relevant deleted-file and
  revision source. The plugin excludes `.trash` and local cache paths from ordinary sync.

Existing v1 behavior must remain available only during an explicit migration window. It must never become
a secondary access path that bypasses share authorization.

## Requirements

- A share is the storage and authorization boundary. Folder-level ACLs inside a shared Git repository are
  not introduced as a replacement boundary.
- A share has a stable opaque identifier that is independent of its mutable display label. The identifier
  is used for authorization, API addressing, storage paths, locks, and device grants.
- Membership is many-to-many and has at least `read` and `read-write` capabilities. The first household
  configuration uses read-write memberships, but read-only must be enforced where assigned.
- Authentication, share lookup, and capability verification occur before accessing content or metadata.
- Ordinary non-members cannot enumerate an inaccessible share or distinguish it from a nonexistent share
  through a share-specific endpoint. Use `404` after successful authentication for unavailable shares;
  use `401` only for missing or invalid authentication.
- Share isolation covers text files, binary objects, upload staging/state, Git repositories and history,
  deleted-file history, binary manifests, device records, version metadata, conflict state, activity data,
  and WebDAV metadata such as names, ETags, sizes, and timestamps.
- Preserve OIDC. Do not require an external identity provider solely for two household accounts.
- Add a minimal secure local multi-user password mode suitable for a single operator. Password hashes must
  remain Argon2 hashes; plaintext passwords and password recovery material are never persisted or logged.
- Administration is host-local initially. It creates/disables local accounts, creates/renames shares,
  assigns/revokes membership, and reports safe identifiers. It is not a public web administration API.
- The first local account is creatable by that host-local administrative command against `/data`; no existing
  application account, public registration endpoint, permanent bootstrap token, or reusable setup secret is
  required.
- Existing v1 vault repositories, Git history, binary attachments, sync state, and credentials are
  migrated deliberately with a backup, consistency check, and documented recovery path.
- Device credentials are share-scoped. Migration must not silently broaden or retarget a credential.
- Harmony receives a dedicated, rotatable, revocable, read-write WebDAV/device credential scoped only to
  `harmony` and to the smallest folders its existing integration needs. It cannot use or inherit Andy's or
  Liz's credentials and cannot access either private share.
- Read-only membership supports a complete non-mutating synchronization workflow: share discovery,
  negotiation/state inspection, manifest/change discovery, and required file/blob downloads. It does not
  authorize content uploads, deletes, conflict-resolution writes, mutable version/device metadata, or
  issuance of write-capable credentials.
- The first client release supports selecting one authorized share per local Obsidian vault.
- The composite client release supports multiple prefix mounts without weakening server authorization.
- Harmony continues to consume ordinary Markdown and attachments only through an explicitly authorized
  interface. ObsidiSync does not take ownership of household document semantics.

## Non-Goals

- A web-based administration console, self-service household invitations, password reset email, SSO
  provisioning, group management, audit/SIEM infrastructure, or high-availability deployment.
- Encrypting data from the server operator, server filesystem backups, a configured external Git remote,
  or a compromised authorized endpoint. Those are separate trust boundaries.
- Folder ACLs within one Git repository.
- Automatically removing previously synchronized private content from a device after membership revocation.
- An atomic cross-share move, automatic cross-share link rewriting, or server-side document transformation.

## Constraints

- The server is a small Rust/Axum service deployed as one container with persistent `/data`; the operator
  accepts brief planned downtime but not silent loss or disclosure.
- Existing routing, service methods, storage paths, tests, and client state are built around `(user, vault)`.
  The new model must make share authorization central rather than add scattered ACL checks to those calls.
- `Dockerfile` currently builds one server binary with a fixed entrypoint. A host-local admin command must
  be usable against the same `/data` volume without exposing a network listener.
- OIDC identity membership must use the stable `sub` subject, not a mutable username claim. The local
  account store needs an equally stable principal ID.
- Any Git remote configured for a private share is an external copy of that private share and must be
  protected by matching remote access controls. A shared remote repository must not carry private shares.
- Existing WebDAV folder restriction logic may be reused only beneath an already-authorized share grant;
  it is not a general share/folder ACL implementation.

## Assumptions

- The initial operator can take a filesystem-consistent backup of `/data` and schedule downtime for
  migration.
- Andy and Liz will each use distinct local-account names or stable OIDC subjects.
- Marvin owns container invocation, persistent-volume backup, TLS/ingress, and operational recovery; this
  ticket does not authorize changes to Marvin's deployment repository.
- Separate local Obsidian vaults are acceptable until the composite client phase is completed.

## Approved Operator Decisions

### Local-account bootstrap

The local-account implementation uses host-local administration with direct access to ObsidiSync's persistent
`/data` directory. The first account is created directly by an operator command; it does not require an
existing application account. There is no public registration endpoint, external identity-provider requirement,
permanent bootstrap token, or reusable setup secret. OIDC remains supported and local passwords continue to use
the existing Argon2 approach.

### Production migration

Live migration is inventory first, then a controlled maintenance-window operation. Before it begins, Marvin
will inventory legacy vault directories/owners, configured Git remotes, device-password grants, connected
Obsidian clients/configuration, and Harmony integrations. The reviewed mapping, verified filesystem-consistent
backup, representative fixture rehearsal, stopped-write window, migration validation, one-at-a-time client
reconciliation, and rollback/recovery procedure are mandatory. This does not block isolated implementation or
fixture testing. Marvin owns deployment/operations; ObsidiSync owns its application migration behavior/tooling.

### Harmony service credential

Harmony continues its existing ObsidiSync/WebDAV integration and modifies shared household Markdown. It receives
a dedicated, rotatable and revocable read-write device/service credential for `harmony`, never an Andy or Liz
credential. The credential is limited to the required Harmony folders when the device-password grant supports
that restriction. Harmony and Marvin own their integration/deployment changes; ObsidiSync provides the
share-scoped credential and authorization behavior.

## Proposed Implementation

Implement this as one parent feature with four ordered implementation subtasks. The parent ticket owns the
security model and end-to-end migration contract; splitting it into unrelated backend/frontend tickets
would duplicate or obscure those contracts.

### Phase 1 / Subtask A: Principals, local accounts, shares, and host-local administration

Introduce a share/authorization module owned by the Rust server. Persist its small configuration under
`data/auth` using JSON-plus-temp-file-rename persistence and process-local locks for runtime writes. Server and
host-local administration must additionally hold one exclusive lifetime OS lock on the data directory; admin
commands run offline, as specified in FEAT-02. This is
appropriate for a single-instance household service; it avoids introducing a database or a public control
plane.

Proposed records:

```text
Principal
  id: stable opaque ID
  display/login name: normalized, unique for local accounts
  kind: local | oidc
  enabled: boolean

Share
  id: stable opaque ID
  label: mutable display label
  members: principal ID -> read | read-write
  createdAt
  optional remote/branch/author configuration
```

For OIDC, verified issuer and `AuthContext.subject` identify the member; the normalized user name remains display data.
Membership keys distinguish local IDs from OIDC issuer/subject pairs, as specified in FEAT-02. For local
password accounts, create immutable random principal IDs and retain a separately validated login name.
FEAT-02 imports the legacy password hash and namespace offline without moving vault storage, with a documented
password-session re-login. It preserves legacy device grants and stages new share credentials without network
activation until Phase 2. Limited client login/setup-state handling belongs to FEAT-02; share selection remains Phase 3.
Refactor application sessions so they preserve the principal ID as `subject` and the current display/login
name as `user`. Disabling an account must prevent fresh authentication and refresh; existing bearer-token
expiry remains bounded by the current 24-hour access-token lifetime unless explicit server-side session
revocation is added in this subtask.

Replace the single-user `PasswordAuth` store with a multi-account store holding Argon2 hashes, account
state, and no plaintext secrets. Keep generic invalid-login responses and the existing throttling behavior
to avoid account probing. Do not add password reset or network registration. Preserve OIDC and static
development token modes, documenting that development tokens are not production household authentication.

Add an admin binary or explicit server subcommand that operates directly on `OBSIDIAN_GIT_SYNC_DATA_DIR`
without starting HTTP. It needs account create/disable/list, share create/rename/list, membership grant/
revoke/list, credential create/rotate/revoke/list, and a validation/dry-run view. Direct host/container access
is the authorization for these commands. The first account is created with the same command. It must print no
password except a newly generated account or device credential exactly once; it must never persist or log that
secret. Document container invocation and file ownership for Marvin; do not change Marvin here.

### Phase 2 / Subtask B: Share-scoped storage, v2 API, and WebDAV compatibility

Add a centralized share resolver used by every data-bearing handler:

```text
authenticate principal -> resolve share ID -> verify capability -> invoke share-scoped service method
```

No storage lookup or activity/feed/history enumeration precedes this check. Replace service keys and locks
from `(user, vault)` to `share_id`, and store data under a share-owned root such as:

```text
data/shares/{share-id}/
  repo/
  binary/
  uploads/
  state.json
  pending-conflicts.json
  devices.json
  version-metadata.json
```

The exact metadata filenames may retain existing helpers, but all must remain beneath the same share root.
Do not place a private share's repository or binary objects below a publicly name-derived path.

Proposed native v2 contract:

```text
GET    /v2/shares
POST   /v2/shares/{shareId}/register
POST   /v2/shares/{shareId}/uploads
POST   /v2/shares/{shareId}/uploads/{uploadId}/chunk
POST   /v2/shares/{shareId}/uploads/{uploadId}/complete
POST   /v2/shares/{shareId}/sync
GET    /v2/shares/{shareId}/history
GET    /v2/shares/{shareId}/file
GET    /v2/shares/{shareId}/blob
POST   /v2/shares/{shareId}/resolve
GET    /v2/shares/{shareId}/devices
GET    /v2/shares/{shareId}/conflicts
GET/POST /v2/shares/{shareId}/files/version-metadata
GET/POST/DELETE /v2/shares/{shareId}/device-passwords[/{id}]
```

The actual response models can reuse the present sync protocol except that register/list responses identify
a share, not a caller-selected user namespace. `GET /v2/shares` returns only shares visible to the caller,
with their label, stable ID, and capability.

The current `POST .../register` is not read-only: the client calls it before every sync, and
`VaultService::register` validates configuration, ensures a repository, and rewrites `state.json`. V2 must
separate this concern. Shares are created/configured by host-local administration or migration; client
negotiation is a read-capable, non-mutating operation, such as `GET /v2/shares/{shareId}/sync-state`, returning
the current head and protocol/configuration information necessary for download synchronization. A read-only
sync path must not create a repository, rewrite share configuration, update device/version metadata, queue a
conflict, consume an upload, or create a Git commit. It may refresh an already configured upstream internally
only when that refresh does not create a user-visible revision or metadata record.

Writes require `read-write`: upload initialization/chunks/completion, content changes/deletes, conflict
resolution through writes, mutable version/device metadata, share configuration, and write-capable credential
issuance. Read-only members may discover, negotiate, inspect state/history, request changes/manifests, and
download files/blobs for an authorized share. The client must not call a write registration endpoint merely to
perform that workflow.

Share-specific unavailable responses return `404` to a valid caller. Do not use differing `403` errors,
share labels, activity feeds, timing-dependent storage initialization, or response content to reveal an
inaccessible share. Keep `401` for authentication failures.

Move device-password records to `{share_id, folder, capability, owner/creator, device metadata}`. Validate
that creator membership permits issuing the credential and that a read-only issuer cannot mint write
credentials. The host-local administrator creates, rotates, and revokes Harmony's distinct read-write grant;
it is scoped to the `harmony` share and the smallest required folders. Authenticate a device password before
resolving its share. A device grant routes WebDAV to one share and one allowed folder; it never chooses a user
namespace from the request URL.

Update `/dav` and Nextcloud-compatible routes so PROPFIND, GET/HEAD/ranges, PUT, DELETE, MKCOL, MOVE,
COPY, locks, virtual folders, OCS user lookup, and Saber login flow all operate from that grant. Explicitly
reject destination shares other than the grant share. The primary API, direct WebDAV, and Nextcloud-style
WebDAV must have equivalent authorization behavior.

Version the server capability/API response so upgraded clients know when to use v2. During migration,
place v1 behind a clearly bounded compatibility mode. Either authorize its `(user, vault)` mapping through
the new share store or make it read-only; it may not continue to access legacy directories independently.
Remove v1 write access only after all supported clients and migrations are complete.

### Phase 3 / Subtask C: Client share selection and migration

Replace the single remote-vault configuration in `IosGitSyncSettings` with a selected share identity:

```text
selectedShareId
selectedShareLabel (display/cache only)
shareSyncState: server head, manifest, initial-sync status, and related local state
```

The client obtains available shares from `GET /v2/shares`, permits choosing one, and never accepts an
arbitrary share label as authority. It keeps existing per-local-vault behavior for this phase: one selected
server share, one local manifest, and existing conflict UI/history/device-password actions routed to v2.

Opening an old configuration must be migration-aware. Do not silently retarget it based on a matching label
or reset its manifest/head. The client asks the user to choose the server-migrated share, preserves the old
settings until success, and then runs the normal initial reconciliation choice. Existing local state must
be backed up before overwrite-local behavior, as it is today.

Document how a user opens Andy Private, Liz Private, or Harmony as distinct Obsidian vaults during this
release. Add capability-aware UI: read-only shares cannot expose mutating device-password controls or
promise that a local edit will upload.

### Phase 4 / Subtask D: Composite local vault synchronization

Build on the v2 share model rather than modifying server authorization. Introduce an ordered local mount
configuration, for example:

```text
mounts:
  - localPrefix: Personal
    shareId: <andy-private>
  - localPrefix: Harmony
    shareId: <harmony>
```

Validate non-empty, safe, non-overlapping prefixes. Every mounted share has its own persisted server head,
manifest, initial-sync/recovery state, pending conflicts, and progress display. Refactor `VaultState` use
so scans and apply operations receive a mount root and only operate below that root. A failure or conflict
in Harmony must not discard, reset, or overwrite Personal state; report per-mount results and retry only
the affected share.

The composite root's `.obsidian/` configuration remains device-local/shared only according to current
plugin behavior and is never assigned to a private or shared remote share by accident. Define and test its
sync exclusion explicitly, including `.obsidian-git-sync/`, `.trash/`, cache data, and plugin settings.

Initially reject rename/move operations whose old and new paths resolve to different mounts before any
remote request. Present an explicit copy/import action that copies ordinary files and attachments into the
destination mount, verifies destination sync, and requires a separate user-confirmed deletion from the
source. There is no cross-share atomicity claim. A rename within one mount retains present semantics.

Markdown links are not authorization grants. Preserve text unchanged by default: links from Harmony to a
private path can be locally useful for their owner but will be broken/unavailable to another member. Do
not automatically rewrite links. Attachments follow the mounted file path and therefore stay in their
share. Document this behavior in the composite setup UI and user guide.

Support the existing Obsidian plugin platforms without filesystem union mounts. The feature must work via
the plugin's adapter on iOS/iPadOS/macOS rather than symlinks, bind mounts, or desktop-only setup.

### Affected components

#### `rust-server/src/password_auth.rs`, `auth.rs`, `app_session.rs`, `auth_throttle.rs`, and `main.rs`

Replace the single local-account persistence model, preserve OIDC behavior, carry stable principal IDs into
authorization, expose an intentional runtime configuration mode, and retain generic/throttled failures.

#### New share/access module and admin binary

Own share records, memberships, local account metadata, storage-safe ID validation, host-local commands,
atomic persistence, and authorization helpers. The server/router must depend on this module rather than
reimplementing membership checks per endpoint.

#### `rust-server/src/vault.rs`, `vault/dav.rs`, `version_registry.rs`, `binary_store.rs`, and
`device_passwords.rs`

Convert storage, locks, state, Git history, conflicts, binary attachments, device state, and device grants
from user-vault scope to share scope. Preserve existing Git/binary representation within a migrated share
so revision history and attachment references remain valid.

#### `rust-server/src/http.rs`, `webdav.rs`, `nextcloud.rs`, `protocol.rs`, and Saber modules

Introduce v2 route handling and a single authorize-before-storage rule across all native, WebDAV, and
compatibility paths. Update public API version/features and only retain v1 in a non-bypass compatibility
mode.

#### `src/settings.ts`, `src/gitService.ts`, `src/vaultState.ts`, `src/main.ts`, settings/login/initial-sync
modals, history UI, and device-password UI

Support listing/selecting authorized shares first, then per-prefix mount state in the composite phase.
Preserve recovery choices and make status/errors share or mount specific.

#### `rust-server/tests/*` and `tests/*.test.ts`

Add account, membership, API, WebDAV, migration, client-state, and composite-routing coverage. Existing
single-user/v1 fixtures must be either migrated or deliberately retained as compatibility fixtures.

#### `README.md`, deployment/migration runbook, and Marvin/Harmony integration documentation

Document account bootstrap, host-local administration, client upgrade order, v1 cutoff, data backup and
rollback, remote-repository privacy, share creation, device credential reissue, and the authorized Harmony
access contract. Marvin owns actual deployment edits; Harmony owns document semantics and any consumer
changes.

## Security Invariants and Negative Authorization Tests

The implementation is incomplete until all relevant surfaces test both authorized and unauthorized users.

- Liz's authenticated `GET /v2/shares` never contains Andy Private; a direct Andy Private v2 path returns
  `404` with no private label, path, revision, device, or response-body detail.
- For an inaccessible share, test sync, uploads/chunks/completion, blob, current and historical file,
  history with and without a path, conflicts, device list, device-version metadata, activity/feed, and
  version metadata. None may reveal private names, hashes, sizes, timestamps, deleted paths, or commits.
- A non-member cannot create, list, revoke, or authenticate a device credential for the share, nor use a
  credential created for another share.
- Direct and Nextcloud-compatible WebDAV tests cover unauthorized `PROPFIND` at roots/ancestors/depth 0/1,
  GET/HEAD/range, PUT, DELETE, MKCOL, COPY/MOVE source and destination, encoded traversal, and virtual
  Saber paths. No operation crosses a share boundary.
- A read-only member can discover an authorized share, complete read-only negotiation, request a no-change
  sync/manifest, inspect permitted history, and download every needed file/blob. Those calls do not create
  share state or require read-write membership.
- A read-only member cannot mutate via native sync, WebDAV, conflict resolution, metadata, registration/
  configuration, upload staging, or device-password issuance. The same denial holds when using a stale client
  that attempts the legacy pre-sync registration sequence.
- Revocation blocks new requests and token refresh as specified; the documentation states that it cannot
  erase content already synchronized to a former member's device.
- A private file never appears in Harmony's Git repository, binary manifest/object tree, conflict records,
  device registry, version metadata, or external remote configuration.

## Migration, Backup, Rollback, and Recovery

The migration tool is an explicit host-local command, not a server-start side effect.

1. Stop writes or take the service offline. Inventory every legacy `data/users/{user}/vaults/{vault}`
   directory, configured remote, known client, and device password.
2. Take and verify a restorable filesystem-consistent backup of `/data`, including auth/session/device
   stores and all Git repositories/binary objects. Record the backup location outside application logs.
3. Create a reviewed migration manifest that maps every legacy user-vault to one new share and grants the
   intended principals. No automatic inference from matching vault names.
4. Run a dry-run that validates source state, target IDs, storage capacity, Git readability, binary manifest
   references, and absence of target collisions. Abort before mutation on any discrepancy.
5. Execute an atomic-per-share move/copy with a journal. Preserve the repository and associated binary,
   upload, conflict, device, and version files as one unit. Verify the resulting share head, tracked paths,
   binary hashes, and metadata counts against the source.
6. Leave the verified backup and legacy data recoverable until upgraded clients have reconciled successfully.
   Do not delete legacy data as part of the initial migration.
7. Reissue device passwords by default. If a migration tool can preserve one, require an explicit operator
   mapping and prove it has no broader scope; never silently retarget it.
8. Upgrade/configure clients one at a time. Each user selects the mapped share and uses the existing
   reconciliation flow, with local backup before overwrite-local. Resolve discrepancies manually rather
   than force-pushing over unknown state.
9. Only after a documented observation period should the operator disable v1 writes and separately archive
   the legacy tree. Rollback before v1 cutoff restores the `/data` backup and pre-upgrade client settings;
   after any accepted v2 writes, recovery is a deliberate reconcile/restore operation, not an automatic
   rollback that could lose newer notes.

## Testing and Validation

- Unit-test account record validation, Argon2 login behavior, disabled accounts, session/refresh principal
  identity, stable share IDs, membership capabilities, and atomic JSON persistence/recovery of interrupted
  writes.
- Integration-test two local accounts and OIDC-shaped subjects against the v2 API; include both private
  shares, Harmony, concurrent share activity, and the distinct Harmony service/device credential.
- Reuse and extend Rust WebDAV tests for all methods and Nextcloud/Saber virtual routes.
- Fixture-test legacy-to-share migration with text history, deleted files, binary attachments, pending
  uploads/conflicts, device/version metadata, and a configured remote. Validate dry-run, success, duplicate
  target refusal, interrupted migration journal recovery, and rollback instructions.
- Extend TypeScript tests for share discovery/selection, old-settings migration without silent retargeting,
  functional read-only negotiation/download synchronization without registration writes, write denial, one-share
  sync, and per-mount state isolation.
- Add composite tests for prefix validation, scoped scan/apply, conflict isolation, failed mount retry,
  same-share rename, rejected cross-share rename, explicit copy/import, attachment routing, and root
  `.obsidian` exclusion.
- Manual verification after deployment: create the three household shares, synchronize Andy's gift note,
  authenticate as Liz, and attempt native/API/WebDAV/Nextcloud enumeration and retrieval. Verify that Liz
  can fully synchronize Harmony but has no observable path to the gift note. Verify recovery from a
  simulated interrupted migration using a disposable backup.

## Manual Verification

- The operator can create Andy and Liz local accounts without an external identity provider, sign in as each,
  and disable an account without revealing a password hash or credential in logs.
- Andy sees Andy Private and Harmony; Liz sees Liz Private and Harmony. Neither share list reveals the other
  private share.
- Both users can create Markdown and binary attachments in Harmony and observe normal synchronization,
  history, and conflict behavior.
- Andy's private gift note survives migration with its history and attachments. Liz's client, API calls, and
  WebDAV client cannot discover or retrieve it.
- A device credential works only for its assigned share/folder and cannot list or move/copy into another
  share.
- During the first-release UX, each selected share opens as a separately synchronized Obsidian vault without
  resetting unrelated local data.
- During the composite release, each person can use `Personal/` and `Harmony/` within one local vault;
  synchronization and recovery status remain independent per mount, and cross-share renames are rejected.

## Delivery Recommendation and Dependencies

Use this document as the parent feature ticket and create four implementation subtasks matching Phases 1-4.
This is preferable to multiple independently deliverable tickets because the central data model,
authorization contract, migration, and v2 API are hard dependencies for all usable share behavior.

1. **A - Principals, local accounts, shares, and host-local administration** is the foundational security
   primitive. It has no useful standalone end-user sync UX but prevents per-endpoint authorization drift.
2. **B - Share-scoped storage, v2 API, WebDAV, and compatibility** depends on A and delivers a secure
   server share boundary plus migration tooling.
3. **C - Client share selection and migration** depends on B and is the first usable household release.
4. **D - Composite local vault synchronization** depends on C and delivers the intended seamless vault UX.

Marvin implications: provision persistent storage backups, an operator-only invocation path for the admin
binary/migration tool, maintenance-window procedures, and protected per-share Git remotes where used. No
Marvin code or deployment configuration is changed by this ticket.

Harmony implications: ordinary Markdown and attachments remain portable. Harmony keeps its ObsidiSync/WebDAV
integration using its dedicated scoped read-write `harmony` credential; Harmony and Marvin own their integration
and deployment updates, while ObsidiSync owns the credential and authorization capability.
