# ObsidiSync handoff - Atomic WebDAV create-if-absent

**Status:** Handoff-ready prerequisite specification; sibling implementation not authorized by this work.  
**Owner:** ObsidiSync Rust server.  
**Consumer:** [FEAT-19 Projects Foundation](feat-19-projects-foundation.md).  
**Scope:** One narrow provider capability, not a Harmony child ticket or a new synchronization protocol.

## Goal and evidence

Allow Harmony to create a Markdown document without ever overwriting an existing destination during a race.
Inspected 2026-10-09: `../obsidisync/rust-server/src/webdav.rs::put` parses exact `If-Match` but does not enforce
`If-None-Match: *`. Its ordinary PUT path can replace content. `vault/dav.rs` already checks update revisions inside
`with_lock`; extend that same storage transaction/commit path for absence checks. GET-then-PUT and random filenames
do not supply atomic exclusion. Empty MKCOL directories are not durable project content.

## Proposed contract

`PUT <authorized document URL>` with `If-None-Match: *` creates only when no destination file/collection exists.
Evaluate absence inside the same per-share/vault storage lock immediately before publication, shared with native
sync and DAV writers. Early HTTP checks may optimize rejection but cannot replace the locked check.

- Absent destination and valid authorized write: 201 only after the existing durable publication/manifest/history
  path completes. GET returns exact bytes and a strong ETag. A response ETag is useful but Harmony still reads back.
- Existing file, collection, or conflicting reserved destination: 412 without modifying its content, identity,
  metadata, history, conflicts, or visible sync state. Do not disclose content in errors.
- Two simultaneous conditional creates: exactly one succeeds; the other receives 412.
- Preserve existing exact If-Match update semantics and existing unconditional PUT behavior for other clients.
  Harmony never uses unconditional PUT for this feature.
- Explicitly parse the supported wildcard. Reject malformed/unsupported conditional values and contradictory
  If-Match plus If-None-Match with 400; never ignore them and fall back to unconditional write.
- Existing authentication, publication, capability, path containment, body-size, symlink, and cross-share rules
  apply before content access. Inaccessible targets remain indistinguishable from nonexistent authorization scopes.
- Parent collection requirements follow the existing API. No new folder creation or recursive operation is added.
- Timeout/connection loss is ambiguous. A retry to an already created destination returns 412; Harmony reconciles
  expected bytes/IDs through GET and must not overwrite. No provider-side Harmony idempotency database is needed.

Clean up staged upload files on rejected publication and failure. Use the existing storage recovery path; do not
add a second journal or claim a cross-SQLite/WebDAV transaction. A failure after publication but before response
must remain recoverable by read-back. Document actual durability guarantees; fixture tests do not prove power-loss
behavior. No new service, credentials, mount model, or public network route.

## Acceptance and validation

- [ ] Conditional create on an absent authorized path returns 201 and exact readable bytes with strong ETag.
- [ ] Existing file and collection return 412 and are unchanged, including history and sync metadata.
- [ ] A barrier-controlled concurrent same-path create has one winner and no overwritten bytes.
- [ ] Native sync racing DAV creation participates in the same exclusion; no stale absence check bypasses it.
- [ ] Malformed/contradictory conditional headers cannot become unconditional writes.
- [ ] Read-only/revoked grants, cross-share destinations, encoded traversal, and symlink ancestors are denied.
- [ ] Existing If-Match stale-update rejection and ordinary client PUT regressions pass unchanged.
- [ ] Interrupted body/publication cleanup and lost-response retry are tested with synthetic disposable documents.
- [ ] Server restart preserves acknowledged creation and existing recovery semantics.
- [ ] API documentation states wildcard support and required read-back after ambiguous responses.

Run the ObsidiSync repository's required Rust/protocol/packaging checks under its own agent instructions when
implementation is authorized. Reuse its existing DAV fixtures; use no household document content in tests/logs.
Harmony adds an integration fixture for conditional create, repeat rejection, GET/read-back, and stale If-Match.

## Provisioning handoff and readiness

Marvin needs an approved immutable ObsidiSync artifact containing this capability, its existing backup/update
procedure, and a disposable scoped-resource verification before Harmony Projects creation is enabled.
Do not infer support from a successful ordinary PUT or OPTIONS method list. Verify actual competing/repeated create
behavior on disposable content; record redacted stage results only. Keep Harmony writes gated if unavailable.
Private/shared share publication and client migration remain separate dependencies, not part of this patch.

Ready to transfer into the ObsidiSync backlog when sibling ticket writes are authorized. No source, ticket, or
deployment file in that repository was modified. MOVE/DELETE source preconditions remain later work and do not
block the first release's display renames and metadata archive.
