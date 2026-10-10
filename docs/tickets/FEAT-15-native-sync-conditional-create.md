# FEAT-15: Atomic Conditional Destination Creation in Native Sync

**Status:** Proposed; ready for implementation
**Owner:** Rust server
**Consumer:** [FEAT-14](FEAT-14-explicit-cross-mount-import.md)
**Dependencies:** Existing published v2 share storage and native upload/sync machinery; independent of FEAT-06.

## Goal

Allow an authorized native sync client to create one destination only if it is still absent when the server
publishes the captured bytes. A concurrent creator must win without having its bytes replaced or converted into
conflict markers by the losing import. This is FEAT-14's server prerequisite, not the import workflow itself.

## Context

Inspected 2026-10-10:

- `v2.rs` authenticates, resolves the share and checks membership/capability before dispatching writes to
  `VaultService::sync_v2`. Empty-change sync is a separate read path.
- `vault.rs::sync_with_contract` holds `with_lock` across Git preparation, pending-file commits, optional remote
  integration, `apply_client_changes`, commit/push and device acknowledgment. The lock is keyed by resolved share
  ID, including mapped v1 and DAV writers; it is not a new lock to add for imports.
- Ordinary text upserts use merge/conflict behavior. Binary upserts compare against the base only when a base
  head exists; a null-base upload can overwrite a concurrently created binary. Neither is an absence condition.
- `read_upload_content` verifies and consumes completed upload files before destination application. Checking
  absence after this point is too late for a clean precondition rejection.
- DAV's `stat_unlocked` resolves physical files/directories, binary-manifest resources and virtual collections.
  This is a concrete candidate for a small shared logical-presence helper; checking the filesystem alone misses
  binary resources. Keep FEAT-06's HTTP/DAV contract and completion path separate.

## Scope

Add opt-in create-only behavior to the native v2 sync write path for one ordinary text or binary upsert per request.
Reuse existing authorization, path/InkVault guards, upload verification, Git history, storage lock and acknowledgment
mechanisms. Do not add an import database, new storage layout, general transaction framework or migration.

## Proposed Contract

`POST /v2/shares/{shareId}/sync` accepts an optional top-level `destinationCondition: "absent"` alongside the existing
`SyncRequest` fields. It applies to exactly one `changes` entry, which must be an `upsert` using the existing inline
or completed-upload representation. `baseHead` may be null or a valid existing base; absence is determined from
current storage, never inferred from that head or `clientManifest`.

- Omitted condition preserves existing behavior. Present values other than the string `"absent"`, including null,
  invalid types, duplicate condition fields or unsupported combinations, fail with `400`; they never become an
  unconditional write. Conditional requests with zero/multiple changes or a delete also fail with `400`.
- Advertise `nativeSyncConditionalCreate` in `/v1/server/info` only once enforcement exists. Old clients omit the
  field and keep working. Old servers can ignore unknown JSON fields, so FEAT-14 must require this capability
  on the currently bound server before conditional submission and must never fall back to ordinary sync or DAV.
- The condition is supported only on ordinary v2 sync writes. Shared `SyncRequest` consumers for v1 sync, read
  sync and paired InkVault resolution must explicitly reject a supplied condition rather than ignore it. Preserve
  existing managed-PDF/source guards; this ticket does not enable copying InkVault sources or managed output.
- Authenticate and authorize before inspecting destination presence. Preserve existing inaccessible-share `404`
  and insufficient-capability responses. A malformed or denied request must not expose destination existence.
- A present logical destination returns `412` with the existing error-body shape and fixed message
  `{"error":"destination precondition failed"}`. This includes identical bytes, zero-byte files, uncommitted files,
  binary-manifest entries, physical directories and virtual collections. No path/content/hash is returned.
- An absent target with unresolved target conflict state is not eligible for creation: return `409` with
  `{"error":"destination reconciliation required"}` without clearing that conflict. Existing path, symlink,
  parent-type and protected-path failures continue to fail closed; they never authorize replacement.
- Success uses the existing `200`/`SyncResponse`, including the resulting `serverHead`, after the normal completion
  path succeeds. No new receipt or success status is needed. Existing unrelated pending conflicts may still produce
  the existing conflict response; the client must inspect authoritative contents/conflicts before acceptance.

Extend the existing server error mapping for these explicit service errors; do not return a `200` sync conflict
response for an absence-precondition failure, and do not expose arbitrary internal error strings.

## Proposed Architecture and Enforcement

Validate request shape and retain the condition through v2 dispatch. Under the existing resolved-share write lock,
validate the path and existing safety guards, then inspect current logical presence before consuming uploads or
performing request-induced Git preparation/application. A present target fails immediately, without importing bytes,
writing conflict markers, modifying its manifest, advancing device acknowledgments or consuming its staged upload.

