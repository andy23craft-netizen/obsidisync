# FEAT-03: Share-Scoped Storage, API, WebDAV, and Migration Tooling

**Status:** Proposed implementation subtask
**Owner:** Rust server
**Parent:** [FEAT-01](FEAT-01-multi-user-shares-and-composite-vault-sync.md)
**Dependencies:** [FEAT-02](FEAT-02-accounts-principals-shares-and-administration.md) identity, membership, offline
administration, and persistence primitives are implemented. FEAT-04 and FEAT-05 follow this phase; neither is
required for independent server/fixture testing.

## Problem

Document state is currently keyed by `(user, vault)` across native sync, Git history, binaries, upload/conflict/
device/version metadata, WebDAV, and Nextcloud/Saber routes. Changing only one endpoint would leave bypasses.

## Desired Behavior

All served document state belongs to a published share. Every data-bearing request authenticates, resolves an
authorized share, checks capability, then accesses storage or returns metadata. V2 supports complete read-only
synchronization without registration writes. Explicitly mapped v1 synchronization remains fully writable during an
operator-controlled compatibility period. Device/service credentials are independent, explicitly activated and
revocable grants; Harmony's dedicated grant has only its authorized share/folder access.

## Current Behavior

- `accounts.rs` persists versioned `auth/accounts.json` with immutable local IDs/namespaces, typed local or verified
  OIDC issuer/subject membership, opaque share IDs, labels, and capabilities. Disabled local accounts fail membership
  lookup. `auth.rs::membership_principal` uses verifier provenance. The approved development amendment requires a
  distinct `development(canonical_configured_user)` principal established only by explicitly enabled development
  authentication, with explicit membership and mapping, never local/OIDC inference or global access. Production
  local/OIDC modes reject it; the packaged image defaults explicitly to OIDC even if DEV_TOKEN is injected.
  FEAT-02 import/login and exclusive auth modes remain, with the approved OIDC exception: issuer-less
  access/refresh requires re-login. New sessions persist verified issuer/subject and membership uses that pair;
  current configuration never fills in a missing issuer. Bound sessions survive restart and provider changes
  cannot reinterpret them as another issuer's identity.
- `share_credentials.rs` stores only staged WebDAV records in `auth/share-device-passwords.json`: ID, secret hash,
  share, folder, capability, creator, label, and timestamps. No network authenticator uses it. It currently has no
  active lifecycle or Saber settings. `device_passwords.rs` preserves legacy grants and encryption/PDF configuration.
- `VaultService`, DAV, and InkVault use user/vault storage and locks. Registration ensures a repo and rewrites
  configuration. Even no-change sync can configure/fetch/rebase Git, commit pending state, and persist bookkeeping.
  Browser/API feeds enumerate user vaults. Saber rendering/push workers retain grants and user/vault keys;
  `saber-push.json` is additional server-local document state.
- `main.rs` holds `DataDirectoryLock` outside the runtime until workers stop. `admin.rs` runs offline in the existing
  binary/image. `auth_storage.rs` syncs temporary JSON, renames, and syncs its directory with private permissions.
  That makes one file durable; separate JSON files and directory renames are not one atomic transaction.
- The plugin calls v1 registration before sync and retains one head/manifest/registration/recovery state. Preserve
  this behavior in mapped compatibility fixtures without implementing FEAT-04 share selection.

## Requirements

- Store a share's repo, binaries, uploads, state, conflicts, devices, and version metadata under
  `data/shares/{share-id}` and key locks/service APIs by share ID; preserve Git and binary representation.
- Add v2 share discovery, sync-state/negotiation, upload, sync, history/file/blob, conflict, device/version, and
  device-credential routes. List only authorized shares; non-members receive `404`, not share metadata or `403`.
- Current `POST .../register` ensures a repo and rewrites `state.json`, so it is write behavior. Split v2 into
  host-local/migration share setup and a read-capable non-mutating sync-state/negotiation endpoint.
- Read-only flow may discover, negotiate, inspect, retrieve change/manifest/history, and download needed files/blobs.
  It may not create a repo, persist a device/version record, stage/consume uploads, queue conflicts, or commit Git.
- Require `read-write` for uploads, changes/deletes, write conflict resolution, mutable metadata/configuration, and
  write-capable credential issuance.
- Bind device credentials to `{share_id, folder, capability}` and apply grant capability to every direct and
  Nextcloud WebDAV method, including PROPFIND depths, ranges, COPY/MOVE source/destination, and Saber paths.
