# WebDAV atomic creation research

**Inspected:** 2026-10-09. **Scope:** source research and one proposed ticket; no implementation or deployment.
**Primary architectural reference:** [Architecture](architecture/README.md), completed before this investigation.
**Implementation ticket:** [FEAT-06](FEAT-06-webdav-atomic-create-if-absent.md).

## Finding and smallest extension

Harmony's reported gap is independently confirmed: WebDAV PUT parses `If-Match`, but never reads
`If-None-Match`. Supplying `If-None-Match: *` currently reaches the unconditional writer and can overwrite a file.
The minimum concurrency fix is to carry an explicit absence precondition into `VaultService::dav_write_source`
and evaluate it using `stat_unlocked` inside the existing share storage mutex, before any destination mutation.
A handler-only existence check, exclusive creation of a text file alone, or GET-then-PUT is insufficient: binary
resources live in a manifest, and the share lock must serialize native sync and DAV operations together.

Two bounded additions make that useful as a provider contract: check parent collection existence under that same
lock for the new conditional mode, and return a receipt captured after the existing commit path succeeds, before
releasing the lock. Preserve old unconditional and If-Match behavior. No new service, schema or migration is needed.

## Verified source path

Line numbers below refer to the inspected working tree; function names are the durable navigation references.

| Stage | Verified behavior | Evidence |
| --- | --- | --- |
| Entry and authentication | DAV and Nextcloud mounts converge on `handle_mounted` / `handle_inner`. A grant-operation read lease surrounds authentication and dispatch. Basic credentials or a device bearer secret authenticate a grant, not a native session. | `rust-server/src/webdav.rs:223,281`; `rust-server/src/grants.rs:7,131` |
| Share authorization | Published active grants resolve exact share IDs and capability; legacy grants require their published mapping. Mutating methods reject read grants before storage. `for_share` clones the existing service, preserving its shared lock map. | `webdav.rs:299`; `grants.rs:65`; `vault.rs:198` |
| Path authorization | Decode segments; reject dot traversal, encoded slashes, NUL and invalid UTF-8; constrain destination to the granted folder. Published out-of-scope targets are masked as `404`. Vault validation additionally rejects backslashes and `.git` components. | `webdav.rs:460,487,497`; `paths.rs:86` |
| PUT validation | Granted folder itself is `405`; partial PUT is `400`; declared or streamed oversized bodies are `413`. `if_match_tag` accepts a single quoted tag and rejects wildcard, weak, list or malformed values with `412`. It uses `headers.get`, so duplicate field lines are not comprehensively validated. | `webdav.rs:891,905` |
| Upload staging | Optional If-Match preflight uses a separate locked read. The request is streamed to `uploads/dav-*.bin` before the final write lock; staging is not destination creation. Stream failure removes the stage; normal write wrappers remove it on returned success/error. Cancellation/crash can leave stages. | `webdav.rs:399,931`; `vault/dav.rs:155,215,242` |
| Final precondition | `dav_write_source` takes `with_lock`, checks state and InkVault guards, reads the binary manifest, stats the resource, rejects directories, and checks If-Match again. That second check supplies atomicity; the preflight alone does not. | `vault/dav.rs:268` |
| Mutation | Markdown goes through `write_unlocked` to `write_repo_file`, which creates parent directories and calls `fs::write`. Binary bytes go to the object store and logical resource metadata goes to the Git manifest. Conflicts are cleared for the touched path. | `vault/dav.rs:743,787`; `vault.rs:2457` |
| Persistence | `finish_dav_commit` validates remote policy, configures Git, commits changed files, optionally fetches/rebases/pushes, then updates device records. Remote conflicts return `409` after local mutation/commit may already have occurred. | `vault/dav.rs:529` |
| Acknowledgment | Handler returns `201` for an absent destination or `204` for replacement, after the storage call returns. Optional `X-OC-Mtime: accepted` acknowledges timestamp input. No ETag or Git revision is returned by PUT. | `webdav.rs:954-1000` |
| Read-back | GET/HEAD returns quoted ETag. PROPFIND depth 0/1 returns `207`, resource metadata and quoted file ETags; infinity is rejected. These reads acquire the same storage mutex. | `webdav.rs:645,775`; `vault/dav.rs:69,82,95` |