Native sync can integrate an upstream remote before `apply_client_changes`. Recheck absence and target conflict
state after that integration, immediately before consuming the upload and creating the destination, still under
the same lock. Do not release the lock between the final check, application, commit and existing completion work.
The successful conditional branch creates the verified payload directly; do not route it through ordinary text
merge semantics, which can conflict even when a previously existing path is now absent. Keep unchanged ordinary
upserts on their existing path. Use a minimal logical-presence helper shared with DAV if practical; no FEAT-06
dependency, DAV behavior change or broad refactor is required.

Atomicity here means that cooperating native v1/v2, DAV and MOVE/COPY writers cannot interleave between the absence
decision and creation. Another writer may change/delete the file after the lock is released. Independent upstream
Git writers and privileged filesystem edits are separate trust boundaries. Normal recovery or upstream integration
may already have changed storage before a second-check rejection; that is not publication of the conditional payload
and must not be rolled back. Document this boundary rather than claiming every failed request leaves all history
unchanged. A direct collision detected before preparation must leave destination/history/conflicts/device state
unchanged by the conditional request.

## Failure and Compatibility

Precondition rejection occurs before completed-upload consumption; staged uploads retain their existing lifecycle
and cleanup policy. After consumption/application starts, disk/Git/remote failures or lost responses can have an
ambiguous outcome, as in existing sync. Do not add automatic rollback or replay consumed upload IDs. A retry remains
conditional: an existing destination returns `412`, even if its bytes match. Read-only snapshots, blobs and conflict
queries provide the evidence FEAT-14 needs to reconcile; matching bytes alone are not a new operation receipt.

This feature does not make file writes plus Git commits crash-atomic or guarantee power-loss durability. It must
never report success before the existing completion path finishes. Failed partial writes remain existing resources
for subsequent absence checks. Requests without the condition retain v1/v2 merge/conflict behavior, upload handling,
remote integration and status semantics. No device credential changes, data migration or client state reset occurs.

## Acceptance Criteria

1. Conditional text and binary creates succeed on absent targets with null and valid non-null bases; captured bytes
   are available through existing snapshot/blob/history paths and survive restart after successful completion.
2. Every listed collision returns `412` without applying the submitted payload or creating import conflict markers.
   Preexisting direct collisions leave destination bytes, Git head, conflicts and device metadata unchanged.
3. Two different conditional creates race on the same path: under successful local persistence and no intervening
   delete, one succeeds and one gets `412`. No losing payload replaces or merges into the winner.
4. Controlled races against ordinary native writes and DAV PUT/MOVE/COPY use the same share lock. If another writer
   installs the target first, conditional creation fails; an ordinary writer may still change it afterward.
5. All invalid condition/shape combinations fail closed. Unsupported shared-request entry points reject the condition.
   Requests omitting it retain existing behavior; capability discovery distinguishes servers that enforce it.
6. Denied/revoked/read-only membership, unpublished/retired shares, wrong shares, traversal, symlinks and protected
   or managed paths cannot disclose inaccessible existence or create content. Sibling shares remain unchanged.
7. Direct collision rejection preserves a completed upload unconsumed. Successful creation uses existing checksum/
   path verification. Lost responses and failures after consumption never trigger automatic replay or overwrite.
8. Optional upstream integration installing a target before application causes the second absence check to reject
   without applying the import payload; preexisting target conflicts are not silently cleared.

## Testing and Validation

Use disposable service fixtures in `rust-server/tests/service_tests.rs` for null-base binary races, create-only text
behavior, physical/logical collections, upload consumption, interrupted publication and commit failures. Extend
`share_transition_tests.rs` for real v2 authorization, mapped v1/DAV lock sharing, JSON errors, feature advertisement
and backward compatibility. Use controlled barriers rather than timing-based race assertions. Reuse existing remote
fixtures for the integration recheck and post-application ambiguity; no new infrastructure is needed.

Run relevant focused Rust fixtures, then `npm test` and `npm run test:e2e` in Ubuntu/WSL. Update native API documentation
with the capability, request restriction, `412`/`409`, local-writer guarantee and lost-response recovery. Human
verification uses disposable files to observe create/repeat rejection and unchanged ordinary sync; live deployment
and verification remain separately authorized operator work.

## Out of Scope

FEAT-14 UI, local copies/barriers/import journals, attachments selection and source deletion; conditional replacement,
conditional deletion, multi-file transactions, exactly-once receipts, WebDAV FEAT-06, cross-share atomic moves,
external-remote transaction guarantees, production migration/deployment and sibling repository changes.