- The migration tool is offline and explicit: reviewed mapping, dry-run, staged copy, validation, journaled recovery,
  and coordinated publication of the reviewed set. It never runs automatically at startup or reissues credentials.
- V1 remains fully writable against explicitly mapped share storage until an explicit measured operator cutoff.
  Neither membership alone nor retained legacy directories provide a compatibility bypass.

### Authorization and complete route audit

Use one resolver and locks keyed by share ID. Audit native v1/v2 sync and metadata; browser `/change-feed` and API
feeds; InkVault source/PDF/publication/recovery/resolve; direct WebDAV; Nextcloud/OCS/avatar/login; Saber browser/token
authentication; background rendering/push; binaries/ranges; uploads; history/deleted files; conflicts; devices and
version metadata; and credentials. Feeds enumerate authorized published shares/mappings before reading repos.
Auth/health/protocol discovery reveals no share-specific metadata. Background work carries resolved share/grant
identity and rechecks publication, retirement, capability, and revocation before accessing storage. Cached grants
cannot outlive revocation. Include InkVault recovery files and Saber push state within share storage/isolation.

For valid authentication, inaccessible/nonexistent/unpublished/retired shares return indistinguishable `404`.
Authentication failure remains `401`; write denial on an accessible share may use `403` without side effects.
DAV ancestors/virtual mounts reveal only the granted path. Reject traversal and cross-share COPY/MOVE before
source/destination effects. Device secrets never become native bearer sessions or membership administration tokens.

Add `/v2/shares/{share_id}/sync-state` and v2 equivalents for the audited native routes, including InkVault, device
versions, and credential management. Advertise additive server API/capability discovery for FEAT-04. Read sync may
reuse existing request/response models with no changes, but must use a non-mutating path and reject nonempty changes
before bookkeeping. Do not fetch/rebase upstream from read-only requests: serve current published state and leave
remote refresh to authorized write synchronization. Host-local setup or migration creates/configures repositories.

### Writable v1 compatibility

- Publish reviewed exact `(legacy_user, legacy_vault) -> share_id` mappings with explicit typed principals authorized
  for each legacy namespace. Initial migration requires unique sources and unique targets; merging repositories is
  excluded. Labels and normalized OIDC display names never infer mappings or typed authorization.
- Native v1 retains token-user equality with the URL namespace, checks the mapping's explicit typed principal and
  current share membership/capability, then accesses share storage. Another share member cannot use someone else's
  legacy namespace. Missing mapping returns `404`; no new legacy directory, label alias, or source-tree fallback.
- Preserve registration/sync/upload/conflict/history/file/blob/device/version/InkVault/credential request and response
  contracts, partial-upload retry, and client state. Registration remains writable configuration of an existing
  mapped share with the same returned user/vault/head fields; it cannot retarget share ID. Preserve remote/branch/
  author behavior and remote-host validation. New v1 namespaces require explicit offline setup/mapping.
- Browser/API legacy feeds use only authorized mappings. Legacy grants independently authenticate with their original
  usernames, hashes, vault URLs, folders, IDs, kinds, timestamps, and Saber settings, then resolve the exact published
  mapping. Legacy create/list/rotate/revoke remains supported for mapped namespaces; new grants inherit the mapping.
  Share credentials never acquire legacy username aliases or authenticate to native v1.
- Store compatibility enablement/cutoff in publication state. Writable compatibility is the migration default;
  no upgrade, timer, or restart silently disables it. Persist redacted per-mapping protocol/client activity counters
  and last-use times outside Git, including identifiable rejected old-client attempts; record no content, paths,
  tokens, or secret-bearing URLs. An operator status/dry-run command reports outstanding required consumers.
- Cutoff requires every required native client inventoried, migrated/reconciled to v2, and replacement flows
  verified. Legacy DAV/Saber consumers must be migrated or explicitly retained as named exceptions. The operator
  records a finite observation interval covering the longest expected offline-client return; zero required v1
  activity for that interval is mandatory. Missing/reset telemetry restarts observation. Explicit reviewed offline
  cutoff commits state only after evidence/exception review. Exceptions retain declared scope; do not claim full
  cutoff while they remain. Authorized removed-alias requests may return `410`; inaccessible aliases remain `404`.
  Notify users through deployment documentation; archive old trees separately, never silently disable v1.

### Explicit activation and independent grants