`repo_path` calls `reject_storage_links`, inspecting the target and every ancestor with `symlink_metadata`, including
dangling links. It fails closed on unsafe links. Some current unsafe-link errors map to `500`, not a polished `4xx`;
the security property is refusal without touching the target. This is not protection against a privileged host
process swapping filesystem entries concurrently. The new mode must retain these checks rather than bypass them.

### Serialization and its limits

`vault.rs:2143` (`with_storage_lock`) keys the shared `Arc<Mutex<HashMap<...>>>` by resolved opaque share ID.
Published v1 aliases resolve to that same key. Read operations also take this exclusive mutex; write operations
first recover any InkVault publication state. `dav_write_source`, `dav_mkcol`, `dav_move_or_copy`, `dav_delete`,
native sync and resolve use this boundary. No extra distributed lock is needed for the supported one-server model.
The lifetime data-directory OS lock in `main.rs` prevents another participating server/admin process using the store.

The guarantee covers operations on clones of the application's shared `VaultService`, not independently constructed
services, raw filesystem writes, remote Git writers or old binaries that ignore the OS lock. Tests must exercise
shared application state, rather than accidentally proving safety only for one URL or bypassing publication.

The device-grant operation lease has a different purpose: revocation waits for authorized in-flight operations.
It does not serialize file writes. Advisory DAV LOCK/UNLOCK responses are not the concurrency primitive for creation.

## Existing directory, relocation and deletion behavior

`webdav::mkcol` (`webdav.rs:1028`) requires an empty body (`415` otherwise) and checks its parent through
`stat_or_virtual`. An absent/non-collection parent returns `409`; the granted folder itself is a virtual collection.
`VaultService::dav_mkcol` (`vault/dav.rs:390`) checks destination existence under the share mutex, then uses
`create_dir_all`. Existing destinations return an `exists:` error mapped to `405`. Two concurrent creates of one
directory therefore produce one `201` and one `405`, absent an intervening delete or failure.

Creating nested directories one level at a time is sufficient for Harmony. On `405`, inspect PROPFIND resource type;
the response alone does not prove the existing destination is a directory. The HTTP parent check is outside the final
mutex, so a competing deletion can cause `create_dir_all` to recreate a parent. Do not claim MKCOL has an atomic
parent-existence contract. Tightening MKCOL generally is adjacent work, not required for a file-based project identity.

MKCOL creates no Git commit. Empty physical directories normally survive a process restart and can survive a complete
filesystem backup/restore if the backup preserves them. Git history, Git-based reconstruction and file-manifest
synchronization do not preserve empty directories as durable entities. The virtual granted folder needs no physical
directory. If MKCOL succeeds and manifest PUT fails, an empty directory may remain; do not recursively clean it up,
because another client may have populated it. A committed `project.md` is the correct durable identity. It restores
with its file history and creates its parent path during normal sync. No `.gitkeep` or directory registry is necessary.

PROPFIND combines physical entries with binary-manifest-derived collections (`dav_list` / `list_unlocked`). A successful
manifest write is discoverable at depth 0 and in its parent's depth-1 listing, unless a later authorized operation
changes it. Listing and stat are separate calls, so PROPFIND is discovery, not a transactional workspace snapshot.

MOVE/COPY validate destination through the same grant scope, and `dav_move_or_copy` checks `Overwrite: F` under the
share mutex (`vault/dav.rs:412`). Replacement defaults to allowed; existing destination plus `Overwrite: F` is `412`.
DELETE recursively removes collection files and commits (`dav_delete`, line 339). The granted folder cannot be deleted
or replaced. These paths share serialization but do not inherit PUT's If-Match handling. Do not promise safe project
relocation or conditional deletion; Harmony explicitly defers those workflows.

## Standards and proposed contract

