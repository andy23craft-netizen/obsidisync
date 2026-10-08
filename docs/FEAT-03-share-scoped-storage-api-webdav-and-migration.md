# FEAT-03: Share-Scoped Storage, API, WebDAV, and Migration Tooling

**Status:** Proposed implementation subtask
**Owner:** Rust server
**Parent:** [FEAT-01](FEAT-01-multi-user-shares-and-composite-vault-sync.md)
**Dependencies:** [FEAT-02](FEAT-02-accounts-principals-shares-and-administration.md) - hard dependency.

## Problem

Document state is currently keyed by `(user, vault)` across native sync, Git history, binaries, upload/conflict/
device/version metadata, WebDAV, and Nextcloud/Saber routes. Changing only one endpoint would leave bypasses.

## Desired Behavior

All document state belongs to a share. Every data-bearing request authenticates a principal, resolves a share,
checks capability, then accesses share storage. V2 supports functional read-only synchronization without a state-
writing registration call. Harmony's dedicated credential has only its scoped Harmony read-write WebDAV access.

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
- The migration tool is host-local and explicit: reviewed mapping, dry-run, journaled atomic-per-share processing,
  validation, backup/recovery guidance, and default credential reissue. It never runs automatically at startup.
- V1 remains only during a bounded compatibility window and must use the same mapping/authorization or be read-only;
  it never directly bypasses share storage.

## Proposed Implementation

Refactor `VaultService` and DAV helpers to share IDs. Route authorization through FEAT-02's access service before
storage lookup. Implement separate read-only sync behavior that does not run mutating bookkeeping; configure shares,
remote/branch/author state through host-local administration or migration. If upstream refresh is necessary, it may
not create user-visible revision/metadata state for a read-only member.

Update `http.rs`, `protocol.rs`, `webdav.rs`, `nextcloud.rs`, `device_passwords.rs`, and Saber integration to use
v2/grants uniformly. Refactor `vault.rs`, `vault/dav.rs`, `binary_store.rs`, and `version_registry.rs` to share
roots. Add a migration binary/module. Update server tests and `README.md`; do not edit Marvin or Harmony repos.

## Acceptance Criteria

- New/migrated shares isolate repo, binaries, uploads, conflicts, devices, version metadata, and remote state; a
  private file never enters Harmony data.
- `GET /v2/shares` reveals only member shares. Every inaccessible native, metadata, historical, blob, or DAV route
  returns non-enumerating behavior without private names, paths, hashes, timestamps, revisions, or ETags.
- Read-write users sync normally. Read-only users complete negotiation/change discovery/download/history without
  register writes or side effects, and every attempted write fails without side effects.
- Harmony's credential reads/writes only permitted Harmony folders, supports independent rotation/revocation, and
  cannot enumerate either private share.
- V1 cannot bypass membership, and migration is dry-run/journal/validation based with a documented recovery path.

## Testing and Validation

- Add multi-principal integration fixtures: Andy, Liz, read-only member, Harmony credential, two private shares,
  and Harmony. Cover all v2 content/metadata paths and non-disclosure.
- Test read-only successful negotiation/download plus denied/no-side-effect register, upload lifecycle, changed sync,
  conflicts, metadata, and credential issuance.
- Extend direct/Nextcloud WebDAV tests for PROPFIND, GET/HEAD/ranges, writes, collection changes, COPY/MOVE,
  traversal, locks, and Saber routes across share/folder/capability boundaries.
- Fixture-test migration dry run, preserved Git/deleted history/binaries/metadata, collisions, interrupted journal
  recovery, and rollback instructions. Local test completion is distinct from production migration.

## Documentation and Completion

Document v2 capability negotiation, credential rotation, v1 cutoff, migration manifest/dry-run/backup/rollback,
remote privacy, and the Harmony scope. Completion requires local reviewed implementation and tests; production
inventory, deployment, migration, and live verification remain Marvin/operator work.

## Out of Scope

- Client share picker (FEAT-04), composite mounts (FEAT-05), actual production inventory/migration, Marvin
  deployment edits, Harmony code changes, folder ACLs, web admin, or databases.