- Activate selected staged credential IDs only through an explicit offline command after share publication.
  Require a valid non-retired published share, valid schema/scope, and an enabled creator with sufficient membership
  at activation. Preserve ID, secret hash, share, folder, capability, kind, and metadata; do not rotate/reissue.
  Upgrade, migration publication, and restart never activate Harmony or any other staged credential automatically.
- The publication manifest's activated-ID set determines effective lifecycle. Existing staged records remain
  byte-preserved on activation; inventories report effective staged/active/revoked state instead of requiring a
  second file update just to activate. A missing/revoked record never authenticates despite a stale activation ID;
  validated recovery removes dangling references safely.
- Once active, credentials are independent grants. Creator membership removal/downgrade or account disable does
  not revoke/reduce them. Authentication checks the secret, live revocation state, immutable share/folder/capability,
  and published non-retired share, not current creator membership. User-session membership checks remain required.
- Issuance, activation, and rotation require an explicitly identified currently authorized creator/acting member
  with sufficient capability. Another authorized member can rotate after original creator removal; preserve creator
  attribution and record the actor where needed. Share/folder/capability cannot broaden or retarget: revoke and
  explicitly issue a new grant. The host operator can always revoke, including after creator disable/removal.
- Redacted operator inventory shows ID, share ID/label, scope, capability, kind, attribution, lifecycle, and usage.
  Account-disable/membership-revoke diagnostics identify surviving independent grants and instruct explicit revoke.
  Lists never reveal hashes, old secrets, encryption passwords, or private document paths.
- Retirement first commits unavailable-share state in the publication manifest; all share and mapped legacy grants
  then fail and queued work stops. Do not reuse retired IDs. Revoke/archive grants before deleting referenced
  shares/accounts; do not drop unknown fields or silently discard attribution. Retained recovery records cannot
  authenticate to retired/deleted shares. No network grant survives deletion.
- Harmony's dedicated service grant survives its creator losing access, stays limited to recorded folders and
  capability, and is independently rotated/revoked. Document this explicitly in compromise recovery: disabling a
  person does not stop their service/device grants. Previously copied local data cannot be remotely erased.

### DAV/Nextcloud identity and Saber continuity

- Share-grant Basic username and OCS account ID are the exact opaque `share_id` (`s_...`), never a label, creator
  name, or legacy namespace. Basic requires that identity plus secret; bearer derives the same identity from the
  secret. Multiple grants share this username but retain independent scopes/hashes. Reject ambiguous eligible
  secret matches. Distinguish share-ID Basic dispatch from legacy usernames without normalization collisions.
  Validate at publication/activation that an active share Basic identity cannot also be a live legacy username;
  refuse ambiguous configurations with actionable offline guidance, never choose one interpretation silently.
- Direct URL: `/dav/{share_id}/{granted_folder}/...`. Nextcloud URL:
  `/remote.php/dav/files/{share_id}/{granted_folder}/...`; `/remote.php/webdav/...` virtually mounts the authenticated
  grant's folder. Return matching encoded hrefs/OCS identity. Basic/URL identity mismatches reveal no other share.
  Bearer may search both stores but must resolve exactly one eligible grant; staged secrets always fail.
- Preserve legacy DAV/Nextcloud/Saber identity and URLs throughout compatibility. Preserve source/PDF folders,
  recoverable encryption password, renderer/pusher settings, and state losslessly. Generated writes need write
  capability and an explicitly recorded rendering scope in the same share; they cannot escape that scope.
- Saber provisioning/authentication/rendering/pushing remains legacy-only for explicitly mapped v1 namespaces.
  Preserve credentials, encryption/PDF settings, URLs and workflows. Historical DAV folder restrictions remain
  unchanged: background `#tablet` export separately scans the original vault's contents and pushes linked PDFs
  to its legacy Saber devices. This preexisting export scope is broader than direct DAV's folder restriction;
  document it without silently narrowing previously working exports or expanding into another mapped share.
- New share credentials are ordinary scoped WebDAV grants and never enable Saber provisioning, scanning, rendering,
  or pushing. Share-native Saber input/source/output configuration and provisioning is deferred to a separate
  future feature, outside FEAT-03. Do not convert staged grants into Saber grants or silently reissue secrets.
- Legacy background tasks recheck publication, credential revocation, and the original mapped share before source
  reads and output writes. Test traversal, symlink escapes, and `#tablet` references outside that share. No legacy
  directory fallback, second writable tree, cross-share source lookup, or publication bypass is permitted.

### Offline migration, coordinated publication, and recovery