[RFC 9110 section 13.1.2](https://www.rfc-editor.org/rfc/rfc9110.html#section-13.1.2) defines wildcard absence and
`412` for failed unsafe-method preconditions. Sections
[13.2.1](https://www.rfc-editor.org/rfc/rfc9110.html#section-13.2.1) and
[13.2.2](https://www.rfc-editor.org/rfc/rfc9110.html#section-13.2.2) place ordinary failures before preconditions,
then evaluate If-Match before If-None-Match. A supported exact If-Match plus wildcard absence cannot both succeed.
Reject it with `412`, rather than silently choosing either header. These are protocol rules, not Harmony semantics.

[RFC 4918 section 9.7](https://www.rfc-editor.org/rfc/rfc4918.html#section-9.7) requires a parent collection for PUT
and permits collection-target errors. Current unconditional text PUT creates missing ancestors; changing that
behavior globally would affect existing clients. Apply `409` for missing/non-collection parents only to the new
create-if-absent mode, under its final lock. Preserve existing directory-target `409` and grant-folder `405`.
This is a scoped extension, not a claim that the existing DAV implementation fully conforms to the standard.

The proposed contract accepts one `If-None-Match` field with trimmed value `*`. Reject other values, including valid
but unsupported tag-list forms, empty values, duplicate lines, `*, *` and mixed wildcard/tag forms with `400` before
mutation. Explicitly document this restricted PUT profile. Do not silently downgrade an unrecognized condition.
Existing If-Match-only behavior stays unchanged; the new parser must not introduce a second first-header-wins bypass.

Return `201` only after the established commit/device bookkeeping path succeeds. Capture the final Git head while
holding the mutex and return `X-ObsidiSync-Revision: <commit-id>` for the new mode. This is a share commit receipt,
not an HTTP entity validator or a globally ordered operation ID. Return the existing quoted file ETag when the final
representation matches the staged input. If remote integration changed the bytes, omit ETag and require read-back;
the commit receipt still identifies the resulting share revision. HTTP forbids a PUT validator for transformed
content ([RFC 9110 section 9.3.4](https://www.rfc-editor.org/rfc/rfc9110.html#section-9.3.4)).

Capture both values inside the write operation; a separate `dav_stat` after unlocking can acknowledge a competitor's
write. Preserve `X-OC-Mtime` behavior. No automatic new ETag behavior is required for existing unconditional clients.
Text ETags currently encode size and millisecond mtime (`text_etag`, line 610); binary tags encode digest and mtime.
They are existing opaque comparison tokens, not durable operation identities. Same-size/time collisions and
delete/recreate identity ambiguity remain limitations; do not claim a cryptographic content validator or redesign
all If-Match semantics in this ticket. Harmony must compare read-back content and its own document identity.

An external Git remote is not a participant in the local mutex. The absence decision is against the current served
share representation, not every remote branch. Existing fetch/rebase can integrate remote changes after local commit.
The receipt describes the final accepted revision and does not prove exclusive ownership of a remote filename.
Harmony's read-back must handle that case; no remote-wide compare-and-swap is proposed.

## Failure, retry and concurrency matrix

These are proposed creation results grounded in the existing locking/persistence behavior. They are not new tests
that have already passed. Except for a definitive pre-mutation rejection, errors may require reconciliation.

| Scenario | Expected result and recovery |
| --- | --- |
| Two create-if-absent requests | With successful storage/Git completion and no intervening delete, one `201`, one `412`; loser cannot change bytes, history or pending conflict state. Streaming order does not reserve the destination. |
| Unconditional PUT races with create | If normal PUT wins first, create returns `412`. If create wins first, it returns `201` and the later normal PUT may return `204` and overwrite it. Absence is a condition at mutation time, not a future reservation. |
| Created but response lost | Original mutation may be fully committed. Retry with the same condition returns `412` while target exists. GET and compare intended identity/content; `412` alone cannot prove which request created it. Never fall back to unconditional PUT. |
| Restart during creation | Before mutation, only staged bytes may remain. During direct text write, a partial/uncommitted file is possible; after local commit, persistence may have succeeded even if remote push/bookkeeping/response failed. Restart does not supply a DAV transaction journal. Read back, preserve partial/foreign files, inspect history offline as needed. |
| Directory succeeds, file fails | Empty directory may remain visible. It is not a project. Reconcile the manifest and retain unrelated/concurrent files; no automatic recursive delete. |
| Retry of ambiguous creation | Existing destination gives `412`, including zero-byte or partial files. Truly absent destination may be created. The provider cannot identify a replay from the request body alone; Harmony's durable journal decides retry/reconciliation. |
| Delete and recreate during retry | Present replacement yields `412`; a momentarily absent destination can yield `201`. There is no tombstone, incarnation check or exactly-once guarantee. Path reuse must be reconciled by Harmony. |
| Directory target | Preserve existing `409` for a descendant collection and `405` for the granted collection; never replace it with a file. Directory detection precedes the absence condition as an existing ordinary method error. |
| Unsafe path / symlink | Existing path/scope/link checks reject access before destination mutation. Assert no external bytes changed, rather than claiming every unsafe link already has a particular `4xx`. |
| Insufficient permission | Read grant returns `403`; wrong share/folder remains masked by existing scope rules, and unusable credentials return existing authentication errors. Never return an existence-based `412` before authorization. |

The current write path uses ordinary `fs::write` and Git subprocesses, not a synced transactional publication of all
file/manifest/history/device state. This assignment does not require exactly-once delivery or power-loss durability.
No `201` is allowed before the normal persistence path finishes, but timeouts, cancellation, remote failures and
post-mutation errors remain uncertain outcomes. A rejected retry must preserve any surviving file, including a partial
one. Safe absence checking is distinct from crash-atomic publication; do not advertise the latter.

## Acceptance tests and verification evidence

Existing evidence inspected:

- `webdav_tests.rs::webdav_if_match_is_atomic_and_advances_an_unchanged_resource_revision`: current/stale tag,
  same-content revision advancement, unconditional compatibility and one-winner If-Match race.
- `webdav_uploads_reach_obsidian_clients_through_sync`: Markdown/binary DAV writes reach native sync, history and devices.
- `webdav_supports_collections_moves_deletes_and_locks`: MKCOL `201`/`405`/missing-parent `409`, discovery, relocation,
  deletion and advisory locking.
- `webdav_authenticates_with_device_passwords_and_scopes_to_folder`, `webdav_rejects_uploads_over_the_configured_limit`:
  grant confinement and bounded upload behavior.
- `share_transition_tests.rs::mapped_writable_v1_and_v2_share_one_root_and_independent_activated_grants` and
  `share_protocol_tests.rs::every_share_route_denies_nonmembers_and_readonly_requests_preserve_storage`: published
  storage, independent grants, read-only and native authorization foundations. These do not prove the new condition.

New acceptance cases, exact expected results and fixture locations are in [FEAT-06](FEAT-06-webdav-atomic-create-if-absent.md).
Use published synthetic shares and a shared router/service. Add deterministic barriers around body completion/write
entry where needed, rather than relying only on simultaneous task launch. Include a native-sync/DAV race and
destination MOVE/COPY race to verify the shared boundary; no new conditions are needed on those APIs.

No application tests were run in this research turn: `cargo` is unavailable on the established WSL PATH and no cargo
executable was found in the inspected conventional locations. An October 8 compiled WebDAV test binary exists, but
running it would not validate today's source, so it was not used as evidence. Test sources were inspected, not claimed
as passing. No new implementation exists to test. Documentation links and whitespace were checked separately.

Future local validation should run focused Rust integration suites, then `npm test` and `npm run test:e2e` in WSL.
Process-stop/remote-failure fixtures use only disposable repositories. Proxy header forwarding, timeout behavior,
actual Harmony bridge reconciliation and supported Obsidian/mobile behavior require a separate integration/staging
verification before rollout. No production store or live Marvin configuration was inspected or changed.

## Readiness verdict

**READY FOR IMPLEMENTATION.** No product or infrastructure decision blocks the scoped provider extension.
The runtime/test toolchain must be available to the implementing environment; missing local cargo prevents test
execution here, not design completion. The current provider is not ready for Harmony create-if-absent use until
FEAT-06 is implemented and verified. Published service-grant provisioning and live proxy/client checks remain
operator/integration work, not grounds for declaring deployment readiness from unit tests.
