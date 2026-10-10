# FEAT-06 - WebDAV atomic create-if-absent

**Status:** Proposed; READY FOR IMPLEMENTATION
**Owner:** ObsidiSync Rust server
**Dependencies:** Existing published share storage and activated folder-scoped grants; no FEAT-04/05 dependency.

## Goal

Let an authorized WebDAV client create a file only when that destination is absent, without overwriting another
client's existing file. Harmony needs this for portable Markdown workspace manifests, but this is a generic storage
capability. Harmony owns project semantics, document editing, operation journaling and ambiguous-outcome reconciliation.

## Context

The [architecture guide](../architecture/README.md) describes the current share/storage boundary. The
[verified investigation](../WEBDAV_CREATE_IF_ABSENT_RESEARCH.md) traces source, tests, standards and failure cases.
PUT currently supports a single exact quoted If-Match tag, repeats its check under the storage mutex, and otherwise
writes unconditionally. If-None-Match is ignored. The production service already serializes v1/v2/DAV operations by
opaque share ID; `for_share` preserves the shared lock map. Current PUT responses carry no revision receipt.

Native v2 sync already supports [conditional destination creation](../../README.md#api). Its locked checks reuse
`vault/dav.rs::stat_unlocked` for logical presence. Reuse that existing lookup and share lock for DAV enforcement;
the native JSON condition does not implement PUT header handling, parent rules or DAV completion receipts.

## Scope

- Enforce wildcard absence in every mounted DAV PUT path, including Nextcloud mounts, using the existing writer.
- Preserve share publication, independent grant capability/folder checks, path containment and symlink refusal.
- Preserve If-Match-only and unconditional PUT behavior, upload limits, timestamp handling, conflict bookkeeping,
  Git history, native sync visibility and legacy Saber scheduling.
- Define an acknowledgment tied to the completed operation, and document retry/restart limitations precisely.
- No application data schema, migration, credential activation or client sync-state change.

## Proposed architecture

Parse the supported PUT condition explicitly in `webdav.rs`, carry it through the staged-file wrapper, and enforce
it in `VaultService::dav_write_source` (`rust-server/src/vault/dav.rs`) under `with_lock`. Use `stat_unlocked` across
physical files, manifest-backed binaries and logical collections. Refuse a present file before writing, changing
the manifest, clearing conflicts or committing. Directory method errors retain precedence.

Stage the bounded request body as today. A cheap preflight is optional; the final locked check is mandatory.
Within that lock also validate the parent for the new mode, execute the existing mutation/commit flow, and capture
the resulting share head and eligible ETag before unlocking. Return those through the writer result; do not take
a fresh unlocked/stat call in the handler to manufacture the receipt. Retain stage cleanup on returned errors.
Carry the authenticated grant's folder as explicit context when recognizing a virtual parent; the storage layer
must not infer that every missing parent is virtual. If final resource inspection fails or remote integration has
removed the target, return an error with an uncertain outcome rather than a successful creation receipt.

Use a narrow explicit condition/result type or equivalent representation; avoid incompatible boolean combinations.
Existing direct in-memory and unconditional staged callers remain unconditional. They and sync/MOVE/COPY/DELETE need
no new HTTP precondition semantics, but must continue using the same storage lock so they cannot slip between the
absence check and mutation. No lock refactor, generalized file API or new persistence journal is required.

## Proposed contract

```http
PUT /dav/{opaque_share_id}/{granted_folder}/Projects/example/project.md
Authorization: Basic <existing share device credential>
If-None-Match: *
Content-Type: text/markdown
```

Create parent collections first, one level at a time using existing MKCOL. Basic username is the exact share ID
for a share-native grant. A native bearer session is not a DAV credential. Existing mapped legacy URLs still work.

| Input / condition | Proposed outcome |
| --- | --- |
| One If-None-Match field, value `*` with optional surrounding whitespace; absent file and existing parent | `201 Created` after normal persistence/bookkeeping completion; request bytes are the creation input. |
| Existing regular file, including zero-byte, identical-content, binary-manifest or partial/uncommitted file | `412 Precondition Failed`, with no destination/history/conflict mutation by the rejected request. |
| Descendant directory target / granted folder target | Retain current `409` / `405`; never replace a collection. |
| Missing or non-collection parent in the new absence mode | `409`, evaluated under the final lock; no implicit ancestor creation by this request. Treat the granted root as the existing virtual collection. |
| Unsupported/malformed If-None-Match, empty value, duplicate field lines, combined stars or wildcard plus tags | `400`, never unconditional fallback. This deliberately supports a restricted PUT wildcard profile, not all tag-list forms. |
| Supported exact If-Match plus wildcard If-None-Match | `412`; evaluate If-Match first, then absence. Neither present nor absent file can satisfy both. |
| If-Match without If-None-Match | Preserve existing exact-tag compare/write semantics and current unsupported-value `412` responses. |
| Neither condition | Preserve existing `201`/`204`, last-write-wins behavior, including current missing-parent handling. |
| Invalid credentials, read-only grant, wrong share/folder, unsafe path, excessive body | Preserve existing authorization/path/limit refusal before existence-based disclosure or destination mutation. |

For the new successful mode, return an empty body and `X-ObsidiSync-Revision: <final Git commit id>` captured under
the share lock after `finish_dav_commit` succeeds. The header identifies a share history revision, not an operation
ID or HTTP validator. Preserve `X-OC-Mtime: accepted` where currently applicable. A success requires an available
resulting Git head; never emit a fabricated or pre-commit revision.

Also return the existing quoted file ETag when final bytes equal the staged request bytes. If optional upstream
integration changes the resulting representation, omit ETag and require GET read-back; the revision receipt still
identifies the resulting commit. Compare against the staged input before its consumption, without retaining a second
whole large upload in memory. Do not return a validator for transformed bytes. Existing text ETags are size/mtime
tokens and must not be presented as content hashes or durable incarnation IDs.

### Atomicity and failure semantics

The absence check and destination mutation are one serialized storage operation relative to all cooperating local
share writers. With successful persistence and no intervening delete, concurrent conditional creates have exactly
one winner. An ordinary PUT may overwrite the newly created file afterward; absence does not reserve the path.
External remote Git writers and privileged direct filesystem edits do not participate in this guarantee.

No success response precedes the existing Git/remote/device completion path. A timeout, restart, cancellation,
remote conflict or post-mutation error can leave a staged file, partial/uncommitted destination or committed file.
This ticket does not make the existing direct-write/Git sequence crash-atomic or guarantee power-loss durability.
Retries retain the absence condition: present means `412`; absent may create. Never automatically fall back to an
unconditional write, delete a surviving destination or return success merely because bytes happen to match.
Harmony reconciles via its durable journal and read-back identity/content. `412` cannot identify the original creator,
and deletion/recreation permits path reuse without an exactly-once guarantee.

MKCOL creates no durable project identity; an empty directory left by failure may remain. Do not automatically
remove it, add `.gitkeep`, or introduce directory persistence. Committed manifest files provide durable identity.

## Technical research

Reuse the current share mutex because it already covers binary metadata and cooperating native/DAV writers.
Filesystem-exclusive text creation alone misses logical binary resources; a separate HTTP existence check races.
No library, service, cost or hosting dependency is introduced.

The contract follows wildcard rejection and condition precedence from
[RFC 9110 sections 13.1.2 and 13.2](https://www.rfc-editor.org/rfc/rfc9110.html#section-13.1.2), scoped parent checks
from [RFC 4918 section 9.7](https://www.rfc-editor.org/rfc/rfc4918.html#section-9.7), and PUT validator restrictions
from [RFC 9110 section 9.3.4](https://www.rfc-editor.org/rfc/rfc9110.html#section-9.3.4).
Unsupported valid tag lists are rejected explicitly under the restricted profile, rather than claimed as implemented.

## Acceptance criteria

1. Absent Markdown target with an existing parent produces `201`, exact readable input, a real revision receipt,
   and an eligible quoted ETag captured from the completed write.
2. Existing Markdown, binary, zero-byte and partial/uncommitted files each cause `412`; bytes, Git head and pending
   conflict state remain unchanged by the rejected request.
3. Two competing create-if-absent writes with different bodies produce one `201` and one `412`, with only the winner
   committed and discoverable, under successful local persistence and no intervening delete.
4. Deterministically exercise both orderings against unconditional PUT: normal-first rejects creation; create-first
   permits the later normal replacement. Receipts identify their own serialized outcomes.
5. Existing current/stale If-Match, same-content revision advancement and concurrent If-Match tests still pass.
6. Whitespace wildcard succeeds; invalid, unsupported, duplicate and combined If-None-Match values fail without
   mutation; supported dual conditions return `412` for absent and present targets.
7. Directory targets remain directories with established errors; missing/non-collection parents return `409` in
   the new mode and do not create ancestors. Existing unconditional semantics remain unchanged.
8. Read-only grants fail with `403`. Invalid/revoked/staged credentials, wrong-share/folder requests, traversal,
   encoded separators, target/ancestor/dangling symlinks and hidden server paths cannot cause writes or disclose
   inaccessible existence via precondition responses.
9. DAV and Nextcloud mounts enforce identical creation semantics with both applicable active-share and retained
   legacy grant fixtures. No new Saber behavior is enabled by a share grant.
10. Native sync and destination MOVE/COPY race fixtures prove they share the same storage boundary; no conditional
    create overwrites a resource installed before its absence decision.
11. Successful creation is visible through GET/HEAD, depth-0/1 PROPFIND, Git history and normal Obsidian sync; bytes
    and history remain available after restarting against the same disposable data directory.
12. Dropped successful responses and retries produce `412` without replacement; delete/recreate cases follow current
    existence, and read-back can distinguish intended bytes from another writer's or a partial file.
13. Streaming failure/oversize requests do not publish a destination. Returned precondition/persistence errors clean
    stages through the existing wrapper. Cancellation/crash leftovers and uncertain destination state are documented.
14. Inject a failure after mutation/local commit and before response completion; no success receipt is emitted, and
    retry preserves surviving content. Remote failure/conflict and transformed-content cases are reconciled without
    falsely returning an ETag for different bytes.
15. Concurrent MKCOL of the same destination yields `201`/`405` absent intervening mutation; an empty collection is
    discoverable but not promised through Git/file sync. A committed manifest survives Git reconstruction.

## Testing and validation

Put HTTP contract/race/discovery tests in `rust-server/tests/webdav_tests.rs`. Preserve the existing If-Match test
`webdav_if_match_is_atomic_and_advances_an_unchanged_resource_revision`. Use published disposable fixtures and shared
application state; use barriers/controlled streaming to ensure both requests reach meaningful race points.

Extend `share_transition_tests.rs` for active independent grants, mapped v1/v2/shared locks, read-only DAV and
cross-share/symlink refusal. Use `nextcloud_tests.rs` for alternate mount coverage. Add focused service fixtures in
`service_tests.rs` for precondition-before-mutation and receipt capture where HTTP alone cannot control the sequence.
Use existing disposable Git-remote patterns for failure and transformed-representation fixtures. Do not use live data.

Run in Ubuntu/WSL with the repository's Rust/Node toolchain:

```bash
cargo test --manifest-path rust-server/Cargo.toml --test webdav_tests
cargo test --manifest-path rust-server/Cargo.toml --test share_transition_tests
cargo test --manifest-path rust-server/Cargo.toml --test nextcloud_tests
cargo test --manifest-path rust-server/Cargo.toml --test service_tests
npm test
npm run test:e2e
```

Update WebDAV reference documentation with conditional profile, receipt header and uncertain-outcome recovery.
After implementation passes locally, verify the actual proxy forwards conditions/receipt headers and preserves
`201`/`412`, and exercise Harmony read-back plus existing Obsidian and Saber clients in a separately authorized
integration environment. Local tests do not establish deployment readiness. No production migration is required.

## Out of scope

Project/milestone schemas, Markdown parsing, ownership/workflow logic, attachments/photos workflows, relocation,
new MOVE/DELETE features, wikilink rewriting, a new sync protocol, general file-management API, workers, directory
registries, global ETag redesign and exactly-once operation journals. Harmony and Marvin repositories remain unchanged.

## Readiness

**READY FOR IMPLEMENTATION.** No unresolved product/design decision blocks this contract. Toolchain availability is
a local verification prerequisite; production service-grant provisioning and proxy/client checks remain separate
operator work. This ticket records proposed behavior, not an implemented or deployed capability.