Use the existing exclusive lock and one small publication module. Proposed versioned `auth/share-publication.json`
owns generation/set ID, published/retired share IDs, exact v1 mappings and typed authorized principals, compatibility/
cutoff state, and activated credential IDs. `accounts.json` remains the sole membership source; credential stores
remain grant sources. Prepare required durable shares/memberships with offline commands before staging. Publication
references and validates these records; it does not introduce a second membership authority or rewrite sessions.

1. Stop server/workers and suppress automatic restart. Inventory sources, remotes, known clients, legacy grants/
   Saber configuration, and staged records. Require a reviewed manifest assigning every legacy vault one target or
   an explicit excluded/archive-only disposition. Required active vaults all belong to the coordinated set.
   Excluded/unmigrated vaults remain offline after publication: no native, DAV, feed, or background access. Preserve
   source bytes and warn about affected consumers/grants; never fall back to those directories.
2. Take/verify a protected complete filesystem-consistent backup including auth/sessions/grants, repos/binaries,
   configuration, and publication/journal state. Protected inventory records heads/hashes/references; diagnostics
   show only safe IDs/counts. Dry-run checks readability, schema, explicit typed authorization, normalized source
   collisions, unique target IDs, capacity, path/symlink safety, remote privacy/host policy, historical binary
   references, and target absence. Require explicit reviewed-manifest confirmation on apply; no source merging.
3. Before copying/installing, durably create `auth/share-migration-pending.json` with reviewed-manifest digest,
   set ID, previous generation, source fingerprints, target ownership, and progress. Pending state freezes ordinary
   admin mutations and blocks startup before listeners/workers. Only redacted inspect and explicit recovery run.
4. Copy each complete source to `data/migrations/{set_id}/staged/{share_id}` on the same filesystem, preserving
   working tree, Git refs/history/configuration, binaries, partial uploads/conflicts, device/version state, InkVault
   recovery files, and Saber push state. Do not commit/render/fetch/push/clean/repair during migration. Refuse uncertain
   source publication/corruption requiring manual recovery. Rewrite only necessary staged storage/config identity;
   record legacy aliases in the reviewed mapping, not in inferred directory names.
5. Validate heads/history/tracked and deleted paths, retained historical binary hashes/references, upload/metadata/
   conflict state and configuration against inventory. Sync files/directories; rename each validated root to
   `data/shares/{share_id}`, sync parents, and journal progress. Installed roots remain unavailable until publication.
   Never overwrite an existing published target; retain legacy sources unchanged as protected recovery copies.
6. Revalidate the full set, durable membership/grant references, roots, and previous generation. Commit one complete
   publication manifest using temporary-file/sync/rename/directory-sync persistence. That rename decides publication
   of the set: storage and authorization prerequisites already exist. Initial publication activates no staged grant.
   Validate the committed state, durably record completion, then clear the pending journal with directory sync.
   Startup rejects any pending journal, corrupt schema, missing root, dangling authority, or inconsistent mapping.
7. Before publication, interruption exposes no new set. Explicit recovery validates and resumes the same approved
   set or abandons only journal-owned new targets, preserving sources/backups/previous publication. After manifest
   rename, including before sync/completion, commit may have occurred: inspect committed generation rather than temp
   files. Validate/finalize that generation or refuse startup and require backup recovery if uncertain. Replay is
   idempotent, detects changed sources/manifest/auth references, and never recopies over accepted writes.
8. Document serving requires publication. Existing legacy data without it causes startup failure with offline
   migration guidance, never pre-share fallback. Empty installations may explicitly initialize an empty publication
   offline, then setup/publish shares. Missing authority with installed roots/journal is corruption, not empty state.
   Subsequent setup/publication uses the same readiness checks; later sets preserve existing published mappings.

Separate JSON renames do not become atomic. Safety comes from offline exclusion, staged prerequisites, the durable
pending startup barrier, and one published routing/activation authority. Normal membership/grant changes use their
existing validated persistence; startup checks current references, not historical hashes of mutable repos/stores.
Migration fingerprints are validation evidence, not perpetual hashes that block legitimate writes. Activation,
retirement, and cutoff update the single authority; any required multi-file cleanup/reconfiguration uses the same
fail-closed pending barrier. Do not rewrite FEAT-02 stores merely to manufacture a transaction.

Rollback before resumed writes restores the complete verified backup and old image/configuration under stopped
conditions, with appropriate client settings. After any accepted v1/v2/DAV/background write, take a fresh backup and
reconcile newer document/auth/config state before recovery; stale snapshot restoration can lose data. External remote
writes are a separate recovery boundary. No automatic source deletion, force-push, client reset, or dual writable
storage is permitted. Production inventory/migration/deployment remains separately authorized operator work.

## Proposed Implementation

Refactor `VaultService` and DAV helpers to share IDs. Route authorization through FEAT-02's access service before
storage lookup. Implement separate read-only sync behavior that does not run mutating bookkeeping; configure shares,
remote/branch/author state through host-local administration or migration. Read-only requests serve current state
without upstream refresh; preserve existing remote refresh for authorized writes.

Update `http.rs`, `protocol.rs`, `webdav.rs`, `nextcloud.rs`, `device_passwords.rs`, and Saber integration to use
v2/grants uniformly. Refactor `vault.rs`, `vault/dav.rs`, `binary_store.rs`, and `version_registry.rs` to share
roots, including `vault/inkvault.rs` and Saber state/workers. Extend existing `admin` commands for inventory/dry-run/
apply/recover, share setup/publication/retirement, activation/inventory, and compatibility status/cutoff. Add one
cohesive publication/resolution module, reusing typed principals, capabilities, durable writes and the directory lock.
Validate publication before HTTP/background initialization in `main.rs`. Update server tests and `README.md`;
do not edit Marvin or Harmony repos. Use provisioned local/OIDC/development fixtures, never implicit token membership.

## Acceptance Criteria

- New/migrated shares isolate repo, binaries, uploads, conflicts, devices, version metadata, and remote state; a
  private file never enters Harmony data.
- `GET /v2/shares` reveals only member shares. Every inaccessible native, metadata, historical, blob, or DAV route
  returns non-enumerating behavior without private names, paths, hashes, timestamps, revisions, or ETags.
- Read-write users sync normally. Read-only users complete negotiation/change discovery/download/history without
  register writes or side effects, and every attempted write fails without side effects.
- Harmony's credential reads/writes only permitted Harmony folders, supports independent rotation/revocation, and
  cannot enumerate either private share.
- Fully writable mapped v1 shares the v2 storage/head/lock without resetting existing client state. Wrong namespace,
  unmapped sources and unauthorized typed principals fail even with membership in the target share.
- Activation preserves staged IDs/hashes/scopes; Harmony remains staged until explicit activation. Independent
  grants survive creator disable/removal, but explicit revoke and retirement stop requests and cached workers.
- Legacy tablets keep their scope/settings/URLs and vault-wide tagged export inside their original mapped share.
  Share-native Saber provisioning is deferred; ordinary share credentials never start Saber workers.
- Publication exposes the validated reviewed set or refuses startup. Excluded vaults are offline, sources preserved,
  recovery journaled, and compatibility remains enabled until measured client migration and explicit cutoff.

## Testing and Validation

- Test distinct stable development identity, explicit v1 mappings/membership, token rotation and restart, missing
  membership/mapping, cross-share/namespace denial, read-only no-side-effect enforcement and revocation. Verify the
  actual packaged production default rejects development tokens and cannot select dev from DEV_TOKEN presence;
  explicitly selected dev retains mapped writable v1 behavior. Matching local/OIDC names never confer dev access.

- Add multi-principal integration fixtures: Andy, Liz, read-only member, Harmony credential, two private shares,
  and Harmony. Cover all v2 content/metadata paths and non-disclosure.
- Test read-only successful negotiation/download plus denied/no-side-effect register, upload lifecycle, changed sync,
  conflicts, metadata, and credential issuance.
- Extend direct/Nextcloud WebDAV tests for PROPFIND, GET/HEAD/ranges, writes, collection changes, COPY/MOVE,
  traversal, locks, and Saber routes across share/folder/capability boundaries.
- Fixture-test migration dry run, preserved Git/deleted history/binaries/metadata, collisions, interrupted journal
  recovery, and rollback instructions. Local test completion is distinct from production migration.
- Use disposable directories/volumes and synthetic accounts, OIDC issuer/subjects, notes, keys, and secrets. Cover
  disabled/local/OIDC identity collisions and inaccessible/nonexistent/unpublished/retired response equivalence.
  Cover issuer-less access/refresh rejection, verified issuer persistence, rotating refresh/restart, provider-change
  rejection, identical-subject issuer isolation, and preservation of unrelated sessions/memberships/sync data.
- Run existing plugin v1 against published mappings: repeated registration/configuration, concurrent edits/conflicts,
  binaries/references, history/deleted files, partial uploads/retry/restart, devices/versions, InkVault, feeds,
  credentials, and retained client head/manifest/recovery. Interleave v1/v2 writes to prove one head/storage/lock.
  Wrong namespace/typed principal and missing mappings fail without legacy fallback or initial-state reset.
- Snapshot files/metadata/Git around read-only success and denied writes; prove no registration, remote refresh,
  upload, device, conflict, version, rendering or push mutation. Audit every protocol/surface listed above with
  positive and negative tests, including encoded traversal, ancestor depths, locks, conditional operations,
  Basic/URL mismatch and cross-share COPY/MOVE with no source/destination effects or private metadata leakage.
- Test staged rejection, explicit activation with original ID/hash/scope/secret, restart, and no Harmony
  autoactivation. Cover Basic/bearer DAV/Nextcloud/OCS/Saber and denied device-secret native/session impersonation.
  Creator removal/downgrade/disable preserves grant use; unauthorized issuance/activation/rotation fails, authorized
  replacement actor rotates, and explicit revoke/retirement stops grants and queued workers.
- Round-trip legacy grants/Saber secrets/configuration losslessly; rerun rendering/push/InkVault regression fixtures
  on mapped roots. Test legacy connect/polling, tagged export outside DAV folders but within the same original
  mapped share, revocation during queued work, traversal/symlink denial, and links outside that share. Prove new
  share WebDAV grants cannot enable Saber provisioning/rendering/pushing or cross-share access.
- Migration fixtures include working tree, historical binaries/deleted history, partial uploads/conflicts,
  devices/versions, InkVault/Saber state, remotes and excluded sources. Cover dry-run zero mutation, approval mismatch,
  collision/path/symlink/schema/capacity failures, source changes, replay, and byte-preserved legacy copies.
- Inject interruption at journal creation/progress, copy/sync, each root install, manifest rename/directory sync,
  completion and journal removal. Process-test exclusive administration/startup, pending refusal, pre/post-commit
  recovery and no mixed mappings or dual writable roots. Rehearse complete pre-write backup restore and rejection
  of blind post-write rollback. Excluded sources/grants must never be served.
- Test persistent activity evidence, missing telemetry, required-client exceptions, unmet cutoff refusal, explicit
  cutoff and authorized `410` versus inaccessible `404`; restart never expires compatibility automatically.
- During implementation run focused checks then `npm test` and `npm run test:e2e` in the documented WSL environment;
  exercise packaged offline commands against a disposable volume with network disabled. Record actual outcomes.
  These are required future tests, not tests performed or verification claimed by this documentation revision.

## Manual Verification

After implementation, use disposable fixtures to inspect a redacted migration plan, excluded-vault warnings and
backup/recovery rehearsal. Interrupt publication and observe startup refusal until recovery. Use the existing v1
plugin and a fixture v2 client to verify writable compatibility/read-only isolation without FEAT-04. Verify tablet
continuity and explicit activation with the original staged secret. Remove its creator's access, verify the grant
still works, then explicitly revoke and verify denial. Review cutoff evidence and perform only a fixture cutoff.

## Documentation and Completion

Document capabilities, the route audit, independent-grant security/recovery inventory, share-ID URLs/identity,
legacy-only Saber continuity and broader background export scope, explicit activation/retirement, writable compatibility evidence/cutoff, and
migration approval/staging/publication/recovery/backup/reconciliation. Promote these contracts to permanent
API/operator documentation when implemented. Completion requires reviewed local implementation and fixture tests.

No unresolved product decisions block local implementation under these contracts. Production inventory, target
IDs/memberships, excluded-vault approval, backup location, consumer reconfiguration, and observation duration remain
explicit operator inputs. Maintain FEAT-03 -> FEAT-04 -> FEAT-05 implementation order, followed by one coordinated
production migration only after validation and separate authorization. No production deployment is authorized;
local completion does not mean deployed or live-verified behavior.

## Out of Scope

- Client share picker (FEAT-04), composite mounts (FEAT-05), actual production inventory/migration, Marvin
  deployment edits, Harmony code changes, folder ACLs, web admin, or databases.
- Automatic activation/conversion, implicit mapping, legacy source deletion, cross-share history merging, silent
  client resets, and any implementation or production actions during this ticket revision.
- Share-native Saber provisioning and configurable export-input/source/output scope (future feature).
